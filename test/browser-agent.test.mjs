import assert from "node:assert/strict";
import { test } from "node:test";
import { agentContext, apiUrl, decide, gameWsUrl, legalMove, modelTransport, PROMPTS } from "../public/js/agent-core.js";
import { BrowserAiAgents } from "../public/js/ai-agents.js";

test("browser AI clamps model output to the legal action", () => {
  const legal = { canFold: true, canCheck: false, canCall: true, canBet: false, canRaise: true, canAllIn: true, minRaiseTo: 8, maxRaiseTo: 100 };
  assert.deepEqual(legalMove('{"action":"check"}', legal), { action: "call" });
  assert.deepEqual(legalMove('{"action":"raise","amount":999}', legal), { action: "raise", amount: 100 });
});

test("browser AI builds model and game WebSocket URLs", () => {
  assert.equal(apiUrl("https://api.example.com/v1", "responses"), "https://api.example.com/v1/responses");
  assert.equal(gameWsUrl("https://poker.example", "ABC123", "bot-1"), "wss://poker.example/ws?table=ABC123&playerId=bot-1");
});

test("browser AI can route a model request through the game proxy", () => {
  const body = { model: "model-a", input: "hello" };
  assert.deepEqual(modelTransport("https://models.example/v1/responses", body, { useProxy: false }), {
    url: "https://models.example/v1/responses", body,
  });
  assert.deepEqual(modelTransport("https://models.example/v1/responses", body, { useProxy: true, proxyOrigin: "https://poker.example/" }), {
    url: "https://poker.example/api/model-proxy",
    body: { url: "https://models.example/v1/responses", body },
  });
});

test("local Codex profile requires a token and sends it only to the model endpoint", async () => {
  const previous = { location: globalThis.location, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  try {
    globalThis.location = { origin: "https://k.amoy.work" };
    globalThis.localStorage = { getItem: () => null };
    const agents = new BrowserAiAgents(() => "https://k.amoy.work");
    await agents.attach("123456", "password");
    const profile = agents.profiles[0];
    assert.equal(profile.model, "gpt-6-luna");
    assert.equal(profile.baseUrl, "https://k.amoy.work/ai");
    assert.equal(agents.getProfiles()[0].apiKey, undefined);
    assert.equal(agents.getProfiles()[0].configured, false);
    assert.throws(() => agents.addBot({ nickname: "AI", level: "experienced", profileId: profile.id }), /请先配置模型 API Key/);
    profile.apiKey = "test-token";
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://k.amoy.work/ai/v1/responses");
      assert.equal(options.headers.authorization, "Bearer test-token");
      return Response.json({ output: [{ content: [{ type: "output_text", text: '{"action":"check"}' }] }] });
    };
    const move = await decide({
      config: { smallBlind: 1, bigBlind: 2, shortDeck: false },
      me: { id: "bot", holeCards: ["As", "Kd"] },
      seats: [{ playerId: "bot", inHand: true, chips: 100, bet: 0, isButton: true, isSb: true, isBb: true }],
      street: "preflop", board: [], pot: 3,
      legal: { canCheck: true },
    }, "experienced", profile);
    assert.deepEqual(move, { action: "check" });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("browser AI reports model failure without submitting a default action", async () => {
  const previousFetch = globalThis.fetch;
  let requests = 0;
  const commands = [];
  try {
    globalThis.fetch = async () => {
      requests++;
      return Response.json({ error: { code: "model_not_found", message: "模型不可用" } }, { status: 403 });
    };
    const agents = new BrowserAiAgents(async () => "https://poker.example");
    agents.tableNumber = "123456";
    agents.profiles = [{ id: "model", apiKey: "test-token", baseUrl: "https://poker.example/ai", model: "gpt-6-luna" }];
    agents.gameApi = async (_path, body) => { commands.push(body.type); return { snapshot: {} }; };
    const runtime = {
      bot: { playerId: "bot", profileId: "model", level: "experienced", nickname: "AI" },
      stopped: false, busy: false, lastTurn: "", status: "运行中", lifecycleController: new AbortController(),
    };
    const snapshot = {
      config: { smallBlind: 1, bigBlind: 2, shortDeck: false },
      me: { id: "bot", sitting: true, chips: 100, holeCards: ["As", "Kd"] },
      seats: [{ playerId: "bot", inHand: true, chips: 100, bet: 0 }],
      street: "preflop", board: [], pot: 3, handNumber: 1, actionDeadline: 12345,
      actingPlayerId: "bot", legal: { canCheck: true },
    };
    await agents.handleSnapshot(runtime, snapshot);
    assert.equal(requests, 1);
    assert.deepEqual(commands, ["stand"]);
    assert.equal(runtime.busy, false);
    assert.equal(runtime.modelFailed, true);
    assert.equal(runtime.stopped, true);
    assert.equal(runtime.status, "模型异常");
    assert.equal(runtime.error, "HTTP 403: model_not_found: 模型不可用");
    await agents.handleSnapshot(runtime, snapshot);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("browser AI rejects an empty model response", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ output: [] });
    await assert.rejects(decide({
      config: { smallBlind: 1, bigBlind: 2, shortDeck: false },
      me: { id: "bot", holeCards: ["As", "Kd"] },
      seats: [{ playerId: "bot", inHand: true, chips: 100, bet: 0 }],
      street: "preflop", board: [], pot: 3, legal: { canCheck: true },
    }, "experienced", { apiKey: "test-token", baseUrl: "https://poker.example/ai", model: "gpt-6-luna" }), /模型返回空内容/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("browser AI receives factual position, stack, player count, and street action context", () => {
  const seat = (playerId, chips, flags = {}) => ({ playerId, nickname: playerId, chips, bet: 0, folded: false, allIn: false, inHand: true, ...flags });
  const seats = [seat("hero", 200, { isButton: true }), seat("sb", 100, { isSb: true }), seat("bb", 400, { isBb: true }), seat("utg", 300), seat("co", 80), null, null, null];
  const context = agentContext({
    config: { smallBlind: 1, bigBlind: 2, shortDeck: false },
    me: { id: "hero", holeCards: ["As", "Kd"] },
    seats,
    street: "preflop",
    board: [],
    pot: 3,
    streetActions: [{ playerId: "sb", type: "call", amount: 2 }],
    legal: { canFold: true, canCall: true },
  });
  assert.equal(context.hero.position, "BTN");
  assert.equal(context.players.find((player) => player.playerId === "utg").position, "UTG");
  assert.equal(context.players.find((player) => player.playerId === "co").position, "CO");
  assert.equal(context.hero.stackBB, 100);
  assert.equal(context.activePlayerCount, 5);
  assert.deepEqual(context.effectiveStacksBB.map((item) => item.value), [50, 100, 100, 40]);
  assert.equal(context.streetActions[0].amountBB, 1);
  for (const style of ["tom_dwan", "tan_xuan", "phil_ivey", "alan_keating", "aaron_zang"]) assert.ok(PROMPTS[style]);
});

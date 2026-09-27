import assert from "node:assert/strict";
import { test } from "node:test";
import { agentContext, gameWsUrl, legalMove, PROMPTS } from "../public/js/agent-core.js";
import { BrowserAiAgents } from "../public/js/ai-agents.js";

test("browser AI clears old profiles and players, and stands their seats", async () => {
  const previous = globalThis.localStorage;
  const oldBot = { botId: "bot-1", playerId: "player-1", nickname: "AI", level: "experienced", profileId: "codex-luna-local", buyinCount: 1 };
  const removed = [];
  const commands = [];
  try {
    globalThis.localStorage = {
      getItem: (key) => key === "easy-poker.ai.tables.v1" ? JSON.stringify({ version: 1, tables: { ABC123: [oldBot] } }) : null,
      removeItem: (key) => removed.push(key),
    };
    const agents = new BrowserAiAgents(async () => "https://poker.example");
    agents.start = () => {};
    agents.gameApi = async (path, body) => { commands.push({ path, body }); };
    await agents.attach("ABC123", "1234");
    assert.deepEqual(agents.getBots(), []);
    assert.deepEqual(removed, ["easy-poker.ai.profiles.v1", "easy-poker.ai.tables.v1"]);
    assert.deepEqual(commands, [{ path: "/api/cmd", body: { type: "stand", tableNumber: "ABC123", playerId: "player-1", nickname: "AI" } }]);
    assert.equal(agents.profiles, undefined);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test("browser AI asks the game server to decide and submit its action", async () => {
  const agents = new BrowserAiAgents(async () => "https://poker.example");
  agents.tableNumber = "ABC123";
  agents.password = "1234";
  const commands = [];
  const snapshot = {
    config: { smallBlind: 1, bigBlind: 2, shortDeck: false },
    me: { id: "player-1", sitting: true, chips: 100, holeCards: ["As", "Kd"] },
    seats: [{ playerId: "player-1", inHand: true, chips: 100, bet: 0 }],
    street: "preflop", board: [], pot: 3, handNumber: 1, actionDeadline: 12345,
    actingPlayerId: "player-1", legal: { canCheck: true },
  };
  const runtime = {
    bot: { playerId: "player-1", level: "experienced", nickname: "AI" },
    stopped: false, busy: false, lastTurn: "", status: "运行中", lifecycleController: new AbortController(),
  };
  agents.gameApi = async (path, body, _signal, timeout) => {
    commands.push({ path, body, timeout });
    return { snapshot: { ...snapshot, actingPlayerId: null } };
  };
  await agents.handleSnapshot(runtime, snapshot);
  assert.deepEqual(commands, [{
    path: "/api/cmd", timeout: 8500,
    body: { type: "aiAction", tableNumber: "ABC123", password: "1234", playerId: "player-1", level: "experienced", handNumber: 1, street: "preflop", actionDeadline: 12345 },
  }]);
  assert.equal(runtime.status, "运行中");
});

test("browser AI shows server request ID and stops on model failure", async () => {
  const agents = new BrowserAiAgents(async () => "https://poker.example");
  agents.tableNumber = "ABC123";
  agents.password = "1234";
  const commands = [];
  agents.gameApi = async (_path, body) => {
    commands.push(body.type);
    if (body.type === "aiAction") throw Object.assign(new Error("模型返回空内容"), { error: "model_empty_content", requestId: "req-1" });
    return { snapshot: {} };
  };
  const runtime = {
    bot: { playerId: "player-1", level: "experienced", nickname: "AI" },
    stopped: false, busy: false, lastTurn: "", status: "运行中", lifecycleController: new AbortController(),
  };
  const snapshot = {
    me: { id: "player-1", sitting: true, chips: 100, holeCards: ["As", "Kd"] },
    street: "preflop", handNumber: 1, actionDeadline: 12345, actingPlayerId: "player-1", legal: { canCheck: true },
  };
  await agents.handleSnapshot(runtime, snapshot);
  assert.deepEqual(commands, ["aiAction", "stand"]);
  assert.equal(runtime.status, "模型异常");
  assert.equal(runtime.error, "模型返回空内容 (req-1)");
  assert.equal(runtime.stopped, true);
});

test("browser AI keeps legal moves and factual context helpers", () => {
  assert.equal(gameWsUrl("https://poker.example", "ABC123", "bot-1"), "wss://poker.example/ws?table=ABC123&playerId=bot-1");
  assert.deepEqual(legalMove('{"action":"raise","amount":999}', { canRaise: true, minRaiseTo: 8, maxRaiseTo: 100 }), { action: "raise", amount: 100 });
  const context = agentContext({
    config: { smallBlind: 1, bigBlind: 2, shortDeck: false }, me: { id: "hero", holeCards: ["As", "Kd"] },
    seats: [{ playerId: "hero", inHand: true, chips: 100, bet: 0, isButton: true, isSb: true }, { playerId: "villain", inHand: true, chips: 100, bet: 2, isBb: true }],
    street: "preflop", board: [], pot: 3, legal: { canCall: true },
  });
  assert.equal(context.hero.position, "BTN/SB");
  assert.equal(context.activePlayerCount, 2);
  assert.ok(PROMPTS.pro);
});

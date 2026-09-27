import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAi } from "../src/ai.ts";
import { createTable, Table } from "../src/engine/table.ts";
import { TableDO } from "../src/table-do.ts";

const config = { AI_MODEL: "deepseek-v4-flash", AI_API_URL: "https://models.example/v1/chat/completions", AI_API_KEY: "server-only-key", AI_THINKING: "disabled" };

function game() {
  const table = createTable({ durationMinutes: 30, tableNumber: "ABC123", password: "1234" });
  table.addPlayer("bot", "AI", "1234");
  table.addPlayer("human", "Player", "1234");
  table.sit("bot", 1);
  table.sit("human", 1);
  table.startHand();
  const playerId = table.hand!.actingPlayerId!;
  return { table, playerId, snapshot: table.snapshot(playerId) };
}

test("server sends only its configured model and key, with thinking disabled", async () => {
  const originalFetch = globalThis.fetch;
  const { snapshot } = game();
  try {
    globalThis.fetch = (async (url, options) => {
      assert.equal(url, config.AI_API_URL);
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer server-only-key");
      const body = JSON.parse(String(options?.body));
      assert.equal(body.model, "deepseek-v4-flash");
      assert.deepEqual(body.thinking, { type: "disabled" });
      assert.equal(body.messages[1].content.includes("holeCards"), true);
      return Response.json({ choices: [{ message: { content: '{"action":"call"}' }, finish_reason: "stop" }], usage: { completion_tokens: 9 } });
    }) as typeof fetch;
    const result = await decideAi(snapshot, "experienced", config);
    assert.ok(["call", "check"].includes(result.move.type));
    assert.equal(result.completionTokens, 9);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("server rejects empty model output", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: "" } }] })) as typeof fetch;
    await assert.rejects(decideAi(game().snapshot, "experienced", config), { code: "model_empty_content" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("server reports an illegal model action instead of silently playing", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: '{"action":"teleport"}' } }] })) as typeof fetch;
    await assert.rejects(decideAi(game().snapshot, "experienced", config), { code: "model_invalid_action" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AI action validates the turn, submits it once, and logs the result", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const { table, playerId, snapshot } = game();
  const data = new Map<string, unknown>([["table", table.toJSON()]]);
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const logs: string[] = [];
  const ctx = { storage, getWebSockets: () => [] } as unknown as DurableObjectState;
  const actor = new TableDO(ctx, { ...config, TABLE: {} as DurableObjectNamespace });
  let modelCalls = 0;
  try {
    console.log = (line: string) => { logs.push(line); };
    globalThis.fetch = (async () => {
      modelCalls++;
      const action = snapshot.legal?.canCall ? "call" : "check";
      return Response.json({ choices: [{ message: { content: JSON.stringify({ action }) } }] });
    }) as typeof fetch;
    const body = { type: "aiAction", password: "1234", playerId, level: "experienced", handNumber: snapshot.handNumber, street: snapshot.street, actionDeadline: snapshot.actionDeadline };
    const send = (payload: object) => actor.fetch(new Request("https://table/cmd", { method: "POST", body: JSON.stringify(payload) }));
    assert.equal((await send({ ...body, password: "wrong" })).status, 403);
    const response = await send(body);
    assert.equal(response.status, 200);
    assert.equal(modelCalls, 1);
    assert.ok((await response.json()).requestId);
    assert.equal((await send(body)).status, 409);
    assert.equal(modelCalls, 1);
    const saved = Table.fromJSON(data.get("table") as ReturnType<Table["toJSON"]>);
    assert.notEqual(saved.hand?.actionDeadline, snapshot.actionDeadline);
    assert.ok(logs.some((line) => JSON.parse(line).phase === "success"));
    assert.ok(logs.every((line) => !line.includes("server-only-key") && !line.includes("holeCards")));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("AI model failure logs status and returns a matching request ID", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const { table, playerId, snapshot } = game();
  const data = new Map<string, unknown>([["table", table.toJSON()]]);
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const ctx = { storage, getWebSockets: () => [] } as unknown as DurableObjectState;
  const actor = new TableDO(ctx, { ...config, TABLE: {} as DurableObjectNamespace });
  const logs: string[] = [];
  try {
    console.log = () => {};
    console.error = (line: string) => { logs.push(line); };
    globalThis.fetch = (async () => Response.json({ error: { code: "model_not_found", message: "模型不可用" } }, { status: 503 })) as typeof fetch;
    const response = await actor.fetch(new Request("https://table/cmd", {
      method: "POST",
      body: JSON.stringify({ type: "aiAction", password: "1234", playerId, level: "experienced", handNumber: snapshot.handNumber, street: snapshot.street, actionDeadline: snapshot.actionDeadline }),
    }));
    assert.equal(response.status, 502);
    const body = await response.json() as { error: string; requestId: string };
    assert.equal(body.error, "model_not_found");
    const log = JSON.parse(logs[0]);
    assert.equal(log.requestId, body.requestId);
    assert.equal(log.upstreamStatus, 503);
    assert.equal(log.code, "model_not_found");
    assert.equal(log.phase, "error");
    assert.ok(!logs[0].includes("server-only-key"));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }
});

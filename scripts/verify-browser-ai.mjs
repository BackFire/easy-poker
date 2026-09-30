import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { BrowserAiAgents } from "../public/js/ai-agents.js";

const origin = (process.env.GAME_API_URL ?? "http://127.0.0.1:18789").replace(/\/$/, "");
const localStore = new Map();
globalThis.localStorage = {
  getItem: (key) => localStore.get(key) ?? null,
  setItem: (key, value) => localStore.set(key, value),
  removeItem: (key) => localStore.delete(key),
};

async function api(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(9500),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${data.error ?? "error"}`);
  return data;
}

const manager = new BrowserAiAgents(async () => origin);
let tableNumber;
let ownerId;
let password;
try {
  ownerId = randomUUID();
  const created = await api("/api/tables", {
    playerId: ownerId, nickname: "Smoke-Owner", durationMinutes: 30,
  });
  tableNumber = created.snapshot.tableNumber;
  password = created.snapshot.password;
  await manager.attach(tableNumber, password);
  await api("/api/cmd", { type: "startHold", on: true, tableNumber, password, playerId: ownerId, nickname: "Smoke-Owner" });
  manager.addBot({ nickname: "Smoke-Browser-1", level: "beginner", buyinCount: 1 });
  manager.addBot({ nickname: "Smoke-Browser-2", level: "experienced", buyinCount: 1 });
  await api("/api/cmd", { type: "startHold", on: false, tableNumber, password, playerId: ownerId, nickname: "Smoke-Owner" });
  const bots = manager.getBots();

  const deadline = Date.now() + 120_000;
  let result;
  while (Date.now() < deadline) {
    const current = manager.getBots();
    const failed = current.find((bot) => bot.status === "模型异常");
    if (failed) throw new Error(`${failed.nickname}: ${failed.error}`);
    const { snapshot } = await api(`/api/table/${tableNumber}`);
    if (snapshot.lastResult?.handNumber && bots.every((bot) => manager.runtimes.get(bot.botId)?.lastTurn)) {
      result = snapshot.lastResult;
      break;
    }
    await sleep(100);
  }

  assert.ok(result, `browser AI did not finish a hand: ${JSON.stringify(manager.getBots().map((bot) => ({ nickname: bot.nickname, status: bot.status, error: bot.error })))}`);
  assert.ok(result.winners.length > 0, "completed hand has no winner");
  assert.deepEqual(result.timeoutIds, [], "browser AI player timed out");
  console.log(JSON.stringify({ tableNumber, completedHand: result.handNumber, winners: result.winners.map((winner) => winner.id), bots: manager.getBots().map((bot) => ({ playerId: bot.playerId, status: bot.status })) }));
} finally {
  await Promise.allSettled(manager.getBots().map((bot) => manager.removeBot(bot.botId)));
  manager.detach();
}

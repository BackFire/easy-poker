import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const origin = (process.env.GAME_API_URL ?? "http://127.0.0.1:18789").replace(/\/$/, "");
const mixed = process.argv.includes("--mixed");
const players = [
  { id: randomUUID(), nickname: mixed ? "Smoke-Human" : "Smoke-AI-1", level: mixed ? null : "beginner" },
  { id: randomUUID(), nickname: "Smoke-AI-2", level: "experienced" },
];
const calls = new Map(players.map((player) => [player.id, 0]));
const requestIds = [];
let tableNumber;
let password;

async function api(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(9500),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${data.error ?? "error"} ${data.requestId ?? ""}`);
  return data;
}

async function command(player, type, extra = {}) {
  return api("/api/cmd", { type, tableNumber, playerId: player.id, nickname: player.nickname, ...extra });
}

try {
  const created = await api("/api/tables", {
    playerId: players[0].id, nickname: players[0].nickname, durationMinutes: 30,
  });
  tableNumber = created.snapshot.tableNumber;
  password = created.snapshot.password;
  await api("/api/join", {
    type: "join", tableNumber, password, playerId: players[1].id, nickname: players[1].nickname,
  });
  for (const player of players) await command(player, "sit", { buyinCount: 1 });

  const deadline = Date.now() + 120_000;
  let result;
  while (Date.now() < deadline) {
    const { snapshot: publicState } = await api(`/api/table/${tableNumber}`);
    if (publicState.lastResult?.handNumber && players.every((player) => calls.get(player.id) > 0)) {
      result = publicState.lastResult;
      break;
    }
    if (publicState.handNumber > 5) throw new Error("五手内未能让两名玩家都完成行动");
    if (publicState.runoutVote) {
      for (const player of players) {
        if (!publicState.runoutVote.choices?.[player.id]) await command(player, "runout", { choice: "once" });
      }
      continue;
    }
    const player = players.find((item) => item.id === publicState.actingPlayerId);
    if (!player) {
      await sleep(100);
      continue;
    }
    const { snapshot } = await api(`/api/table/${tableNumber}?playerId=${player.id}`);
    if (!snapshot.legal || snapshot.actingPlayerId !== player.id) continue;
    const data = player.level
      ? await command(player, "aiAction", {
          password, level: player.level, handNumber: snapshot.handNumber,
          street: snapshot.street, actionDeadline: snapshot.actionDeadline,
        })
      : await command(player, "action", {
          action: snapshot.legal.canCheck ? "check" : snapshot.legal.canCall ? "call" : "fold",
        });
    if (player.level) {
      assert.ok(data.requestId, "AI action must return a model request ID");
      requestIds.push(data.requestId);
    }
    calls.set(player.id, calls.get(player.id) + 1);
    if (data.snapshot.lastResult?.handNumber && players.every((item) => calls.get(item.id) > 0)) {
      result = data.snapshot.lastResult;
      break;
    }
  }

  assert.ok(result, "AI players did not finish a hand before the deadline");
  assert.ok(result.winners.length > 0, "completed hand has no winner");
  assert.deepEqual(result.timeoutIds, [], "AI player timed out");
  console.log(JSON.stringify({ mode: mixed ? "mixed" : "all-ai", tableNumber, completedHand: result.handNumber, winners: result.winners.map((winner) => winner.id), calls: Object.fromEntries(calls), requestIds }));
} finally {
  if (tableNumber) await Promise.allSettled(players.map((player) => command(player, "stand")));
}

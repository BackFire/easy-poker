import { cryptoRandom } from "./engine/cards.ts";
import { AiError, decideAi, type AiConfig } from "./ai.ts";
import { createTable, Table, type ActionInput, type TableJSON } from "./engine/table.ts";
import type { CreateTableInput } from "./engine/types.ts";

export interface Env extends AiConfig {
  TABLE: DurableObjectNamespace;
}

const NEXT_HAND_MS = 5000;

export class TableDO {
  ctx: DurableObjectState;
  env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const playerId = url.searchParams.get("playerId") ?? "";
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ playerId });
      const table = await this.loadAndTick();
      if (table) {
        await this.save(table);
        await this.schedule(table);
        pair[1].send(JSON.stringify({ type: "state", snapshot: table.snapshot(playerId || null) }));
      } else {
        pair[1].send(JSON.stringify({ type: "error", code: "not_found", message: "游戏桌不存在" }));
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    try {
      if (request.method === "POST" && url.pathname.endsWith("/init")) {
        return await this.init(await request.json());
      }
      if (request.method === "POST" && url.pathname.endsWith("/cmd")) {
        const body = await request.json<Record<string, unknown>>();
        return body.type === "aiAction" ? await this.aiAction(body) : await this.cmd(body);
      }
      if (request.method === "GET") {
        const playerId = url.searchParams.get("playerId");
        const table = await this.loadAndTick();
        if (!table) return json({ error: "not_found" }, 404);
        await this.save(table);
        await this.schedule(table);
        return json({ snapshot: table.snapshot(playerId) });
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      return errorResponse(err);
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "无效消息" }));
      return;
    }
    const att = (ws.deserializeAttachment() ?? {}) as { playerId?: string };
    if (!body.playerId && att.playerId) body.playerId = att.playerId;
    try {
      const snapshot = await this.apply(body);
      if (body.playerId) ws.serializeAttachment({ playerId: String(body.playerId) });
      if (snapshot) ws.send(JSON.stringify({ type: "state", snapshot }));
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", ...errorBody(err) }));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
  }

  async alarm(): Promise<void> {
    const table = await this.load();
    if (!table) return;
    table.tick();
    if (!table.hand && table.canStartHand()) {
      table.startHand();
    }
    await this.save(table);
    this.broadcast();
    await this.schedule(table);
  }

  private async init(body: CreateTableInput & { playerId: string; nickname: string; password?: string }): Promise<Response> {
    const existing = await this.loadAndTick();
    if (existing) {
      await this.save(existing);
      await this.schedule(existing);
      return json({ error: "exists", snapshot: existing.snapshot(body.playerId) }, 409);
    }
    const table = createTable(
      {
        durationMinutes: body.durationMinutes,
        shortDeck: body.shortDeck,
        unlimitedBuyin: body.unlimitedBuyin,
        maxBuyins: body.maxBuyins,
        straddleAllowed: body.straddleAllowed,
        squidEnabled: body.squidEnabled,
        bounty27Enabled: body.bounty27Enabled,
        tableNumber: body.tableNumber,
        password: body.password,
      },
      { now: Date.now, random: cryptoRandom },
    );
    table.addPlayer(body.playerId, body.nickname, table.password);
    await this.save(table);
    return json({ snapshot: table.snapshot(body.playerId), invite: table.getInvite() });
  }

  private async cmd(body: Record<string, unknown>): Promise<Response> {
    const snapshot = await this.apply(body);
    return json({ snapshot });
  }

  private async aiAction(body: Record<string, unknown>): Promise<Response> {
    const playerId = String(body.playerId ?? "");
    const table = await this.loadAndTick();
    if (!table) return json({ error: "not_found", message: "游戏桌不存在" }, 404);
    await this.save(table);
    await this.schedule(table);
    if (body.password !== table.password) return json({ error: "wrong_password", message: "密码错误" }, 403);
    const snapshot = table.snapshot(playerId);
    if (!snapshot.me?.sitting || snapshot.actingPlayerId !== playerId || !snapshot.legal ||
      snapshot.handNumber !== body.handNumber || snapshot.street !== body.street || snapshot.actionDeadline !== body.actionDeadline) {
      return json({ error: "stale_turn", message: "已不是该 AI 的行动回合" }, 409);
    }
    const turn = `${snapshot.handNumber}:${snapshot.street}:${snapshot.actionDeadline}:${playerId}`;
    if (await this.ctx.storage.get<string>("aiTurn") === turn) return json({ error: "duplicate_turn", message: "该回合已请求模型" }, 409);
    await this.ctx.storage.put("aiTurn", turn);

    const requestId = crypto.randomUUID();
    const started = Date.now();
    const log = { event: "ai_model", requestId, tableNumber: table.tableNumber, playerId, handNumber: snapshot.handNumber, street: snapshot.street, model: this.env.AI_MODEL };
    console.log(JSON.stringify({ ...log, phase: "start" }));
    try {
      const result = await decideAi(snapshot, String(body.level ?? ""), this.env);
      const current = await this.loadAndTick();
      if (!current || current.hand?.actionDeadline !== snapshot.actionDeadline || current.hand?.actingPlayerId !== playerId) {
        console.warn(JSON.stringify({ ...log, phase: "stale", elapsedMs: Date.now() - started }));
        return json({ error: "stale_turn", message: "模型返回时该回合已结束", requestId }, 409);
      }
      current.action(playerId, result.move);
      await this.save(current);
      this.broadcast();
      await this.schedule(current);
      console.log(JSON.stringify({ ...log, phase: "success", elapsedMs: Date.now() - started, action: result.move.type, finishReason: result.finishReason, completionTokens: result.completionTokens, reasoningTokens: result.reasoningTokens }));
      return json({ snapshot: current.snapshot(playerId), requestId });
    } catch (err) {
      const modelError = err instanceof AiError ? err : new AiError("model_action_error", (err as Error).message);
      const status = modelError.code === "model_timeout" ? 504 : 502;
      console.error(JSON.stringify({ ...log, phase: "error", elapsedMs: Date.now() - started, code: modelError.code, upstreamStatus: modelError.httpStatus }));
      return json({ error: modelError.code, message: modelError.message, requestId }, status);
    }
  }

  private async apply(body: Record<string, unknown>): Promise<ReturnType<Table["snapshot"]> | null> {
    const table = await this.load();
    if (!table) throw Object.assign(new Error("游戏桌不存在"), { code: "not_found" });
    const type = String(body.type ?? "");
    const playerId = String(body.playerId ?? "");
    const nickname = String(body.nickname ?? "");
    try {
      table.tick();
      switch (type) {
        case "join":
          table.addPlayer(playerId, nickname, String(body.password ?? ""));
          break;
        case "sit":
          table.sit(playerId, Number(body.buyinCount ?? 0));
          break;
        case "stand":
          table.stand(playerId);
          break;
        case "rebuy":
          table.rebuy(playerId, Number(body.buyinCount ?? 1));
          break;
        case "runout":
          table.chooseRunout(playerId, body.choice === "twice" ? "twice" : "once");
          break;
        case "action":
          table.action(playerId, {
            type: body.action as ActionInput["type"],
            amount: body.amount === undefined ? undefined : Number(body.amount),
          });
          break;
        case "show":
          table.showCards(playerId);
          break;
        case "emote":
          table.emote(playerId, String(body.emoji ?? ""));
          break;
        case "autoStraddle":
          table.setAutoStraddle(playerId, Boolean(body.on));
          break;
        case "snapshot":
          break;
        default:
          throw Object.assign(new Error("未知命令"), { code: "unknown_cmd" });
      }

      if (!table.hand && table.canStartHand() && table.nextHandNumber === 1) {
        table.startHand();
      }
      return table.snapshot(playerId || null);
    } finally {
      await this.save(table);
      this.broadcast();
      await this.schedule(table);
    }
  }

  private async load(): Promise<Table | null> {
    const data = await this.ctx.storage.get<TableJSON>("table");
    if (!data) return null;
    return Table.fromJSON(data, { now: Date.now, random: cryptoRandom });
  }

  private async loadAndTick(): Promise<Table | null> {
    const table = await this.load();
    if (!table) return null;
    table.tick();
    return table;
  }

  private async save(table: Table): Promise<void> {
    await this.ctx.storage.put("table", table.toJSON());
  }

  private broadcast(): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    void this.load().then((table) => {
      if (!table) return;
      for (const ws of sockets) {
        const att = (ws.deserializeAttachment() ?? {}) as { playerId?: string };
        try {
          ws.send(JSON.stringify({ type: "state", snapshot: table.snapshot(att.playerId ?? null) }));
        } catch {
          /* closed */
        }
      }
    });
  }

  private async schedule(table: Table): Promise<void> {
    const when = table.nextWakeAt(NEXT_HAND_MS);
    if (when === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(when);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorBody(err: unknown): { code: string; message: string } {
  const e = err as { code?: string; message?: string };
  return { code: e.code ?? "error", message: e.message ?? "服务器错误" };
}

function errorResponse(err: unknown): Response {
  const body = errorBody(err);
  const status = body.code === "not_found" ? 404 : body.code === "wrong_password" ? 403 : 400;
  return json({ error: body.code, ...body }, status);
}

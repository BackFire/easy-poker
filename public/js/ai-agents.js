import { gameWsUrl, PROMPTS, PROMPT_LABELS } from "./agent-core.js";

const TABLES_KEY = "easy-poker.ai.tables.v2";
const OLD_TABLES_KEY = "easy-poker.ai.tables.v1";

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; }
  catch { return fallback; }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export class BrowserAiAgents {
  constructor(getApiOrigin, onChange = () => {}) {
    this.getApiOrigin = getApiOrigin;
    this.onChange = onChange;
    this.tableNumber = "";
    this.password = "";
    this.bots = [];
    this.runtimes = new Map();
  }

  async attach(tableNumber, password) {
    if (this.tableNumber === tableNumber) return;
    this.detach();
    this.tableNumber = tableNumber;
    this.password = password;
    const oldBots = readJson(OLD_TABLES_KEY, { tables: {} }).tables?.[tableNumber] ?? [];
    localStorage.removeItem("easy-poker.ai.profiles.v1");
    localStorage.removeItem(OLD_TABLES_KEY);
    const tables = readJson(TABLES_KEY, { version: 1, tables: {} }).tables ?? {};
    this.bots = tables[tableNumber] ?? [];
    this.onChange();
    for (const bot of this.bots) this.start(bot);
    await Promise.allSettled(oldBots.filter((bot) => typeof bot.playerId === "string").map((bot) =>
      this.gameApi("/api/cmd", { type: "stand", tableNumber, playerId: bot.playerId, nickname: bot.nickname ?? "" })
    ));
  }

  detach() {
    for (const runtime of this.runtimes.values()) this.stop(runtime);
    this.runtimes.clear();
    this.tableNumber = "";
    this.password = "";
    this.bots = [];
  }

  getBots() {
    return this.bots.map((bot) => {
      const runtime = this.runtimes.get(bot.botId);
      return {
        ...bot,
        levelName: PROMPT_LABELS[bot.level] ?? bot.level,
        status: runtime?.status ?? "连接中",
        error: runtime?.error ?? "",
      };
    });
  }

  addBot(input) {
    if (!this.tableNumber) throw new Error("尚未进入牌桌");
    if (!input.nickname.trim()) throw new Error("请填写 AI 昵称");
    if (!PROMPTS[input.level]) throw new Error("无效的 AI 水平");
    const bot = {
      botId: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      nickname: input.nickname.trim().slice(0, 16),
      level: input.level,
      buyinCount: Math.max(1, Math.floor(Number(input.buyinCount) || 1)),
    };
    this.bots.push(bot);
    this.persistBots();
    this.onChange();
    this.start(bot);
  }

  async removeBot(botId) {
    const bot = this.bots.find((item) => item.botId === botId);
    if (!bot) return;
    const runtime = this.runtimes.get(botId);
    if (runtime) this.stop(runtime);
    this.runtimes.delete(botId);
    this.bots = this.bots.filter((item) => item.botId !== botId);
    this.persistBots();
    this.onChange();
    try {
      await this.gameApi("/api/cmd", { type: "stand", tableNumber: this.tableNumber, playerId: bot.playerId, nickname: bot.nickname });
    } catch {
      /* local removal must still complete */
    }
  }

  persistBots() {
    const store = readJson(TABLES_KEY, { version: 1, tables: {} });
    store.version = 1;
    store.tables ??= {};
    store.tables[this.tableNumber] = this.bots;
    writeJson(TABLES_KEY, store);
  }

  start(bot) {
    if (this.runtimes.has(bot.botId)) return;
    const runtime = { bot, status: "连接中", error: "", stopped: false, socket: null, snapshot: null, busy: false, lastTurn: "", retryAt: 0, abortController: null, lifecycleController: new AbortController(), reconnectTimer: null, releaseLock: null };
    this.runtimes.set(bot.botId, runtime);
    const run = async () => {
      const hold = new Promise((resolve) => { runtime.releaseLock = resolve; });
      if (runtime.stopped) return;
      await this.connect(runtime);
      await hold;
    };
    if (navigator.locks) {
      void navigator.locks.request(`easy-poker-ai:${this.tableNumber}:${bot.botId}`, { ifAvailable: true }, async (lock) => {
        if (!lock) return this.setStatus(runtime, "其他标签页运行");
        await run();
      }).catch(() => this.setStatus(runtime, "连接异常", "无法获取运行锁"));
    } else {
      void run();
    }
  }

  stop(runtime) {
    runtime.stopped = true;
    runtime.lifecycleController.abort();
    runtime.abortController?.abort();
    clearTimeout(runtime.reconnectTimer);
    if (runtime.socket) {
      runtime.socket.onclose = null;
      runtime.socket.close();
    }
    runtime.releaseLock?.();
  }

  async connect(runtime) {
    try {
      const data = await this.gameApi("/api/join", {
        type: "join",
        tableNumber: this.tableNumber,
        password: this.password,
        playerId: runtime.bot.playerId,
        nickname: runtime.bot.nickname,
      }, runtime.lifecycleController.signal);
      if (runtime.stopped) return;
      runtime.snapshot = data.snapshot;
      await this.ensureSeated(runtime);
      if (!runtime.stopped) this.openSocket(runtime);
    } catch (err) {
      if (runtime.stopped) return;
      this.setStatus(runtime, "连接异常", this.safeError(err, "游戏连接失败"));
      runtime.reconnectTimer = setTimeout(() => this.connect(runtime), 3000);
    }
  }

  openSocket(runtime) {
    void this.getApiOrigin().then((origin) => {
      if (runtime.stopped) return;
      this.setStatus(runtime, "连接中");
      const ws = new WebSocket(gameWsUrl(origin, this.tableNumber, runtime.bot.playerId));
      runtime.socket = ws;
      ws.onopen = () => this.setStatus(runtime, runtime.snapshot?.me?.sitting ? "运行中" : "等待空位");
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "state" && message.snapshot) void this.handleSnapshot(runtime, message.snapshot);
          if (message.type === "error") this.setStatus(runtime, "连接异常", "游戏连接失败");
        } catch {
          this.setStatus(runtime, "连接异常", "游戏消息无效");
        }
      };
      ws.onerror = () => this.setStatus(runtime, "连接异常", "游戏连接失败");
      ws.onclose = () => {
        if (runtime.stopped) return;
        this.setStatus(runtime, "连接中");
        runtime.reconnectTimer = setTimeout(() => this.openSocket(runtime), 1200);
      };
    }).catch((err) => this.setStatus(runtime, "连接异常", this.safeError(err, "游戏连接失败")));
  }

  async ensureSeated(runtime) {
    const snap = runtime.snapshot;
    if (runtime.stopped || runtime.modelFailed || !snap || snap.status === "finished" || snap.me?.sitting || runtime.seating || Date.now() < runtime.retryAt) return;
    runtime.seating = true;
    runtime.retryAt = Date.now() + 3000;
    try {
      const data = await this.gameApi("/api/cmd", {
        type: "sit",
        tableNumber: this.tableNumber,
        playerId: runtime.bot.playerId,
        nickname: runtime.bot.nickname,
        buyinCount: snap.me?.chips ? 0 : runtime.bot.buyinCount,
      }, runtime.lifecycleController.signal);
      runtime.snapshot = data.snapshot;
      this.setStatus(runtime, "运行中");
    } catch (err) {
      if (err.code === "table_full") this.setStatus(runtime, "等待空位");
      else if (err.code === "already_seated") this.setStatus(runtime, "运行中");
      else this.setStatus(runtime, "连接异常", this.safeError(err, "无法坐下"));
    } finally {
      runtime.seating = false;
    }
  }

  async handleSnapshot(runtime, snapshot) {
    runtime.snapshot = snapshot;
    if (runtime.stopped || runtime.modelFailed || snapshot.status === "finished") return;
    if (snapshot.me?.chips || snapshot.me?.pendingChips) runtime.rebuying = false;
    if (!snapshot.me?.sitting) {
      await this.ensureSeated(runtime);
      if (!runtime.snapshot?.me?.sitting) return;
      snapshot = runtime.snapshot;
    }
    if (!snapshot.me.chips && !snapshot.me.pendingChips && !runtime.rebuying) {
      runtime.rebuying = true;
      try {
        const data = await this.gameApi("/api/cmd", { type: "rebuy", tableNumber: this.tableNumber, playerId: runtime.bot.playerId, nickname: runtime.bot.nickname, buyinCount: runtime.bot.buyinCount }, runtime.lifecycleController.signal);
        runtime.snapshot = data.snapshot;
      } catch (err) {
        runtime.rebuying = false;
        this.setStatus(runtime, "连接异常", this.safeError(err, "补码失败"));
      }
    }
    if (snapshot.runoutVote && snapshot.me?.holeCards && !snapshot.runoutVote.choices?.[runtime.bot.playerId]) {
      try { await this.gameApi("/api/cmd", { type: "runout", choice: "once", tableNumber: this.tableNumber, playerId: runtime.bot.playerId, nickname: runtime.bot.nickname }, runtime.lifecycleController.signal); }
      catch { /* server timeout will choose once */ }
      return;
    }
    const turn = `${snapshot.handNumber}:${snapshot.street}:${snapshot.actionDeadline}`;
    if (!snapshot.legal || snapshot.actingPlayerId !== runtime.bot.playerId || runtime.busy || runtime.lastTurn === turn) return;
    runtime.busy = true;
    runtime.lastTurn = turn;
    runtime.abortController = new AbortController();
    try {
      const data = await this.gameApi("/api/cmd", {
        type: "aiAction", tableNumber: this.tableNumber, password: this.password,
        playerId: runtime.bot.playerId, level: runtime.bot.level,
        handNumber: snapshot.handNumber, street: snapshot.street, actionDeadline: snapshot.actionDeadline,
      }, runtime.abortController.signal, 8500);
      runtime.snapshot = data.snapshot;
      this.setStatus(runtime, "运行中");
    } catch (err) {
      if (runtime.stopped || err.name === "AbortError") return;
      if (["stale_turn", "duplicate_turn"].includes(err.error)) return;
      runtime.modelFailed = true;
      const detail = err.name === "TimeoutError" ? "模型请求超时" : err.message || "模型请求失败";
      this.setStatus(runtime, "模型异常", `${detail}${err.requestId ? ` (${err.requestId})` : ""}`);
      try {
        await this.gameApi("/api/cmd", { type: "stand", tableNumber: this.tableNumber, playerId: runtime.bot.playerId, nickname: runtime.bot.nickname }, runtime.lifecycleController.signal);
      } catch { /* the game server will eventually time out this seat */ }
      this.stop(runtime);
    } finally {
      runtime.abortController = null;
      runtime.busy = false;
    }
  }

  async gameApi(path, body, signal, timeout = 5000) {
    const origin = await this.getApiOrigin();
    const res = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || data.error || "请求失败"), data);
    return data;
  }

  setStatus(runtime, status, error = "") {
    runtime.status = status;
    runtime.error = error;
    this.onChange();
  }

  safeError(err, fallback) {
    return ["table_full", "buyin_limit"].includes(err?.code) ? err.message : fallback;
  }
}

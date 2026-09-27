import { agentContext, legalMove, PROMPTS } from "../public/js/agent-core.js";
import type { ClientSnapshot } from "./engine/table.ts";
import type { ActionInput } from "./engine/table.ts";

export interface AiConfig {
  AI_MODEL?: string;
  AI_API_URL?: string;
  AI_API_KEY?: string;
  AI_THINKING?: string;
}

export interface AiResult {
  move: ActionInput;
  finishReason?: string;
  completionTokens?: number;
  reasoningTokens?: number;
}

export class AiError extends Error {
  code: string;
  httpStatus?: number;

  constructor(code: string, message: string, httpStatus?: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export async function decideAi(snapshot: ClientSnapshot, level: string, config: AiConfig): Promise<AiResult> {
  const { AI_MODEL: model, AI_API_URL: url, AI_API_KEY: key } = config;
  if (!model || !url || !key) throw new AiError("model_not_configured", "服务端模型未配置");
  if (!Object.hasOwn(PROMPTS, level)) throw new AiError("invalid_level", "无效的 AI 水平");
  const instruction = `${PROMPTS[level]}只依据提供的牌局事实决策，不假设对手风格或不可见信息。只输出 JSON，例如 {"action":"call"} 或 {"action":"raise","amount":10}。amount 是本轮总下注额，必须遵循 legal。`;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: JSON.stringify(agentContext(snapshot)) },
    ],
  };
  if (config.AI_THINKING) body.thinking = { type: config.AI_THINKING };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(7000),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") throw new AiError("model_timeout", "模型请求超时");
    throw new AiError("model_network_error", (err as Error).message);
  }

  let data: {
    choices?: { message?: { content?: unknown }; finish_reason?: string }[];
    usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    error?: { code?: string; message?: string };
  };
  try {
    data = await response.json();
  } catch {
    throw new AiError("model_invalid_json", "模型返回非 JSON", response.status);
  }
  if (!response.ok) throw new AiError(data.error?.code || "model_http_error", data.error?.message || `HTTP ${response.status}`, response.status);
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new AiError("model_empty_content", "模型返回空内容", response.status);
  if (!snapshot.legal) throw new AiError("invalid_game_context", "当前回合没有合法动作");
  let move: ActionInput;
  try {
    const reply = JSON.parse(content.match(/\{[^{}]*\}/)?.[0] ?? content);
    const allowed = {
      fold: snapshot.legal.canFold, check: snapshot.legal.canCheck, call: snapshot.legal.canCall,
      bet: snapshot.legal.canBet, raise: snapshot.legal.canRaise, allin: snapshot.legal.canAllIn,
    } as Record<string, boolean | undefined>;
    if (!allowed[reply.action]) throw new Error("illegal action");
    const legal = legalMove(reply, snapshot.legal);
    move = { type: legal.action, amount: legal.amount } as ActionInput;
  } catch {
    throw new AiError("model_invalid_action", "模型动作不是有效 JSON", response.status);
  }
  return {
    move,
    finishReason: data.choices?.[0]?.finish_reason,
    completionTokens: data.usage?.completion_tokens,
    reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
  };
}

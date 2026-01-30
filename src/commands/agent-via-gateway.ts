/**
 * Agent 命令实现 - Gateway 执行模式
 * 
 * 这个文件实现了通过 Gateway 执行 Agent 命令的功能。
 * Gateway 模式意味着 CLI 通过 WebSocket 连接到 Gateway，由 Gateway 执行 Agent。
 * 
 * 执行流程：
 * 1. 参数验证
 * 2. 解析会话 Key
 * 3. 通过 WebSocket 调用 Gateway 的 agent 方法
 * 4. 等待 Gateway 返回结果
 * 5. 格式化并输出结果
 * 
 * 与本地模式的区别：
 * - Gateway 模式：通过 WebSocket 连接，Gateway 负责执行
 * - 本地模式：直接在 CLI 进程中执行
 * 
 * 优势：
 * - Gateway 可以管理多个会话
 * - 支持远程访问
 * - 统一的执行环境
 * 
 * 学习重点：
 * - WebSocket 通信：如何通过 callGateway 调用 Gateway
 * - 协议格式：Gateway 协议的消息格式
 * - 错误处理：Gateway 失败时的回退机制
 */

// ==================== 导入模块 ====================

// 默认聊天渠道
import { DEFAULT_CHAT_CHANNEL } from "../channels/registry.js";

// CLI 依赖类型
import type { CliDeps } from "../cli/deps.js";

// 进度显示
import { withProgress } from "../cli/progress.js";

// 配置加载
import { loadConfig } from "../config/config.js";

// 会话解析
import { resolveSessionKeyForRequest } from "./agent/session.js";

// Gateway 调用
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";

// Agent 作用域
import { listAgentIds } from "../agents/agent-scope.js";
import { normalizeAgentId } from "../routing/session-key.js";

// 运行时环境
import type { RuntimeEnv } from "../runtime.js";

// CLI 命令格式化
import { formatCliCommand } from "../cli/command-format.js";

// 消息渠道
import {
  GATEWAY_CLIENT_MODES,      // Gateway 客户端模式常量
  GATEWAY_CLIENT_NAMES,       // Gateway 客户端名称常量
  normalizeMessageChannel,    // 规范化消息渠道
} from "../utils/message-channel.js";

// 本地 Agent 命令（用于回退）
import { agentCommand } from "./agent.js";

type AgentGatewayResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string | null;
    mediaUrls?: string[];
  }>;
  meta?: unknown;
};

type GatewayAgentResponse = {
  runId?: string;
  status?: string;
  summary?: string;
  result?: AgentGatewayResult;
};

export type AgentCliOpts = {
  message: string;
  agent?: string;
  to?: string;
  sessionId?: string;
  thinking?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  channel?: string;
  replyTo?: string;
  replyChannel?: string;
  replyAccount?: string;
  bestEffortDeliver?: boolean;
  lane?: string;
  runId?: string;
  extraSystemPrompt?: string;
  local?: boolean;
};

function parseTimeoutSeconds(opts: { cfg: ReturnType<typeof loadConfig>; timeout?: string }) {
  const raw =
    opts.timeout !== undefined
      ? Number.parseInt(String(opts.timeout), 10)
      : (opts.cfg.agents?.defaults?.timeoutSeconds ?? 600);
  if (Number.isNaN(raw) || raw <= 0) {
    throw new Error("--timeout must be a positive integer (seconds)");
  }
  return raw;
}

function formatPayloadForLog(payload: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string | null;
}) {
  const lines: string[] = [];
  if (payload.text) lines.push(payload.text.trimEnd());
  const mediaUrl =
    typeof payload.mediaUrl === "string" && payload.mediaUrl.trim()
      ? payload.mediaUrl.trim()
      : undefined;
  const media = payload.mediaUrls ?? (mediaUrl ? [mediaUrl] : []);
  for (const url of media) lines.push(`MEDIA:${url}`);
  return lines.join("\n").trimEnd();
}

/**
 * 通过 Gateway 执行 Agent 命令
 * 
 * 这个函数通过 WebSocket 连接到 Gateway，调用 Gateway 的 agent 方法来执行 Agent。
 * 
 * 参数：
 * - opts: AgentCliOpts - CLI 选项（消息、会话、模型等）
 * - runtime: RuntimeEnv - 运行时环境
 * 
 * 返回值：
 * - Promise<GatewayAgentResponse> - Gateway 返回的响应
 * 
 * 执行流程：
 * 1. 验证参数
 * 2. 加载配置
 * 3. 验证 Agent ID
 * 4. 解析会话 Key
 * 5. 调用 Gateway
 * 6. 格式化结果
 */
export async function agentViaGatewayCommand(opts: AgentCliOpts, runtime: RuntimeEnv) {
  /**
   * 步骤 1: 验证消息内容
   */
  const body = (opts.message ?? "").trim();
  if (!body) throw new Error("Message (--message) is required");
  
  /**
   * 步骤 2: 验证会话标识
   * 至少需要提供一个：to、sessionId 或 agent
   */
  if (!opts.to && !opts.sessionId && !opts.agent) {
    throw new Error("Pass --to <E.164>, --session-id, or --agent to choose a session");
  }

  /**
   * 步骤 3: 加载配置
   */
  const cfg = loadConfig();
  
  /**
   * 步骤 4: 验证和规范化 Agent ID
   */
  const agentIdRaw = opts.agent?.trim();
  const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
  if (agentId) {
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentId)) {
      throw new Error(
        `Unknown agent id "${agentIdRaw}". Use "${formatCliCommand("moltbot agents list")}" to see configured agents.`,
      );
    }
  }
  
  /**
   * 步骤 5: 解析超时时间
   * 
   * Gateway 的超时时间应该比 Agent 的超时时间稍长（+30秒），
   * 以确保 Gateway 有足够时间等待 Agent 完成
   */
  const timeoutSeconds = parseTimeoutSeconds({ cfg, timeout: opts.timeout });
  const gatewayTimeoutMs = Math.max(10_000, (timeoutSeconds + 30) * 1000);

  /**
   * 步骤 6: 解析会话 Key
   * 
   * 会话 Key 用于标识会话，格式通常是：agentId:sessionId
   */
  const sessionKey = resolveSessionKeyForRequest({
    cfg,
    agentId,
    to: opts.to,
    sessionId: opts.sessionId,
  }).sessionKey;

  /**
   * 步骤 7: 规范化消息渠道
   * 
   * 消息渠道指定消息发送到哪里（如 WhatsApp、Telegram 等）
   */
  const channel = normalizeMessageChannel(opts.channel) ?? DEFAULT_CHAT_CHANNEL;
  
  /**
   * 步骤 8: 生成幂等性 Key
   * 
   * 幂等性 Key 用于确保相同的请求不会被重复执行。
   * 如果用户提供了 runId，使用它；否则生成一个随机 UUID
   */
  const idempotencyKey = opts.runId?.trim() || randomIdempotencyKey();

  /**
   * 步骤 9: 调用 Gateway
   * 
   * 这是核心步骤，通过 WebSocket 调用 Gateway 的 agent 方法。
   * 
   * TypeScript/JavaScript 知识点：
   * - withProgress: 显示进度条（如果 enabled）
   * - callGateway<T>: 泛型函数，T 是返回值的类型
   * - async () => ...: 异步箭头函数
   * 
   * Gateway 协议：
   * - method: "agent" - 调用 agent 方法
   * - params: 方法参数
   * - expectFinal: true - 期望最终响应（不是流式）
   * - timeoutMs: 超时时间
   * - clientName/mode: 客户端标识
   */
  const response = await withProgress(
    {
      label: "Waiting for agent reply…",  // 进度条标签
      indeterminate: true,                 // 不确定进度（转圈）
      enabled: opts.json !== true,         // 如果输出 JSON，不显示进度条
    },
    async () =>
      await callGateway<GatewayAgentResponse>({
        method: "agent",                   // Gateway 方法名
        params: {
          message: body,                   // 用户消息
          agentId,                         // Agent ID
          to: opts.to,                     // 接收者
          replyTo: opts.replyTo,           // 回复对象
          sessionId: opts.sessionId,       // 会话 ID
          sessionKey,                      // 会话 Key
          thinking: opts.thinking,         // 思考级别
          deliver: Boolean(opts.deliver),  // 是否交付消息
          channel,                         // 消息渠道
          replyChannel: opts.replyChannel, // 回复渠道
          replyAccountId: opts.replyAccount, // 回复账户 ID
          timeout: timeoutSeconds,         // 超时时间（秒）
          lane: opts.lane,                 // 执行通道
          extraSystemPrompt: opts.extraSystemPrompt, // 额外的系统提示
          idempotencyKey,                  // 幂等性 Key
        },
        expectFinal: true,                 // 期望最终响应
        timeoutMs: gatewayTimeoutMs,       // 超时时间（毫秒）
        clientName: GATEWAY_CLIENT_NAMES.CLI, // 客户端名称
        mode: GATEWAY_CLIENT_MODES.CLI,    // 客户端模式
      }),
  );

  if (opts.json) {
    runtime.log(JSON.stringify(response, null, 2));
    return response;
  }

  const result = response?.result;
  const payloads = result?.payloads ?? [];

  if (payloads.length === 0) {
    runtime.log(response?.summary ? String(response.summary) : "No reply from agent.");
    return response;
  }

  for (const payload of payloads) {
    const out = formatPayloadForLog(payload);
    if (out) runtime.log(out);
  }

  return response;
}

/**
 * Agent CLI 命令的统一入口
 * 
 * 这个函数是 agent 命令的统一入口，它会：
 * 1. 如果指定了 --local，直接使用本地模式
 * 2. 否则，先尝试 Gateway 模式
 * 3. 如果 Gateway 失败，回退到本地模式
 * 
 * 这种设计的好处：
 * - 默认使用 Gateway（更强大，支持多会话）
 * - 如果 Gateway 不可用，自动回退到本地模式（更可靠）
 * - 用户可以通过 --local 强制使用本地模式（用于调试）
 * 
 * 参数：
 * - opts: AgentCliOpts - CLI 选项
 * - runtime: RuntimeEnv - 运行时环境
 * - deps: CliDeps - CLI 依赖（可选）
 * 
 * 返回值：
 * - Promise<...> - Agent 执行结果
 * 
 * TypeScript/JavaScript 知识点：
 * - ...opts: 展开运算符，复制对象的所有属性
 * - try/catch: 错误处理
 * - ?. 可选链：如果 runtime.error 存在才调用
 */
export async function agentCliCommand(opts: AgentCliOpts, runtime: RuntimeEnv, deps?: CliDeps) {
  /**
   * 准备本地模式的选项
   * 
   * 将 Gateway 模式的选项转换为本地模式的选项格式
   */
  const localOpts = {
    ...opts,                              // 复制所有选项
    agentId: opts.agent,                  // agent -> agentId
    replyAccountId: opts.replyAccount,    // replyAccount -> replyAccountId
  };
  
  /**
   * 如果指定了 --local，直接使用本地模式
   */
  if (opts.local === true) {
    return await agentCommand(localOpts, runtime, deps);
  }

  /**
   * 尝试 Gateway 模式，失败则回退到本地模式
   * 
   * 这种设计模式叫做"优雅降级"（Graceful Degradation）：
   * - 优先使用更强大的功能（Gateway）
   * - 如果失败，自动回退到基本功能（本地）
   * - 确保用户体验不受影响
   */
  try {
    // 尝试 Gateway 模式
    return await agentViaGatewayCommand(opts, runtime);
  } catch (err) {
    // Gateway 失败，记录错误并回退到本地模式
    // ?. 可选链：如果 runtime.error 存在才调用
    runtime.error?.(`Gateway agent failed; falling back to embedded: ${String(err)}`);
    return await agentCommand(localOpts, runtime, deps);
  }
}

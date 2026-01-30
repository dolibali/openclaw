/**
 * 会话解析模块
 * 
 * 这个文件负责解析和创建会话（session）。
 * 会话是 Agent 与用户之间的对话上下文。
 * 
 * 核心概念：
 * - Session ID: 会话的唯一标识符（如 "test1"）
 * - Session Key: 完整的会话标识符，包含 agent ID（如 "main:test1"）
 * - Session Entry: 会话的存储条目，包含历史、配置等
 * 
 * 会话的作用：
 * - 维护对话历史
 * - 存储会话配置（模型、思考级别等）
 * - 支持多会话隔离
 * 
 * 学习重点：
 * - 会话如何被创建和查找
 * - Session Key 的生成规则
 * - 会话的新鲜度检查
 * - 会话重置策略
 */

// ==================== 导入模块 ====================

// Node.js 内置模块
import crypto from "node:crypto";  // 用于生成 UUID

// 消息上下文类型
import type { MsgContext } from "../../auto-reply/templating.js";

// 思考级别和详细级别
import {
  normalizeThinkLevel,      // 规范化思考级别
  normalizeVerboseLevel,     // 规范化详细级别
  type ThinkLevel,           // 思考级别类型
  type VerboseLevel,         // 详细级别类型
} from "../../auto-reply/thinking.js";

// 配置类型
import type { MoltbotConfig } from "../../config/config.js";

// 会话存储相关
import {
  evaluateSessionFreshness,        // 评估会话新鲜度
  loadSessionStore,                 // 加载会话存储
  resolveAgentIdFromSessionKey,     // 从会话 Key 解析 agent ID
  resolveChannelResetConfig,        // 解析渠道重置配置
  resolveExplicitAgentSessionKey,   // 解析显式的 agent 会话 Key
  resolveSessionResetPolicy,        // 解析会话重置策略
  resolveSessionResetType,          // 解析会话重置类型
  resolveSessionKey,                // 解析会话 Key
  resolveStorePath,                 // 解析存储路径
  type SessionEntry,                // 会话条目类型
} from "../../config/sessions.js";

// 路由相关
import { normalizeMainKey } from "../../routing/session-key.js";

export type SessionResolution = {
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  storePath: string;
  isNewSession: boolean;
  persistedThinking?: ThinkLevel;
  persistedVerbose?: VerboseLevel;
};

type SessionKeyResolution = {
  sessionKey?: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
};

export function resolveSessionKeyForRequest(opts: {
  cfg: MoltbotConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionKeyResolution {
  const sessionCfg = opts.cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const explicitSessionKey =
    opts.sessionKey?.trim() ||
    resolveExplicitAgentSessionKey({
      cfg: opts.cfg,
      agentId: opts.agentId,
    });
  const storeAgentId = resolveAgentIdFromSessionKey(explicitSessionKey);
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: storeAgentId,
  });
  const sessionStore = loadSessionStore(storePath);

  const ctx: MsgContext | undefined = opts.to?.trim() ? { From: opts.to } : undefined;
  let sessionKey: string | undefined =
    explicitSessionKey ?? (ctx ? resolveSessionKey(scope, ctx, mainKey) : undefined);

  // If a session id was provided, prefer to re-use its entry (by id) even when no key was derived.
  if (
    !explicitSessionKey &&
    opts.sessionId &&
    (!sessionKey || sessionStore[sessionKey]?.sessionId !== opts.sessionId)
  ) {
    const foundKey = Object.keys(sessionStore).find(
      (key) => sessionStore[key]?.sessionId === opts.sessionId,
    );
    if (foundKey) sessionKey = foundKey;
  }

  return { sessionKey, sessionStore, storePath };
}

/**
 * 解析会话
 * 
 * 这是会话解析的核心函数，负责：
 * 1. 解析会话 Key
 * 2. 加载会话存储
 * 3. 检查会话新鲜度
 * 4. 决定是使用现有会话还是创建新会话
 * 5. 提取持久化的配置（思考级别、详细级别等）
 * 
 * 参数：
 * - opts.cfg: MoltbotConfig - 配置
 * - opts.to?: string - 接收者（如电话号码）
 * - opts.sessionId?: string - 会话 ID
 * - opts.sessionKey?: string - 会话 Key
 * - opts.agentId?: string - Agent ID
 * 
 * 返回值：
 * - SessionResolution - 会话解析结果
 *   - sessionId: 会话 ID
 *   - sessionKey: 会话 Key
 *   - sessionEntry: 会话条目（如果存在）
 *   - sessionStore: 会话存储对象
 *   - storePath: 存储文件路径
 *   - isNewSession: 是否是新会话
 *   - persistedThinking: 持久化的思考级别
 *   - persistedVerbose: 持久化的详细级别
 * 
 * 执行流程：
 * 1. 解析会话 Key（通过 resolveSessionKeyForRequest）
 * 2. 加载会话存储
 * 3. 获取会话条目（如果存在）
 * 4. 检查会话新鲜度（是否过期）
 * 5. 决定会话 ID（使用现有的或生成新的）
 * 6. 提取持久化配置
 */
export function resolveSession(opts: {
  cfg: MoltbotConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionResolution {
  /**
   * 步骤 1: 获取会话配置
   */
  const sessionCfg = opts.cfg.session;
  
  /**
   * 步骤 2: 解析会话 Key
   * 
   * 这会：
   * - 根据 to/sessionId/sessionKey/agentId 解析出会话 Key
   * - 加载会话存储
   * - 返回存储路径
   */
  const { sessionKey, sessionStore, storePath } = resolveSessionKeyForRequest({
    cfg: opts.cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    agentId: opts.agentId,
  });
  
  /**
   * 步骤 3: 获取当前时间
   * 
   * 用于检查会话是否过期
   */
  const now = Date.now();

  /**
   * 步骤 4: 获取会话条目
   * 
   * 如果会话 Key 存在，从存储中获取对应的条目
   */
  const sessionEntry = sessionKey ? sessionStore[sessionKey] : undefined;

  /**
   * 步骤 5: 解析会话重置策略
   * 
   * 会话可能会因为以下原因被重置：
   * - 时间过期（太久没有使用）
   * - 渠道变化（从 WhatsApp 切换到 Telegram）
   * - 手动重置（用户执行 /reset）
   */
  const resetType = resolveSessionResetType({ sessionKey });
  const channelReset = resolveChannelResetConfig({
    sessionCfg,
    channel: sessionEntry?.lastChannel ?? sessionEntry?.channel,
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    resetOverride: channelReset,
  });
  
  /**
   * 步骤 6: 评估会话新鲜度
   * 
   * 检查会话是否"新鲜"（未过期）。
   * 如果会话过期，会被视为新会话。
   */
  const fresh = sessionEntry
    ? evaluateSessionFreshness({ updatedAt: sessionEntry.updatedAt, now, policy: resetPolicy })
        .fresh
    : false;
  
  /**
   * 步骤 7: 确定会话 ID
   * 
   * 优先级：
   * 1. opts.sessionId（用户指定）
   * 2. sessionEntry.sessionId（如果会话新鲜）
   * 3. 生成新的 UUID
   */
  const sessionId =
    opts.sessionId?.trim() || (fresh ? sessionEntry?.sessionId : undefined) || crypto.randomUUID();
  
  /**
   * 步骤 8: 判断是否是新会话
   * 
   * 如果会话不新鲜且用户没有指定 sessionId，则是新会话
   */
  const isNewSession = !fresh && !opts.sessionId;

  /**
   * 步骤 9: 提取持久化的配置
   * 
   * 如果会话新鲜，从会话条目中提取之前保存的配置：
   * - thinkingLevel: 思考级别
   * - verboseLevel: 详细级别
   */
  const persistedThinking =
    fresh && sessionEntry?.thinkingLevel
      ? normalizeThinkLevel(sessionEntry.thinkingLevel)
      : undefined;
  const persistedVerbose =
    fresh && sessionEntry?.verboseLevel
      ? normalizeVerboseLevel(sessionEntry.verboseLevel)
      : undefined;

  /**
   * 步骤 10: 返回解析结果
   */
  return {
    sessionId,
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
  };
}

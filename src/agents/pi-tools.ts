/**
 * Pi Agent 工具定义和注册
 * 
 * 这个文件负责创建和注册所有可供 Agent 使用的工具。
 * 工具是 Agent 可以调用的函数，用于执行各种操作。
 * 
 * 工具类型：
 * 1. 文件操作：read, write, edit
 * 2. 命令执行：exec, process
 * 3. 渠道操作：send, list 等
 * 4. Moltbot 工具：sessions, agents, gateway 等
 * 5. 插件工具：来自扩展的工具
 * 
 * 工具注册流程：
 * 1. 创建工具定义（schema + handler）
 * 2. 应用策略过滤（允许/拒绝）
 * 3. 规范化工具参数
 * 4. 注册到 Pi Agent
 * 
 * 学习重点：
 * - 工具如何被定义（JSON Schema）
 * - 工具如何被注册到 Agent
 * - 工具调用的执行流程
 * - 工具策略和安全边界
 */

// ==================== 导入模块 ====================

// Pi Coding Agent 的基础工具
import {
  codingTools,          // 编码工具集合
  createEditTool,       // 创建编辑工具
  createReadTool,       // 创建读取工具
  createWriteTool,      // 创建写入工具
  readTool,             // 读取工具
} from "@mariozechner/pi-coding-agent";

// 配置类型
import type { MoltbotConfig } from "../config/config.js";

// 路由相关
import { isSubagentSessionKey } from "../routing/session-key.js";

// 消息渠道
import { resolveGatewayMessageChannel } from "../utils/message-channel.js";

// 补丁应用工具
import { createApplyPatchTool } from "./apply-patch.js";

// Bash 工具（命令执行）
import {
  createExecTool,              // 创建执行工具
  createProcessTool,            // 创建进程工具
  type ExecToolDefaults,       // 执行工具默认配置类型
  type ProcessToolDefaults,    // 进程工具默认配置类型
} from "./bash-tools.js";

// 渠道工具
import { listChannelAgentTools } from "./channel-tools.js";

// Moltbot 工具
import { createMoltbotTools } from "./moltbot-tools.js";

// 模型认证模式
import type { ModelAuthMode } from "./model-auth.js";

// 工具中止信号
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";

// 工具策略
import {
  filterToolsByPolicy,          // 根据策略过滤工具
  isToolAllowedByPolicies,       // 检查工具是否被策略允许
  resolveEffectiveToolPolicy,   // 解析有效工具策略
  resolveGroupToolPolicy,        // 解析群组工具策略
  resolveSubagentToolPolicy,     // 解析子 Agent 工具策略
} from "./pi-tools.policy.js";

// 工具参数处理
import {
  assertRequiredParams,          // 断言必需参数
  CLAUDE_PARAM_GROUPS,          // Claude 参数组
  createMoltbotReadTool,        // 创建 Moltbot 读取工具
  createSandboxedEditTool,      // 创建沙箱编辑工具
  createSandboxedReadTool,       // 创建沙箱读取工具
  createSandboxedWriteTool,     // 创建沙箱写入工具
  normalizeToolParams,          // 规范化工具参数
  patchToolSchemaForClaudeCompatibility, // 为 Claude 兼容性修补工具 schema
  wrapToolParamNormalization,   // 包装工具参数规范化
} from "./pi-tools.read.js";

// 工具 Schema 处理
import { cleanToolSchemaForGemini, normalizeToolParameters } from "./pi-tools.schema.js";

// 工具类型
import type { AnyAgentTool } from "./pi-tools.types.js";

// 沙箱上下文
import type { SandboxContext } from "./sandbox.js";

// 工具策略
import {
  buildPluginToolGroups,        // 构建插件工具组
  collectExplicitAllowlist,     // 收集显式允许列表
  expandPolicyWithPluginGroups, // 扩展策略（包含插件组）
  normalizeToolName,            // 规范化工具名称
  resolveToolProfilePolicy,     // 解析工具配置文件策略
  stripPluginOnlyAllowlist,     // 移除仅插件允许列表
} from "./tool-policy.js";

// 插件工具
import { getPluginToolMeta } from "../plugins/tools.js";

// 日志
import { logWarn } from "../logger.js";

function isOpenAIProvider(provider?: string) {
  const normalized = provider?.trim().toLowerCase();
  return normalized === "openai" || normalized === "openai-codex";
}

function isApplyPatchAllowedForModel(params: {
  modelProvider?: string;
  modelId?: string;
  allowModels?: string[];
}) {
  const allowModels = Array.isArray(params.allowModels) ? params.allowModels : [];
  if (allowModels.length === 0) return true;
  const modelId = params.modelId?.trim();
  if (!modelId) return false;
  const normalizedModelId = modelId.toLowerCase();
  const provider = params.modelProvider?.trim().toLowerCase();
  const normalizedFull =
    provider && !normalizedModelId.includes("/")
      ? `${provider}/${normalizedModelId}`
      : normalizedModelId;
  return allowModels.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) return false;
    return normalized === normalizedModelId || normalized === normalizedFull;
  });
}

function resolveExecConfig(cfg: MoltbotConfig | undefined) {
  const globalExec = cfg?.tools?.exec;
  return {
    host: globalExec?.host,
    security: globalExec?.security,
    ask: globalExec?.ask,
    node: globalExec?.node,
    pathPrepend: globalExec?.pathPrepend,
    safeBins: globalExec?.safeBins,
    backgroundMs: globalExec?.backgroundMs,
    timeoutSec: globalExec?.timeoutSec,
    approvalRunningNoticeMs: globalExec?.approvalRunningNoticeMs,
    cleanupMs: globalExec?.cleanupMs,
    notifyOnExit: globalExec?.notifyOnExit,
    applyPatch: globalExec?.applyPatch,
  };
}

export const __testing = {
  cleanToolSchemaForGemini,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapToolParamNormalization,
  assertRequiredParams,
} as const;

/**
 * 创建 Moltbot 编码工具集合
 * 
 * 这是工具系统的核心函数，负责创建所有可供 Agent 使用的工具。
 * 
 * 工具创建流程：
 * 1. 解析工具策略（全局、agent、群组、配置文件）
 * 2. 创建基础工具（read, write, edit, exec 等）
 * 3. 创建渠道工具（send, list 等）
 * 4. 创建 Moltbot 工具（sessions, agents 等）
 * 5. 加载插件工具
 * 6. 应用策略过滤
 * 7. 规范化工具参数
 * 8. 返回工具列表
 * 
 * 参数：
 * - options: 工具创建选项
 *   - exec: 执行工具配置
 *   - sandbox: 沙箱上下文（用于隔离执行）
 *   - sessionKey: 会话 Key
 *   - workspaceDir: 工作空间目录
 *   - config: 配置
 *   - modelProvider/modelId: 当前模型信息（用于工具兼容性）
 *   - 等等
 * 
 * 返回值：
 * - AnyAgentTool[]: 工具数组，每个工具包含：
 *   - name: 工具名称
 *   - description: 工具描述
 *   - inputSchema: 输入参数 schema（JSON Schema）
 *   - handler: 工具处理函数
 * 
 * TypeScript/JavaScript 知识点：
 * - ?: 可选属性
 * - | 联合类型（如 "off" | "first" | "all"）
 * - & 交叉类型（如 ExecToolDefaults & ProcessToolDefaults）
 * - []: 数组类型
 */
export function createMoltbotCodingTools(options?: {
  exec?: ExecToolDefaults & ProcessToolDefaults;  // 执行工具配置
  messageProvider?: string;                       // 消息提供者
  agentAccountId?: string;                       // Agent 账户 ID
  messageTo?: string;                            // 消息接收者
  messageThreadId?: string | number;             // 消息线程 ID
  sandbox?: SandboxContext | null;               // 沙箱上下文
  sessionKey?: string;                           // 会话 Key
  agentDir?: string;                              // Agent 目录
  workspaceDir?: string;                           // 工作空间目录
  config?: MoltbotConfig;                        // 配置
  abortSignal?: AbortSignal;                     // 中止信号
  /**
   * 当前选择的模型提供者（用于提供者特定的工具兼容性处理）
   * 例如："anthropic", "openai", "google", "openai-codex"
   */
  modelProvider?: string;
  /** 当前提供者的模型 ID（用于模型特定的工具门控） */
  modelId?: string;
  /**
   * 当前提供者的认证模式。主要用于 Anthropic OAuth 的工具名称阻止兼容性问题
   */
  modelAuthMode?: ModelAuthMode;
  /** 当前渠道 ID（用于 Slack 自动线程） */
  currentChannelId?: string;
  /** 当前线程时间戳（用于 Slack 自动线程） */
  currentThreadTs?: string;
  /** 群组 ID（用于渠道级别的工具策略解析） */
  groupId?: string | null;
  /** 群组渠道标签（例如 #general，用于渠道级别的工具策略解析） */
  groupChannel?: string | null;
  /** 群组空间标签（例如 guild/team id，用于渠道级别的工具策略解析） */
  groupSpace?: string | null;
  /** 父会话 Key（用于子 Agent 群组策略继承） */
  spawnedBy?: string | null;
  senderId?: string | null;                      // 发送者 ID
  senderName?: string | null;                    // 发送者名称
  senderUsername?: string | null;               // 发送者用户名
  senderE164?: string | null;                    // 发送者 E.164 号码
  /** 回复模式（用于 Slack 自动线程） */
  replyToMode?: "off" | "first" | "all";
  /** 可变引用，用于跟踪是否已发送回复（用于 "first" 模式） */
  hasRepliedRef?: { value: boolean };
  /** 如果为 true，模型具有原生视觉能力 */
  modelHasVision?: boolean;
}): AnyAgentTool[] {
  /**
   * 步骤 1: 确定执行工具名称和沙箱
   */
  const execToolName = "exec";
  const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined;
  
  /**
   * 步骤 2: 解析有效工具策略
   * 
   * 工具策略决定哪些工具可以被使用。
   * 策略层次（从高到低）：
   * 1. 全局策略（config.tools.policy）
   * 2. Agent 策略（config.agents.defaults.tools.policy）
   * 3. 群组策略（config.channels.*.tools.policy）
   * 4. 配置文件策略（profile）
   * 
   * 策略类型：
   * - allowlist: 只允许列表中的工具
   * - denylist: 禁止列表中的工具
   * - 默认：允许所有工具
   */
  const {
    agentId,                    // Agent ID
    globalPolicy,               // 全局策略
    globalProviderPolicy,       // 全局提供者策略
    agentPolicy,                // Agent 策略
    agentProviderPolicy,         // Agent 提供者策略
    profile,                    // 配置文件策略
    providerProfile,            // 提供者配置文件策略
    profileAlsoAllow,           // 配置文件额外允许
    providerProfileAlsoAllow,   // 提供者配置文件额外允许
  } = resolveEffectiveToolPolicy({
    config: options?.config,
    sessionKey: options?.sessionKey,
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
  });
  
  /**
   * 步骤 3: 解析群组工具策略
   * 
   * 群组策略用于在群组聊天中限制工具使用。
   * 例如：在 Discord 群组中，可能只允许某些工具。
   */
  const groupPolicy = resolveGroupToolPolicy({
    config: options?.config,
    sessionKey: options?.sessionKey,
    spawnedBy: options?.spawnedBy,
    messageProvider: options?.messageProvider,
    groupId: options?.groupId,
    groupChannel: options?.groupChannel,
    groupSpace: options?.groupSpace,
    accountId: options?.agentAccountId,
    senderId: options?.senderId,
    senderName: options?.senderName,
    senderUsername: options?.senderUsername,
    senderE164: options?.senderE164,
  });
  
  /**
   * 步骤 4: 解析配置文件工具策略
   */
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);

  const mergeAlsoAllow = (policy: typeof profilePolicy, alsoAllow?: string[]) => {
    if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) return policy;
    return { ...policy, allow: Array.from(new Set([...policy.allow, ...alsoAllow])) };
  };

  const profilePolicyWithAlsoAllow = mergeAlsoAllow(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllow(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const scopeKey = options?.exec?.scopeKey ?? (agentId ? `agent:${agentId}` : undefined);
  const subagentPolicy =
    isSubagentSessionKey(options?.sessionKey) && options?.sessionKey
      ? resolveSubagentToolPolicy(options.config)
      : undefined;
  const allowBackground = isToolAllowedByPolicies("process", [
    profilePolicyWithAlsoAllow,
    providerProfilePolicyWithAlsoAllow,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    sandbox?.tools,
    subagentPolicy,
  ]);
  const execConfig = resolveExecConfig(options?.config);
  const sandboxRoot = sandbox?.workspaceDir;
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
  const workspaceRoot = options?.workspaceDir ?? process.cwd();
  const applyPatchConfig = options?.config?.tools?.exec?.applyPatch;
  const applyPatchEnabled =
    !!applyPatchConfig?.enabled &&
    isOpenAIProvider(options?.modelProvider) &&
    isApplyPatchAllowedForModel({
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
      allowModels: applyPatchConfig?.allowModels,
    });

  const base = (codingTools as unknown as AnyAgentTool[]).flatMap((tool) => {
    if (tool.name === readTool.name) {
      if (sandboxRoot) {
        return [createSandboxedReadTool(sandboxRoot)];
      }
      const freshReadTool = createReadTool(workspaceRoot);
      return [createMoltbotReadTool(freshReadTool)];
    }
    if (tool.name === "bash" || tool.name === execToolName) return [];
    if (tool.name === "write") {
      if (sandboxRoot) return [];
      // Wrap with param normalization for Claude Code compatibility
      return [
        wrapToolParamNormalization(createWriteTool(workspaceRoot), CLAUDE_PARAM_GROUPS.write),
      ];
    }
    if (tool.name === "edit") {
      if (sandboxRoot) return [];
      // Wrap with param normalization for Claude Code compatibility
      return [wrapToolParamNormalization(createEditTool(workspaceRoot), CLAUDE_PARAM_GROUPS.edit)];
    }
    return [tool as AnyAgentTool];
  });
  const { cleanupMs: cleanupMsOverride, ...execDefaults } = options?.exec ?? {};
  const execTool = createExecTool({
    ...execDefaults,
    host: options?.exec?.host ?? execConfig.host,
    security: options?.exec?.security ?? execConfig.security,
    ask: options?.exec?.ask ?? execConfig.ask,
    node: options?.exec?.node ?? execConfig.node,
    pathPrepend: options?.exec?.pathPrepend ?? execConfig.pathPrepend,
    safeBins: options?.exec?.safeBins ?? execConfig.safeBins,
    agentId,
    cwd: options?.workspaceDir,
    allowBackground,
    scopeKey,
    sessionKey: options?.sessionKey,
    messageProvider: options?.messageProvider,
    backgroundMs: options?.exec?.backgroundMs ?? execConfig.backgroundMs,
    timeoutSec: options?.exec?.timeoutSec ?? execConfig.timeoutSec,
    approvalRunningNoticeMs:
      options?.exec?.approvalRunningNoticeMs ?? execConfig.approvalRunningNoticeMs,
    notifyOnExit: options?.exec?.notifyOnExit ?? execConfig.notifyOnExit,
    sandbox: sandbox
      ? {
          containerName: sandbox.containerName,
          workspaceDir: sandbox.workspaceDir,
          containerWorkdir: sandbox.containerWorkdir,
          env: sandbox.docker.env,
        }
      : undefined,
  });
  const processTool = createProcessTool({
    cleanupMs: cleanupMsOverride ?? execConfig.cleanupMs,
    scopeKey,
  });
  const applyPatchTool =
    !applyPatchEnabled || (sandboxRoot && !allowWorkspaceWrites)
      ? null
      : createApplyPatchTool({
          cwd: sandboxRoot ?? workspaceRoot,
          sandboxRoot: sandboxRoot && allowWorkspaceWrites ? sandboxRoot : undefined,
        });
  const tools: AnyAgentTool[] = [
    ...base,
    ...(sandboxRoot
      ? allowWorkspaceWrites
        ? [createSandboxedEditTool(sandboxRoot), createSandboxedWriteTool(sandboxRoot)]
        : []
      : []),
    ...(applyPatchTool ? [applyPatchTool as unknown as AnyAgentTool] : []),
    execTool as unknown as AnyAgentTool,
    processTool as unknown as AnyAgentTool,
    // Channel docking: include channel-defined agent tools (login, etc.).
    ...listChannelAgentTools({ cfg: options?.config }),
    ...createMoltbotTools({
      sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
      allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
      agentSessionKey: options?.sessionKey,
      agentChannel: resolveGatewayMessageChannel(options?.messageProvider),
      agentAccountId: options?.agentAccountId,
      agentTo: options?.messageTo,
      agentThreadId: options?.messageThreadId,
      agentGroupId: options?.groupId ?? null,
      agentGroupChannel: options?.groupChannel ?? null,
      agentGroupSpace: options?.groupSpace ?? null,
      agentDir: options?.agentDir,
      sandboxRoot,
      workspaceDir: options?.workspaceDir,
      sandboxed: !!sandbox,
      config: options?.config,
      pluginToolAllowlist: collectExplicitAllowlist([
        profilePolicy,
        providerProfilePolicy,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        sandbox?.tools,
        subagentPolicy,
      ]),
      currentChannelId: options?.currentChannelId,
      currentThreadTs: options?.currentThreadTs,
      replyToMode: options?.replyToMode,
      hasRepliedRef: options?.hasRepliedRef,
      modelHasVision: options?.modelHasVision,
      requesterAgentIdOverride: agentId,
    }),
  ];
  const coreToolNames = new Set(
    tools
      .filter((tool) => !getPluginToolMeta(tool as AnyAgentTool))
      .map((tool) => normalizeToolName(tool.name))
      .filter(Boolean),
  );
  const pluginGroups = buildPluginToolGroups({
    tools,
    toolMeta: (tool) => getPluginToolMeta(tool as AnyAgentTool),
  });
  const resolvePolicy = (policy: typeof profilePolicy, label: string) => {
    const resolved = stripPluginOnlyAllowlist(policy, pluginGroups, coreToolNames);
    if (resolved.unknownAllowlist.length > 0) {
      const entries = resolved.unknownAllowlist.join(", ");
      const suffix = resolved.strippedAllowlist
        ? "Ignoring allowlist so core tools remain available. Use tools.alsoAllow for additive plugin tool enablement."
        : "These entries won't match any tool unless the plugin is enabled.";
      logWarn(`tools: ${label} allowlist contains unknown entries (${entries}). ${suffix}`);
    }
    return expandPolicyWithPluginGroups(resolved.policy, pluginGroups);
  };
  const profilePolicyExpanded = resolvePolicy(
    profilePolicyWithAlsoAllow,
    profile ? `tools.profile (${profile})` : "tools.profile",
  );
  const providerProfileExpanded = resolvePolicy(
    providerProfilePolicyWithAlsoAllow,
    providerProfile ? `tools.byProvider.profile (${providerProfile})` : "tools.byProvider.profile",
  );
  const globalPolicyExpanded = resolvePolicy(globalPolicy, "tools.allow");
  const globalProviderExpanded = resolvePolicy(globalProviderPolicy, "tools.byProvider.allow");
  const agentPolicyExpanded = resolvePolicy(
    agentPolicy,
    agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
  );
  const agentProviderExpanded = resolvePolicy(
    agentProviderPolicy,
    agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
  );
  const groupPolicyExpanded = resolvePolicy(groupPolicy, "group tools.allow");
  const sandboxPolicyExpanded = expandPolicyWithPluginGroups(sandbox?.tools, pluginGroups);
  const subagentPolicyExpanded = expandPolicyWithPluginGroups(subagentPolicy, pluginGroups);

  const toolsFiltered = profilePolicyExpanded
    ? filterToolsByPolicy(tools, profilePolicyExpanded)
    : tools;
  const providerProfileFiltered = providerProfileExpanded
    ? filterToolsByPolicy(toolsFiltered, providerProfileExpanded)
    : toolsFiltered;
  const globalFiltered = globalPolicyExpanded
    ? filterToolsByPolicy(providerProfileFiltered, globalPolicyExpanded)
    : providerProfileFiltered;
  const globalProviderFiltered = globalProviderExpanded
    ? filterToolsByPolicy(globalFiltered, globalProviderExpanded)
    : globalFiltered;
  const agentFiltered = agentPolicyExpanded
    ? filterToolsByPolicy(globalProviderFiltered, agentPolicyExpanded)
    : globalProviderFiltered;
  const agentProviderFiltered = agentProviderExpanded
    ? filterToolsByPolicy(agentFiltered, agentProviderExpanded)
    : agentFiltered;
  const groupFiltered = groupPolicyExpanded
    ? filterToolsByPolicy(agentProviderFiltered, groupPolicyExpanded)
    : agentProviderFiltered;
  const sandboxed = sandboxPolicyExpanded
    ? filterToolsByPolicy(groupFiltered, sandboxPolicyExpanded)
    : groupFiltered;
  const subagentFiltered = subagentPolicyExpanded
    ? filterToolsByPolicy(sandboxed, subagentPolicyExpanded)
    : sandboxed;
  // Always normalize tool JSON Schemas before handing them to pi-agent/pi-ai.
  // Without this, some providers (notably OpenAI) will reject root-level union schemas.
  const normalized = subagentFiltered.map(normalizeToolParameters);
  const withAbort = options?.abortSignal
    ? normalized.map((tool) => wrapToolWithAbortSignal(tool, options.abortSignal))
    : normalized;

  // NOTE: Keep canonical (lowercase) tool names here.
  // pi-ai's Anthropic OAuth transport remaps tool names to Claude Code-style names
  // on the wire and maps them back for tool dispatch.
  return withAbort;
}

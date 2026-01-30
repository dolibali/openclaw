/**
 * Agent 命令实现 - 本地执行模式
 * 
 * 这个文件实现了 `moltbot agent` 命令的本地执行模式。
 * 本地执行意味着直接在 CLI 进程中运行 Pi Agent，不通过 Gateway。
 * 
 * 执行流程：
 * 1. 参数验证和解析
 * 2. 加载配置
 * 3. 解析会话（session）
 * 4. 准备 Agent 工作空间
 * 5. 选择模型和认证配置
 * 6. 运行 Agent（支持模型回退）
 * 7. 更新会话存储
 * 8. 交付结果
 * 
 * 与 Gateway 模式的区别：
 * - 本地模式：直接在 CLI 进程中运行，适合调试和开发
 * - Gateway 模式：通过 WebSocket 连接到 Gateway，由 Gateway 执行
 * 
 * 学习重点：
 * - 会话管理：如何解析和创建会话
 * - 模型选择：如何选择模型和处理回退
 * - Agent 运行：如何启动和运行 Pi Agent
 * - 工具调用：Agent 如何调用工具
 */

// ==================== 导入模块 ====================

// Agent 作用域相关（agent ID、目录、工作空间等）
import {
  listAgentIds,                          // 列出所有配置的 agent ID
  resolveAgentDir,                       // 解析 agent 目录路径
  resolveAgentModelFallbacksOverride,    // 解析 agent 的模型回退覆盖
  resolveAgentModelPrimary,              // 解析 agent 的主模型
  resolveAgentWorkspaceDir,             // 解析 agent 工作空间目录
} from "../agents/agent-scope.js";

// 认证配置相关
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";

// CLI 后端运行器（用于本地 CLI 后端，如 Claude CLI）
import { runCliAgent } from "../agents/cli-runner.js";
import { getCliSessionId } from "../agents/cli-session.js";

// 默认配置
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";

// 模型目录和选择
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runWithModelFallback } from "../agents/model-fallback.js";
import {
  buildAllowedModelSet,                 // 构建允许的模型集合
  isCliProvider,                        // 检查是否是 CLI 后端提供者
  modelKey,                             // 生成模型键（provider/model）
  resolveConfiguredModelRef,            // 解析配置的模型引用
  resolveThinkingDefault,                // 解析默认的思考级别
} from "../agents/model-selection.js";

// 嵌入式 Pi Agent 运行器
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";

// Skills（技能）相关
import { buildWorkspaceSkillSnapshot } from "../agents/skills.js";
import { getSkillsSnapshotVersion } from "../agents/skills/refresh.js";

// 超时配置
import { resolveAgentTimeoutMs } from "../agents/timeout.js";

// 工作空间管理
import { ensureAgentWorkspace } from "../agents/workspace.js";

// 思考级别和详细级别
import {
  formatThinkingLevels,                 // 格式化思考级别提示
  formatXHighModelHint,                 // 格式化 xhigh 模型提示
  normalizeThinkLevel,                  // 规范化思考级别
  normalizeVerboseLevel,                // 规范化详细级别
  supportsXHighThinking,                 // 检查是否支持 xhigh 思考级别
  type ThinkLevel,                      // 思考级别类型
  type VerboseLevel,                    // 详细级别类型
} from "../auto-reply/thinking.js";

// CLI 依赖
import { type CliDeps, createDefaultDeps } from "../cli/deps.js";

// 配置加载
import { loadConfig } from "../config/config.js";

// 会话管理
import {
  resolveAgentIdFromSessionKey,         // 从会话 Key 解析 agent ID
  resolveSessionFilePath,                // 解析会话文件路径
  type SessionEntry,                    // 会话条目类型
  updateSessionStore,                   // 更新会话存储
} from "../config/sessions.js";

// Agent 事件
import {
  clearAgentRunContext,                 // 清除 agent 运行上下文
  emitAgentEvent,                       // 发送 agent 事件
  registerAgentRunContext,               // 注册 agent 运行上下文
} from "../infra/agent-events.js";

// 远程技能资格
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";

// 运行时环境
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

// CLI 命令格式化
import { formatCliCommand } from "../cli/command-format.js";

// 会话级别覆盖
import { applyVerboseOverride } from "../sessions/level-overrides.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { clearSessionAuthProfileOverride } from "../agents/auth-profiles/session-override.js";

// 消息渠道
import { resolveMessageChannel } from "../utils/message-channel.js";

// Agent 命令相关
import { deliverAgentCommandResult } from "./agent/delivery.js";
import { resolveAgentRunContext } from "./agent/run-context.js";
import { resolveSession } from "./agent/session.js";
import { updateSessionStoreAfterAgentRun } from "./agent/session-store.js";
import type { AgentCommandOpts } from "./agent/types.js";
import { normalizeAgentId } from "../routing/session-key.js";

/**
 * Agent 命令主函数 - 本地执行模式
 * 
 * 这是 `moltbot agent` 命令的核心实现，负责在本地进程中运行 Agent。
 * 
 * 参数：
 * - opts: AgentCommandOpts - 命令选项（消息、会话、模型等）
 * - runtime: RuntimeEnv - 运行时环境（默认使用 defaultRuntime）
 * - deps: CliDeps - CLI 依赖（默认使用 createDefaultDeps()）
 * 
 * 返回值：
 * - Promise<...> - 返回 Agent 执行结果
 * 
 * TypeScript/JavaScript 知识点：
 * - async function: 异步函数，可以使用 await
 * - 默认参数: = defaultRuntime 表示如果没有提供，使用默认值
 * - 类型注解: : RuntimeEnv 表示参数类型
 * 
 * 执行流程概览：
 * 1. 验证参数（消息、会话标识）
 * 2. 加载配置
 * 3. 验证和规范化 agent ID
 * 4. 准备工作空间
 * 5. 解析会话
 * 6. 选择模型和认证配置
 * 7. 运行 Agent（支持回退）
 * 8. 更新会话存储
 * 9. 交付结果
 */
export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  /**
   * 步骤 1: 验证和提取消息内容
   * 
   * TypeScript/JavaScript 知识点：
   * - ?? 空值合并运算符：如果左边是 null 或 undefined，使用右边
   * - trim(): 去除首尾空格
   * - throw new Error(): 抛出错误，中断执行
   */
  const body = (opts.message ?? "").trim();
  if (!body) throw new Error("Message (--message) is required");
  
  /**
   * 步骤 2: 验证会话标识
   * 
   * 会话可以通过以下方式指定：
   * - to: 接收者（如电话号码）
   * - sessionId: 会话 ID
   * - sessionKey: 会话 Key（包含 agent ID）
   * - agentId: Agent ID（会创建新会话）
   * 
   * 至少需要提供一个，否则无法确定使用哪个会话
   */
  if (!opts.to && !opts.sessionId && !opts.sessionKey && !opts.agentId) {
    throw new Error("Pass --to <E.164>, --session-id, or --agent to choose a session");
  }

  /**
   * 步骤 3: 加载配置
   * 
   * 配置包含：
   * - agents: Agent 配置（模型、超时、工作空间等）
   * - session: 会话配置
   * - gateway: Gateway 配置
   * - 等等
   */
  const cfg = loadConfig();
  
  /**
   * 步骤 4: 验证和规范化 Agent ID
   * 
   * Agent ID 用于标识不同的 Agent 实例。
   * 例如：main、dev、test 等
   * 
   * TypeScript/JavaScript 知识点：
   * - ?. 可选链运算符：如果左边是 null/undefined，返回 undefined，不继续访问
   * - 三元运算符：condition ? value1 : value2
   */
  const agentIdOverrideRaw = opts.agentId?.trim();
  const agentIdOverride = agentIdOverrideRaw ? normalizeAgentId(agentIdOverrideRaw) : undefined;
  
  // 如果指定了 agent ID，验证它是否存在
  if (agentIdOverride) {
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentIdOverride)) {
      throw new Error(
        `Unknown agent id "${agentIdOverrideRaw}". Use "${formatCliCommand("moltbot agents list")}" to see configured agents.`,
      );
    }
  }
  
  // 如果同时指定了 agent ID 和 sessionKey，验证它们是否匹配
  if (agentIdOverride && opts.sessionKey) {
    const sessionAgentId = resolveAgentIdFromSessionKey(opts.sessionKey);
    if (sessionAgentId !== agentIdOverride) {
      throw new Error(
        `Agent id "${agentIdOverrideRaw}" does not match session key agent "${sessionAgentId}".`,
      );
    }
  }
  
  /**
   * 步骤 5: 解析 Agent 配置和路径
   * 
   * - agentCfg: Agent 的默认配置
   * - sessionAgentId: 确定使用的 agent ID（可能是覆盖的或从 sessionKey 解析的）
   * - workspaceDirRaw: Agent 工作空间目录（源代码、文件等）
   * - agentDir: Agent 配置目录（配置文件、认证等）
   */
  const agentCfg = cfg.agents?.defaults;
  const sessionAgentId = agentIdOverride ?? resolveAgentIdFromSessionKey(opts.sessionKey?.trim());
  const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, sessionAgentId);
  const agentDir = resolveAgentDir(cfg, sessionAgentId);
  
  /**
   * 步骤 6: 确保 Agent 工作空间存在
   * 
   * 工作空间包含：
   * - AGENTS.md: Agent 系统提示
   * - TOOLS.md: 工具文档
   * - SOUL.md: Agent 个性定义
   * - skills/: 技能目录
   * 
   * TypeScript/JavaScript 知识点：
   * - await: 等待异步操作完成
   * - ! 逻辑非运算符
   */
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,  // 如果配置了 skipBootstrap，不创建引导文件
  });
  const workspaceDir = workspace.dir;
  const configuredModel = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const thinkingLevelsHint = formatThinkingLevels(configuredModel.provider, configuredModel.model);

  const thinkOverride = normalizeThinkLevel(opts.thinking);
  const thinkOnce = normalizeThinkLevel(opts.thinkingOnce);
  if (opts.thinking && !thinkOverride) {
    throw new Error(`Invalid thinking level. Use one of: ${thinkingLevelsHint}.`);
  }
  if (opts.thinkingOnce && !thinkOnce) {
    throw new Error(`Invalid one-shot thinking level. Use one of: ${thinkingLevelsHint}.`);
  }

  const verboseOverride = normalizeVerboseLevel(opts.verbose);
  if (opts.verbose && !verboseOverride) {
    throw new Error('Invalid verbose level. Use "on", "full", or "off".');
  }

  const timeoutSecondsRaw =
    opts.timeout !== undefined ? Number.parseInt(String(opts.timeout), 10) : undefined;
  if (
    timeoutSecondsRaw !== undefined &&
    (Number.isNaN(timeoutSecondsRaw) || timeoutSecondsRaw <= 0)
  ) {
    throw new Error("--timeout must be a positive integer (seconds)");
  }
  const timeoutMs = resolveAgentTimeoutMs({
    cfg,
    overrideSeconds: timeoutSecondsRaw,
  });

  const sessionResolution = resolveSession({
    cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    agentId: agentIdOverride,
  });

  const {
    sessionId,
    sessionKey,
    sessionEntry: resolvedSessionEntry,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
  } = sessionResolution;
  let sessionEntry = resolvedSessionEntry;
  const runId = opts.runId?.trim() || sessionId;

  try {
    if (opts.deliver === true) {
      const sendPolicy = resolveSendPolicy({
        cfg,
        entry: sessionEntry,
        sessionKey,
        channel: sessionEntry?.channel,
        chatType: sessionEntry?.chatType,
      });
      if (sendPolicy === "deny") {
        throw new Error("send blocked by session policy");
      }
    }

    let resolvedThinkLevel =
      thinkOnce ??
      thinkOverride ??
      persistedThinking ??
      (agentCfg?.thinkingDefault as ThinkLevel | undefined);
    const resolvedVerboseLevel =
      verboseOverride ?? persistedVerbose ?? (agentCfg?.verboseDefault as VerboseLevel | undefined);

    if (sessionKey) {
      registerAgentRunContext(runId, {
        sessionKey,
        verboseLevel: resolvedVerboseLevel,
      });
    }

    const needsSkillsSnapshot = isNewSession || !sessionEntry?.skillsSnapshot;
    const skillsSnapshotVersion = getSkillsSnapshotVersion(workspaceDir);
    const skillsSnapshot = needsSkillsSnapshot
      ? buildWorkspaceSkillSnapshot(workspaceDir, {
          config: cfg,
          eligibility: { remote: getRemoteSkillEligibility() },
          snapshotVersion: skillsSnapshotVersion,
        })
      : sessionEntry?.skillsSnapshot;

    if (skillsSnapshot && sessionStore && sessionKey && needsSkillsSnapshot) {
      const current = sessionEntry ?? {
        sessionId,
        updatedAt: Date.now(),
      };
      const next: SessionEntry = {
        ...current,
        sessionId,
        updatedAt: Date.now(),
        skillsSnapshot,
      };
      sessionStore[sessionKey] = next;
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = next;
      });
      sessionEntry = next;
    }

    // Persist explicit /command overrides to the session store when we have a key.
    if (sessionStore && sessionKey) {
      const entry = sessionStore[sessionKey] ??
        sessionEntry ?? { sessionId, updatedAt: Date.now() };
      const next: SessionEntry = { ...entry, sessionId, updatedAt: Date.now() };
      if (thinkOverride) {
        if (thinkOverride === "off") delete next.thinkingLevel;
        else next.thinkingLevel = thinkOverride;
      }
      applyVerboseOverride(next, verboseOverride);
      sessionStore[sessionKey] = next;
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = next;
      });
    }

    const agentModelPrimary = resolveAgentModelPrimary(cfg, sessionAgentId);
    const cfgForModelSelection = agentModelPrimary
      ? {
          ...cfg,
          agents: {
            ...cfg.agents,
            defaults: {
              ...cfg.agents?.defaults,
              model: {
                ...(typeof cfg.agents?.defaults?.model === "object"
                  ? cfg.agents.defaults.model
                  : undefined),
                primary: agentModelPrimary,
              },
            },
          },
        }
      : cfg;

    const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
      cfg: cfgForModelSelection,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    let provider = defaultProvider;
    let model = defaultModel;
    const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
    const hasStoredOverride = Boolean(
      sessionEntry?.modelOverride || sessionEntry?.providerOverride,
    );
    const needsModelCatalog = hasAllowlist || hasStoredOverride;
    let allowedModelKeys = new Set<string>();
    let allowedModelCatalog: Awaited<ReturnType<typeof loadModelCatalog>> = [];
    let modelCatalog: Awaited<ReturnType<typeof loadModelCatalog>> | null = null;

    if (needsModelCatalog) {
      modelCatalog = await loadModelCatalog({ config: cfg });
      const allowed = buildAllowedModelSet({
        cfg,
        catalog: modelCatalog,
        defaultProvider,
        defaultModel,
      });
      allowedModelKeys = allowed.allowedKeys;
      allowedModelCatalog = allowed.allowedCatalog;
    }

    if (sessionEntry && sessionStore && sessionKey && hasStoredOverride) {
      const entry = sessionEntry;
      const overrideProvider = sessionEntry.providerOverride?.trim() || defaultProvider;
      const overrideModel = sessionEntry.modelOverride?.trim();
      if (overrideModel) {
        const key = modelKey(overrideProvider, overrideModel);
        if (
          !isCliProvider(overrideProvider, cfg) &&
          allowedModelKeys.size > 0 &&
          !allowedModelKeys.has(key)
        ) {
          const { updated } = applyModelOverrideToSessionEntry({
            entry,
            selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
          });
          if (updated) {
            sessionStore[sessionKey] = entry;
            await updateSessionStore(storePath, (store) => {
              store[sessionKey] = entry;
            });
          }
        }
      }
    }

    const storedProviderOverride = sessionEntry?.providerOverride?.trim();
    const storedModelOverride = sessionEntry?.modelOverride?.trim();
    if (storedModelOverride) {
      const candidateProvider = storedProviderOverride || defaultProvider;
      const key = modelKey(candidateProvider, storedModelOverride);
      if (
        isCliProvider(candidateProvider, cfg) ||
        allowedModelKeys.size === 0 ||
        allowedModelKeys.has(key)
      ) {
        provider = candidateProvider;
        model = storedModelOverride;
      }
    }
    if (sessionEntry) {
      const authProfileId = sessionEntry.authProfileOverride;
      if (authProfileId) {
        const entry = sessionEntry;
        const store = ensureAuthProfileStore();
        const profile = store.profiles[authProfileId];
        if (!profile || profile.provider !== provider) {
          if (sessionStore && sessionKey) {
            await clearSessionAuthProfileOverride({
              sessionEntry: entry,
              sessionStore,
              sessionKey,
              storePath,
            });
          }
        }
      }
    }

    if (!resolvedThinkLevel) {
      let catalogForThinking = modelCatalog ?? allowedModelCatalog;
      if (!catalogForThinking || catalogForThinking.length === 0) {
        modelCatalog = await loadModelCatalog({ config: cfg });
        catalogForThinking = modelCatalog;
      }
      resolvedThinkLevel = resolveThinkingDefault({
        cfg,
        provider,
        model,
        catalog: catalogForThinking,
      });
    }
    if (resolvedThinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
      const explicitThink = Boolean(thinkOnce || thinkOverride);
      if (explicitThink) {
        throw new Error(`Thinking level "xhigh" is only supported for ${formatXHighModelHint()}.`);
      }
      resolvedThinkLevel = "high";
      if (sessionEntry && sessionStore && sessionKey && sessionEntry.thinkingLevel === "xhigh") {
        const entry = sessionEntry;
        entry.thinkingLevel = "high";
        entry.updatedAt = Date.now();
        sessionStore[sessionKey] = entry;
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = entry;
        });
      }
    }
    const sessionFile = resolveSessionFilePath(sessionId, sessionEntry, {
      agentId: sessionAgentId,
    });

    const startedAt = Date.now();
    let lifecycleEnded = false;

    let result: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
    let fallbackProvider = provider;
    let fallbackModel = model;
    try {
      const runContext = resolveAgentRunContext(opts);
      const messageChannel = resolveMessageChannel(
        runContext.messageChannel,
        opts.replyChannel ?? opts.channel,
      );
      const spawnedBy = opts.spawnedBy ?? sessionEntry?.spawnedBy;
      const fallbackResult = await runWithModelFallback({
        cfg,
        provider,
        model,
        agentDir,
        fallbacksOverride: resolveAgentModelFallbacksOverride(cfg, sessionAgentId),
        run: (providerOverride, modelOverride) => {
          if (isCliProvider(providerOverride, cfg)) {
            const cliSessionId = getCliSessionId(sessionEntry, providerOverride);
            return runCliAgent({
              sessionId,
              sessionKey,
              sessionFile,
              workspaceDir,
              config: cfg,
              prompt: body,
              provider: providerOverride,
              model: modelOverride,
              thinkLevel: resolvedThinkLevel,
              timeoutMs,
              runId,
              extraSystemPrompt: opts.extraSystemPrompt,
              cliSessionId,
              images: opts.images,
              streamParams: opts.streamParams,
            });
          }
          const authProfileId =
            providerOverride === provider ? sessionEntry?.authProfileOverride : undefined;
          return runEmbeddedPiAgent({
            sessionId,
            sessionKey,
            messageChannel,
            agentAccountId: runContext.accountId,
            messageTo: opts.replyTo ?? opts.to,
            messageThreadId: opts.threadId,
            groupId: runContext.groupId,
            groupChannel: runContext.groupChannel,
            groupSpace: runContext.groupSpace,
            spawnedBy,
            currentChannelId: runContext.currentChannelId,
            currentThreadTs: runContext.currentThreadTs,
            replyToMode: runContext.replyToMode,
            hasRepliedRef: runContext.hasRepliedRef,
            sessionFile,
            workspaceDir,
            config: cfg,
            skillsSnapshot,
            prompt: body,
            images: opts.images,
            clientTools: opts.clientTools,
            provider: providerOverride,
            model: modelOverride,
            authProfileId,
            authProfileIdSource: authProfileId
              ? sessionEntry?.authProfileOverrideSource
              : undefined,
            thinkLevel: resolvedThinkLevel,
            verboseLevel: resolvedVerboseLevel,
            timeoutMs,
            runId,
            lane: opts.lane,
            abortSignal: opts.abortSignal,
            extraSystemPrompt: opts.extraSystemPrompt,
            streamParams: opts.streamParams,
            agentDir,
            onAgentEvent: (evt) => {
              // Track lifecycle end for fallback emission below.
              if (
                evt.stream === "lifecycle" &&
                typeof evt.data?.phase === "string" &&
                (evt.data.phase === "end" || evt.data.phase === "error")
              ) {
                lifecycleEnded = true;
              }
            },
          });
        },
      });
      result = fallbackResult.result;
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
      if (!lifecycleEnded) {
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "end",
            startedAt,
            endedAt: Date.now(),
            aborted: result.meta.aborted ?? false,
          },
        });
      }
    } catch (err) {
      if (!lifecycleEnded) {
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "error",
            startedAt,
            endedAt: Date.now(),
            error: String(err),
          },
        });
      }
      throw err;
    }

    // Update token+model fields in the session store.
    if (sessionStore && sessionKey) {
      await updateSessionStoreAfterAgentRun({
        cfg,
        contextTokensOverride: agentCfg?.contextTokens,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: provider,
        defaultModel: model,
        fallbackProvider,
        fallbackModel,
        result,
      });
    }

    const payloads = result.payloads ?? [];
    return await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts,
      sessionEntry,
      result,
      payloads,
    });
  } finally {
    clearAgentRunContext(runId);
  }
}

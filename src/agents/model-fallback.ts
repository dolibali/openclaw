import type { MoltbotConfig } from "../config/config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  coerceToFailoverError,
  describeFailoverError,
  isFailoverError,
  isTimeoutError,
} from "./failover-error.js";
import {
  buildModelAliasIndex,
  modelKey,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
import {
  ensureAuthProfileStore,
  isProfileInCooldown,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";

type ModelCandidate = {
  provider: string;
  model: string;
};

type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
};

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (isFailoverError(err)) return false;
  const name = "name" in err ? String(err.name) : "";
  // Only treat explicit AbortError names as user aborts.
  // Message-based checks (e.g., "aborted") can mask timeouts and skip fallback.
  return name === "AbortError";
}

function shouldRethrowAbort(err: unknown): boolean {
  return isAbortError(err) && !isTimeoutError(err);
}

function buildAllowedModelKeys(
  cfg: MoltbotConfig | undefined,
  defaultProvider: string,
): Set<string> | null {
  const rawAllowlist = (() => {
    const modelMap = cfg?.agents?.defaults?.models ?? {};
    return Object.keys(modelMap);
  })();
  if (rawAllowlist.length === 0) return null;
  const keys = new Set<string>();
  for (const raw of rawAllowlist) {
    const parsed = parseModelRef(String(raw ?? ""), defaultProvider);
    if (!parsed) continue;
    keys.add(modelKey(parsed.provider, parsed.model));
  }
  return keys.size > 0 ? keys : null;
}

function resolveImageFallbackCandidates(params: {
  cfg: MoltbotConfig | undefined;
  defaultProvider: string;
  modelOverride?: string;
}): ModelCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider,
  });
  const allowlist = buildAllowedModelKeys(params.cfg, params.defaultProvider);
  const seen = new Set<string>();
  const candidates: ModelCandidate[] = [];

  const addCandidate = (candidate: ModelCandidate, enforceAllowlist: boolean) => {
    if (!candidate.provider || !candidate.model) return;
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) return;
    if (enforceAllowlist && allowlist && !allowlist.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const addRaw = (raw: string, enforceAllowlist: boolean) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (!resolved) return;
    addCandidate(resolved.ref, enforceAllowlist);
  };

  if (params.modelOverride?.trim()) {
    addRaw(params.modelOverride, false);
  } else {
    const imageModel = params.cfg?.agents?.defaults?.imageModel as
      | { primary?: string }
      | string
      | undefined;
    const primary = typeof imageModel === "string" ? imageModel.trim() : imageModel?.primary;
    if (primary?.trim()) addRaw(primary, false);
  }

  const imageFallbacks = (() => {
    const imageModel = params.cfg?.agents?.defaults?.imageModel as
      | { fallbacks?: string[] }
      | string
      | undefined;
    if (imageModel && typeof imageModel === "object") {
      return imageModel.fallbacks ?? [];
    }
    return [];
  })();

  for (const raw of imageFallbacks) {
    addRaw(raw, true);
  }

  return candidates;
}

function resolveFallbackCandidates(params: {
  cfg: MoltbotConfig | undefined;
  provider: string;
  model: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
}): ModelCandidate[] {
  const primary = params.cfg
    ? resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      })
    : null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = primary?.model ?? DEFAULT_MODEL;
  const provider = String(params.provider ?? "").trim() || defaultProvider;
  const model = String(params.model ?? "").trim() || defaultModel;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
  });
  const allowlist = buildAllowedModelKeys(params.cfg, defaultProvider);
  const seen = new Set<string>();
  const candidates: ModelCandidate[] = [];

  const addCandidate = (candidate: ModelCandidate, enforceAllowlist: boolean) => {
    if (!candidate.provider || !candidate.model) return;
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) return;
    if (enforceAllowlist && allowlist && !allowlist.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  addCandidate({ provider, model }, false);

  const modelFallbacks = (() => {
    if (params.fallbacksOverride !== undefined) return params.fallbacksOverride;
    const model = params.cfg?.agents?.defaults?.model as
      | { fallbacks?: string[] }
      | string
      | undefined;
    if (model && typeof model === "object") return model.fallbacks ?? [];
    return [];
  })();

  for (const raw of modelFallbacks) {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider,
      aliasIndex,
    });
    if (!resolved) continue;
    addCandidate(resolved.ref, true);
  }

  if (params.fallbacksOverride === undefined && primary?.provider && primary.model) {
    addCandidate({ provider: primary.provider, model: primary.model }, false);
  }

  return candidates;
}

/**
 * 使用模型回退机制运行函数
 * 
 * 这是模型回退系统的核心函数。当主模型失败时，会自动尝试回退模型。
 * 
 * 回退场景：
 * - 模型不可用（API 错误、网络问题）
 * - 认证失败（API key 无效）
 * - 速率限制（rate limit）
 * - 上下文溢出（context overflow）
 * - 超时
 * 
 * 回退策略：
 * 1. 尝试主模型
 * 2. 如果失败，尝试配置的回退模型（按顺序）
 * 3. 如果所有模型都失败，抛出错误
 * 
 * 参数：
 * - params.cfg: MoltbotConfig - 配置
 * - params.provider: string - 主模型提供者
 * - params.model: string - 主模型 ID
 * - params.agentDir?: string - Agent 目录
 * - params.fallbacksOverride?: string[] - 回退模型覆盖（可选）
 * - params.run: (provider, model) => Promise<T> - 要运行的函数
 * - params.onError?: (attempt) => void - 错误回调（可选）
 * 
 * 返回值：
 * - Promise<{ result: T, provider: string, model: string, attempts: FallbackAttempt[] }>
 *   - result: 运行结果
 *   - provider: 最终使用的提供者
 *   - model: 最终使用的模型
 *   - attempts: 所有尝试的记录
 * 
 * TypeScript/JavaScript 知识点：
 * - <T>: 泛型，T 是返回值的类型
 * - Promise<T>: 返回 Promise
 * - async/await: 异步编程
 * - try/catch: 错误处理
 * - for 循环: 遍历回退候选
 */
export async function runWithModelFallback<T>(params: {
  cfg: MoltbotConfig | undefined;
  provider: string;
  model: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  run: (provider: string, model: string) => Promise<T>;
  onError?: (attempt: {
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    total: number;
  }) => void | Promise<void>;
}): Promise<{
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}> {
  /**
   * 步骤 1: 解析回退候选模型
   * 
   * 候选模型列表包括：
   * - 主模型
   * - 配置的回退模型
   * - 覆盖的回退模型（如果有）
   */
  const candidates = resolveFallbackCandidates({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
  });
  
  /**
   * 步骤 2: 加载认证配置存储
   * 
   * 用于检查认证配置是否可用（不在冷却期）
   */
  const authStore = params.cfg
    ? ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false })
    : null;
  
  /**
   * 步骤 3: 初始化尝试记录
   */
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  /**
   * 步骤 4: 遍历所有候选模型
   * 
   * 按顺序尝试每个模型，直到成功或全部失败
   */
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i] as ModelCandidate;
    
    /**
     * 步骤 4.1: 检查认证配置是否可用
     * 
     * 如果所有认证配置都在冷却期（rate limit），跳过这个模型
     */
    if (authStore) {
      const profileIds = resolveAuthProfileOrder({
        cfg: params.cfg,
        store: authStore,
        provider: candidate.provider,
      });
      const isAnyProfileAvailable = profileIds.some((id) => !isProfileInCooldown(authStore, id));

      if (profileIds.length > 0 && !isAnyProfileAvailable) {
        // 所有认证配置都在冷却期，跳过尝试
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          error: `Provider ${candidate.provider} is in cooldown (all profiles unavailable)`,
          reason: "rate_limit",
        });
        continue;  // 跳过这个模型，尝试下一个
      }
    }
    
    /**
     * 步骤 4.2: 尝试运行函数
     */
    try {
      const result = await params.run(candidate.provider, candidate.model);
      
      /**
       * 成功：返回结果和使用的模型信息
       */
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    } catch (err) {
      /**
       * 失败：处理错误并尝试下一个模型
       */
      
      // 如果是用户中止（AbortError），直接抛出，不尝试回退
      if (shouldRethrowAbort(err)) throw err;
      
      /**
       * 规范化错误为 FailoverError
       * 
       * FailoverError 包含回退信息（原因、状态码等）
       */
      const normalized =
        coerceToFailoverError(err, {
          provider: candidate.provider,
          model: candidate.model,
        }) ?? err;
      
      // 如果不是 FailoverError，直接抛出（不尝试回退）
      if (!isFailoverError(normalized)) throw err;

      /**
       * 记录失败尝试
       */
      lastError = normalized;
      const described = describeFailoverError(normalized);
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described.message,
        reason: described.reason,      // 失败原因（auth, rate_limit, context_overflow 等）
        status: described.status,       // HTTP 状态码（如果有）
        code: described.code,          // 错误代码（如果有）
      });
      
      /**
       * 调用错误回调（如果提供）
       * 
       * 可以用于记录日志、发送通知等
       */
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: normalized,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  /**
   * 步骤 5: 所有模型都失败了
   * 
   * 如果只有一个尝试且失败，直接抛出原始错误
   * 否则，抛出包含所有尝试信息的汇总错误
   */
  if (attempts.length <= 1 && lastError) throw lastError;
  
  /**
   * 生成错误摘要
   * 
   * 格式：provider/model: error (reason) | provider/model: error (reason) | ...
   */
  const summary =
    attempts.length > 0
      ? attempts
          .map(
            (attempt) =>
              `${attempt.provider}/${attempt.model}: ${attempt.error}${
                attempt.reason ? ` (${attempt.reason})` : ""
              }`,
          )
          .join(" | ")
      : "unknown";
  
  /**
   * 抛出汇总错误
   * 
   * TypeScript/JavaScript 知识点：
   * - new Error(message, { cause }): 创建错误，cause 是原始错误
   * - instanceof: 类型检查
   */
  throw new Error(`All models failed (${attempts.length || candidates.length}): ${summary}`, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

export async function runWithImageModelFallback<T>(params: {
  cfg: MoltbotConfig | undefined;
  modelOverride?: string;
  run: (provider: string, model: string) => Promise<T>;
  onError?: (attempt: {
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    total: number;
  }) => void | Promise<void>;
}): Promise<{
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}> {
  const candidates = resolveImageFallbackCandidates({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    modelOverride: params.modelOverride,
  });
  if (candidates.length === 0) {
    throw new Error(
      "No image model configured. Set agents.defaults.imageModel.primary or agents.defaults.imageModel.fallbacks.",
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i] as ModelCandidate;
    try {
      const result = await params.run(candidate.provider, candidate.model);
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    } catch (err) {
      if (shouldRethrowAbort(err)) throw err;
      lastError = err;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: err instanceof Error ? err.message : String(err),
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: err,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  if (attempts.length <= 1 && lastError) throw lastError;
  const summary =
    attempts.length > 0
      ? attempts
          .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`)
          .join(" | ")
      : "unknown";
  throw new Error(`All image models failed (${attempts.length || candidates.length}): ${summary}`, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

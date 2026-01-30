import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import JSON5 from "json5";
import { getFileMtimeMs, isCacheEnabled, resolveCacheTtlMs } from "../cache-utils.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
  type DeliveryContext,
} from "../../utils/delivery-context.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import { mergeSessionEntry, type SessionEntry } from "./types.js";

// ============================================================================
// Session Store Cache with TTL Support
// ============================================================================

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  loadedAt: number;
  storePath: string;
  mtimeMs?: number;
};

const SESSION_STORE_CACHE = new Map<string, SessionStoreCacheEntry>();
const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 seconds (between 30-60s)

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getSessionStoreTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.CLAWDBOT_SESSION_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_STORE_TTL_MS,
  });
}

function isSessionStoreCacheEnabled(): boolean {
  return isCacheEnabled(getSessionStoreTtl());
}

function isSessionStoreCacheValid(entry: SessionStoreCacheEntry): boolean {
  const now = Date.now();
  const ttl = getSessionStoreTtl();
  return now - entry.loadedAt <= ttl;
}

function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
}

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const normalized = normalizeSessionDeliveryFields(entry);
  const nextDelivery = normalized.deliveryContext;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) === nextDelivery?.accountId &&
    (entry.deliveryContext?.threadId ?? undefined) === nextDelivery?.threadId;
  const sameLast =
    entry.lastChannel === normalized.lastChannel &&
    entry.lastTo === normalized.lastTo &&
    entry.lastAccountId === normalized.lastAccountId &&
    entry.lastThreadId === normalized.lastThreadId;
  if (sameDelivery && sameLast) return entry;
  return {
    ...entry,
    deliveryContext: nextDelivery,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
}

function normalizeSessionStore(store: Record<string, SessionEntry>): void {
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) continue;
    const normalized = normalizeSessionEntryDelivery(entry);
    if (normalized !== entry) {
      store[key] = normalized;
    }
  }
}

export function clearSessionStoreCacheForTest(): void {
  SESSION_STORE_CACHE.clear();
}

type LoadSessionStoreOptions = {
  skipCache?: boolean;
};

/**
 * 加载会话存储
 * 
 * 这个函数负责从文件系统加载会话存储。
 * 会话存储是一个 JSON 文件，包含所有会话的配置和历史。
 * 
 * 存储位置：
 * - 默认：~/.clawdbot/sessions/sessions.json
 * - 可以配置：config.session.store
 * 
 * 缓存机制：
 * - 使用内存缓存提高性能
 * - 缓存有效期：45 秒（可配置）
 * - 检查文件修改时间，如果文件被修改，使缓存失效
 * 
 * 参数：
 * - storePath: string - 存储文件路径
 * - opts.skipCache?: boolean - 是否跳过缓存（默认 false）
 * 
 * 返回值：
 * - Record<string, SessionEntry> - 会话存储对象
 *   - key: 会话 Key（如 "main:test1"）
 *   - value: 会话条目（包含历史、配置等）
 * 
 * TypeScript/JavaScript 知识点：
 * - Record<K, V>: 对象类型，键类型 K，值类型 V
 * - = {}: 默认参数值
 * - try/catch: 错误处理
 * - structuredClone: 深拷贝（防止修改影响缓存）
 */
export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  /**
   * 步骤 1: 检查缓存
   * 
   * 如果缓存启用且有效，直接返回缓存的数据。
   * 这可以避免频繁读取文件系统，提高性能。
   */
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    const cached = SESSION_STORE_CACHE.get(storePath);
    if (cached && isSessionStoreCacheValid(cached)) {
      /**
       * 检查文件修改时间
       * 
       * 如果文件被修改（mtime 不同），说明缓存已过期，需要重新加载
       */
      const currentMtimeMs = getFileMtimeMs(storePath);
      if (currentMtimeMs === cached.mtimeMs) {
        /**
         * 返回深拷贝
         * 
         * 使用 structuredClone 创建深拷贝，防止外部修改影响缓存。
         * 
         * TypeScript/JavaScript 知识点：
         * - structuredClone: 深拷贝函数（ES2022）
         * - 深拷贝 vs 浅拷贝：
         *   - 浅拷贝：只复制第一层，嵌套对象仍然共享
         *   - 深拷贝：完全复制，包括所有嵌套对象
         */
        return structuredClone(cached.store);
      }
      /**
       * 文件已修改，使缓存失效
       */
      invalidateSessionStoreCache(storePath);
    }
  }

  /**
   * 步骤 2: 从磁盘加载
   * 
   * 缓存未命中或已禁用，从文件系统读取
   */
  let store: Record<string, SessionEntry> = {};
  let mtimeMs = getFileMtimeMs(storePath);
  
  try {
    /**
     * 读取文件内容
     * 
     * TypeScript/JavaScript 知识点：
     * - fs.readFileSync: 同步读取文件
     * - "utf-8": 文件编码
     */
    const raw = fs.readFileSync(storePath, "utf-8");
    
    /**
     * 解析 JSON5
     * 
     * JSON5 是 JSON 的扩展，支持注释、尾随逗号等。
     * 使用 JSON5 可以让配置文件更易读。
     */
    const parsed = JSON5.parse(raw);
    
    /**
     * 验证解析结果
     * 
     * 确保解析出来的是正确的会话存储格式
     */
    if (isSessionStoreRecord(parsed)) {
      store = parsed as Record<string, SessionEntry>;
    }
    
    /**
     * 更新文件修改时间
     */
    mtimeMs = getFileMtimeMs(storePath) ?? mtimeMs;
  } catch {
    /**
     * 忽略错误
     * 
     * 如果文件不存在或格式无效，使用空对象。
     * 后续写入时会创建新文件。
     */
    // ignore missing/invalid store; we'll recreate it
  }

  // Best-effort migration: message provider → channel naming.
  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as unknown as Record<string, unknown>;
    if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
      rec.channel = rec.provider;
      delete rec.provider;
    }
    if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
      rec.lastChannel = rec.lastProvider;
      delete rec.lastProvider;
    }

    // Best-effort migration: legacy `room` field → `groupChannel` (keep value, prune old key).
    if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
      rec.groupChannel = rec.room;
      delete rec.room;
    } else if ("room" in rec) {
      delete rec.room;
    }
  }

  // Cache the result if caching is enabled
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    SESSION_STORE_CACHE.set(storePath, {
      store: structuredClone(store), // Store a copy to prevent external mutations
      loadedAt: Date.now(),
      storePath,
      mtimeMs,
    });
  }

  return structuredClone(store);
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
  try {
    const store = loadSessionStore(params.storePath);
    return store[params.sessionKey]?.updatedAt;
  } catch {
    return undefined;
  }
}

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  // Invalidate cache on write to ensure consistency
  invalidateSessionStoreCache(storePath);

  normalizeSessionStore(store);

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);

  // Windows: avoid atomic rename swaps (can be flaky under concurrent access).
  // We serialize writers via the session-store lock instead.
  if (process.platform === "win32") {
    try {
      await fs.promises.writeFile(storePath, json, "utf-8");
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") return;
      throw err;
    }
    return;
  }

  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fs.promises.rename(tmp, storePath);
    // Ensure permissions are set even if rename loses them
    await fs.promises.chmod(storePath, 0o600);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;

    if (code === "ENOENT") {
      // In tests the temp session-store directory may be deleted while writes are in-flight.
      // Best-effort: try a direct write (recreating the parent dir), otherwise ignore.
      try {
        await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
        await fs.promises.writeFile(storePath, json, { mode: 0o600, encoding: "utf-8" });
        await fs.promises.chmod(storePath, 0o600);
      } catch (err2) {
        const code2 =
          err2 && typeof err2 === "object" && "code" in err2
            ? String((err2 as { code?: unknown }).code)
            : null;
        if (code2 === "ENOENT") return;
        throw err2;
      }
      return;
    }

    throw err;
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  await withSessionStoreLock(storePath, async () => {
    await saveSessionStoreUnlocked(storePath, store);
  });
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
): Promise<T> {
  return await withSessionStoreLock(storePath, async () => {
    // Always re-read inside the lock to avoid clobbering concurrent writers.
    const store = loadSessionStore(storePath, { skipCache: true });
    const result = await mutator(store);
    await saveSessionStoreUnlocked(storePath, store);
    return result;
  });
}

type SessionStoreLockOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
};

async function withSessionStoreLock<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 25;
  const staleMs = opts.staleMs ?? 30_000;
  const lockPath = `${storePath}.lock`;
  const startedAt = Date.now();

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });

  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
          "utf-8",
        );
      } catch {
        // best-effort
      }
      await handle.close();
      break;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") {
        // Store directory may be deleted/recreated in tests while writes are in-flight.
        // Best-effort: recreate the parent dir and retry until timeout.
        await fs.promises
          .mkdir(path.dirname(storePath), { recursive: true })
          .catch(() => undefined);
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }
      if (code !== "EEXIST") throw err;

      const now = Date.now();
      if (now - startedAt > timeoutMs) {
        throw new Error(`timeout acquiring session store lock: ${lockPath}`);
      }

      // Best-effort stale lock eviction (e.g. crashed process).
      try {
        const st = await fs.promises.stat(lockPath);
        const ageMs = now - st.mtimeMs;
        if (ageMs > staleMs) {
          await fs.promises.unlink(lockPath);
          continue;
        }
      } catch {
        // ignore
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  try {
    return await fn();
  } finally {
    await fs.promises.unlink(lockPath).catch(() => undefined);
  }
}

export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, update } = params;
  return await withSessionStoreLock(storePath, async () => {
    const store = loadSessionStore(storePath);
    const existing = store[sessionKey];
    if (!existing) return null;
    const patch = await update(existing);
    if (!patch) return existing;
    const next = mergeSessionEntry(existing, patch);
    store[sessionKey] = next;
    await saveSessionStoreUnlocked(storePath, store);
    return next;
  });
}

export async function recordSessionMetaFromInbound(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  return await updateSessionStore(storePath, (store) => {
    const existing = store[sessionKey];
    const patch = deriveSessionMetaPatch({
      ctx,
      sessionKey,
      existing,
      groupResolution: params.groupResolution,
    });
    if (!patch) return existing ?? null;
    if (!existing && !createIfMissing) return null;
    const next = mergeSessionEntry(existing, patch);
    store[sessionKey] = next;
    return next;
  });
}

export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
}) {
  const { storePath, sessionKey, channel, to, accountId, threadId, ctx } = params;
  return await withSessionStoreLock(storePath, async () => {
    const store = loadSessionStore(storePath);
    const existing = store[sessionKey];
    const now = Date.now();
    const explicitContext = normalizeDeliveryContext(params.deliveryContext);
    const inlineContext = normalizeDeliveryContext({
      channel,
      to,
      accountId,
      threadId,
    });
    const mergedInput = mergeDeliveryContext(explicitContext, inlineContext);
    const merged = mergeDeliveryContext(mergedInput, deliveryContextFromSession(existing));
    const normalized = normalizeSessionDeliveryFields({
      deliveryContext: {
        channel: merged?.channel,
        to: merged?.to,
        accountId: merged?.accountId,
        threadId: merged?.threadId,
      },
    });
    const metaPatch = ctx
      ? deriveSessionMetaPatch({
          ctx,
          sessionKey,
          existing,
          groupResolution: params.groupResolution,
        })
      : null;
    const basePatch: Partial<SessionEntry> = {
      updatedAt: Math.max(existing?.updatedAt ?? 0, now),
      deliveryContext: normalized.deliveryContext,
      lastChannel: normalized.lastChannel,
      lastTo: normalized.lastTo,
      lastAccountId: normalized.lastAccountId,
      lastThreadId: normalized.lastThreadId,
    };
    const next = mergeSessionEntry(
      existing,
      metaPatch ? { ...basePatch, ...metaPatch } : basePatch,
    );
    store[sessionKey] = next;
    await saveSessionStoreUnlocked(storePath, store);
    return next;
  });
}

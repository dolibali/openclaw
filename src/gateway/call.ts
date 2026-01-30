/**
 * Gateway 调用封装
 * 
 * 这个文件提供了调用 Gateway 的统一接口。
 * Gateway 是一个 WebSocket 服务器，提供 Agent 执行、会话管理等功能。
 * 
 * 核心功能：
 * 1. 建立 WebSocket 连接到 Gateway
 * 2. 发送请求并等待响应
 * 3. 处理超时和错误
 * 4. 支持本地和远程 Gateway
 * 5. 支持 TLS 加密连接
 * 
 * 使用场景：
 * - CLI 调用 Gateway 执行 Agent
 * - macOS 应用连接 Gateway
 * - Web UI 连接 Gateway
 * 
 * 学习重点：
 * - WebSocket 连接管理
 * - Gateway 协议格式
 * - 错误处理和超时
 * - 本地 vs 远程 Gateway
 * 
 * 协议格式：
 * - 请求: { type: "req", id, method, params }
 * - 响应: { type: "res", id, ok, payload|error }
 * - 事件: { type: "event", event, payload }
 */

// ==================== 导入模块 ====================

// Node.js 内置模块
import { randomUUID } from "node:crypto";  // 生成随机 UUID

// 配置相关
import type { MoltbotConfig } from "../config/config.js";
import {
  loadConfig,              // 加载配置
  resolveConfigPath,       // 解析配置路径
  resolveGatewayPort,      // 解析 Gateway 端口
  resolveStateDir,         // 解析状态目录
} from "../config/config.js";

// Tailscale 网络
import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";

// 设备身份
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";

// 消息渠道
import {
  GATEWAY_CLIENT_MODES,      // Gateway 客户端模式常量
  GATEWAY_CLIENT_NAMES,       // Gateway 客户端名称常量
  type GatewayClientMode,     // Gateway 客户端模式类型
  type GatewayClientName,      // Gateway 客户端名称类型
} from "../utils/message-channel.js";

// TLS 运行时
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";

// Gateway 客户端
import { GatewayClient } from "./client.js";

// 协议版本
import { PROTOCOL_VERSION } from "./protocol/index.js";

export type CallGatewayOptions = {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  config?: MoltbotConfig;
  method: string;
  params?: unknown;
  expectFinal?: boolean;
  timeoutMs?: number;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
  minProtocol?: number;
  maxProtocol?: number;
  /**
   * Overrides the config path shown in connection error details.
   * Does not affect config loading; callers still control auth via opts.token/password/env/config.
   */
  configPath?: string;
};

export type GatewayConnectionDetails = {
  url: string;
  urlSource: string;
  bindDetail?: string;
  remoteFallbackNote?: string;
  message: string;
};

export function buildGatewayConnectionDetails(
  options: { config?: MoltbotConfig; url?: string; configPath?: string } = {},
): GatewayConnectionDetails {
  const config = options.config ?? loadConfig();
  const configPath =
    options.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode ? config.gateway?.remote : undefined;
  const tlsEnabled = config.gateway?.tls?.enabled === true;
  const localPort = resolveGatewayPort(config);
  const tailnetIPv4 = pickPrimaryTailnetIPv4();
  const bindMode = config.gateway?.bind ?? "loopback";
  const preferTailnet = bindMode === "tailnet" && !!tailnetIPv4;
  const scheme = tlsEnabled ? "wss" : "ws";
  const localUrl =
    preferTailnet && tailnetIPv4
      ? `${scheme}://${tailnetIPv4}:${localPort}`
      : `${scheme}://127.0.0.1:${localPort}`;
  const urlOverride =
    typeof options.url === "string" && options.url.trim().length > 0
      ? options.url.trim()
      : undefined;
  const remoteUrl =
    typeof remote?.url === "string" && remote.url.trim().length > 0 ? remote.url.trim() : undefined;
  const remoteMisconfigured = isRemoteMode && !urlOverride && !remoteUrl;
  const url = urlOverride || remoteUrl || localUrl;
  const urlSource = urlOverride
    ? "cli --url"
    : remoteUrl
      ? "config gateway.remote.url"
      : remoteMisconfigured
        ? "missing gateway.remote.url (fallback local)"
        : preferTailnet && tailnetIPv4
          ? `local tailnet ${tailnetIPv4}`
          : "local loopback";
  const remoteFallbackNote = remoteMisconfigured
    ? "Warn: gateway.mode=remote but gateway.remote.url is missing; set gateway.remote.url or switch gateway.mode=local."
    : undefined;
  const bindDetail = !urlOverride && !remoteUrl ? `Bind: ${bindMode}` : undefined;
  const message = [
    `Gateway target: ${url}`,
    `Source: ${urlSource}`,
    `Config: ${configPath}`,
    bindDetail,
    remoteFallbackNote,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    url,
    urlSource,
    bindDetail,
    remoteFallbackNote,
    message,
  };
}

/**
 * 调用 Gateway 的通用函数
 * 
 * 这是调用 Gateway 的核心函数，负责：
 * 1. 解析 Gateway URL（本地或远程）
 * 2. 建立 WebSocket 连接
 * 3. 发送请求并等待响应
 * 4. 处理超时和错误
 * 
 * 参数：
 * - opts: CallGatewayOptions - 调用选项
 *   - method: string - Gateway 方法名（如 "agent", "health"）
 *   - params?: unknown - 方法参数
 *   - expectFinal?: boolean - 是否期望最终响应（不是流式）
 *   - timeoutMs?: number - 超时时间（毫秒）
 *   - url?: string - Gateway URL（覆盖配置）
 *   - token?: string - 认证 token
 *   - password?: string - 认证密码
 *   - 等等
 * 
 * 返回值：
 * - Promise<T> - Gateway 返回的响应（类型 T）
 * 
 * TypeScript/JavaScript 知识点：
 * - <T = unknown>: 泛型，T 是返回值的类型，默认是 unknown
 * - Promise<T>: 返回一个 Promise，解析为类型 T
 * - ?? 空值合并运算符
 * 
 * 执行流程：
 * 1. 解析 Gateway URL（本地或远程）
 * 2. 解析认证信息（token/password）
 * 3. 创建 GatewayClient
 * 4. 建立连接
 * 5. 发送请求
 * 6. 等待响应
 * 7. 处理超时和错误
 */
export async function callGateway<T = unknown>(opts: CallGatewayOptions): Promise<T> {
  /**
   * 步骤 1: 解析超时时间
   * 
   * 默认超时时间是 10 秒（10_000 毫秒）
   * TypeScript/JavaScript 知识点：
   * - 数字分隔符：10_000 等同于 10000，提高可读性
   */
  const timeoutMs = opts.timeoutMs ?? 10_000;
  
  /**
   * 步骤 2: 加载配置
   */
  const config = opts.config ?? loadConfig();
  
  /**
   * 步骤 3: 检查是否是远程模式
   * 
   * Gateway 可以运行在两种模式：
   * - local: 本地模式，Gateway 运行在同一台机器上
   * - remote: 远程模式，Gateway 运行在另一台机器上（通过 Tailscale 或 SSH）
   */
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode ? config.gateway?.remote : undefined;
  
  /**
   * 步骤 4: 解析 Gateway URL
   * 
   * URL 的优先级：
   * 1. opts.url（命令行参数覆盖）
   * 2. remote.url（远程配置）
   * 3. 本地 URL（127.0.0.1:port 或 tailnet IP:port）
   */
  const urlOverride =
    typeof opts.url === "string" && opts.url.trim().length > 0 ? opts.url.trim() : undefined;
  const remoteUrl =
    typeof remote?.url === "string" && remote.url.trim().length > 0 ? remote.url.trim() : undefined;
  
  /**
   * 步骤 5: 验证远程模式配置
   * 
   * 如果是远程模式但没有配置 URL，抛出错误
   */
  if (isRemoteMode && !urlOverride && !remoteUrl) {
    const configPath =
      opts.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
    throw new Error(
      [
        "gateway remote mode misconfigured: gateway.remote.url missing",
        `Config: ${configPath}`,
        "Fix: set gateway.remote.url, or set gateway.mode=local.",
      ].join("\n"),
    );
  }
  const authToken = config.gateway?.auth?.token;
  const authPassword = config.gateway?.auth?.password;
  const connectionDetails = buildGatewayConnectionDetails({
    config,
    url: urlOverride,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  });
  const url = connectionDetails.url;
  const useLocalTls =
    config.gateway?.tls?.enabled === true && !urlOverride && !remoteUrl && url.startsWith("wss://");
  const tlsRuntime = useLocalTls ? await loadGatewayTlsRuntime(config.gateway?.tls) : undefined;
  const remoteTlsFingerprint =
    isRemoteMode && !urlOverride && remoteUrl && typeof remote?.tlsFingerprint === "string"
      ? remote.tlsFingerprint.trim()
      : undefined;
  const overrideTlsFingerprint =
    typeof opts.tlsFingerprint === "string" ? opts.tlsFingerprint.trim() : undefined;
  const tlsFingerprint =
    overrideTlsFingerprint ||
    remoteTlsFingerprint ||
    (tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : undefined);
  const token =
    (typeof opts.token === "string" && opts.token.trim().length > 0
      ? opts.token.trim()
      : undefined) ||
    (isRemoteMode
      ? typeof remote?.token === "string" && remote.token.trim().length > 0
        ? remote.token.trim()
        : undefined
      : process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
        (typeof authToken === "string" && authToken.trim().length > 0
          ? authToken.trim()
          : undefined));
  const password =
    (typeof opts.password === "string" && opts.password.trim().length > 0
      ? opts.password.trim()
      : undefined) ||
    process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
    (isRemoteMode
      ? typeof remote?.password === "string" && remote.password.trim().length > 0
        ? remote.password.trim()
        : undefined
      : typeof authPassword === "string" && authPassword.trim().length > 0
        ? authPassword.trim()
        : undefined);

  const formatCloseError = (code: number, reason: string) => {
    const reasonText = reason?.trim() || "no close reason";
    const hint =
      code === 1006 ? "abnormal closure (no close frame)" : code === 1000 ? "normal closure" : "";
    const suffix = hint ? ` ${hint}` : "";
    return `gateway closed (${code}${suffix}): ${reasonText}\n${connectionDetails.message}`;
  };
  const formatTimeoutError = () =>
    `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
  /**
   * 步骤 6: 创建 Promise 并建立连接
   * 
   * 使用 Promise 包装整个连接和请求过程。
   * 
   * TypeScript/JavaScript 知识点：
   * - new Promise<T>((resolve, reject) => { ... }): 创建 Promise
   * - resolve: 成功时调用，传递结果
   * - reject: 失败时调用，传递错误
   * - settled: 标志，防止多次 resolve/reject
   */
  return await new Promise<T>((resolve, reject) => {
    /**
     * 状态管理
     * 
     * - settled: 是否已经完成（resolve 或 reject）
     * - ignoreClose: 是否忽略关闭事件（用于正常完成后的清理）
     */
    let settled = false;
    let ignoreClose = false;
    
    /**
     * 停止函数
     * 
     * 统一处理完成逻辑：
     * - 清除定时器
     * - 调用 resolve 或 reject
     * 
     * 参数：
     * - err?: Error - 错误（如果有）
     * - value?: T - 返回值（如果成功）
     */
    const stop = (err?: Error, value?: T) => {
      if (settled) return;  // 防止重复调用
      settled = true;
      clearTimeout(timer);  // 清除超时定时器
      if (err) reject(err);  // 如果有错误，reject
      else resolve(value as T);  // 否则 resolve
    };

    /**
     * 创建 Gateway 客户端
     * 
     * GatewayClient 封装了 WebSocket 连接和协议处理。
     * 
     * 参数说明：
     * - url: Gateway WebSocket URL
     * - token/password: 认证信息
     * - tlsFingerprint: TLS 指纹（用于验证远程 Gateway）
     * - instanceId: 客户端实例 ID（用于标识连接）
     * - clientName/mode: 客户端标识
     * - role: 角色（operator 表示操作者）
     * - scopes: 权限范围
     * - deviceIdentity: 设备身份（用于配对）
     * - minProtocol/maxProtocol: 协议版本范围
     * - onHelloOk: 连接成功后的回调
     * - onClose: 连接关闭时的回调
     */
    const client = new GatewayClient({
      url,
      token,
      password,
      tlsFingerprint,
      instanceId: opts.instanceId ?? randomUUID(),  // 如果没有提供，生成随机 ID
      clientName: opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
      clientDisplayName: opts.clientDisplayName,
      clientVersion: opts.clientVersion ?? "dev",
      platform: opts.platform,
      mode: opts.mode ?? GATEWAY_CLIENT_MODES.CLI,
      role: "operator",  // 角色：操作者
      scopes: ["operator.admin", "operator.approvals", "operator.pairing"],  // 权限
      deviceIdentity: loadOrCreateDeviceIdentity(),  // 设备身份
      minProtocol: opts.minProtocol ?? PROTOCOL_VERSION,  // 最小协议版本
      maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,   // 最大协议版本
      
      /**
       * 连接成功回调
       * 
       * 当 WebSocket 连接建立并完成握手后，会调用这个回调。
       * 此时可以发送请求。
       */
      onHelloOk: async () => {
        try {
          /**
           * 发送请求并等待响应
           * 
           * client.request<T> 会：
           * 1. 发送请求到 Gateway
           * 2. 等待响应
           * 3. 返回结果
           * 
           * 参数：
           * - opts.method: 方法名（如 "agent"）
           * - opts.params: 方法参数
           * - { expectFinal: opts.expectFinal }: 选项
           */
          const result = await client.request<T>(opts.method, opts.params, {
            expectFinal: opts.expectFinal,
          });
          
          // 成功：忽略关闭事件，停止客户端，resolve
          ignoreClose = true;
          stop(undefined, result);
          client.stop();
        } catch (err) {
          // 失败：忽略关闭事件，停止客户端，reject
          ignoreClose = true;
          client.stop();
          stop(err as Error);
        }
      },
      
      /**
       * 连接关闭回调
       * 
       * 当 WebSocket 连接关闭时调用。
       * 如果还没有完成（settled），说明是异常关闭。
       */
      onClose: (code, reason) => {
        if (settled || ignoreClose) return;  // 如果已经完成或忽略，直接返回
        ignoreClose = true;
        client.stop();
        stop(new Error(formatCloseError(code, reason)));
      },
    });

    /**
     * 设置超时定时器
     * 
     * 如果超过 timeoutMs 还没有完成，触发超时错误。
     */
    const timer = setTimeout(() => {
      ignoreClose = true;
      client.stop();
      stop(new Error(formatTimeoutError()));
    }, timeoutMs);

    /**
     * 启动客户端
     * 
     * 这会开始建立 WebSocket 连接。
     */
    client.start();
  });
}

export function randomIdempotencyKey() {
  return randomUUID();
}

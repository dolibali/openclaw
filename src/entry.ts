#!/usr/bin/env node
/**
 * 这是 Moltbot CLI 的真正入口文件
 * 
 * 文件说明：
 * - 这是 TypeScript 源文件 (.ts)
 * - 编译后会生成 dist/entry.js
 * - 这个文件负责处理进程初始化、参数解析、环境设置等
 * 
 * 执行流程：
 * 1. 设置进程标题
 * 2. 安装警告过滤器
 * 3. 处理颜色输出选项
 * 4. 处理实验性警告（可能需要重启进程）
 * 5. 规范化 Windows 参数
 * 6. 解析 CLI profile 参数
 * 7. 加载并运行 CLI 主函数
 */

// ==================== 导入模块 ====================
// TypeScript/JavaScript 知识点：
// - import 用于导入其他模块的功能
// - 可以导入默认导出或命名导出
// - node: 前缀表示 Node.js 内置模块

// 从 Node.js 内置模块导入
import { spawn } from "node:child_process";  // spawn: 用于创建子进程
import path from "node:path";                 // path: 用于处理文件路径
import process from "node:process";           // process: 进程对象，包含环境变量、命令行参数等

// 从项目内部模块导入（注意：.js 扩展名是必需的，即使源文件是 .ts）
// TypeScript 编译后所有文件都是 .js，所以导入时要用 .js 扩展名
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import { isTruthyEnvValue } from "./infra/env.js";
import { installProcessWarningFilter } from "./infra/warnings.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";

// ==================== 初始化设置 ====================

/**
 * 设置进程标题
 * 
 * 作用：
 * - 在进程列表中显示为 "moltbot"
 * - 方便在任务管理器或 ps 命令中识别进程
 */
process.title = "moltbot";

/**
 * 安装进程警告过滤器
 * 
 * 作用：
 * - 过滤掉一些不必要的 Node.js 警告信息
 * - 让输出更清晰
 */
installProcessWarningFilter();

/**
 * 处理颜色输出选项
 * 
 * 作用：
 * - 如果用户指定了 --no-color，禁用颜色输出
 * - 这对于脚本自动化或日志记录很有用
 * 
 * TypeScript/JavaScript 知识点：
 * - process.argv: 命令行参数数组
 * - process.env: 环境变量对象
 * - includes(): 数组方法，检查是否包含某个元素
 */
if (process.argv.includes("--no-color")) {
  // 设置环境变量来禁用颜色输出
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
}

/**
 * 实验性警告标志
 * 
 * 作用：
 * - Node.js 有时会显示实验性功能的警告
 * - 这个标志用于禁用这些警告
 */
const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";

/**
 * 检查是否已经禁用了实验性警告
 * 
 * 参数：
 * - nodeOptions: NODE_OPTIONS 环境变量的值（字符串）
 * 
 * 返回值：
 * - boolean: 如果已经禁用警告，返回 true
 * 
 * TypeScript/JavaScript 知识点：
 * - function 关键字定义函数
 * - : boolean 是 TypeScript 的类型注解，表示返回值类型
 * - : string 表示参数类型
 * - || 是逻辑或运算符
 */
function hasExperimentalWarningSuppressed(nodeOptions: string): boolean {
  // 如果没有 nodeOptions，返回 false
  if (!nodeOptions) return false;
  
  // 检查是否包含禁用警告的标志
  // includes() 方法检查字符串是否包含子字符串
  return (
    nodeOptions.includes(EXPERIMENTAL_WARNING_FLAG) || 
    nodeOptions.includes("--no-warnings")
  );
}

/**
 * 确保实验性警告被禁用
 * 
 * 作用：
 * - 如果 NODE_OPTIONS 中没有禁用警告的标志，就添加它
 * - 由于环境变量在进程启动时设置，需要重启进程才能生效
 * - 这个函数会创建一个新的子进程，并传递所有参数
 * 
 * 返回值：
 * - boolean: 如果创建了子进程，返回 true（父进程应该退出）
 * - false: 如果不需要重启，返回 false（继续执行）
 * 
 * TypeScript/JavaScript 知识点：
 * - ?? 是空值合并运算符：如果左边是 null 或 undefined，返回右边
 * - ... 是展开运算符：展开数组或对象
 * - 模板字符串：使用反引号和 ${} 来插入变量
 */
function ensureExperimentalWarningSuppressed(): boolean {
  // 如果设置了不重启标志，直接返回 false
  if (isTruthyEnvValue(process.env.CLAWDBOT_NO_RESPAWN)) return false;
  
  // 如果已经处理过 NODE_OPTIONS，直接返回 false
  if (isTruthyEnvValue(process.env.CLAWDBOT_NODE_OPTIONS_READY)) return false;
  
  // 获取当前的 NODE_OPTIONS 环境变量，如果没有则使用空字符串
  // ?? 运算符：如果左边是 null 或 undefined，使用右边的值
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  
  // 如果已经禁用了警告，不需要重启，返回 false
  if (hasExperimentalWarningSuppressed(nodeOptions)) return false;

  // 标记已经处理过 NODE_OPTIONS
  process.env.CLAWDBOT_NODE_OPTIONS_READY = "1";
  
  // 在 NODE_OPTIONS 中添加禁用警告的标志
  // trim() 去除首尾空格
  process.env.NODE_OPTIONS = `${nodeOptions} ${EXPERIMENTAL_WARNING_FLAG}`.trim();

  /**
   * 创建子进程
   * 
   * spawn() 参数说明：
   * - process.execPath: Node.js 可执行文件的路径
   * - [...process.execArgv, ...process.argv.slice(1)]: 
   *   - process.execArgv: Node.js 的执行参数（如 --harmony）
   *   - process.argv.slice(1): 当前进程的命令行参数（去掉第一个，即脚本路径）
   *   - ... 展开运算符：将数组展开
   * - { stdio: "inherit", env: process.env }:
   *   - stdio: "inherit" 表示子进程继承父进程的标准输入/输出/错误
   *   - env: 传递环境变量给子进程
   */
  const child = spawn(
    process.execPath,                                    // Node.js 可执行文件路径
    [...process.execArgv, ...process.argv.slice(1)],    // 参数数组
    {
      stdio: "inherit",      // 继承标准输入/输出/错误
      env: process.env,      // 传递环境变量
    }
  );

  // 附加子进程桥接（用于处理进程间通信）
  attachChildProcessBridge(child);

  /**
   * 监听子进程退出事件
   * 
   * once() 方法：只监听一次事件
   * 
   * 参数：
   * - code: 退出码（数字）
   * - signal: 退出信号（字符串，如 'SIGTERM'）
   */
  child.once("exit", (code, signal) => {
    // 如果是因为信号退出（如被 kill），设置退出码为 1
    if (signal) {
      process.exitCode = 1;
      return;
    }
    // 否则使用子进程的退出码，如果没有则使用 1
    // ?? 运算符：如果 code 是 null 或 undefined，使用 1
    process.exit(code ?? 1);
  });

  /**
   * 监听子进程错误事件
   * 
   * 如果子进程启动失败，记录错误并退出
   */
  child.once("error", (error) => {
    console.error(
      "[moltbot] Failed to respawn CLI:",
      // instanceof 检查：如果 error 是 Error 实例，使用 stack 或 message
      // 否则直接使用 error
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });

  // 父进程不应该继续运行 CLI，应该等待子进程
  return true;
}

/**
 * 规范化 Windows 系统的命令行参数
 * 
 * 问题背景：
 * - Windows 系统在传递命令行参数时，可能会包含 Node.js 可执行文件路径
 * - 这会导致参数解析错误
 * - 这个函数会移除这些多余的路径
 * 
 * 参数：
 * - argv: 命令行参数数组
 * 
 * 返回值：
 * - string[]: 规范化后的参数数组
 * 
 * TypeScript/JavaScript 知识点：
 * - 箭头函数：const func = (param) => { ... }
 * - 正则表达式：/pattern/flags
 * - 数组方法：filter(), splice(), slice()
 * - 字符串方法：replace(), trim(), toLowerCase(), endsWith()
 */
function normalizeWindowsArgv(argv: string[]): string[] {
  // 如果不是 Windows 系统，直接返回原参数
  if (process.platform !== "win32") return argv;
  
  // 如果参数少于 2 个，直接返回
  if (argv.length < 2) return argv;
  
  /**
   * 移除控制字符
   * 
   * 作用：移除不可见的控制字符（ASCII 码 < 32 或 = 127）
   * 
   * TypeScript/JavaScript 知识点：
   * - charCodeAt(): 获取字符的 Unicode 码点
   * - 字符串拼接：使用 += 或 +
   */
  const stripControlChars = (value: string): string => {
    let out = "";
    // 遍历字符串的每个字符
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      // 只保留可见字符（ASCII 32-126）
      if (code >= 32 && code !== 127) {
        out += value[i];
      }
    }
    return out;
  };
  
  /**
   * 规范化单个参数
   * 
   * 作用：
   * - 移除控制字符
   * - 移除首尾的引号
   * - 去除首尾空格
   * 
   * TypeScript/JavaScript 知识点：
   * - 链式调用：方法可以连续调用
   * - replace(): 字符串替换，第一个参数是正则表达式
   * - /^['"]+|['"]+$/g: 匹配开头或结尾的引号
   *   - ^: 开头
   *   - ['"]+: 一个或多个单引号或双引号
   *   - |: 或
   *   - $: 结尾
   *   - g: 全局匹配
   */
  const normalizeArg = (value: string): string =>
    stripControlChars(value)
      .replace(/^['"]+|['"]+$/g, "")  // 移除首尾引号
      .trim();                         // 去除首尾空格
  
  /**
   * 规范化候选路径
   * 
   * 作用：移除 Windows 路径前缀（如 \\?\）
   */
  const normalizeCandidate = (value: string): string =>
    normalizeArg(value).replace(/^\\\\\\?\\/, "");
  
  // 获取并规范化 Node.js 可执行文件路径
  const execPath = normalizeCandidate(process.execPath);
  const execPathLower = execPath.toLowerCase();
  const execBase = path.basename(execPath).toLowerCase();
  
  /**
   * 检查一个值是否是 Node.js 可执行文件路径
   * 
   * TypeScript/JavaScript 知识点：
   * - path.basename(): 获取路径的文件名部分
   * - endsWith(): 检查字符串是否以某个子字符串结尾
   * - includes(): 检查字符串是否包含某个子字符串
   */
  const isExecPath = (value: string | undefined): boolean => {
    if (!value) return false;
    const lower = normalizeCandidate(value).toLowerCase();
    return (
      lower === execPathLower ||                    // 完全匹配
      path.basename(lower) === execBase ||          // 文件名匹配
      lower.endsWith("\\node.exe") ||              // Windows 路径
      lower.endsWith("/node.exe") ||                // Unix 路径
      lower.includes("node.exe")                    // 包含 node.exe
    );
  };
  
  // 复制参数数组（使用展开运算符创建新数组）
  const next = [...argv];
  
  // 移除前 3 个参数中可能的 Node.js 路径
  for (let i = 1; i <= 3 && i < next.length; ) {
    if (isExecPath(next[i])) {
      // splice(): 删除数组元素
      // 参数：起始索引，删除数量
      next.splice(i, 1);
      continue;  // 继续循环，不增加 i
    }
    i += 1;  // 只有不是路径时才增加索引
  }
  
  // 过滤掉所有是 Node.js 路径的参数（保留第一个）
  // filter(): 过滤数组，返回新数组
  // 参数：回调函数，返回 true 保留，false 删除
  const filtered = next.filter((arg, index) => index === 0 || !isExecPath(arg));
  
  // 如果过滤后少于 3 个参数，直接返回
  if (filtered.length < 3) return filtered;
  
  // 再次清理：移除可能的 Node.js 路径
  const cleaned = [...filtered];
  for (let i = 2; i < cleaned.length; ) {
    const arg = cleaned[i];
    // 如果是空或选项（以 - 开头），跳过
    if (!arg || arg.startsWith("-")) {
      i += 1;
      continue;
    }
    // 如果是 Node.js 路径，删除
    if (isExecPath(arg)) {
      cleaned.splice(i, 1);
      continue;
    }
    // 否则跳出循环
    break;
  }
  return cleaned;
}

/**
 * ==================== 主执行流程 ====================
 */

// 规范化 Windows 系统的命令行参数
process.argv = normalizeWindowsArgv(process.argv);

/**
 * 如果不需要重启进程（处理实验性警告），继续执行 CLI
 * 
 * 执行流程：
 * 1. 解析 CLI profile 参数
 * 2. 应用 profile 环境变量
 * 3. 动态导入并运行 CLI 主函数
 * 
 * TypeScript/JavaScript 知识点：
 * - ! 是逻辑非运算符
 * - if 语句：条件判断
 * - 对象解构：const { property } = object
 * - Promise: .then() 和 .catch() 处理异步操作
 */
if (!ensureExperimentalWarningSuppressed()) {
  /**
   * 解析 CLI profile 参数
   * 
   * profile 的作用：
   * - 允许用户使用不同的配置环境
   * - 例如：开发环境、生产环境等
   * 
   * 返回值：
   * - { ok: boolean, error?: string, profile?: string, argv: string[] }
   */
  const parsed = parseCliProfileArgs(process.argv);
  
  // 如果解析失败，输出错误并退出
  if (!parsed.ok) {
    // 保持简单；Commander 会在我们移除标志后处理详细的帮助/错误信息
    console.error(`[moltbot] ${parsed.error}`);
    process.exit(2);  // 退出码 2 表示参数错误
  }

  /**
   * 如果指定了 profile，应用 profile 的环境变量
   * 
   * TypeScript/JavaScript 知识点：
   * - if (parsed.profile): 检查属性是否存在且为真值
   * - 对象字面量：{ profile: parsed.profile }
   */
  if (parsed.profile) {
    // 应用 profile 的环境变量
    applyCliProfileEnv({ profile: parsed.profile });
    
    // 保持 Commander 和临时 argv 检查的一致性
    // 更新 process.argv，移除 profile 相关的参数
    process.argv = parsed.argv;
  }

  /**
   * 动态导入 CLI 主函数并执行
   * 
   * TypeScript/JavaScript 知识点：
   * - import(): 动态导入，返回 Promise
   * - .then(): Promise 成功时的回调
   * - .catch(): Promise 失败时的回调
   * - 解构赋值：{ runCli } 从导入的模块中提取 runCli 函数
   * - 箭头函数：() => { ... } 是匿名函数
   */
  import("./cli/run-main.js")
    .then(({ runCli }) => {
      // 导入成功，调用 runCli 函数
      // runCli 是 CLI 的主函数，负责解析命令并执行
      runCli(process.argv);
    })
    .catch((error) => {
      // 导入失败，输出错误信息
      console.error(
        "[moltbot] Failed to start CLI:",
        // 如果 error 是 Error 实例，使用 stack 或 message
        // 否则直接使用 error
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      // 设置退出码为 1（表示错误）
      process.exitCode = 1;
    });
}

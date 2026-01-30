/**
 * CLI 主函数文件
 * 
 * 这个文件是 CLI 的核心，负责：
 * 1. 初始化环境（加载 .env 文件、规范化环境变量）
 * 2. 检查运行时版本
 * 3. 构建命令程序
 * 4. 注册命令和插件
 * 5. 解析并执行命令
 * 
 * 执行流程：
 * entry.ts → run-main.ts → buildProgram() → 命令执行
 */

// ==================== 导入模块 ====================

// Node.js 内置模块
import fs from "node:fs";                    // 文件系统操作
import path from "node:path";                // 路径处理
import process from "node:process";          // 进程对象
import { fileURLToPath } from "node:url";   // URL 转文件路径（ES Module 需要）

// 项目内部模块
import { loadDotEnv } from "../infra/dotenv.js";                    // 加载 .env 文件
import { normalizeEnv } from "../infra/env.js";                    // 规范化环境变量
import { isMainModule } from "../infra/is-main.js";                 // 检查是否是主模块
import { ensureMoltbotCliOnPath } from "../infra/path-env.js";      // 确保 CLI 在 PATH 中
import { assertSupportedRuntime } from "../infra/runtime-guard.js"; // 检查运行时版本
import { formatUncaughtError } from "../infra/errors.js";          // 格式化未捕获的错误
import { installUnhandledRejectionHandler } from "../infra/unhandled-rejections.js"; // 处理未处理的 Promise 拒绝
import { enableConsoleCapture } from "../logging.js";               // 启用控制台捕获
import { getPrimaryCommand, hasHelpOrVersion } from "./argv.js";   // 获取主命令、检查帮助/版本
import { tryRouteCli } from "./route.js";                           // 尝试路由 CLI 命令

// ==================== 辅助函数 ====================

/**
 * 重写更新标志参数
 * 
 * 作用：
 * - 将 --update 标志转换为 update 命令
 * - 例如：`moltbot --update` → `moltbot update`
 * 
 * 参数：
 * - argv: 命令行参数数组
 * 
 * 返回值：
 * - string[]: 重写后的参数数组
 * 
 * TypeScript/JavaScript 知识点：
 * - indexOf(): 查找元素在数组中的索引，找不到返回 -1
 * - splice(): 修改数组，参数：起始索引，删除数量，插入的元素
 * - 展开运算符 [...argv]: 创建数组的副本
 */
export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  // 查找 --update 的索引
  const index = argv.indexOf("--update");
  
  // 如果没找到，直接返回原数组
  if (index === -1) return argv;

  // 创建数组副本
  const next = [...argv];
  
  // 将 --update 替换为 update
  // splice(起始索引, 删除数量, 插入的元素)
  next.splice(index, 1, "update");
  
  return next;
}

/**
 * CLI 主函数
 * 
 * 这是 CLI 的核心函数，负责整个 CLI 的初始化、命令注册和执行流程
 * 
 * 参数：
 * - argv: 命令行参数数组，默认为 process.argv
 * 
 * 返回值：
 * - Promise<void>: 异步函数，不返回具体值
 * 
 * TypeScript/JavaScript 知识点：
 * - async function: 异步函数，可以使用 await
 * - = process.argv: 默认参数值
 * - await: 等待 Promise 完成
 * - import(): 动态导入模块
 */
export async function runCli(argv: string[] = process.argv) {
  /**
   * 步骤 1: 规范化 Windows 系统的参数
   * 
   * 作用：移除 Windows 系统可能添加的多余的 Node.js 路径
   */
  const normalizedArgv = stripWindowsNodeExec(argv);
  
  /**
   * 步骤 2: 加载环境变量
   * 
   * 作用：
   * - 从 .env 文件加载环境变量
   * - quiet: true 表示不输出加载信息
   */
  loadDotEnv({ quiet: true });
  
  /**
   * 步骤 3: 规范化环境变量
   * 
   * 作用：统一环境变量的格式和值
   */
  normalizeEnv();
  
  /**
   * 步骤 4: 确保 Moltbot CLI 在 PATH 中
   * 
   * 作用：确保可以在任何地方运行 moltbot 命令
   */
  ensureMoltbotCliOnPath();

  /**
   * 步骤 5: 检查运行时版本
   * 
   * 作用：
   * - 确保 Node.js 版本符合要求（>= 22）
   * - 如果不符合，会输出错误并退出
   */
  assertSupportedRuntime();

  /**
   * 步骤 6: 尝试路由 CLI 命令
   * 
   * 作用：
   * - 某些命令可能有快速路由路径（不经过完整的命令解析）
   * - 如果路由成功，直接返回，不继续执行
   * 
   * TypeScript/JavaScript 知识点：
   * - await: 等待异步操作完成
   * - if (await ...): 如果条件为真，执行 return
   */
  if (await tryRouteCli(normalizedArgv)) return;

  /**
   * 步骤 7: 启用控制台捕获
   * 
   * 作用：
   * - 捕获所有 console 输出到结构化日志
   * - 同时保持 stdout/stderr 的正常行为
   */
  enableConsoleCapture();

  /**
   * 步骤 8: 构建命令程序
   * 
   * 作用：
   * - 动态导入 program.js 模块
   * - 调用 buildProgram() 创建 Commander.js 程序实例
   * 
   * TypeScript/JavaScript 知识点：
   * - await import(): 动态导入，返回 Promise
   * - 解构赋值：{ buildProgram } 从模块中提取函数
   * - buildProgram(): 构建并返回 Commander.js 的 Command 实例
   */
  const { buildProgram } = await import("./program.js");
  const program = buildProgram();

  /**
   * 步骤 9: 安装全局错误处理器
   * 
   * 作用：
   * - 防止未处理的 Promise 拒绝导致静默崩溃
   * - 记录错误并优雅退出，而不是无痕迹地崩溃
   */
  installUnhandledRejectionHandler();

  /**
   * 步骤 10: 处理未捕获的异常
   * 
   * 作用：
   * - 捕获所有未处理的异常
   * - 记录错误信息并退出程序
   * 
   * TypeScript/JavaScript 知识点：
   * - process.on(): 监听进程事件
   * - "uncaughtException": 未捕获的异常事件
   * - 箭头函数：error => { ... }
   */
  process.on("uncaughtException", (error) => {
    console.error("[moltbot] Uncaught exception:", formatUncaughtError(error));
    process.exit(1);  // 退出码 1 表示错误
  });

  /**
   * 步骤 11: 重写更新标志
   * 
   * 作用：将 --update 转换为 update 命令
   */
  const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
  
  /**
   * 步骤 12: 注册主命令（如果存在）
   * 
   * 作用：
   * - 为了延迟加载（lazy-loading），只加载需要的命令
   * - 提高启动速度
   * 
   * 例如：如果用户运行 `moltbot agent`，只加载 agent 相关的代码
   */
  const primary = getPrimaryCommand(parseArgv);
  if (primary) {
    // 动态导入子命令注册函数
    const { registerSubCliByName } = await import("./program/register.subclis.js");
    // 注册主命令
    await registerSubCliByName(program, primary);
  }

  /**
   * 步骤 13: 注册插件命令
   * 
   * 作用：
   * - 如果只是查看帮助或版本（--help, --version），跳过插件注册
   * - 否则，注册所有插件的 CLI 命令
   * 
   * TypeScript/JavaScript 知识点：
   * - ! 逻辑非运算符
   * - && 逻辑与运算符
   * - 条件判断：如果 shouldSkipPluginRegistration 为 false，执行注册
   */
  const shouldSkipPluginRegistration = !primary && hasHelpOrVersion(parseArgv);
  if (!shouldSkipPluginRegistration) {
    // 动态导入插件 CLI 和配置加载函数
    const { registerPluginCliCommands } = await import("../plugins/cli.js");
    const { loadConfig } = await import("../config/config.js");
    
    // 加载配置并注册插件命令
    registerPluginCliCommands(program, loadConfig());
  }

  /**
   * 步骤 14: 解析并执行命令
   * 
   * 作用：
   * - 这是最后一步，Commander.js 会解析参数
   * - 找到对应的命令处理器并执行
   * - 如果命令不存在或参数错误，会输出帮助信息
   * 
   * TypeScript/JavaScript 知识点：
   * - parseAsync(): 异步解析命令
   * - await: 等待命令执行完成
   */
  await program.parseAsync(parseArgv);
}

/**
 * 移除 Windows 系统中的 Node.js 可执行文件路径
 * 
 * 问题背景：
 * - Windows 系统在传递命令行参数时，可能会包含 Node.js 可执行文件路径
 * - 这会导致参数解析错误
 * 
 * 参数：
 * - argv: 命令行参数数组
 * 
 * 返回值：
 * - string[]: 清理后的参数数组
 * 
 * 注意：这个函数与 entry.ts 中的 normalizeWindowsArgv 类似但略有不同
 */
function stripWindowsNodeExec(argv: string[]): string[] {
  // 如果不是 Windows，直接返回
  if (process.platform !== "win32") return argv;
  
  // 移除控制字符的函数（与 entry.ts 中相同）
  const stripControlChars = (value: string): string => {
    let out = "";
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 32 && code !== 127) {
        out += value[i];
      }
    }
    return out;
  };
  
  // 规范化单个参数
  const normalizeArg = (value: string): string =>
    stripControlChars(value)
      .replace(/^['"]+|['"]+$/g, "")  // 移除首尾引号
      .trim();
  
  // 规范化候选路径
  const normalizeCandidate = (value: string): string =>
    normalizeArg(value).replace(/^\\\\\\?\\/, "");  // 移除 Windows 路径前缀
  
  // 获取 Node.js 可执行文件路径
  const execPath = normalizeCandidate(process.execPath);
  const execPathLower = execPath.toLowerCase();
  const execBase = path.basename(execPath).toLowerCase();
  
  /**
   * 检查是否是 Node.js 可执行文件路径
   * 
   * TypeScript/JavaScript 知识点：
   * - fs.existsSync(): 同步检查文件是否存在
   */
  const isExecPath = (value: string | undefined): boolean => {
    if (!value) return false;
    const normalized = normalizeCandidate(value);
    if (!normalized) return false;
    const lower = normalized.toLowerCase();
    return (
      lower === execPathLower ||                                    // 完全匹配
      path.basename(lower) === execBase ||                          // 文件名匹配
      lower.endsWith("\\node.exe") ||                              // Windows 路径
      lower.endsWith("/node.exe") ||                               // Unix 路径
      lower.includes("node.exe") ||                                 // 包含 node.exe
      (path.basename(lower) === "node.exe" && fs.existsSync(normalized))  // 文件名是 node.exe 且文件存在
    );
  };
  
  // 过滤掉所有是 Node.js 路径的参数（保留第一个）
  const filtered = argv.filter((arg, index) => index === 0 || !isExecPath(arg));
  
  // 如果过滤后少于 3 个参数，直接返回
  if (filtered.length < 3) return filtered;
  
  // 再次清理：移除可能的 Node.js 路径
  const cleaned = [...filtered];
  if (isExecPath(cleaned[1])) {
    cleaned.splice(1, 1);
  }
  if (isExecPath(cleaned[2])) {
    cleaned.splice(2, 1);
  }
  return cleaned;
}

/**
 * 检查当前模块是否是 CLI 主模块
 * 
 * 作用：
 * - 用于判断当前文件是否是被直接执行的（而不是被导入的）
 * - 这在某些情况下很有用，例如决定是否执行某些初始化代码
 * 
 * 返回值：
 * - boolean: 如果是主模块，返回 true
 * 
 * TypeScript/JavaScript 知识点：
 * - import.meta.url: ES Module 的元数据，包含当前模块的 URL
 * - fileURLToPath(): 将 file:// URL 转换为文件系统路径
 * - isMainModule(): 检查是否是主模块
 */
export function isCliMainModule(): boolean {
  // import.meta.url 是当前模块的 URL（如 file:///path/to/file.js）
  // fileURLToPath() 将其转换为文件系统路径（如 /path/to/file.js）
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}

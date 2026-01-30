#!/usr/bin/env node
/**
 * 这是 Moltbot CLI 的入口文件
 * 
 * 文件说明：
 * - .mjs 扩展名表示这是一个 ES Module (ESM) 文件
 * - 这个文件会被 Node.js 直接执行（通过 shebang #!/usr/bin/env node）
 * - 它的主要作用是启用编译缓存，然后加载真正的入口文件
 * 
 * 执行流程：
 * 1. Node.js 读取这个文件
 * 2. 启用编译缓存（如果支持）
 * 3. 动态导入编译后的入口文件 (dist/entry.js)
 */

// shebang: 告诉系统使用 node 来执行这个文件
// 当你运行 `./moltbot.mjs` 时，系统会自动使用 node 来执行

// 从 Node.js 的 module 模块导入（注意：node: 前缀是 Node.js 的内置模块前缀）
// TypeScript/JavaScript 知识点：
// - import 是 ES Module 的导入语法
// - "node:module" 是 Node.js 内置模块的导入方式
import module from "node:module";

/**
 * 启用编译缓存
 * 
 * 编译缓存的作用：
 * - Node.js 可以将编译后的代码缓存起来，提高后续执行速度
 * - 这对于 TypeScript 编译后的代码特别有用
 * 
 * 代码逻辑：
 * 1. 检查模块是否支持编译缓存功能
 * 2. 检查环境变量是否禁用了编译缓存
 * 3. 如果都满足，尝试启用编译缓存
 * 4. 如果出错，忽略错误（不影响程序运行）
 */
// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    // 尝试启用编译缓存
    module.enableCompileCache();
  } catch {
    // 如果启用失败，忽略错误
    // 注意：这里使用了空的 catch 块，表示不处理错误
    // 这是为了确保即使缓存启用失败，程序也能继续运行
  }
}

/**
 * 动态导入真正的入口文件
 * 
 * TypeScript/JavaScript 知识点：
 * - await import() 是动态导入语法，返回一个 Promise
 * - 这里使用 top-level await（顶层 await），是 ES2022 的特性
 * - 动态导入允许在运行时加载模块，而不是在编译时
 * 
 * 执行流程：
 * 1. 导入编译后的入口文件 (dist/entry.js)
 * 2. 该文件会继续执行 CLI 的初始化逻辑
 * 
 * 注意：
 * - 这里导入的是 dist/entry.js，这是 TypeScript 编译后的 JavaScript 文件
 * - 源代码在 src/entry.ts，编译后会生成 dist/entry.js
 */
await import("./dist/entry.js");

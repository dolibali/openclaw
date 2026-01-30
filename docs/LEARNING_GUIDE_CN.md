# Moltbot 项目学习指南

## 项目概述

**Moltbot** 是一个个人AI助手框架，你可以在自己的设备上运行。它支持多种消息渠道（WhatsApp、Telegram、Slack、Discord、Signal、iMessage等），通过一个统一的Gateway控制平面来管理会话、工具和事件。

### 核心特性

- **多渠道支持**: WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、Microsoft Teams、Matrix、Zalo等
- **Gateway架构**: 单一WebSocket控制平面，统一管理所有连接
- **Pi Agent运行时**: 基于RPC模式的AI代理，支持工具调用和流式响应
- **工具生态**: 浏览器控制、Canvas、节点设备、定时任务、会话管理等
- **跨平台应用**: macOS菜单栏应用、iOS/Android节点应用

## 项目架构概览

```
┌─────────────────────────────────────────┐
│           消息渠道层                      │
│  WhatsApp/Telegram/Slack/Discord/...    │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│          Gateway (控制平面)               │
│      WebSocket: ws://127.0.0.1:18789    │
│  - 会话管理                               │
│  - 路由和事件分发                         │
│  - 工具调用                               │
│  - 配置管理                               │
└──────────────┬──────────────────────────┘
               │
       ┌───────┴───────┬───────────┬──────────┐
       │               │           │          │
       ▼               ▼           ▼          ▼
┌──────────┐  ┌──────────┐  ┌─────────┐  ┌─────────┐
│ Pi Agent │  │  CLI     │  │ Web UI  │  │  Nodes  │
│ (RPC)    │  │ (moltbot)│  │(WebChat)│  │(iOS/...)│
└──────────┘  └──────────┘  └─────────┘  └─────────┘
```

## 代码模块功能详解

### 1. 核心入口和CLI (`src/cli/`, `src/commands/`)

**功能**: 命令行接口，用户与系统交互的主要方式

**关键文件**:
- `moltbot.mjs`: CLI入口点
- `src/cli/`: CLI框架和命令注册
- `src/commands/`: 具体命令实现（gateway、agent、send、onboard等）

**学习重点**:
- 命令如何注册和路由
- 参数解析和验证
- 与Gateway的交互方式

### 2. Gateway核心 (`src/gateway/`)

**功能**: WebSocket服务器，系统的控制平面

**关键组件**:
- **WebSocket服务器**: 处理客户端连接
- **协议层**: 请求/响应/事件的消息格式
- **会话管理**: 维护agent会话状态
- **路由系统**: 消息路由到正确的agent
- **工具调用**: 执行agent请求的工具

**学习重点**:
- WebSocket协议设计
- 请求/响应/事件的消息流
- 会话生命周期管理
- 工具调用的执行机制

### 3. 消息渠道 (`src/channels/`, `src/whatsapp/`, `src/telegram/`, etc.)

**功能**: 连接各种消息平台

**支持的渠道**:
- `src/whatsapp/`: WhatsApp (Baileys)
- `src/telegram/`: Telegram (grammY)
- `src/slack/`: Slack (Bolt)
- `src/discord/`: Discord (discord.js)
- `src/signal/`: Signal (signal-cli)
- `src/imessage/`: iMessage (macOS only)
- `extensions/`: 扩展渠道 (Teams, Matrix, Zalo等)

**学习重点**:
- 各平台的API集成方式
- 消息格式转换
- 连接状态管理
- 群组和私聊处理

### 4. Agent运行时 (`src/agents/`)

**功能**: Pi Agent的RPC适配器和运行时

**关键组件**:
- **RPC客户端**: 与Pi Agent通信
- **工具注册**: 将Gateway工具暴露给agent
- **会话管理**: 维护对话历史
- **流式处理**: 处理agent的流式响应

**学习重点**:
- RPC协议设计
- 工具调用的桥接
- 会话上下文管理
- 流式响应的处理

### 5. 工具系统 (`src/browser/`, `src/canvas-host/`, `src/cron/`, etc.)

**功能**: Agent可调用的各种工具

**主要工具**:
- **Browser** (`src/browser/`): 浏览器控制（Chrome DevTools Protocol）
- **Canvas** (`src/canvas-host/`): 可视化工作空间
- **Cron** (`src/cron/`): 定时任务
- **Sessions** (`src/sessions/`): 会话间通信
- **Nodes** (`src/node-host/`): 设备节点控制

**学习重点**:
- 工具如何注册到Gateway
- 工具调用的安全边界
- 工具结果的返回格式

### 6. 配置系统 (`src/config/`)

**功能**: 配置文件的加载、验证和管理

**学习重点**:
- 配置文件的层次结构
- 配置验证（TypeBox schemas）
- 配置热重载
- 环境变量覆盖

### 7. 媒体处理 (`src/media/`, `src/media-understanding/`)

**功能**: 图片、音频、视频的处理和理解

**学习重点**:
- 媒体文件的临时存储
- 媒体格式转换
- 媒体理解（OCR、语音转文字等）

### 8. 路由系统 (`src/routing/`)

**功能**: 将消息路由到正确的agent和会话

**学习重点**:
- 路由规则的定义
- 群组消息的特殊处理
- 多agent路由策略

### 9. 安全系统 (`src/security/`)

**功能**: 认证、授权、沙箱隔离

**学习重点**:
- Gateway认证机制
- 设备配对流程
- Docker沙箱隔离
- 权限控制

### 10. Web界面 (`src/web/`)

**功能**: Web控制台和WebChat界面

**学习重点**:
- WebSocket客户端实现
- UI组件架构
- 实时状态更新

### 11. 基础设施 (`src/infra/`)

**功能**: 底层基础设施（HTTP服务器、文件系统、进程管理等）

**学习重点**:
- HTTP服务器实现
- 文件系统操作
- 进程管理
- 日志系统

## 学习路线

### 阶段一：理解整体架构（1-2周）

**目标**: 理解系统如何工作，数据如何流动

#### 1.1 从入口开始
- [ ] 阅读 `README.md` 了解项目定位
- [ ] 阅读 `docs/concepts/architecture.md` 理解架构
- [ ] 查看 `moltbot.mjs` 了解CLI入口
- [ ] 运行 `moltbot onboard` 体验完整流程

#### 1.2 理解Gateway核心
- [ ] 阅读 `docs/concepts/architecture.md` Gateway部分
- [ ] 查看 `src/gateway/` 目录结构
- [ ] 阅读 `src/gateway/server.ts` 了解WebSocket服务器
- [ ] 理解协议格式（请求/响应/事件）

**实践**:
```bash
# 启动Gateway
pnpm gateway:watch

# 在另一个终端连接
pnpm moltbot agent --message "Hello"
```

#### 1.3 理解消息流
- [ ] 阅读 `docs/concepts/channel-routing.md`
- [ ] 选择一个渠道（如Telegram）追踪消息流
- [ ] 理解从消息接收到agent响应的完整路径

**实践**: 设置一个Telegram bot，发送消息，追踪日志

### 阶段二：深入核心模块（2-3周）

**目标**: 理解关键模块的实现细节

#### 2.1 Gateway协议深入
- [ ] 阅读 `docs/gateway/protocol.md`
- [ ] 查看 `src/gateway/protocol/` 了解协议定义
- [ ] 理解TypeBox schema如何定义协议
- [ ] 查看协议代码生成脚本

**实践**: 添加一个新的Gateway方法

#### 2.2 Agent运行时
- [ ] 阅读 `docs/concepts/agent.md`
- [ ] 阅读 `docs/concepts/agent-loop.md`
- [ ] 查看 `src/agents/` 了解RPC适配器
- [ ] 理解工具如何暴露给agent

**实践**: 添加一个新的工具

#### 2.3 会话管理
- [ ] 阅读 `docs/concepts/session.md`
- [ ] 查看 `src/sessions/` 了解会话实现
- [ ] 理解会话的创建、更新、清理
- [ ] 理解多agent路由

**实践**: 实现一个自定义路由规则

### 阶段三：渠道集成（2-3周）

**目标**: 理解如何集成新的消息渠道

#### 3.1 研究现有渠道
- [ ] 选择一个简单渠道（如Telegram）深入研究
- [ ] 理解渠道的初始化流程
- [ ] 理解消息格式转换
- [ ] 理解连接状态管理

#### 3.2 理解渠道抽象
- [ ] 查看 `src/channels/` 了解渠道抽象
- [ ] 理解 `Channel` 接口
- [ ] 理解路由和配对机制

**实践**: 阅读一个完整渠道的实现（推荐从Telegram开始）

### 阶段四：工具系统（2-3周）

**目标**: 理解工具如何工作，如何添加新工具

#### 4.1 工具注册机制
- [ ] 查看 `src/gateway/tools/` 了解工具注册
- [ ] 理解工具schema定义
- [ ] 理解工具调用的执行流程

#### 4.2 研究现有工具
- [ ] 研究 `browser` 工具（相对复杂）
- [ ] 研究 `read`/`write` 工具（相对简单）
- [ ] 研究 `cron` 工具（定时任务）

**实践**: 实现一个简单的工具（如获取系统时间）

#### 4.3 工具安全
- [ ] 阅读 `docs/gateway/security.md`
- [ ] 理解Docker沙箱隔离
- [ ] 理解权限控制

### 阶段五：高级特性（3-4周）

**目标**: 理解高级功能和系统集成

#### 5.1 多agent路由
- [ ] 阅读 `docs/concepts/multi-agent.md`
- [ ] 理解workspace和agent隔离
- [ ] 理解会话间通信

#### 5.2 媒体处理
- [ ] 查看 `src/media/` 了解媒体管道
- [ ] 理解媒体理解（OCR、语音转文字）
- [ ] 理解媒体格式转换

#### 5.3 节点设备
- [ ] 阅读 `docs/nodes/` 了解节点系统
- [ ] 理解设备配对
- [ ] 理解设备命令执行

#### 5.4 Web界面
- [ ] 查看 `src/web/` 了解Web UI
- [ ] 理解WebSocket客户端实现
- [ ] 理解实时状态同步

### 阶段六：实战项目（持续）

**目标**: 通过实际项目加深理解

#### 建议项目
1. **添加一个新工具**: 实现一个实用的工具（如天气查询）
2. **优化现有功能**: 改进某个现有功能的性能或体验
3. **添加新渠道**: 集成一个新的消息平台（如果熟悉其API）
4. **改进文档**: 为某个模块编写更详细的文档
5. **修复bug**: 从issue列表中选择一个bug修复

## 学习资源

### 文档
- **架构文档**: `docs/concepts/architecture.md`
- **Gateway协议**: `docs/gateway/protocol.md`
- **概念文档**: `docs/concepts/` 下的所有文档
- **渠道文档**: `docs/channels/` 下的各渠道文档

### 代码示例
- **测试文件**: `src/**/*.test.ts` - 了解如何使用API
- **E2E测试**: `src/**/*.e2e.test.ts` - 了解完整流程
- **Live测试**: `src/**/*.live.test.ts` - 了解真实场景

### 调试技巧
1. **启用详细日志**: `moltbot gateway --verbose`
2. **查看Gateway日志**: 关注WebSocket连接和消息
3. **使用测试套件**: `pnpm test` 运行单元测试
4. **追踪消息流**: 在关键点添加日志

## 常见问题

### Q: 我应该从哪里开始？
A: 从 `moltbot onboard` 开始，体验完整流程，然后阅读架构文档。

### Q: 如何理解消息的完整流程？
A: 选择一个渠道（如Telegram），从消息接收到agent响应，追踪代码执行路径。

### Q: 如何添加新功能？
A: 先理解相关模块的代码结构，参考现有实现，编写测试，然后实现功能。

### Q: 如何调试问题？
A: 启用详细日志，使用测试套件，在关键点添加断点或日志。

### Q: 代码量很大，如何高效学习？
A: 按照学习路线，先理解架构，再深入具体模块。不要试图一次性理解所有代码。

## 下一步

1. **运行项目**: `pnpm install && pnpm build && pnpm moltbot onboard`
2. **阅读架构文档**: `docs/concepts/architecture.md`
3. **选择一个模块深入学习**: 建议从Gateway或Agent运行时开始
4. **参与社区**: 查看GitHub issues，尝试修复bug或回答问题

祝学习愉快！🦞

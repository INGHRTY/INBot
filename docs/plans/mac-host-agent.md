# 策划案：Mac 本地 Agent + 活动记忆 + 可扩展插件（v2）

> 状态：提案（非当前产品事实）。与 `VISION.md`、`AGENTS.md` 冲突时以那两份为准。
> v2 变更：核心架构从「云端驱动设备工具」改为「Mac 端跑本地 Pi agent，云端只派任务与收结果」。
> 依据用户决策：**产品需求三项按原推荐执行**（M1 只做静帧、活动数据上传摘要且托管部署默认关闭采集、L3 宿主适配器暂缓）。

---

## 0. 架构决策记录（先看这个）

### 0.1 决策：Mac 端跑本地 Pi agent，云端只做调度

```
┌─────────────── 云端 Rakazo ───────────────┐   ┌──────────── Mac（Electron） ────────────┐
│                                            │   │                                        │
│  Pi agent（云端）                          │   │  本地 Pi agent                          │
│   └ 决策：做什么、拆成几步                 │   │   └ 决策：下一步点哪里、输什么           │
│                                            │   │   └ 工具：observe / act / shell / files │
│  CloudAgentProvider 实现：LocalDeviceAgent │──▶│  └ 模型：Mac 本地模型 或 你的 key 直连    │
│   └ launch / get / reply / cancel          │◀──│  └ 结果：最终答案 + 轨迹摘要             │
│                                            │   │                                        │
│  CloudAgent 表 + cloud_agent.poll + 卡片    │   │  授权包执行器（本地强制）                │
└────────────────────────────────────────────┘   └────────────────────────────────────────┘
```

**这不是新架构。** 仓库里已经有「派任务 → 远端执行 → 结果回传 → 唤醒 bot」的完整机制：

| 现有部件 | 位置 | 复用方式 |
| --- | --- | --- |
| `CloudAgentProvider` 接口（launch/get/reply/cancel） | `packages/adapter-kit/src/interfaces.ts:597` | **直接实现**，新增 `LocalDeviceAgentProvider` |
| `CloudAgent` 表（状态机、幂等键、租约、fence、唤醒代数） | `packages/db/prisma/schema.prisma:935` | 直接复用，不改结构 |
| `cloud_agent.poll` 后台 job（派发/轮询/取消/终态唤醒） | `packages/adapters/src/cloud-agent-poll.ts` | 直接复用 |
| 线程里的 `cloud_agent` 卡片 + 终态唤醒 run | `packages/contracts/src/events.ts:236` | 直接复用 |
| 设备主动外连的 WebSocket 通道 | `packages/adapters/src/user-device-client.ts` | **复用传输层**，但换消息语义（见 §2） |
| 本地模型 provider（Ollama/LM Studio/llama.cpp/MLX） | `packages/adapters/src/pi-local-provider.ts` | 复用 provider 绑定逻辑 |

Cursor 那个 provider 是「对端在云上」，我们要做的是「对端在你 Mac 上」。**同一个 provider 契约，两种落地。**

### 0.2 决策：模型在哪，决定隐私承诺是否成立

「执行在本地」≠「数据不出本机」。设备端 agent 用的模型决定屏幕帧流向：

| 设备端模型 | 屏幕帧流向 | Rakazo 服务器能看到你的屏幕吗 | GUI 任务质量 |
| --- | --- | --- | --- |
| Mac 本地模型（Ollama / LM Studio / llama.cpp / MLX） | 只在 Mac 内 | **看不到** | 差（小模型点不准） |
| 你的 provider key，直连模型厂商 | Mac → 模型厂商，**不经过 Rakazo** | **看不到** | 好 |
| 经 Rakazo 服务器代理模型调用 | Mac → Rakazo → 模型厂商 | **看得到** | 好 |

**默认建议**：只支持前两种，**永不提供「经 Rakazo 代理」这一档**。
理由：Rakazo 的产品定位是「你拥有自己的 AI 队友」（`VISION.md`）。提供第三档等于提供一个「把你的屏幕内容送进我们服务器」的功能，且用户难以察觉它被悄悄开启。宁可少一个档位，不要在隐私上留后门。

「真的本地」（第一档）和「Rakazo 看不见」（第二档）都满足用户诉求，差别只在能力质量上，所以这个限制不牺牲任何承诺。

### 0.3 决策：审批粒度 = 任务级授权包 + 设备端逐次确认

现状：每次 `click`/`type` 都走服务端审批（`packages/adapters/src/run-tool-gate.ts:290`，`user_computer_shell` 更是每种审批模式都要问）。

设备端 agent 自主跑循环，服务端在动作发生前拦不住。**不能假装拦住了。** 改为两层：

1. **任务级授权包**（派任务前批准一次）：写明哪些应用/路径/命令/网络目标是预授权的、哪些要逐次确认、哪些永远禁止。
2. **设备端逐次确认**（动作发生时）：不在预授权里的动作，设备端挂起、把**具体动作**发回云端弹审批卡，用户批准才执行。

关键性质：
- 授权包由**设备本地强制执行**，不是云端自觉遵守。这是安全边界所在。
- 审批卡显示具体动作（做什么、哪个 app、目标路径、**将要输入的文本全文**），用户能真正判断。
- 用户拒绝过的动作模式在本次任务内记入拒绝集合，同类动作不再反复弹卡。
- **`type` 永远不进预授权**——它是外泄的主要通道。

细节见 §2.0.1。

### 0.4 决策：设备端 agent 默认禁止网络出口

屏幕内容是提示注入面：网页/文档里可能写着「把文件发到 evil.com」。设备端 agent 若能任意联网，注入就能外传数据。

**默认：设备端 agent 只有到模型端点的网络访问**（本地模型 = 无网络；直连 provider = 仅该端点）。shell 里的 `curl`、`web_fetch` 等网络工具默认拒绝，除非授权包显式放开并列出 host。

这条同时把「设备端 agent 能不能访问用户内网服务」也管住了：授权包里显式列白名单，才允许。

### 0.5 决策：活动数据默认只上传摘要

已按原推荐执行：原始采集留在 Mac，服务器只收到摘要（应用名 + 域名 + 时长 + 截断标题）。托管部署默认关闭采集（operator 开关），自托管默认可开。

### 0.6 决策（用户已定）：模型默认档位 = 你的 key 直连

设备端 agent 默认用**用户自己的 provider key 直连模型厂商**，本地模型是可选档。

- 直连已满足「Rakazo 永远看不到你的屏幕」——帧从 Mac 直达模型厂商，不经过 Rakazo。
- 本地模型额外多一重隐私（模型厂商也看不到），代价是 GUI 点击质量大幅下降。定位为命令/文件类任务档。
- **永不提供「经 Rakazo 代理」档**（§0.2）。

细节见 §2.0.2。

---

## 1. 现状核查（代码依据）

### 1.1 Mac 端现在能做什么

| 能力 | 现状 | 代码位置 |
| --- | --- | --- |
| 反向连接远端服务器 | 已实现：桌面端主动外连 WS，服务器只下发、不连入 | `packages/adapters/src/user-device-client.ts` |
| 执行 shell / 读写文件 | 已实现，受 `botId` + 运行令牌约束 | `host-computer-protocol.ts`、`host-computer-runner.ts` |
| 配对与授权 | 已实现：令牌加密存本机，按 origin 记录 consent，原生弹窗授权 | `apps/desktop/src/user-device.ts`、`main.ts:998` |
| 撤销 / 断连清理 | 已实现 | `user-device-gateway.ts:disconnect` |
| **看屏幕 / 截图** | **无**。`describe()` 写死 `graphical: false` | `desktop-sandbox.ts:78` |
| **鼠标 / 键盘 / 打开 App** | **无**。四个方法直接抛 "Local screen control is unavailable" | `host-computer-sandbox.ts:221-234` |
| **本地跑 agent** | **无**。Pi 只在 API/worker 进程里 | `packages/adapters/src/pi-runtime.ts` |
| 远程机器人触达 | 仅 `user_computer_shell`，只对该 run 的发起人、默认每次审批 | `run-tools-user-computer.ts` |

### 1.2 为什么现有 `user_computer_shell` 不够

它让云端 agent **逐步**指挥 Mac：每个工具调用往返一次，每一步都要审批，每一张截图都要上行。对「打开网页点几下」这种任务，交互轮次和审批次数都爆炸，而且截图内容必然经过 Rakazo 服务器。

本地 agent 方案把整个循环压进 Mac：云端只发一次任务、收一次结果。

### 1.3 记忆现状

| 能力 | 现状 | 代码位置 |
| --- | --- | --- |
| 持久记忆文档（bot / user 两种 scope，含 revision 历史） | 已实现，content 已加密 | `packages/memory/src/index.ts`、`content-encryption.ts:64` |
| 每轮注入记忆上下文（上限 32 KiB） | 已实现 | `memory-context.ts` |
| 语义记忆 provider（Honcho / Supermemory / Serenity） | 已实现、可插拔 | `memory-provider-factory.ts` |
| 对话历史压缩摘要 | 已实现（后台 job） | `history-compaction.ts` |
| 定时任务 + 「变化才触发」（files/command/tool 指纹） | 已实现 | `routine-watch.ts` |
| Hermes/OpenClaw 记忆文件导入（MEMORY.md / USER.md / daily notes） | 已实现**导入** | `packages/core/src/agent-import/*` |
| **日常活动采集** | **完全没有** | — |
| **定时「整理记忆」** | **没有原生能力** | — |

关键：`agent-import` 已经承认 `MEMORY.md`、`USER.md`、`memory/YYYY-MM-DD.md` 这套路径约定，但 Rakazo 自己从不写 daily notes。**采集 + 整理可以复用这套已存在的路径语义。**

### 1.4 插件现状

| 能力 | 现状 | 代码位置 |
| --- | --- | --- |
| 插件清单（Agent Plugins / Cursor / Grok） | 已实现 | `plugin-connectors.ts` |
| skills / commands / agents / 远程 MCP | 已实现 | 同上 |
| 市场 + 提交审核 | 已实现 | `plugin-marketplace.ts` |
| 安装记录、可用空间、按 bot 启用 | 已实现 | `CapabilityInstall`（schema.prisma:1198） |
| 本地 stdio MCP | 服务端可选（需部署方开 allowlist） | `mcp-transport.ts:268` |
| **`extensions` 字段** | **被接受但完全忽略** | `plugin-connectors.ts:536` |
| **插件提供 UI / 宿主能力 / 工具实现** | **不支持**，`VISION.md` 明确拒绝执行插件代码 | `VISION.md` |

---

## 2. 里程碑 M1：Mac 本地 Agent（G1）

### 2.0 三个细化决策（用户反馈后补充）

#### 2.0.1 审批粒度：从「任务级」细化到「任务级 + 设备端实时拦截」

原方案只到任务级授权包，粒度太粗：一旦批准，整个任务期间设备端 agent 都可以在授权范围内自由点击。细化如下。

**授权包拆成两层**：

```ts
type TaskGrant = {
  // 预授权：包内动作无需再问，直接执行。
  preapproved: {
    apps?: string[];            // 允许操作的应用（bundle id）
    readPaths?: string[];       // 允许读的路径前缀
    writePaths?: string[];      // 允许写的路径前缀
    shell?: { allow: boolean; commands?: string[] };
  };
  // 需要逐次确认：包内但不在预授权里的动作。
  // 设备端在执行前把「打算做什么」发回云端，云端弹审批卡。
  onDemand: "ask" | "deny";
  // 硬禁止：无论上面怎么写都不执行。
  denied: { apps?: string[]; paths?: string[]; hosts?: string[] };
  expiresAt: string;
};
```

执行流程：

```
设备端 agent 想执行一个动作
  ↓
grant.denied 命中？ → 不执行，回 blocked 事件（云端展示「被安全策略拒绝」）
  ↓ 否
在 preapproved 范围内？ → 直接执行
  ↓ 否
onDemand === "deny"？ → 不执行，回 blocked
  ↓ ask
把动作摘要（做什么、目标 app、目标路径/坐标）发回云端
  ↓
云端弹审批卡 → 用户批准 → 设备端执行 / 拒绝
```

**关键点**：
- **审批请求带具体动作**，不是笼统的「允许这个任务吗」。用户在卡片上看到的是「要在 Safari 点击 (820, 440)」。
- **审批在设备端等待时挂起**，不占用云端 run。云端只需要保持连接；用户不批准则超时（默认 5 分钟）后按拒绝处理。
- **拒绝是终局的**：用户拒绝一次后，设备端把该动作模式记入本次任务的「本次拒绝集合」，同类动作后续直接拒绝，不再反复弹卡。这避免「用户拒绝一次 → agent 换个措辞再问」的骚扰循环。
- **预授权 + 逐次确认的组合**覆盖了实际使用：浏览网页这类高频低危操作预授权（只读应用 + 只读路径），真正「点击提交 / 输入文字 / 写文件」逐次确认。
- **输入文字（`type`）永远不进预授权**。理由：`type` 是外泄的主要通道（把凭据粘到错误的地方），且用户无法从坐标判断将被输入的内容。审批卡上显示**将要输入的文本全文**，让用户能看清。

**这比纯任务级严格，比纯动作级可用。** 云端仍然保留任务级的「这次任务大概要做什么」总开关，但细粒度落在设备端。

#### 2.0.2 模型档位：默认「你的 key 直连」，本地模型是可选档

原方案留下「默认用哪个模型」未定。**定为：默认用用户自己的 provider key 直连模型厂商；本地模型是可选档。**

理由（与 §0.2 一致）：
- 直连模式下屏幕帧**从 Mac 直接到模型厂商，不经过 Rakazo**。Rakazo 对你的屏幕是瞎的——这已经兑现了「Rakazo 永远看不到你的屏幕」。
- 本地模型额外的好处是「模型厂商也看不到」，代价是 GUI 点击质量大幅下降（本地小模型的视觉定位能力不足以稳定点中按钮）。
- 对「操控我的电脑」这个场景，**点击准确率比多一重隐私更重要**。多一重隐私用户可以自己去选（用 Ollama），但点不准会让功能不可用。

**「本地模型」档位保留**，定位明确：
- 适合：命令/文件类任务（`shell`、`read_file`、`write_file`），不需要看屏幕。
- 不适合：GUI 点击。
- UI 上标注清楚，不要让用户以为两者能力相同。

**永不提供「经 Rakazo 代理」档**（§0.2 的硬约束）。这条不变。

凭据处理：
- **key 只存在 Mac 的 Keychain**（Electron `safeStorage`，`apps/desktop/src/main.ts:1024` 已有现成模式），**绝不下发给云端**。
- 云端只知道一个不含秘密的 `connectionRef`（一个随机 ID + 显示名 + provider 类型），用来在任务里指定「用哪个连接」。
- 设备端拿 `connectionRef` 去自己的 Keychain 取 key，取不到就报「连接不可用」，不回退到任何默认凭据。

#### 2.0.3 本地 Pi loop 的具体骨架

见 **§2.5**（工具集 / loop 主循环 / 模型绑定 / 凭据存取四件套）。

---

### 2.1 传输层：从「请求-响应」到「任务-结果」

现有设备通道是「云端发一个请求、设备回一堆帧」（`host-computer-protocol.ts`）。任务语义需要另外几种消息：

```ts
// packages/adapters/src/user-device-protocol.ts
// 云端 → 设备
{ type: "task", id, task: LocalAgentTask }        // 派一个任务
{ type: "taskReply", id, text }                   // 追加一条指令
{ type: "taskCancel", id }                        // 中止任务
{ type: "taskDecision", id, decision }            // 回答一次逐次确认
// 设备 → 云端
{ type: "taskEvent", id, event: TaskEvent }       // 进度与最终结果
{ type: "taskApproval", id, request }             // 请求用户批准一个动作
```

**向后兼容靠「联合类型里没有分支」实现**：消息联合是 `z.discriminatedUnion`，老客户端解析不了 `task` 就整条丢弃；老服务端同样丢弃 `taskEvent`。两个方向的测试都钉住了这一点（`user-device-protocol.test.ts`）。

**幂等**：`task.taskId` 是幂等键。设备端记住跑完的任务的终态事件，重发同一个 `taskId` 时**重放结果**而不是重跑。

**取消不能丢**：任务先登记再 `await`（授权、用户确认都是异步的），所以「取消」在授权还没回来时也能生效。

`LocalAgentTask` 结构：

```ts
{
  taskId: string;              // 幂等键；重发不重复执行
  prompt: string;              // 自然语言任务
  botId: string;               // 归属哪个 bot（用于审计与记忆归属）
  grant: TaskGrant;            // 授权包，见 §2.3
  model: { provider, id, connectionRef? };  // 用哪个模型
  budget: { maxSteps: number; maxSeconds: number; maxTokens?: number };
  context?: {                  // 可选：云端已知的上下文
    memoryPaths?: string[];    // 要注入的本地记忆文档
    attachments?: { name, path }[];  // 本机上的文件
  };
}
```

`TaskEvent` 结构：

```ts
| { kind: "started"; at: string }
| { kind: "step"; at: string; index: number; action: string; summary: string }  // 摘要，不含原始帧
| { kind: "blocked"; at: string; reason: string }      // 授权包拒绝了一次动作
| { kind: "progress"; at: string; message: string }
| { kind: "finished"; at: string; answer: string; summary?: string }
| { kind: "failed"; at: string; error: string }
```

**要点**：
- `step` 事件只带**动作摘要**（"点击了 Safari 地址栏"），不带坐标、不带截图、不带输入文本。审计够用，隐私不外泄。
- 帧只在 Mac 内流转（云端 agent 看不到），这是本方案相对 v1 的核心收益。
- `blocked` 事件让云端知道「设备端拒绝了某个动作及原因」，云端可以据此向用户解释。

**带宽**：任务下发是一次小 JSON；结果是文本 + 少量 step 摘要。**完全不传图片**。相比 v1（每步一张 1280×800 PNG 上行），这是数量级的节省。

### 2.2 服务端：`LocalDeviceAgentProvider`

实现 `CloudAgentProvider`（`packages/adapter-kit/src/interfaces.ts:597`）：

```ts
export class LocalDeviceAgentProvider implements CloudAgentProvider {
  describe() {
    return { id: "local-device", contractVersion: "1", adapterVersion: "0.1.0",
             capabilities: { launch: true, reply: true, cancel: true, offline: false } };
  }
  async launch(request, context): Promise<CloudAgentHandle>   // → task 发到设备
  async get(id, context, runId?): Promise<CloudAgentSnapshot> // → 拉取最新 TaskEvent
  async reply(id, request, context): Promise<CloudAgentHandle>// → 追加指令
  async cancel(id, context, runId?): Promise<CloudAgentSnapshot> // → 中止设备任务
}
```

**必须解决的两个集成问题**：

1. **provider 选择是部署级的**。现在 `createCloudAgentConnection()` 读环境变量选一个 provider（`cloud-agent-provider-env.ts`），`cloudAgentsEnabled()` 还要求 `connection.spaceId === spaceId`——一个部署只能配一个 provider，且绑定单个 Space。设备 agent 是**按用户**的（每个用户自己的 Mac）。
   → 改成：`cloudAgent` 依赖从「一个连接」变为「按 (spaceId, userId) 解析的 provider 列表」。Cursor 那条保持可用，设备那条按 `userId` 命中其已配对设备。
   → `cloudAgentsEnabled` 的 Space 绑定对设备 provider 不适用（设备属于用户，不属于 Space），需要一条「该用户在本 Space 内有已授权设备」的判定。

2. **`CloudAgent` 表的行状态**已经够用：`launchRequest` 存任务、`remoteId` 存 deviceId、`latestRunId` 存 taskId、`status`、`cancelRequested`、`generation`（重试代数）、`leaseToken`（轮询租约）、`wakeGeneration`（终态唤醒）。
   → 只有 `launchRequest` 的 schema 要放宽（现在强制 `prompt` + 可选 `repository`/`openPr`）。用 `cloudAgentLaunchSchema` 扩一个 `kind: "local-device"` 分支即可。

   **但实测核查后有一处必须补：任务的答案没有地方落。** `CloudAgentSnapshot` 只有 `title / status / url / branch / prUrl / latestRunId`，`snapshotData()` 也只写这几个字段（`cloud-agent-poll.ts:238`）。Cursor 那边「答案」是远端仓库里的 PR，云端不需要存；设备任务的答案是**一段文本**，而 worker 里的 `get()` 拿不到 API 进程活着的那条 socket 会话，所以必须**持久化**，否则终态唤醒的 bot 只看到 `status = finished`，读不到任何内容。
   → 建议：`CloudAgent` 加一个 `result String?`（新增可空列，按 `AGENTS.md` 是安全迁移），`CloudAgentSnapshot` 加 `result?: string`，`snapshotData()` 写它，`cloud_agent_status` 读它。这是本轮唯一需要动的 schema。

3. **`get()` 的调用面**：`pollCloudAgent` 在 `launch` 之后的每一次轮询都调 `provider.get(remoteId)`，而 `launch` 返回的 `UserDeviceTaskHandle` 是进程内的、随 `launch` 那次调用结束就没了。因此 `get()` 不能依赖 handle，只能**按需向设备重问一次**：新增一条 `taskStatus` 请求（设备回「还在跑 / 已结束 + 答案」），由现有的同步请求通道（`request`/`frame`）承载，不占用任务会话。

4. **审批**：`cloud_agent_launch` 已经在 `action-approval.ts:41` 的 `EXPLICIT_APPROVAL` 名单里（每次都要问）。设备任务沿用这个位置，但审批卡要显示**授权包内容**（不是一句「允许启动云 agent」）。审批规则匹配按工具名走，够用。

### 2.3 授权包（TaskGrant）

这是本方案的安全核心，必须**在设备端强制**，不能只在云端记着。结构见 §2.0.1 的两层拆分（`preapproved` / `onDemand` / `denied`）。

**执行位置**：`packages/adapters/src/local-agent/grant.ts`（新文件，纯逻辑，无 IO）。
- 一份实现，同时被「派任务前的校验」和「设备端执行前的校验」使用。
- 设备端执行器在每次工具调用前调用 `grant.check(action)`，返回 `{allowed}` / `{denied, reason}` / `{ask}`。
- 路径检查复用现成的 `isAllowedDesktopPath`（`desktop-sandbox-paths.ts`），不要重写。
- 命令检查复用 `desktop-command-guard.ts` 的解析逻辑（它已经在解析 shell 命令并拒绝危险动作）。
- **网络检查是新增的**：`grant.check` 对任何会发起网络请求的工具都要判定（`web_fetch`、`shell` 里的 `curl`/`nc` 等）。默认拒绝，只放行 `preapproved` 里显式列出的 host。

**默认从严**：授权包所有字段默认为「什么都不允许」。用户要在审批卡上明确勾选才能放开。这样「误批一次」的后果被限制在用户明确勾选的范围内。

**只读工具不需要授权**：`computer_observe` 只读取屏幕像素，不改变任何状态——但它会把屏幕内容送到模型厂商，所以它受**模型档位**约束（见 §0.2）而不是授权包约束。

### 2.4 设备端：本地 Pi agent

**这是 v2 相对 v1 最大的新增工作量。** 需要的部件：

1. **Pi 运行时**。`@earendil-works/pi-agent-core` 已经在依赖里（`packages/adapters/package.json:27`）。设备端需要跑一个**精简版** agent loop：
   - 模型：走 `pi-ai` 的 provider 抽象，复用 `pi-local-provider.ts`（本地模型）和 `pi-openai-compatible-provider.ts`（你的 key 直连）。
   - 工具集：`observe` / `act` / `shell` / `read_file` / `write_file` / `open_path` / `launch_app`（+ 可选 `web_fetch`）。
   - **不需要**服务端那一整套：`run-tool-gate`、审批、外部效果幂等、`external_effects`、内存压缩、子 agent、团队工具、购买、消息发送。这些在设备端一律不提供。
   - 建议**新写一个小的 loop**（`packages/adapters/src/local-agent-loop.ts`），而不是复用 `pi-runtime.ts`（后者耦合了服务端的 `ToolHost`、审批暂停、effect 幂等、run 上下文，搬过去会带一堆不该有的依赖）。
   - 但**工具实现必须共享**：`observe`/`act` 的底层原语（截图、输入注入、应用启动）要与 v1 的图形能力共用一份实现，见 §2.5。

2. **屏幕捕获与输入注入**（macOS 优先，Windows/Linux 后续）。
   - **截图**：Electron `desktopCapturer.getSources({ types: ["screen"], thumbnailSize })`。macOS 需要「屏幕录制」TCC 授权；用 `systemPreferences.getMediaAccessStatus("screen")` 探测。
   - **截图按「点」而不是「像素」**：Retina 屏上 `CGEvent` 的鼠标坐标是逻辑点，截图却是两倍像素。为了让模型看到的坐标就是能点的坐标，缩略图按显示器的逻辑尺寸请求（`thumbnailSize = display.bounds`），图像像素与屏幕坐标一一对应，点击时只需加上显示器原点。
   - **输入注入**：**koffi 调用 CoreGraphics**（`CGEventCreateMouseEvent` / `CGEventCreateKeyboardEvent` / `CGEventPost`）。仓库已有 koffi 依赖和 macOS 调用先例（`file-handle-path.ts` 加载 `libSystem.dylib`）。需要「辅助功能」TCC 授权，用 `AXIsProcessTrusted` 探测。
     - 不要用 `osascript` + System Events：慢、中文输入法不友好、且要同时申请「辅助功能」和「自动化」两项授权。
   - **移动指针必须用 `CGWarpMouseCursorPosition`**：只 post 一个 mouse-moved 事件**不会**移动指针（实测：事件发出后指针纹丝不动）。正确做法是先 warp，再 post 事件让应用收到 hover。
   - **文本输入**：走 `CGEventKeyboardSetUnicodeString` 逐字符注入，**不动剪贴板**。原方案写的是剪贴板 + `Cmd+V`，实现时改了：剪贴板方案会覆盖用户自己的剪贴板，在个人电脑上这是看得见的副作用；Unicode 注入同样支持中文。`\n` / `\t` 仍走 Return / Tab 键，因为纯 Unicode 字符不会触发应用的换行处理。
   - **窗口信息**：用 `CGWindowListCopyWindowInfo`，取**第一个 layer == 0 的窗口**（系统自己的菜单栏 / Dock / 通知中心都在更高的 layer 上，所以这一条规则与系统语言无关）。窗口标题由「屏幕录制」权限决定，没有该权限时标题为空。**不用 `AXUIElement`**：实测 `AXUIElementCopyAttributeValue` 取 `AXFocusedApplication` 会返回 `-25204` / `-25212`，且失败时输出缓冲区里是野指针，接着调用 `AXUIElementGetPid` 会直接 SIGILL 崩溃。
   - **应用启动**：`open -a <name>` / `open <path>`。
   - **注意**：macOS 27 的系统框架只在 dyld 共享缓存里，磁盘上没有 `Versions/C`，只有 `Versions/A`。所以框架路径一律用**不带版本号**的软链接（`/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics`），写死 `Versions/C` 会在新系统上直接失败。

   **已在本机验证**（macOS 27.2，Electron 45）：
- 截图按请求尺寸返回；Electron `getCursorScreenPoint()` 与 `CGEventGetLocation()` 数值相同（同一坐标空间）。
- 中文与 ASCII 文本注入成功、`⌘A` 修饰键成功、按钮点击成功。
- **整条本地 agent 链路**：真实桌面 + 本地假模型跑完一次任务——
  `computer_observe` 拿到真实截图 → 模型要求点击 → 设备端弹出**带具体动作**的审批请求（`Click in T3 Code (Nightly) at (40, 40)`）→ 批准后执行 → 返回答案。上报的 `step` 摘要只有「Used the computer in …」，**不含坐标**。

3. **授权包执行器**（§2.3）。在每个工具调用前检查。

4. **模型凭据**（§2.5.5 有完整骨架）。设备端 agent 的模型连接存在**设备本地**，云端只看到一个不含秘密的 `connectionRef`：
   - **默认档：你的 provider key 直连模型厂商**（§2.0.2）。key 存 Mac Keychain（`safeStorage`，`main.ts:1024` 已有现成模式），**绝不下发给云端**。屏幕帧从 Mac 直达模型厂商，Rakazo 看不到。
   - **可选档：Mac 本地模型**（Ollama / LM Studio / llama.cpp / MLX）。真正零外泄，但 GUI 点击质量差，只适合命令/文件类任务。
   - **不提供「经 Rakazo 代理」档**（§0.2 的硬约束）。

5. **UI**：
   - 设置里新增「我的 Mac 上的 AI」区：选模型连接、选授权档位、开关、显示设备状态。
   - 任务进行中：菜单栏（Electron `Tray`，当前项目没有，需新增）常驻状态点 + 「停止」。
   - 一键中断：菜单栏按钮 + 全局快捷键，立即中止本地任务。
   - **逐次确认的审批卡**（§2.0.1）：走服务端现有的审批卡 UI 通道，卡上显示具体动作（做什么、哪个 app、目标路径、将要输入的文本全文）。

### 2.5 本地 Pi loop 的代码骨架

四件套：**工具集 / loop 主循环 / 模型绑定 / 凭据存取**。全部落在 `packages/adapters/src/local-agent/`，设备端（Electron 主进程）只做薄壳。

> 为什么新写 loop 而不是复用 `pi-runtime.ts`：后者耦合了服务端的 `ToolHost`（审批暂停、effect 幂等、`run` 上下文、steering、subagent、telemetry）。搬到设备端会带一堆不该有的依赖，且那些依赖在设备端**没有对应物**。新写一个约 200 行的 loop 成本更低、边界更清楚。
> 但**底层原语必须共享**：截图、输入注入、应用启动、TCC 探测、路径校验、命令解析——这些与 v1 完全共用，见 §2.4 第 2 点。

#### 2.5.1 文件布局

```
packages/adapters/src/
  host-screen.ts            # HostScreen 契约：截图 + 输入注入的编排，平台无关
  local-agent/
    grant.ts                # 授权包判定（纯逻辑，云端与设备端共用）
    network-target.ts       # shell 命令的网络目标识别（纯逻辑）

apps/desktop/src/
  host-screen.ts            # 桌面端 HostScreen 实现（组合下面两个）
  screen-capture.ts         # Electron desktopCapturer 截图 + 屏幕录制授权探测
  macos-native.ts           # koffi → CoreGraphics 注入 / 窗口列表 / 授权探测
  macos-keys.ts             # 虚拟键码与修饰键表（纯逻辑）
```

> **为什么原生代码在 `apps/desktop` 而不是 `packages/adapters`**：`packages/adapters` 是服务端包，会被打进 API / worker 镜像；屏幕捕获和输入注入是**平台原生的交互**，按 `AGENTS.md` 的划分（"genuinely native ... interactions platform-specific"）应当留在桌面应用里。`packages/adapters` 只保留**平台无关的契约**（`HostScreen`）和**纯逻辑**（授权包判定、网络目标识别），设备端和将来的本地 agent 共用这两份。
>
> `HostScreen` 的边界因此很窄：底层是 `capture / inject / frontmost` 三个原语，平台实现换成 Windows/Linux 时只需换掉 `apps/desktop` 里的那一份。

#### 2.5.2 工具集

工具名沿用服务端那套（`computer_observe` / `computer_act` / `shell` / `read_file` / `write_file` / `list_files` / `open_path` / `launch_app`），这样模型学到的语义一致，也方便把服务端提示词复用过来。

```ts
// packages/adapters/src/local-agent/tools.ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ComputerAction, ComputerObservation } from "@rakazo/adapter-kit";

export interface LocalToolDeps {
  /** 截图 + 输入注入原语。 */
  screen: HostScreen;
  /** 设备端的工作目录（bot 的本地 home）。 */
  home: string;
  /** 授权包判定。返回拒绝原因则不执行。 */
  grant: GrantChecker;
  /** 逐次确认通道（§2.0.1）。返回 true 表示用户批准。 */
  confirm: (request: ActionApprovalRequest) => Promise<boolean>;
  /** 本次任务内已被用户拒绝的动作模式，后续同类直接拒绝。 */
  deniedPatterns: Set<string>;
  signal: AbortSignal;
}

export function localAgentTools(deps: LocalToolDeps): AgentTool[] {
  return [
    {
      name: "computer_observe",
      label: "computer_observe",
      description:
        "Capture the current screen of this computer. Returns a frame and the active window. Observe before any coordinate-based action and whenever something else may have changed the screen.",
      parameters: Type.Object({}),
      execute: async (_id, _params) => {
        const frame = await deps.screen.capture();
        return textAndImage(frame);
      },
    },
    {
      name: "computer_act",
      label: "computer_act",
      description:
        "Perform up to 24 ordered desktop actions. Action kinds: click, move, down, up, type, key, scroll, wait, focus, open, launch. Batch only predictable actions; stop before an outcome you need to inspect.",
      parameters: Type.Object({
        actions: Type.Array(Type.Object({
          kind: Type.String(),
          x: Type.Optional(Type.Number()),
          y: Type.Optional(Type.Number()),
          text: Type.Optional(Type.String()),
          key: Type.Optional(Type.String()),
          application: Type.Optional(Type.String()),
          path: Type.Optional(Type.String()),
          direction: Type.Optional(Type.String()),
          amount: Type.Optional(Type.Number()),
          ms: Type.Optional(Type.Number()),
        })),
        observe: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => {
        const actions = parseComputerActions((params as { actions?: unknown }).actions);
        for (const action of actions) {
          const verdict = await deps.grant.check(action);
          if (verdict.allowed) continue;
          if (verdict.denied) {
            return textResult(`Refused: ${verdict.reason}`);
          }
          // 需要逐次确认
          const pattern = actionPattern(action);
          if (deps.deniedPatterns.has(pattern)) {
            return textResult(`Refused: the user declined this kind of action earlier in this task.`);
          }
          const ok = await deps.confirm({
            action, app: await deps.screen.activeApp(), at: new Date().toISOString(),
          });
          if (!ok) {
            deps.deniedPatterns.add(pattern);
            return textResult(`Refused: the user declined this action.`);
          }
        }
        const observation = await deps.screen.apply(actions);
        return textAndImage(observation);
      },
    },
    // shell / read_file / write_file / list_files / open_path / launch_app 同理，
    // 各自在 execute 前过 grant.check()。
  ];
}
```

要点：
- **`type` 动作永远走 `confirm`**，不进预授权（§2.0.1）。`actionPattern` 把动作归一成一个可比较的形状（`type`、`click@Safari`、`shell:curl`），供「拒绝集合」使用。
- **`textAndImage`** 返回 `AgentToolResult` 的多模态 content（`{type:"text"}` + `{type:"image"}`），与 `packages/adapter-kit/src/types.ts` 的 `AgentToolExecutionResult` 一致。
- 工具描述**不复用** `builtin-tools.ts` 里服务端那套长描述（那些提到「bot 的电脑」「Team Computer」等服务端概念）。设备端的描述要按本机语义重写。

#### 2.5.3 主循环

```ts
// packages/adapters/src/local-agent/loop.ts
import { Agent } from "@earendil-works/pi-agent-core";

export interface LocalAgentRun {
  task: LocalAgentTask;
  tools: AgentTool[];
  model: RuntimeModelTarget;
  signal: AbortSignal;
  onEvent: (event: TaskEvent) => void;
}

export async function runLocalAgent(run: LocalAgentRun): Promise<LocalAgentResult> {
  const startedAt = Date.now();
  let steps = 0;

  const agent = new Agent({
    sessionId: `device:${run.task.taskId}`,
    steeringMode: "none",
    getApiKey: async () => run.model.apiKey,
    tools: run.tools,
    // 设备端没有 steering、没有 follow-up 注入、没有子 agent。
  });

  const answer = { text: "", steps: 0, blocked: 0 };

  agent.subscribe(async (event) => {
    if (event.type === "tool_execution_start") {
      steps += 1;
      run.onEvent({
        kind: "step",
        at: new Date().toISOString(),
        index: steps,
        // 摘要，不含坐标/截图/输入文本。
        action: describeToolActivity(event.toolName, event.args),
        summary: "",
      });
      if (steps > run.task.budget.maxSteps) {
        run.signal.abort(new Error("step budget exceeded"));
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      answer.text = lastAssistantText(event.message);
    }
  });

  // 超时也要真正停掉循环，不只是不再发新请求。
  const timer = setTimeout(
    () => run.signal.abort(new Error("task timed out")),
    run.task.budget.maxSeconds * 1000,
  );

  try {
    await agent.prompt(run.task.prompt);
  } catch (error) {
    run.onEvent({ kind: "failed", at: new Date().toISOString(), error: errorText(error) });
    return { ...answer, ok: false };
  } finally {
    clearTimeout(timer);
  }

  run.onEvent({
    kind: "finished",
    at: new Date().toISOString(),
    answer: answer.text,
    summary: summarizeSteps(steps, answer.text),
  });
  return { ...answer, ok: true };
}
```

要点：
- **不用 `pi-runtime.ts` 的 `streamFn` / `finishTurn` / `prepareNextTurnWithContext`**——那是服务端 run 的机制（steering、shell 完成回注、上下文裁剪）。设备端 loop 不需要。
- **超时用 `signal.abort`**，Pi 的 `Agent` 支持 abort（`pi-runtime.ts` 里的 `controller.abort()` 同样用法）。
- **步数预算**：超了直接 abort，并回报失败。`budget.maxSteps` 由云端下发（防止 agent 无限点击）。
- **`describeToolActivity`** 复用 `packages/adapters/src/pi-runtime-tools.ts:117` 的现成函数——它已经把工具调用压成一行人类可读摘要，正好符合「事件不含坐标/截图」的要求。

#### 2.5.4 模型绑定

```ts
// packages/adapters/src/local-agent/model.ts
import type { Model, MutableModels, Provider } from "@earendil-works/pi-ai";

export type DeviceModelRef =
  | { kind: "local"; baseUrl: string; modelId: string; acceptsImages: boolean }
  | { kind: "openai-compatible"; baseUrl: string; modelId: string; apiKey: string; acceptsImages: boolean }
  | { kind: "anthropic"; apiKey: string; modelId: string; acceptsImages: boolean };

export function bindDeviceModel(models: MutableModels, ref: DeviceModelRef): Model<"openai-completions"> {
  // local 与 openai-compatible 都能用 OpenAI 兼容的 wire 格式；
  // anthropic 走 pi-ai 自带的 anthropic api。
  // 复用 packages/adapters/src/pi-openai-compatible-provider.ts 的
  // openAiCompatibleProvider()，它已经处理了 key 的传递与 SSRF 防护。
}
```

**复用 Pi 的 provider 原语，但不复用服务端那层守卫**（实现时修正）：
- **内置 provider**（OpenAI / Anthropic / OpenRouter 等）→ 复用 Pi 的 `builtinModels()` + `applyPiModelCompatibility()`，设备端和云端走同一份目录。
- **自建 / 本地端点** → 在设备端用 `createProvider()` + `openAICompletionsApi()` **直接注册**，照抄 `pi-local-provider.ts` 的写法，**不调** `registerOpenAiCompatibleRuntime()`。
  原因（CI 抓出来的）：`pi-openai-compatible-provider.ts` → `network-address.ts` → `@rakazo/db` → Prisma。桌面端一旦 import 它，esbuild 会把整个数据库包和 Prisma 客户端打进 Electron 主进程——CI 上没有生成 Prisma 客户端，桌面构建直接失败；就算本地生成了，主进程包也会从 6.7 MB 涨到 14 MB，并带进一堆它永远不会用的服务端依赖。改直连注册后 `packages/db` 在桌面 bundle 里是 **0 个模块**。

**为什么服务端那层守卫本来也不该来设备端**：它的作用是阻止**bot**在共享服务器上解析到私网/元数据地址。而在用户自己的 Mac 上，`127.0.0.1` 正是本地模型的地址——这个守卫在设备端不是「放宽一下」的问题，而是它保护的资产不在那儿。设备端真正的边界是 §0.4 的默认禁出口。

#### 2.5.5 凭据存取

```ts
// apps/desktop/src/device-model-credentials.ts（新增）
// 与 apps/desktop/src/user-device.ts 的 deviceTokenCipher 同构。
export interface DeviceModelStore {
  list(): Promise<DeviceModelConnection[]>;   // 不含 secret
  save(connection: DeviceModelConnection & { secret?: string }): Promise<void>;
  remove(id: string): Promise<void>;
  resolveSecret(connectionId: string): Promise<string>;  // 只在设备端调用
}

export interface DeviceModelConnection {
  id: string;                 // 随机 id，云端只看到这个
  label: string;              // 显示名
  kind: "local" | "openai-compatible" | "anthropic";
  baseUrl?: string;
  modelId: string;
  acceptsImages: boolean;
}
```

- **secret 存 Keychain**：用 `safeStorage`（`main.ts:1024` 的现成 `deviceTokenCipher()` 模式）加密后写到 `userDataDir` 下的私有文件（`0600`）。macOS 上 `safeStorage` 落到 Keychain。
- **云端只看到 `DeviceModelConnection`**（不含 secret）。任务里传 `connectionRef`（= `id`），设备端用 id 查本地存储取 secret。
- **取不到就报错**，不回退到任何默认凭据、不把 secret 写进日志、不放进 `TaskEvent`。
- **Linux 无 keyring 时**（`safeStorage` 落在 `basic_text`）沿用现有 `deviceTokenCipher` 的判断：不可用时**不提供「你的 key」这一档**，只留本地模型档。

#### 2.5.6 设备端薄壳

```ts
// apps/desktop/src/local-agent-host.ts（新增）
// Electron 主进程里跑：收到 task 消息 → 跑 loop → 回 taskEvent。
export function createLocalAgentHost(deps: {
  credentials: DeviceModelStore;
  screen: HostScreen;
  confirm: (req: ActionApprovalRequest) => Promise<boolean>;
  send: (event: TaskEvent) => void;
}) {
  return {
    async handleTask(task: LocalAgentTask, signal: AbortSignal) {
      const ref = await deps.credentials.resolve(task.model.connectionRef);
      const tools = localAgentTools({ ... });
      return runLocalAgent({ task, tools, model, signal, onEvent: deps.send });
    },
  };
}
```

`confirm` 通道的实现：设备端把 `ActionApprovalRequest` 通过 `taskEvent` 发给云端，云端弹审批卡，用户的选择通过一条新的下行消息 `{ type: "taskApproval", id, approved }` 回给设备。设备端在 `confirm` 的 Promise 上等待，超时（5 分钟）按拒绝处理。

### 2.7 与 v1 图形能力的关系

v1 计划里的「静帧 `observe` + 动作 `act`」的**底层原语**（截图、输入注入、TCC 探测）**完全复用**到本地 agent 的工具实现里。区别只在**谁来决策**：

- v1：云端 agent 每步决策，每步上行一张图。
- v2：本地 agent 每步决策，**图不出 Mac**。

所以：**先实现原语，再在其上实现本地 agent**。原语部分的工作量在两个方案间是共享的，不浪费。

### 2.8 云端 bot 怎么用

**不需要新增工具。** 复用 `cloud_agent_launch` / `cloud_agent_status` / `cloud_agent_reply` / `cloud_agent_cancel`，只是后端 provider 换成本地设备。模型侧的工具描述需要调整（现在是「远程云端编程 agent…打开 PR」），改成通用描述。

不过更自然的是**新增一个语义更准的工具名**，比如 `device_agent_run`，避免「云 agent」和「我的 Mac」混淆。代价是多一套工具定义与契约。**建议新增工具名**，因为语义差异大（编程 agent vs 操控我的电脑），复用会让模型误解。

### 2.9 验收标准（M1）

- [ ] Mac 端未授权屏幕录制时，本地 agent 拒绝 GUI 任务并给出「需要屏幕录制权限」的清晰原因，不静默失败。
- [ ] 授权后，本地 agent 能在本地浏览器 fixture 上完成「打开 → 点击 → 读取结果」，全程**无图片上行**（用抓包或服务端日志证明）。
- [ ] 默认档（你的 key 直连）下，屏幕帧从 Mac 直达模型厂商：**Rakazo 服务端日志与数据库中检索不到任何截图字节**。
- [ ] 不存在「经 Rakazo 代理模型调用」这一档：配置界面里没有这个选项，协议里也没有这个字段。
- [ ] 授权包为默认全禁时，任务只允许 `read_file` 范围内的只读操作；越界动作产生 `blocked` 事件，云端能看到原因。
- [ ] **逐次确认生效**：一个不在 `preapproved` 里的点击动作会挂起设备端、在云端弹出显示具体动作的审批卡；批准后执行，拒绝后不执行。
- [ ] **拒绝有记忆**：用户在一次任务里拒绝过 `type` 动作后，同类 `type` 动作后续直接被拒，不再弹卡。
- [ ] **`type` 永不被预授权**：即使授权包把某应用列入 `preapproved`，`type` 动作仍走逐次确认，且审批卡显示待输入文本全文。
- [ ] **网络默认关闭**：`shell` 里的 `curl` 被拒；`web_fetch` 除非 `preapproved` 显式列出 host 否则被拒。
- [ ] 授权包过期后，本地 agent 立即停止并回报。
- [ ] 菜单栏「停止」在 2 秒内中止本地任务，且后续工具调用全部被拒。
- [ ] 本地任务进行中，服务端重启后任务状态可恢复（`CloudAgent` 的 lease/fence 语义已覆盖，需验证）。
- [ ] provider key 只存在于 Mac Keychain：服务端数据库、API 响应、日志中均检索不到该 key。
- [ ] 老版本桌面客户端（不认识 `task` 消息）连接时，设备侧忽略该消息，云端在超时后标记任务失败，不崩溃。

### 2.10 工作量估算

| 项 | 人日 |
| --- | --- |
| 屏幕捕获 + 输入注入 + TCC 探测（macOS） | 8 |
| 本地 Pi loop + 工具集（§2.5） | 6 |
| 授权包：两层判定 + 设备端强制 | 4 |
| **逐次确认通道**（设备端挂起/等待/超时 + 云端审批卡接线） | 4 |
| 设备协议扩展（task/taskEvent/taskApproval）+ 客户端 | 5 |
| `LocalDeviceAgentProvider` + provider 按用户解析 | 5 |
| 模型凭据本地存储（Keychain）+ 设置 UI | 4 |
| 菜单栏状态 + 一键中断 | 3 |
| 本地模型 provider 绑定 + 私网例外 | 2 |
| 文档 + changelog | 2 |
| **合计** | **约 43 人日** |

比 v1 的 20 人日多，因为多了「本地 agent loop + 两层授权 + 逐次确认通道 + 凭据管理」。但换来的是：**隐私承诺成立、带宽降一个数量级、审批既不烦人也不失控**。

比上一版（38 人日）多的 5 人日，全部花在**逐次确认通道**上——这是把审批粒度从「任务级」细化回「动作级」的成本。

---

## 3. 里程碑 M2：活动记忆（G2）

### 3.1 设计原则（已按推荐确定）

1. **原始数据不出设备**。截图、完整窗口标题、完整 URL 只存在 Mac 本地；上传的是**摘要**（应用名、停留时长、域名、截断标题）。
2. **采集默认关闭**，且与 M1 的屏幕控制开关**互相独立**。
3. **可暂停、可删除、可导出**。删除是真删（含本地缓存）。
4. **加密落库**。新增表必须加进 `ENCRYPTED_MODELS`（`packages/db/src/content-encryption.ts:47`）。
5. **不采集按键内容、不采集剪贴板全文、不采集密码框**。

### 3.2 采集端（`apps/desktop/src/activity-collector.ts`，新增）

| 源 | API | 权限 | 备注 |
| --- | --- | --- | --- |
| 前台应用 | `NSWorkspace.frontmostApplication`（koffi）或 Electron `powerMonitor` | 无 | 最基础，先做 |
| 窗口标题 | Accessibility `kAXFocusedWindow` | 辅助功能 | 无授权时降级为只记应用名 |
| 浏览器 URL | Accessibility 读地址栏 | 辅助功能 | 不做浏览器插件，避免多一个安装面 |
| 文件打开/保存 | `FSEvents`（koffi）或轮询 | 无 | 只记路径与时间，不读内容 |
| 剪贴板 | **不采集** | — | 隐私边界 |
| 按键 | **不采集** | — | 隐私边界 |

**聚合**：每 5 秒采样；同一 (app, title) 连续出现合并成段，记 `startedAt/endedAt/durationMs`；单段超过 30 分钟强制切段。本地 SQLite（先确认 Electron 45 的 Node 版本有 `node:sqlite`；没有就用 `better-sqlite3`）。**本地保留默认 7 天滚动删除。**

### 3.3 数据模型

```prisma
/// 一条聚合后的活动段。内容加密；只有摘要字段参与查询。
model ActivitySegment {
  id        String   @id @default(cuid())
  spaceId   String
  userId    String
  deviceId  String
  startedAt DateTime
  endedAt   DateTime
  /// 前台应用标识（bundle id 或进程名），明文，用于过滤。
  appId     String
  /// 加密后的 JSON：{ appName, title, url?, domain?, filePath? }
  detail    String
  /// 摘要文本（供模型检索，加密）。
  summary   String
  createdAt DateTime @default(now())

  @@index([spaceId, userId, startedAt])
  @@index([deviceId, startedAt])
  @@map("activity_segments")
}

/// 每天一次的整理结果，指向 MemoryDocument。
model ActivityDigest {
  id         String   @id @default(cuid())
  spaceId    String
  userId     String
  day        String                  // YYYY-MM-DD（用户时区）
  documentId String?
  status     String   @default("pending") // pending | done | failed | skipped
  error      String?
  createdAt  DateTime @default(now())

  @@unique([spaceId, userId, day])
  @@map("activity_digests")
}
```

**约束**：只新增表（符合 `AGENTS.md` 的迁移前向兼容要求）。`detail`/`summary` 必须进 `ENCRYPTED_MODELS`，`ownerRelation: "user"`。`day` 用**用户时区**而非 UTC。

### 3.4 上传与入库

- 设备协议新增 `{ type: "activitySync", segments: [...] }`（复用 outbound 通道，不新开端口）。
- 服务端新增 RPC（`apps/api/src/routes/activity.ts`）：
  - `activity.settings` / `activity.updateSettings`（开关、保留期、排除的应用/域名）
  - `activity.pause` / `activity.resume`
  - `activity.delete`（真删）
  - `activity.exportMarkdown`（导出成 `memory/YYYY-MM-DD.md` 格式）
- 入库前服务端再脱敏：URL 去掉 query，路径只保留文件名，标题截断。

### 3.5 整理（定时整理记忆）

**触发**：每日一次，新增后台 job `activity.digest`（不用让用户自建 routine）。记忆整理是产品内建的维护动作，与 `history.compact` 同级。

**流程**（`packages/adapters/src/activity-digest.ts` 新增）：

1. 取当天所有 `ActivitySegment`，按应用/域名聚合（时长、次数、首末时间）。
2. 生成结构化摘要（**不调模型**）：应用时长表、访问最多的 10 个域名、打开的文件、按小时热力。
3. 调模型做一次**语义提炼**：
   - 输入：结构化摘要 + 已有 `MEMORY.md` / `USER.md`。
   - 输出：`memory/YYYY-MM-DD.md` + 对 `USER.md` 的**候选修改**（不直接改）。
   - **必须用显式版本化 rubric**（`AGENTS.md` 要求）：什么算「值得记住」、什么算「偏好」、什么可忽略。rubric 文件带版本号，写入 `ActivityDigest`。
   - 判断「是否值得记忆」是自由文本判断，**不能**用关键词/正则。
4. `memory/YYYY-MM-DD.md` 直接写入。
5. `USER.md` / `MEMORY.md` 的修改生成**审批卡**（复用 `propose_instructions_update` 的卡片机制），用户同意才写。

**为什么把「提炼」和「写长期记忆」分开**：直接让模型改 `USER.md` 会积累错误偏好且用户难发现。审批卡让用户每天扫一眼。

**降级**：没配模型或模型不可用 → 只生成结构化摘要写入 daily note，`status = "skipped"`。

### 3.6 UI

- 设置页（web/desktop/mobile）：开关、保留期、排除列表、「暂停 1 小时 / 今天」、「立即删除全部」。
- 首页卡片：每天首次打开显示「昨天的活动已整理」。
- 文案遵循 `AGENTS.md`「keep UI minimal」：一行状态 + 一个开关，不加解释性文字。

### 3.7 合规与信任

- 会触发 App Store 数据收集申报（macOS 走 DMG，但 iOS/Android 的 AI 数据披露需同步更新 `AiDataUse`）。
- `docs/ai-data-sharing-review.md` 的发布门禁加一条：活动数据是否离开设备。
- 托管部署默认关闭采集（operator 开关，如 `ACTIVITY_CAPTURE_ENABLED`），与 `USER_DEVICES_ENABLED` 同级。

### 3.8 验收标准（M2）

- [ ] 关闭开关时：Mac 不采样、不建本地库、不上传。
- [ ] 开启 24 小时后生成一份 `memory/YYYY-MM-DD.md`，含应用时长与域名统计。
- [ ] 出现密码管理器窗口时跳过该段（只记「用了 1Password 3 分钟」）。
- [ ] 删除后服务端 `activity_segments` 与本地 SQLite 都无对应记录。
- [ ] `USER.md` 修改必须经审批卡；未审批时 daily note 仍生成。
- [ ] 未配置模型时 `status = "skipped"` 且不报错。

### 3.9 工作量估算

| 项 | 人日 |
| --- | --- |
| macOS 采集器 | 6 |
| 本地 SQLite + 聚合 | 3 |
| 协议 + 服务端 RPC + 表 + 加密 | 5 |
| digest job + rubric + 结构化摘要 | 6 |
| 审批卡接 `USER.md` | 2 |
| UI（设置 + 卡片 + 删除/导出） | 4 |
| 文档 + 合规 | 2 |
| **合计** | **约 28 人日** |

---

## 4. 里程碑 M3：可扩展性（G3）

### 4.1 边界（`VISION.md` 明确的两条）

> "Plugins in the shared plugin format install as ordinary connectors and skills rather than a runtime of their own."
> "Plugin parts that would run the plugin's own code on our side, such as hooks, language servers, local MCP commands and skill scripts, are not installed."

所以扩展必须分三层，逐层放开，**每层能单独用**。

| 层 | 内容 | 执行第三方代码？ | 门槛 |
| --- | --- | --- | --- |
| **L1 声明式** | `extensions.rakazo`：声明工具来源、默认 settings、UI 文案键、所需宿主能力 | 否 | 低 |
| **L2 远程工具**（已有） | 远程 MCP / OpenAPI / GraphQL / Treg | 否（代码在对方服务器） | 已有 |
| **L3 宿主适配器** | 在用户自己 Mac 上运行的薄适配器，通过 MCP 暴露本地能力 | **是，但跑在用户设备上** | 高：签名 + 显式授权 + allowlist |

### 4.2 L1：把 `extensions` 字段变成真的

现在 `plugin-connectors.ts:536` 接受 `extensions` 但完全忽略。定义 `extensions.rakazo` **v1**：

```json
{
  "name": "mac-shortcuts",
  "extensions": {
    "rakazo": {
      "schemaVersion": 1,
      "capabilities": ["host.apps.launch", "host.files.read"],
      "settings": [
        { "key": "defaultFolder", "type": "string", "label": "Default folder" }
      ],
      "tools": [
        { "name": "open_shortcut", "mcpServer": "shortcuts", "tool": "run_shortcut" }
      ]
    }
  }
}
```

规则：
- `schemaVersion` 不匹配 → 预览时明确报 "This plugin targets a newer Rakazo"，**不静默忽略**（静默忽略正是当前 `extensions` 的问题）。
- `capabilities` 必须在服务端白名单里；未知能力 → 预览拒绝安装。
- `settings` 只支持 `string | number | boolean | enum`，不支持嵌套对象。
- 安装时把 `capabilities` 与用户授权一起存进 `CapabilityInstall.config`，作为工具可见性的输入。

**这一层不执行任何代码**，纯粹让插件描述「我需要什么能力」，服务端据此决定给不给工具。

### 4.3 L3 与本地 agent 的关系（新增洞察）

v1 计划里，L3「宿主适配器」的风险是「等于允许执行任意本地代码」。但在 v2 架构下风险大幅下降：

- 适配器跑在**用户自己的 Mac 上**，由用户自己安装、自己启动、自己授权。
- **Rakazo 服务端永远不启动这个进程**，因此不违反 `VISION.md` 的「不在我们这边执行插件代码」——执行发生在用户自己的机器上。
- 适配器通过 MCP 暴露能力，Mac 上的本地 agent 可以调用它。

所以 L3 的自然形态是：**用户在 Mac 上装一个本地 MCP server（stdio 或本地 HTTP），本地 agent 连上它**。这与已有的 `MCP_STDIO_ENABLED` allowlist 机制同构，只是执行位置从服务器挪到了用户设备。

L3 仍需：安装确认（原生弹窗）、命令 allowlist、随 app 退出而终止、超时与输出上限。这条路留到 M1 之后单独评审（**本轮不做**）。

### 4.4 不做的事

- 不做插件自带 UI 面板（任意 HTML/JS 在 app 内渲染 = 新的 XSS/CSP 面）。
- 不做插件 hook（`before_tool` / `after_run`）——`VISION.md` 明确拒绝。
- 不 fork Rakazo 自己的插件市场；继续用 Cursor / xAI registry + 提交审核。

### 4.5 验收标准（M3）

- [ ] 带 `extensions.rakazo` 且 `schemaVersion: 1` 的插件，安装预览显示其声明的能力与设置项。
- [ ] 声明未知 `capabilities` 的插件在预览阶段被拒绝，原因可读。
- [ ] 不带 `extensions` 的旧插件行为完全不变（回归测试）。

### 4.6 工作量估算

| 项 | 人日 |
| --- | --- |
| `extensions.rakazo` schema + 校验 + 预览 UI | 5 |
| 能力白名单 + 安装记录 | 2 |
| **合计** | **约 7 人日** |

---

## 5. 依赖与顺序

```
M1（本地 Agent）
 ├─ 2.5 原语（截图/输入/TCC）—— 与 v1 共享，不浪费
 ├─ 授权包实现（共享一份，设备端强制）
 ├─ 设备协议扩展（向后兼容：老客户端忽略新消息）
 └─ provider 按用户解析（改动现有 cloud agent 装配）

M2（活动记忆）
 ├─ 依赖：M1 的 TCC/辅助功能探测复用
 ├─ 依赖：加密落库
 └─ 可与 M1 并行

M3（扩展性 L1）
 └─ 无依赖，零风险，收益/成本比最高
```

**建议排期**：M3-L1（7 人日）→ M1 原语（8 人日）→ M1 主体（35 人日）→ M2（28 人日）。
M2 的采集端可以与 M1 主体并行开发。

**当前进度**（2026-10-30）：

| 部分 | 状态 | 落点 |
| --- | --- | --- |
| 屏幕原语（截图 / 输入注入 / 窗口信息 / TCC 探测） | **已实现并在本机验证** | `apps/desktop/src/{screen-capture,macos-native,macos-keys}.ts` |
| `HostScreen` 契约（平台无关） | **已实现** | `packages/adapters/src/host-screen.ts` |
| 授权包判定（两层：预授权 / 逐次确认 / 硬禁止） | **已实现** | `packages/adapters/src/local-agent/grant.ts` |
| shell 命令的网络目标识别 | **已实现** | `packages/adapters/src/local-agent/network-target.ts` |
| 设备协议扩展（任务 / 事件消息） | **已实现** | `packages/adapters/src/user-device-protocol.ts`、`local-agent/{task,grant}-protocol.ts` |
| 本地 Pi loop（主循环 / 工具集 / 系统提示词） | **已实现** | `packages/adapters/src/local-agent/{loop,tools,system-prompt,shell}.ts` |
| 模型绑定 | **已实现** | `packages/adapters/src/local-agent/model.ts` |
| 凭据存取（Keychain，云端只见 `connectionRef`） | **已实现** | `apps/desktop/src/device-model-credentials.ts` |
| 桌面端接线 | **已实现** | `apps/desktop/src/local-task-runner.ts`、`main.ts` |
| 云端 `LocalDeviceAgentProvider` | 未开始 | `packages/adapters/src/` |
| 逐次确认的审批卡 UI | 未开始（协议已通，界面未做） | `apps/web` |
| 菜单栏常驻状态 + 一键中断 | 未开始 | `apps/desktop` |

---

## 6. 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **本地 agent 被屏幕内容诱导** | 诱导执行越权动作或外传数据 | 授权包默认全禁 + 设备端强制 + **默认禁网络出口** + 注入内容一律当数据不当指令 |
| **授权包被误批** | 一次批准换来长时间的实际控制权 | 两层设计：预授权只覆盖低危只读操作；高危动作（`type`、写文件、shell、网络）逐次确认；授权包有过期时间；菜单栏常驻状态 + 一键中断 |
| **逐次确认被绕过** | agent 用近似动作骗过授权 | 拒绝集合按**动作模式**归一（不是按参数值）；`type` 永不在预授权内；判定在设备端，云端无法绕过 |
| **逐次确认太吵** | 用户烦了直接全批准 | 预授权覆盖高频只读场景；拒绝后同类不再弹；审批卡显示具体动作让用户能快速判断；超时按拒绝而非放行 |
| **TCC 权限被系统静默撤销** | 功能突然失效 | 每次连接探测 + 明确 UI 提示 + 文档说明如何重新授权 |
| **provider key 泄漏** | 账号被盗刷 | 只存 Mac Keychain；不下发云端；不进日志；任务参数里只传不含秘密的连接 ID；取不到就报错不回退 |
| **本地模型质量不足** | GUI 任务做不好 | 默认档是「你的 key 直连」（§0.6）；本地模型定位为「命令/文件类任务」；UI 里说清差别 |
| **老桌面客户端不兼容** | 任务卡住或 500 | 设备侧忽略未知消息；云端超时后标记失败；服务端按设备能力（`capabilities` 探测）决定是否下发 |
| **设备断连时任务悬挂** | 云端一直等 | `CloudAgent` 的 lease + `nextPollAt` + `errorCount` 已有；补上「设备离线即失败并唤醒 bot」 |
| **活动采集被理解为监视** | 信任崩塌 | 默认关闭、开关独立、菜单栏可见指示、真删除、只上传摘要 |
| **实时流带宽/CPU** | 发热耗电 | 本方案无实时流；本地 agent 只在需要时截图 |
| **L3 成为任意代码执行入口** | 供应链风险 | 本轮不做；将来只在用户设备上跑、显式安装、命令 allowlist、单独安全评审 |

---

## 7. 决策状态汇总

| 决策 | 状态 | 结论 |
| --- | --- | --- |
| 模型默认档位 | **已定** | 你的 provider key 直连；本地模型为可选档；**永不提供经 Rakazo 代理档**（§0.6、§2.0.2） |
| 审批粒度 | **已定** | 任务级授权包 + 设备端逐次确认；`type` 永不预授权（§0.3、§2.0.1） |
| 屏幕流 | **已定** | 不做实时流。v2 下帧根本不上行（§0.2） |
| 活动数据 | **已定** | 只上传摘要；托管部署默认关闭采集（§0.5、§3.1） |
| L3 宿主适配器 | **已定** | 本轮不做（§4.3） |

**未决且不阻塞开工**：设备端 agent 的 `systemPrompt` 具体措辞（写第一版再按实际行为调）；本地模型档位支持哪些 provider（先 Ollama + LM Studio）。

---

## 8. 附：一处现成的不一致（顺手可修）

`apps/api/src/computer-status.ts:89`：
```ts
screenAvailable: !computer?.maintenanceId && (state === "running" || state === "booting"),
```
对 `kind === "desktop"` 也返回 `true`，但 desktop 根本没有屏幕。前端靠 `screenMissing()` 里的 `kind !== "desktop"` 绕开了，但 API 字段本身是错的，任何新客户端都会被误导。建议改成 `screenAvailable: kind !== "desktop" && ...`。

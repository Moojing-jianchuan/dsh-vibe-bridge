# dsh-vibe-bridge（中文说明）

[English](README.md) · **中文**

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的插件：把**父子会话**这条链路上缺的三件事补上 —— 不花模型轮次就能建子会话、父会话能读到子会话到底产出了什么、侧栏里能看见这层关系。

> DSH 本来就把"会话血缘"当一等公民：父会话通过 `subagent` 工具派生一个子会话。但周边体验很薄：
> 子会话的 session id 永远到不了父会话手里；侧栏按设计隐藏 `origin: 'subagent'` 的行；
> 也没有便宜的办法问一句"那个子会话到底做了什么"。
> 这个插件用**纯 Cordis 插件**补齐，另外提供一个可选的构建级增强（让子会话行出现在**原生**侧栏里）。

![桌面版：子会话缩进挂在父会话下面](docs/screenshots/desktop-nested-sessions.png)

## 实际长什么样

父会话一行，它的子会话往右缩进一格，每个父行自带一个折叠开关（`▾` 展开 / `▸` 收起）。左侧那个 `Vibe Bridge` 入口打开调度台页面：会话树、创建子会话表单、当前生效的碎碎念规则。

子会话是**真正的会话**：点开就是它自己的对话；它每完成一轮，父会话会收到一条带 session id 的通知，不需要再额外调 `list_sessions` 去查 id。

### 细节：子会话到底收到了什么

任务原文直接作为子会话的**第一条用户消息**到达 —— 不是"请你去调 spawn_session 建一个子会话"那种转述。下面这个子会话是从侧栏右键建出来的，14 秒内确认收到，并用 `send_message` 回报父会话：

![子会话收到父会话下发的任务原文并确认投递](docs/screenshots/child-session-delivery.jpg)

第二张是父会话真正关心的那一趟往返：子会话复述任务、说明工作目录、把结果发回父会话的 session id —— 一次完成，工具调用在对话里可见：

![子会话完成指派并把结果回报给父会话](docs/screenshots/child-session-report.jpg)

## 功能一览

| # | 功能 | 实现方式 | 需要可选补丁？ |
|---|---|---|---|
| 1 | **直接建子会话** —— 右键任一会话 →「创建子会话」，或用 `/vibe-spawn 名字\|任务`，或用插件面板 | 注册宿主命令（`ctx.commands.register`）后直接 `startActivation`；子会话收到的第一条消息就是任务原文，不是"请去创建子会话"的转述 | 否 |
| 2 | **父会话拿到子会话 id** —— 每次**被指派的运行**完成一条通知，带 id + 状态，同批合并 | `subagents.startActivation` 配 `delivery: "caller"`，再用 `agent.followup` 投递；合并窗口把同时收工的多个子会话压成一条。只有"本插件建出来的"或"父会话用 `post_to_session` 投过任务的"运行才算指派；你自己在子会话里聊的轮次不会回报父会话 | 否 |
| 3 | **`query_session`** —— 读另一个会话最近几轮 | 流式读 JSONL 会话日志、按魔数切多帧 zstd、渲染轮次与工具摘要 | 否 |
| 4 | **`post_to_session` / `stop_session` / `list_sessions`** | 对 subagent 服务的薄封装，带父子角色校验 | 否 |
| 5 | **轮次碎碎念** | `agent/pre-step` 在指定轮次注入提醒；文案每轮从磁盘重读（改文件即时生效）；连续相同内容折叠成一行标记 | 否 |
| 6 | **唤醒状态落盘** | `<DSH_HOME>/vibe-bridge/wake-state.json`，原子写、12 小时 TTL、启动补偿 | 否 |
| 7 | **原生侧栏里的缩进子行 + 折叠** | 对 `ui-workspace` 的源码补丁 + 自建该包产物 | **是**（实验性，跟版本绑定）|

除第 7 项外都是标准插件。原因很实在：DSH 在会话列表里只声明了 `menu.item` / `row.action` / `row.leading` / `row.hover` 四个插槽，**没有"插入一行"的插槽**，所以纯插件无论如何做不到原生子行 —— 这是接口事实，不是偷懒。

### 哪些运行会回报父会话

子会话只在"父会话要的那一轮"完成时回报：

| 谁发起的这一轮 | 会不会回报 |
|---|---|
| 本插件（`spawn_session`、面板「创建子会话」、`/vibe-spawn`） | 会 —— 该 activation 收尾时回报一次 |
| 父会话再给它投任务（`post_to_session`） | 会 —— 每条消息回报一次：投递时重新 arm，投完的第一次收尾就回报 |
| **你自己**在子会话里打字聊天 | **不会** —— 子会话没被 arm，父会话不受打扰 |
| 子会话回报之后自己继续干活 | 不会 |

这就是 `wake-state.json` 里的 `armed` 标记：插件建子会话或父会话投递时置上，通知入队时清掉，重启补偿也只补"还 armed 且没回报过"的条目。所以打开子会话随便聊不会惊动它的父会话，而真正派下去的活一定会带着 session id 回来。

## 安装（插件部分）

```bash
# 1) 一次性指向你的 DSH 安装目录，让测试和安装能解析 @deepseek-ai/*
node tools/dev-link.mjs --dsh "/path/to/dsh"
#    或者：--dsh-node-modules "/path/to/dsh/node_modules"

# 2) 跑契约测试（对着真实服务形状跑，服务改版会当场红）
npm test

# 3) 装进某个 profile（幂等；--uninstall 卸载）
node tools/install.mjs --profile desktop --dsh "/path/to/dsh"
```

`tools/install.mjs` 会把包复制到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-vibe-bridge`，把 `@deepseek-ai` 依赖联接到你的 DSH 安装（两半共用同一份模块实例），**在安装位置**跑一遍冒烟测试，最后往 `cordis.patch.yml` 追加插件条目。宿主半需要重启 DSH，客户端半刷新页面。

Windows 上依赖联接用的是目录 junction，不需要管理员权限、也不需要开发者模式。

## 配置

```yaml
- insert:
    - id: vibe-bridge
      name: 'dsh-vibe-bridge'
      config:
        enabled: true
        provider: spawn          # spawn=全新上下文；fork=继承父会话已完成的轮次
        wakeParentOnChildFinish: true
        wakeDebounceMs: 800      # 这个窗口内收工的多个子会话合并成一条通知
        persistWakeState: true   # 重启后仍记得在跑的子会话
        announceChildId: true    # 告诉子会话它自己的 id
        rules:
          - name: verify
            file: '/abs/path/to/nudge.md'   # 每轮重读，改完即时生效
            everyTurns: 4                   # 稀疏提醒的节奏
            fullEveryTurns: 12              # 全量文案的节奏
            fromTurn: 1
            skipSubagentSessions: true
            speakOnFirstSeen: true
```

| 键 | 默认 | 含义 |
|---|---|---|
| `rules[].text` / `rules[].file` | — | 内联文本，或每轮重读的文件路径 |
| `rules[].sparseText` | 取全文前 N 行 | 稀疏节奏发的文案 |
| `rules[].everyTurns` / `fullEveryTurns` | 1 / 0 | 节奏；`0` 表示不发全量 |
| `wakeDebounceMs` | 800 | 完成通知的合并窗口 |
| `persistWakeState` | `true` | 写 `wake-state.json` 并在启动时补偿 |
| `enableSpawn` / `enableQuery` / `enablePost` / `enableList` / `enableStop` | `true` | 逐工具开关 |

## 工具

| 工具 | 模型可见的契约 |
|---|---|
| `spawn_session(prompt, label?, cwd?)` | 建子会话，返回 `session started: <childSessionId>` |
| `post_to_session(session_id, message, stop_current?)` | 给某个会话投一条消息，前缀 `[来自会话 <id> 的消息]`；`stop_current` 先中断正在跑的直接子会话 |
| `list_sessions()` | 所有会话，含 `{id, label, status, role: parent\|child}` |
| `query_session(session_id, tail?, include_tools?, verbose?)` | 头部信息 + 最近 `tail` 轮；`verbose` 才给模型/供应商/工作目录与更长的正文 |
| `stop_session(session_id)` | 只停自己的直接子会话 |
| `vibe_bridge_status()` | 在线状态、规则列表、已注入次数**与字符数** |

宿主命令 `/vibe-spawn <名字>|<任务>` 就是界面里「创建子会话」背后的那条路径 —— 所以建子会话不消耗父会话的任何模型轮次。

## 上下文成本（实测）

在一条 19 轮的父会话上量的（只算模型可见的 `content` 文本，不重复计 `source.sections` 那份副本）：

| 项 | 0.6.0 之前 | 之后 |
|---|---|---|
| 注入的提醒条数 | 12 | 12（节奏完全不变）|
| 注入字符 | 2,501 | 预期约 1.2k —— 相同内容折叠成一行标记 |
| 占 user 侧内容比例 | **54 %** | 约减半 |
| `query_session` 报告长度 | 938 字符（verbose 形态）| 默认 818，`verbose: true` 才 938 |
| 5 个子会话的完成通知 | 5 条 | **1** 条合并 |
| `announceChildId` | 180 字符 | 96 字符 |

碎碎念**仍然以可见的用户消息出现**，这是刻意的：搬进 system prompt 更省 token，但那会把"看得见的提醒"降级成"看不见的规则"，属于功能打折。

## 可选：原生侧栏里的子会话行

```bash
# 1) 拿到补丁对应的 DSH 源码
git clone --depth 1 --branch dsh-v0.2.1-rc.5 https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness

# 2) 应用补丁并构建这个包的产物
git apply -p1 /path/to/dsh-vibe-bridge/tools/source-patch/nested-sessions.patch
pnpm install
pnpm run build:artifacts

# 3) 把构建出来的那一个 bundle 装进你的 DSH（原产物留作备份）
node /path/to/dsh-vibe-bridge/tools/install-bundle.mjs \
  --bundle packages/client/ui-workspace/lib/client.js \
  --dsh-node-modules "/path/to/dsh/node_modules"

# 随时回退
node /path/to/dsh-vibe-bridge/tools/install-bundle.mjs --restore --dsh-node-modules "…"
```

补丁到底做了什么（7 个源码文件 + 3 个测试文件，外加 README 及其 i18n 记录）：

- 子行缩进挂在父行正下方，标题优先取**实时**会话标题（重命名立即生效）→ catalog label → id 前 8 位；
- 每个父行一个折叠键 `session:<parentId>`，**默认展开**，可访问名走 locale 字典；
- 子行不占水位线、不可拖拽；
- **子行只带一个行动作：归档 / 恢复**，走它自己的列表槽 `sidebar.workspaces.session.childRow.action`。子行不渲染菜单，所以重命名、pin、fork 都不会落到它身上；普通行的 action 列表也不渲染给子行，避免 pin 按钮出现在点不动的行上。归档正在跑的子会话仍会走"先停再归档"确认；
- 归档过滤器对子行与父行一视同仁，唯一例外是「仅归档」视图仍列出归档父行的归档子行 —— 因为那个视图正是恢复归档会话的入口；
- 选中的是子行时，它的父行会被算作注意力目标，即使父行处于折叠状态也不会被水位线裁掉。

在 `dsh-v0.2.1-rc.5` 上验证过：`pnpm run typecheck`（5 个 gate）、`pnpm run build:artifacts`（7 个 gate / 327 个产物）、`packages/client/ui-workspace` 的 vitest（**495 个测试**）、`tree.ts / stores.ts / Rows.tsx / locales.ts` 逐文件覆盖率 **100 %**、`verify-client-ui-i18n`、`verify-export-jsdoc`、`verify-md-wrap`、`verify-translation-pairing` 全绿。

> **这一半是实验性的、跟版本绑定的。** 它改的是构建产物、碰的是内部形状。DSH 升级可能让它失效；失效时插件本体（1–6 项）照常工作，只是原生子行退化成插件自己的面板树。仓库里的 `tools/legacy-dist-patch.mjs` 是同一思路更早的纯文本补丁版本，留作参考；检测到源码版已安装时它会拒绝执行。

## 兼容性

| 组件 | 版本 |
|---|---|
| DSH | `0.2.1-rc.5`（源码补丁基于 `dsh-v0.2.1-rc.5` 生成）|
| Node | `>= 22.19` |
| 系统 | Windows（依赖联接用 junction）、macOS、Linux |

升级 DSH 时：先重跑 `tools/install.mjs`（插件半对版本不敏感，除非服务形状变了 —— 契约测试会当场告诉你），如果你用了侧栏增强，再重新构建并应用源码补丁。补丁打不上就带版本号开 issue，diff 很小，重基成本低。

## 已知限制

- **DSH 没有"行插槽"** —— 这正是需要源码补丁的唯一原因；任何宣称纯插件能做到原生嵌套行的说法都是错的。
- `query_session` 读的是**日志**而不是内存：正在跑但还没落盘的轮次只能看到已经写入的部分。
- 重启补偿是**推断**：重启后插件只知道"这个子会话不在跑了"，拿不到真实收尾原因。DSH 停机期间被杀掉的子会话会被报成"已完成"。
- 子行只列 `continuable` 子会话；`external`（一次性 ACP）子会话没有可恢复的会话可打开。
- 在 DSH 源码仓库里跑 `pnpm run test:gui`，Windows 上会有与本插件无关的红（`ui-deliverables` 需要符号链接权限；另两条在并行负载下不稳定，单独跑通过）。详见 [docs/troubleshooting.md](docs/troubleshooting.md)。

## 卸载

```bash
node tools/install.mjs --uninstall --profile desktop
node tools/install-bundle.mjs --restore --dsh-node-modules "/path/to/dsh/node_modules"
```

## 仓库结构

```
lib/index.js                 宿主半：工具、碎碎念、完成唤醒、唤醒状态落盘
lib/client.js                客户端半：侧栏入口、面板会话树、创建子会话弹窗
nudge.md                     默认碎碎念文案（每轮重读）
test/                        宿主契约 27 项、客户端契约 16 项、落盘探针 4 项
tools/install.mjs            装进 profile（幂等，并在安装位置跑测试）
tools/install-bundle.mjs     装/回滚可选的侧栏产物
tools/dev-link.mjs           把 DSH 的 @deepseek-ai/* 联接到本包，便于本地跑测试
tools/source-patch/          对 DSH `ui-workspace` 的 unified diff
tools/legacy-dist-patch.mjs  已退役的纯文本补丁器（仅作参考）
docs/                        截图、故障排查、维护指南
```

## 许可

MIT，见 [LICENSE](LICENSE)。本仓库**不打包** DSH 的源码或构建产物，只提供补丁与安装器；署名与商标说明见 [NOTICE](NOTICE)。

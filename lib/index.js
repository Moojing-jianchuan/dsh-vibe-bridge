/**
 * dsh-vibe-bridge — 把 vibe-agent-bridge 的三件套搬进 DSH。
 *
 * | vibe-agent-bridge                        | 本插件                                   | DSH 落点                                   |
 * | ---------------------------------------- | ---------------------------------------- | ------------------------------------------ |
 * | 碎碎念：按轮次往 prompt 前面塞 [SYSTEM REMINDER] | `nudge` 中间件（多规则、按轮次节奏）      | `agent/pre-step` 里追加一条 user 消息        |
 * | create_vaw_session：父会话建独立子会话     | `spawn_session` 工具                      | `ctx.subagents.startActivation()`          |
 * | send_message_to_vaw_session：跨会话投递    | `post_to_session` 工具                    | `ctx.subagents.sendMessage()`              |
 * | query_vaw_session：看子会话清单/状态       | `list_sessions` 工具                      | `ctx.subagents.listChildren()`             |
 *
 * 0.9.0 起补上的可审计性（都建立在会话日志里的 `agent/inbox/spliced` 上，不改宿主）：
 * - `query_session` 渲染 `[inject]` 段：谁（source.kind / senderSessionId）、什么时候、现在什么状态；
 * - 三态重放（`queued` / `consumed` / `dropped`）+ `get_session_inbox` 队列视图；
 * - `post_to_session(cross_parent: true)`：血缘被拒时回落到 sessionController.prompt，`via` 说明来源是否保真；
 * - `list_sessions(scope: 'workspace')`：扫会话库，给出 parent_id / workdir / origin / status。
 *
 * 与原始实现的差别（都是有意的）：
 * - 原实现的碎碎念是 `turnsSinceFullReminder >= 5 || === 1` 的硬编码节奏，且只支持一套文案；
 *   这里改成规则数组，每条规则有自己的节流、全量/稀疏文案和生效轮次区间，且文案可以从文件热读。
 * - 原实现的子会话活在云端后端 + 另一个 bridge 上；DSH 的子会话是进程内持久 Session，
 *   由 subagent provider 负责生命周期，`send_message` 天然支持“忙则排队、闲则起新轮”。
 *
 * @module dsh-vibe-bridge
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { brandString } from "@deepseek-ai/dsh-brand";
import { open, readFile, readdir } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

/** Cordis 插件名，同时作为注入消息的 `source.kind`。 */
const name = "vibe-bridge";

/** 版本号：`vibe_bridge_status` 会回报它，用来确认当前进程里跑的是哪一版代码。 */
const VERSION = "0.14.3";

/** 依赖的宿主服务：工具注册表、子会话服务，以及用来读“在跑/空闲”的 Agent 注册表。 */
const inject = ["tools", "subagents", "agents", "commands"];

/** 一条碎碎念规则。 */
const Rule = z.object({
  /** 规则名，出现在 `[SYSTEM REMINDER:name]` 标记和日志里。 */
  name: z.string().default("nudge"),
  enabled: z.boolean().default(true),
  /** 全量文案（内联）。 */
  text: z.string().default(""),
  /** 全量文案文件；非空时优先于 `text`，每轮重新读取，改文件即时生效。 */
  file: z.string().default(""),
  /** 稀疏文案；留空则取全量文案的前若干行。 */
  sparseText: z.string().default(""),
  /**
   * 间隔多少轮提醒一次；0 = 只做全量提醒。
   * 不写（undefined）= 回落顶层标量 `everyTurns`；带窗口（fromTurn≠1 或 toTurn>0）的规则
   * 未写本字段时沿用历史行为「窗内每轮」（= 1）。
   */
  everyTurns: z.number(),
  /** 每多少轮来一次“全量”提醒；0 = 永不。不写时同 `everyTurns` 的回落规则（历史默认 5）。 */
  fullEveryTurns: z.number(),
  /** 从第几轮开始生效（1 = 第一轮）。 */
  fromTurn: z.number().default(1),
  /** 到第几轮为止；0 = 不限制。 */
  toTurn: z.number().default(0),
  /** 子会话（origin === 'subagent'）里不念：碎碎念通常只对主对话有意义。不写时回落顶层标量。 */
  skipSubagentSessions: z.union([z.boolean(), z.string()]),
  /**
   * 第一次在这个会话里遇到该规则时（哪怕已经是第 N 轮）立刻念一次全量。
   * 没有它，插件在会话中途装上时要等到下一个轮次节点才开口，看着像没生效。不写时回落顶层标量。
   */
  speakOnFirstSeen: z.union([z.boolean(), z.string()]),
});

/** 内置默认（顶层标量的缺省值，同时也是文档里写的那几个数）。 */
const NUDGE_DEFAULTS = {
  everyTurns: 4,
  fullEveryTurns: 12,
  fromTurn: 1,
  skipSubagentSessions: true,
  speakOnFirstSeen: true,
  nudgeText: "",
};

/** 插件配置。 */
const Config = z.object({
  /** 总开关：关掉后既不加碎碎念，也不注册任何工具。 */
  enabled: z.boolean().default(true),
  rules: z.array(Rule).default([]),
  /**
   * 顶层节奏标量：`rules[]` 里没写的字段按这里取值（规则内字段 > 顶层标量 > 内置默认）。
   * 这些键就是为了让设置页能改（设置表单只编辑顶层标量）。
   */
  everyTurns: z.number().default(NUDGE_DEFAULTS.everyTurns),
  fullEveryTurns: z.number().default(NUDGE_DEFAULTS.fullEveryTurns),
  fromTurn: z.number().default(NUDGE_DEFAULTS.fromTurn),
  skipSubagentSessions: z.union([z.boolean(), z.string()]).default(NUDGE_DEFAULTS.skipSubagentSessions),
  speakOnFirstSeen: z.union([z.boolean(), z.string()]).default(NUDGE_DEFAULTS.speakOnFirstSeen),
  /**
   * 全局全量文案：非空时优先于规则的 text/file（设置页的“碎碎念文案”）。
   * 为空时回落 `rule.file` → `rule.text`；`rules` 为空时再回落包内自带的 `nudge.md`。
   */
  nudgeText: z.string().default(NUDGE_DEFAULTS.nudgeText),
  /**
   * 碎碎念总开关（“只关碎碎念”，与整插件 `enabled` 区分）。
   * false 时 `agent/pre-step` 最先短路：连会话覆盖（`full` / `every:1`）也不生效。
   */
  nudgeEnabled: z.union([z.boolean(), z.string()]).default(true),
  /** 子会话 provider 名（对应 `ctx.subagents` 里注册的名字，如 spawn / fork / acp）。 */
  provider: z.string().default("spawn"),
  /** spawn 时的默认工作目录；留空 = 继承父会话当前目录。 */
  spawnCwd: z.string().default(""),
  enableSpawn: z.boolean().default(true),
  enablePost: z.boolean().default(true),
  enableList: z.boolean().default(true),
  enableQuery: z.boolean().default(true),
  /** 停子会话工具（只接受自己直接起的子会话）。 */
  enableStop: z.boolean().default(true),
  /** `get_session_inbox`：列出别的会话还没被消费的队列（R2 的查询入口）。 */
  enableInbox: z.boolean().default(true),
  /** `nudge_control` 工具 + `/vibe-nudge` 命令（按会话开关/节奏）。 */
  enableNudgeControl: z.boolean().default(true),
  /** `post_to_session(cross_parent: true)`：允许投递给「不是自己的子会话」的会话（R3）。 */
  enableCrossParent: z.boolean().default(true),
  /** 子会话跑完一轮后，往父会话注入一条带 session id 的回报通知（对应 vibe 截图里的完成回报）。 */
  notifyOnChildFinish: z.boolean().default(true),
  /** 立即唤醒：子会话一行结束就由插件主动把「带 session id 的回报」投给父会话（不等原生通知）。 */
  wakeParentOnChildFinish: z.boolean().default(true),
  /** 兜底哨兵间隔（毫秒）：只在拿不到 activation 结果时用；0 = 关闭。 */
  wakePollMs: z.number().default(3000),
  /** 合并窗口（毫秒）：同一父会话在这个窗口内完成的子会话合成一条通知。 */
  wakeDebounceMs: z.number().default(800),
  /** 唤醒状态落盘：DSH 重启后仍记得在跑的子会话，并能补发“你离线期间完成了”的通知。 */
  persistWakeState: z.boolean().default(true),
  /** 落盘记录的有效期（毫秒，默认 12 小时），过期条目自动清掉。 */
  wakeStateTtlMs: z.number().default(43200000),
  /** 创建子会话后，补一条消息告诉它自己的 session id 与回报方式。 */
  announceChildId: z.boolean().default(true),
  /** 稀疏文案取全量文案的前 N 行。 */
  sparseLines: z.number().default(3),
});

/** 取 agent 的会话 id，兼容 `agent.id` 与 `agent.session.id` 两种形态。 */
function agentIdOf(agent) {
  const id = agent?.id ?? agent?.session?.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("vibe-bridge: the calling agent has no session id");
  return id;
}

/** 包内自带的兜底文案（`rules` 为空、又没有 `nudgeText`/`rule.file` 时用）。 */
const PACKAGED_NUDGE_FILE = fileURLToPath(new URL("../nudge.md", import.meta.url));

/**
 * 把 `boolean | "true" | "false" | "1" | "0" | 1 | 0` 归一成布尔。
 * 设置页只能给文本框，所以这两个开关可能以字符串到达；缺省按 fallback。
 * @param value - 配置里的原始值。
 * @param fallback - 缺省值。
 * @returns 布尔值。
 */
function asBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true" || text === "1" || text === "on" || text === "yes") return true;
    if (text === "false" || text === "0" || text === "off" || text === "no") return false;
  }
  return fallback;
}

/** 顶层标量归一化（缺省来自 NUDGE_DEFAULTS）。 */
function topLevelSchedule(config) {
  const numberOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    everyTurns: numberOr(config?.everyTurns, NUDGE_DEFAULTS.everyTurns),
    fullEveryTurns: numberOr(config?.fullEveryTurns, NUDGE_DEFAULTS.fullEveryTurns),
    fromTurn: numberOr(config?.fromTurn, NUDGE_DEFAULTS.fromTurn),
    skipSubagentSessions: asBool(config?.skipSubagentSessions, NUDGE_DEFAULTS.skipSubagentSessions),
    speakOnFirstSeen: asBool(config?.speakOnFirstSeen, NUDGE_DEFAULTS.speakOnFirstSeen),
  };
}

/**
 * 按「规则内字段 > 顶层标量 > 内置默认」算出一条规则真正生效的节奏。
 *
 * 兼容性例外（老配置一字不变的必要条件）：规则带了窗口（`fromTurn ≠ 1` 或 `toTurn > 0`）
 * 却没写 `everyTurns`/`fullEveryTurns` 时，沿用历史值 1 / 5 —— 也就是“窗内每轮都念”。
 * @param rule - 配置里的原始规则。
 * @param top - 顶层标量（{@link topLevelSchedule}）。
 * @returns 补齐节奏字段后的规则（`plan()` 直接吃这个）。
 */
function resolveRule(rule, top) {
  const windowed = Number(rule.toTurn) > 0 || (rule.fromTurn !== undefined && Number(rule.fromTurn) !== NUDGE_DEFAULTS.fromTurn);
  return {
    ...rule,
    everyTurns: Number.isFinite(Number(rule.everyTurns)) ? Number(rule.everyTurns) : windowed ? 1 : top.everyTurns,
    fullEveryTurns: Number.isFinite(Number(rule.fullEveryTurns)) ? Number(rule.fullEveryTurns) : windowed ? 5 : top.fullEveryTurns,
    fromTurn: Number.isFinite(Number(rule.fromTurn)) ? Number(rule.fromTurn) : top.fromTurn,
    toTurn: Number.isFinite(Number(rule.toTurn)) ? Number(rule.toTurn) : 0,
    skipSubagentSessions: asBool(rule.skipSubagentSessions, top.skipSubagentSessions),
    speakOnFirstSeen: asBool(rule.speakOnFirstSeen, top.speakOnFirstSeen),
  };
}

/**
 * `rules` 为空时的隐式规则：顶层标量 + `nudgeText` 就是“一条规则”。
 *
 * 只有用户**确实**配过东西才生成（`nudgeText` 非空，或任一顶层键偏离默认值）；
 * 否则 `rules: []` 仍然等于“仅工具”，老配置不会突然开始念念有词。
 * @param config - 已归一化的插件配置。
 * @returns 规则对象，或 undefined（不注入）。
 */
function implicitRuleOf(config) {
  const top = topLevelSchedule(config);
  const overrideText = typeof config?.nudgeText === "string" ? config.nudgeText.trim() : "";
  const tuned =
    overrideText.length > 0 ||
    top.everyTurns !== NUDGE_DEFAULTS.everyTurns ||
    top.fullEveryTurns !== NUDGE_DEFAULTS.fullEveryTurns ||
    top.fromTurn !== NUDGE_DEFAULTS.fromTurn ||
    top.skipSubagentSessions !== NUDGE_DEFAULTS.skipSubagentSessions ||
    top.speakOnFirstSeen !== NUDGE_DEFAULTS.speakOnFirstSeen;
  if (!tuned) return undefined;
  return {
    name: "nudge",
    enabled: true,
    text: "",
    file: "",
    sparseText: "",
    everyTurns: top.everyTurns,
    fullEveryTurns: top.fullEveryTurns,
    fromTurn: top.fromTurn,
    toTurn: 0,
    skipSubagentSessions: top.skipSubagentSessions,
    speakOnFirstSeen: top.speakOnFirstSeen,
    /** 标记来源：文案可回落包内 nudge.md。 */
    implicit: true,
  };
}

/**
 * 本进程真正使用的规则表：显式规则按优先级补齐；没有显式规则时用隐式规则。
 * @param config - 已归一化的插件配置。
 * @returns 规则数组（可能是空数组 = 不注入）。
 */
function resolveRules(config) {
  const top = topLevelSchedule(config);
  const explicit = Array.isArray(config?.rules) ? config.rules : [];
  if (explicit.length > 0) return explicit.map((rule) => resolveRule(rule, top));
  const implicit = implicitRuleOf(config);
  return implicit === undefined ? [] : [implicit];
}

/**
 * 包内 `nudge.md` 的内容（“添加默认规则”按钮用；**不再**用于自动注入）。
 * @returns 正文；读不到返回空串。
 */
async function defaultRuleContent() {
  try {
    const raw = await readFile(PACKAGED_NUDGE_FILE, "utf8");
    return raw.trim();
  } catch {
    return "";
  }
}

/** 拼装最终注入的文本块。 */
function renderReminder(entries) {
  const body = entries.map((entry) => `[SYSTEM REMINDER:${entry.name}]\n${entry.text}\n[/SYSTEM REMINDER]`).join("\n\n");
  return `\n\n${body}\n\n`;
}

//#region session-log —— 读别的会话的落盘日志（query_session 的实现基础）
/**
 * DSH 的 home 目录。
 * 每次现读 `DSH_HOME`：测试可以把它指向临时目录，而不用改模块加载顺序。
 */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(homedir(), ".dsh");
}

/** 会话日志根目录：`<home>/sessions/<workspace-slug>/<session-dir>/session.v*.jsonl*`。 */
function sessionsRoot() {
  return path.join(dshHome(), "sessions");
}

/** 唤醒状态的落盘位置（重启补偿用）。 */
function wakeStateFile() {
  return path.join(dshHome(), "vibe-bridge", "wake-state.json");
}

/** 按 id 找到某个会话的日志文件（父会话目录名带 `session-` 前缀，子会话直接是 uuid）。 */
async function findSessionLog(sessionId) {
  const root = sessionsRoot();
  let slugs;
  try {
    slugs = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const workspaceDir = path.join(root, slug.name);
    let entries;
    try {
      entries = await readdir(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.includes(sessionId)) continue;
      const sessionDir = path.join(workspaceDir, entry.name);
      let files;
      try {
        files = await readdir(sessionDir);
      } catch {
        continue;
      }
      const log = files.find((file) => file.includes("jsonl"));
      if (log !== undefined) return path.join(sessionDir, log);
    }
  }
  return undefined;
}

/** 解一段可能由多帧 zstd 组成的日志缓冲。 */
function decodeLog(buffer, options = {}) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  // 只读开头时用 maxBytes/maxText 兜住代价：会话多、日志大时不把整仓日志全解压一遍。
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : Number.POSITIVE_INFINITY;
  const maxText = Number.isFinite(options.maxText) ? options.maxText : Number.POSITIVE_INFINITY;
  const starts = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const at = buffer.indexOf(magic, cursor);
    if (at < 0) break;
    starts.push(at);
    cursor = at + 4;
  }
  if (starts.length === 0) return buffer.toString("utf8");
  let text = "";
  for (let index = 0; index < starts.length; index += 1) {
    if (starts[index] > maxBytes || text.length > maxText) break;
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length;
    try {
      text += zstdDecompressSync(buffer.subarray(starts[index], end)).toString("utf8");
    } catch {
      // 最后一帧可能还在写，忽略解不开的一段。
    }
  }
  return text;
}

/** 把 JSONL 文本切成事件对象（坏行丢掉，不抛）。 */
function parseLogLines(text) {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((event) => event !== undefined);
}

/** 读一个会话的完整事件流。 */
async function readSessionEvents(sessionId) {
  const log = await findSessionLog(sessionId);
  if (log === undefined) return { events: [], log: undefined };
  const buffer = await readFile(log);
  return { events: parseLogLines(decodeLog(buffer)), log };
}

/**
 * 只读日志开头的一段字节。
 *
 * workspace 列表要扫几十上百个会话日志，其中有些上 MB；首行元数据在最前面，
 * 所以读 256 KB 就够，把整份日志读进内存纯属浪费（也不该在工具调用里同步阻塞）。
 * @param file - 日志路径。
 * @param bytes - 最多读多少字节。
 * @returns 缓冲（截断在帧中间时，最后一帧解压会失败并被忽略）。
 */
async function readFileHead(file, bytes = 262144) {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 会话的首行元数据（`{type:'session', version, id, createdAt, cwd, parentSession?, origin?, delegationDepth?}`）。
 * 注意：它**不在** `request/header` 里 —— parentSession / cwd / delegationDepth 都只写在这一条事件上，
 * 而且这条事件是文件里的第一行，所以只解开头一小段就够。
 * @param file - 日志路径。
 * @returns `{ id, cwd, parentSession, origin, delegationDepth, createdAt, title, label }`（缺的字段是 undefined）。
 */
async function readSessionMeta(file) {
  const buffer = await readFileHead(file);
  const events = parseLogLines(decodeLog(buffer, { maxBytes: 262144, maxText: 2000000 }));
  const sessionEvent = events.find((event) => event.type === "session");
  const title = events.find((event) => event.type === "session/title")?.data?.title;
  const descriptor = events.find((event) => event.type === "subagent/descriptor")?.data;
  const meta = sessionEvent ?? {};
  return {
    id: typeof meta.id === "string" ? meta.id : undefined,
    cwd: typeof meta.cwd === "string" ? meta.cwd : undefined,
    parentSession: typeof meta.parentSession === "string" ? meta.parentSession : undefined,
    origin: typeof meta.origin === "string" ? meta.origin : undefined,
    delegationDepth: typeof meta.delegationDepth === "number" ? meta.delegationDepth : undefined,
    createdAt: typeof meta.createdAt === "number" ? meta.createdAt : undefined,
    title: typeof title === "string" ? title : undefined,
    label: typeof descriptor?.label === "string" ? descriptor.label : undefined,
  };
}

/**
 * 列出 `<home>/sessions/<slug>/<session-dir>/session*.jsonl*` 里所有会话（R4 的 workspace 扫描）。
 * @returns `{ id, slug, dir, file }[]`。
 */
async function listSessionLogs() {
  const root = sessionsRoot();
  let slugs;
  try {
    slugs = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const workspaceDir = path.join(root, slug.name);
    let entries;
    try {
      entries = await readdir(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(workspaceDir, entry.name);
      let files;
      try {
        files = await readdir(sessionDir);
      } catch {
        continue;
      }
      const log = files.find((file) => file.includes("jsonl"));
      if (log === undefined) continue;
      rows.push({ id: entry.name, slug: slug.name, dir: sessionDir, file: path.join(sessionDir, log) });
    }
  }
  return rows;
}

/**
 * workspace 作用域的会话清单（R4）。
 *
 * 数据来源是落盘日志的首行元数据，所以**不要求目标会话进程内还活着**；
 * `status` 只有在该会话的 Agent 还注册在 `ctx.agents` 里时才可信，否则是 `not-loaded`。
 * 排序：调用方自己所在的 workspace 先出，然后新的在前 —— 一眼能看到「谁和我在一个工作区」。
 *
 * @param options - `callerId` 与 `statusOf(id)`。
 * @returns 行数组，形状对齐 `list_sessions` 的 output schema。
 */
async function listWorkspaceSessions({ callerId, statusOf }) {
  const logs = await listSessionLogs();
  const ownSlug = logs.find((entry) => entry.id === callerId)?.slug;
  const collected = [];
  for (const entry of logs) {
    let meta;
    try {
      meta = await readSessionMeta(entry.file);
    } catch {
      meta = {};
    }
    const id = meta.id ?? entry.id;
    const label = meta.label ?? meta.title ?? "";
    collected.push({
      row: {
        id,
        label,
        status: statusOf(id),
        origin: meta.origin ?? "interactive",
        workdir: meta.cwd ?? "-",
        workspace: entry.slug,
        // 顶层会话没有 parentSession：不写这个键（schema 里它是可选的）。
        ...(meta.parentSession === undefined ? {} : { parent_id: meta.parentSession }),
      },
      createdAt: meta.createdAt ?? 0,
      own: ownSlug !== undefined && entry.slug === ownSlug,
    });
  }
  collected.sort((left, right) => {
    if (left.own !== right.own) return left.own ? -1 : 1;
    return right.createdAt - left.createdAt;
  });
  return collected.map((entry) => entry.row);
}

/** 取一条消息里所有文本块。 */
function textOfMessage(message) {
  if (message === undefined || message === null) return "";
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** 截断到指定长度。 */
function clip(text, limit) {
  const value = typeof text === "string" ? text : "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…[+${value.length - limit} chars]`;
}

/**
 * 时间戳：`2026-11-19 16:42:24`（UTC 秒级，取自事件 time）。报告里一律用这一种写法。
 * @param time - 毫秒时间戳。
 * @returns 可读时间戳；拿不到返回 `-`。
 */
function stamp(time) {
  if (typeof time !== "number" || !Number.isFinite(time)) return "-";
  const iso = new Date(time).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/** inbox 里两条队列的固定顺序。 */
const INBOX_TARGETS = ["next-turn", "next-step"];

/** 一条消息在 replay 里的稳定 key（DSH 给每条 UserMessage 都带 id）。 */
function messageKey(message, fallback) {
  const id = message?.id;
  if (typeof id === "string" && id.length > 0) return id;
  return fallback;
}

/**
 * 归一化消息来源。
 * `agent-message` / `subagent-settled` 带 senderSessionId；`vibe-bridge` / `tool-jobs` 这类只有 kind。
 * @param source - `message.source`。
 * @returns `{ kind, sender, label }`。
 */
function describeSource(source) {
  const kind = typeof source?.kind === "string" && source.kind.length > 0 ? source.kind : "user";
  const sender = typeof source?.senderSessionId === "string" && source.senderSessionId.length > 0 ? source.senderSessionId : undefined;
  return { kind, sender, label: sender === undefined ? kind : `${kind} from ${sender}` };
}

/**
 * 按日志顺序重放 `agent/inbox/spliced`，还原每条注入的三态。
 *
 * 三态规则（对齐 `packages/core/agent-loop/src/inbox.ts`）：
 * - `inserted` → `queued`；
 * - 之后被 `removedCount > 0` 移除、且没有 `outcome` → `consumed`（`claim()` 把队列搬进下一轮）；
 * - 被移除且 `outcome === 'canceled'` → `dropped`（`clear()` / `remove()` / 中断清队）。
 *
 * @param events - 会话事件流。
 * @returns `{ records, queues }`：`records` 按消息 id 索引，`queues` 是重放结束时的待消费队列。
 */
function replayInbox(events) {
  const queues = { "next-turn": [], "next-step": [] };
  const records = new Map();
  // 第一轮 turn/start 之前发生的注入：到达时间其实就在这一轮之前，归到这一轮。
  const beforeFirstTurn = [];
  let currentTurn = 0;
  let seq = 0;
  for (const event of events ?? []) {
    if (event?.type === "turn/start") {
      currentTurn = typeof event.data?.turn === "number" ? event.data.turn : currentTurn + 1;
      for (const record of beforeFirstTurn) record.turn = currentTurn;
      beforeFirstTurn.length = 0;
      continue;
    }
    if (event?.type !== "agent/inbox/spliced") continue;
    const data = event.data ?? {};
    const target = data.target === "next-step" ? "next-step" : "next-turn";
    const queue = queues[target];
    const start = Math.max(0, Math.min(Number(data.start) || 0, queue.length));
    const removedCount = Math.max(0, Math.min(Number(data.removedCount) || 0, queue.length - start));
    const canceled = data.outcome === "canceled";
    for (const removed of queue.splice(start, removedCount)) {
      const key = messageKey(removed, undefined);
      const record = key === undefined ? undefined : records.get(key);
      if (record === undefined) continue;
      record.status = canceled ? "dropped" : "consumed";
      record.settledAt = event.time;
      record.reason = canceled
        ? "removed or canceled before consuming"
        : "drained into the next request";
    }
    const inserted = Array.isArray(data.inserted) ? data.inserted : [];
    for (const [offset, message] of inserted.entries()) {
      seq += 1;
      const key = messageKey(message, `splice-${seq}-${offset}`);
      const at = Math.min(start + offset, queue.length);
      queue.splice(at, 0, message);
      const record = {
        key,
        message,
        seq,
        target,
        status: "queued",
        queuedAt: event.time,
        settledAt: undefined,
        reason: "",
        turn: currentTurn,
      };
      records.set(key, record);
      if (currentTurn <= 0) beforeFirstTurn.push(record);
    }
  }
  return { records, queues };
}

/**
 * 收集 `[user]` 段真正会渲染的消息 id（`user/message` 里 `source.kind` 缺失或为 `'user'`）。
 *
 * 去重口径是「`[user]` 段已经显示过」，**不是**「日志里存在 user/message」：
 * `agent-message` / `agent-instructions` / `vibe-bridge` 这些来源同样会被写成 `user/message`
 * 事件（真机上 `15d41732` 的 `5cd1130f`、`44932880` 就是两边同 id），
 * 而 `[user]` 段按来源过滤不渲染它们 —— 按「事件存在」去重会把它们从报告里彻底抹掉，
 * 也就是把「注入不可见」从一种形态换成另一种形态。
 * @param events - 会话事件流。
 * @returns 已由 `[user]` 段呈现的消息 id 集合。
 */
function renderedUserMessageIds(events) {
  const ids = new Set();
  for (const event of events ?? []) {
    if (event?.type !== "user/message") continue;
    const kind = event.data?.source?.kind;
    if (kind !== undefined && kind !== "user") continue;
    const id = event.data?.id;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  return ids;
}

/**
 * 收集一个会话里必须在 `[inject]` 段出现的注入条目。
 *
 * 判据按 **message id** 去重：`[user]` 段已经呈现过的 id 跳过，其余全部进 `[inject]`——
 * 包括 `user` 来源的（冷会话 resume 时消息只经 splice 喂进请求，日志里根本没有
 * `user/message` 事件，按来源过滤会让它彻底不可见；这正是 R1 要消灭的“发了看不到”）。
 * @param records - `replayInbox()` 的 records。
 * @param shownUserIds - `[user]` 段已经渲染过的消息 id。
 * @returns 按到达顺序排列的条目。
 */
function inboxEntries(records, shownUserIds = new Set()) {
  return [...records.values()]
    .filter((record) => !shownUserIds.has(record.key))
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
}

/**
 * 把一个会话的日志整理成 vibe `query_vaw_session` 那种报告文本。
 * @param sessionId - 目标会话 id。
 * @param events - 事件流。
 * @param options - tail 轮数、是否带工具摘要、以及当前是否在运行。
 * @returns 报告文本。
 */
function summarizeSession(sessionId, events, options) {
  const header = events.find((event) => event.type === "session") ?? {};
  const descriptor = events.find((event) => event.type === "subagent/descriptor")?.data;
  const title = events.find((event) => event.type === "session/title")?.data?.title;
  const config = events.find((event) => event.type === "request/header")?.data?.header?.config;

  // 事件按顺序归到轮次：turn/start 开一轮；不带 turn 字段的事件（user/message、tool/*）归到当前轮。
  const perTurn = new Map();
  let current = 0;
  for (const event of events) {
    if (event.type === "turn/start") {
      current = typeof event.data?.turn === "number" ? event.data.turn : current + 1;
      if (!perTurn.has(current)) perTurn.set(current, []);
      continue;
    }
    const turn = typeof event.data?.turn === "number" ? event.data.turn : current;
    if (turn <= 0) continue;
    if (!perTurn.has(turn)) perTurn.set(turn, []);
    perTurn.get(turn).push(event);
  }
  const turns = [...perTurn.keys()].sort((left, right) => left - right);
  const totalRounds = turns.length;
  const visible = turns.slice(Math.max(0, totalRounds - options.tail));

  const lines = [];
  lines.push("## query_session");
  lines.push(`- Session: ${sessionId}`);
  if (typeof title === "string" && title.length > 0) lines.push(`- Title: ${title}`);
  lines.push(`- Total rounds: ${totalRounds}`);
  lines.push(`- Status: ${options.running ? "running" : "idle"}`);
  // 默认只报「判断下一步」需要的字段；Model/Provider/Workdir 只在 verbose 里给（它们是常量，重复读没信息量）。
  if (options.verbose === true) {
    const providerName = descriptor?.agentProvider ?? config?.provider;
    const modelName = descriptor?.agentModel ?? config?.model;
    lines.push(`- Model: ${providerName === undefined ? "-" : `${providerName}/${modelName ?? "?"}`}`);
    lines.push(`- Provider: ${descriptor?.provider ?? "-"}`);
    lines.push(`- Workdir: ${header.cwd ?? "-"}`);
    lines.push(`- Mode: ${header.origin === "subagent" ? "autonomous (subagent session)" : "interactive"}`);
  }
  if (typeof header.parentSession === "string") lines.push(`- Parent: ${header.parentSession}`);
  if (typeof descriptor?.label === "string") lines.push(`- Label: ${descriptor.label}`);

  // R1：注入可见性。按 message id 去重（[user] 段显示过的跳过），其余全进 [inject]。
  const { records } = replayInbox(events);
  const injections = inboxEntries(records, renderedUserMessageIds(events));
  const countOf = (status) => injections.filter((record) => record.status === status).length;
  lines.push(
    `- Inbox: ${countOf("queued")} pending, ${countOf("consumed")} consumed, ${countOf("dropped")} dropped`,
  );
  // 注入按「到达时所在的轮次」归档；按到达顺序渲染。
  const injectionsByTurn = new Map();
  for (const record of injections) {
    const bucket = typeof record.turn === "number" && record.turn > 0 ? record.turn : 0;
    if (!injectionsByTurn.has(bucket)) injectionsByTurn.set(bucket, []);
    injectionsByTurn.get(bucket).push(record);
  }

  if (totalRounds === 0) {
    lines.push("", "(no turns yet)");
    return lines.join("\n");
  }

  lines.push("", `# Rounds ${visible[0] ?? 0}-${visible[visible.length - 1] ?? 0} (of ${totalRounds})`);
  const injectClip = options.verbose === true ? 1200 : 160;
  const renderInject = (record) => {
    const who = describeSource(record.message?.source);
    const body = textOfMessage(record.message);
    lines.push(
      "",
      `--- [inject] ${stamp(record.queuedAt)} · ${who.label} · ${record.status} ---`,
      clip(body.length > 0 ? body : "(no text content)", injectClip),
    );
    if (record.status !== "queued" && record.settledAt !== undefined) {
      lines.push(`    (${record.status} at ${stamp(record.settledAt)} — ${record.reason})`);
    }
  };
  // 第一轮之前到达、且日志里一直没有 turn/start 的注入：附在可见范围的开头，不丢。
  if (visible[0] === turns[0]) {
    for (const record of injectionsByTurn.get(0) ?? []) renderInject(record);
  }
  for (const turn of visible) {
    const inTurn = perTurn.get(turn) ?? [];
    // 只取真正由人/父会话发出的 user 消息：runtime-context、skill-catalog 这类快照会把报告淹没。
    const user = inTurn
      .filter((event) => event.type === "user/message" && (event.data?.source?.kind === undefined || event.data?.source?.kind === "user"))
      .map((event) => textOfMessage(event.data))
      .filter(Boolean);
    const userText = user.length > 0 ? user.join("\n---\n") : "(no user message)";
    // 默认截短：读子会话是为了判断下一步，不是读全文。
    const userClip = options.verbose === true ? 900 : 400;
    const assistantClip = options.verbose === true ? 1200 : 700;
    lines.push("", `--- [user] Round ${turn} ---`, clip(userText, userClip));
    // 注入落在 user 之后、assistant 之前：它们就是这一轮之前/之中塞进来的消息。
    for (const record of injectionsByTurn.get(turn) ?? []) renderInject(record);
    const assistant = inTurn.filter((event) => event.type === "assistant/message").map((event) => textOfMessage(event.data.message)).filter(Boolean);
    if (assistant.length > 0) lines.push(`--- [assistant] Round ${turn} ---`, clip(assistant.join("\n---\n"), assistantClip));
    if (options.includeTools === "summary") {
      const tools = inTurn.filter((event) => event.type === "tool/call").map((event) => event.data?.name).filter(Boolean);
      if (tools.length > 0) {
        const counts = new Map();
        for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
        lines.push(`--- [tools] Round ${turn} ---`, [...counts].map(([tool, count]) => `${tool} x${count}`).join(", "));
      }
    }
  }
  return lines.join("\n");
}
//#endregion

//#region 子会话完成通知 / 唤醒
/**
 * 生成一条“子会话完成”的通知正文。
 *
 * 措辞按 **arm 原因** 区分，因为这两种通知对用户意味着完全不同的事：
 * - `spawn`：这一轮就是父会话派下去的活，所以直接说“完成了新一轮工作”；
 * - `post`：父会话只是用 `post_to_session` 订阅过一次，之后对方每一轮收尾都会回一条 ——
 *   它只是**订阅回执**，不代表这一轮是为那条消息专门做的，也不代表父会话拿到了它的全部工作。
 * @param childId - 子会话 id。
 * @param label - 列表里显示的名字。
 * @param status - `done` / `failed` / `aborted`。
 * @param reason - `spawn`（派单）或 `post`（订阅）。
 * @returns 通知正文。
 */
function childDoneNotice(childId, label, status, reason = "spawn") {
  const name = typeof label === "string" && label.length > 0 ? label : childId;
  const word = statusWord(status);
  const head = `会话「${name}」（session id: ${childId}）${word}。`;
  if (reason === "post") {
    return (
      `${head}这一条是 post_to_session 的订阅回执 —— 只表示它跑完了一轮，` +
      `不代表这一轮是为你那条消息专门做的，也不代表你收到了它的全部工作。` +
      `要细看用 query_session({ session_id: "${childId}", tail: 1 })；` +
      `不想再收这类回执，下次投递时带 notify: "never"。`
    );
  }
  return (
    `${head}` +
    `用 query_session({ session_id: "${childId}", tail: 1 }) 看它最新内容；` +
    `要它继续就 post_to_session({ session_id: "${childId}", message: "..." })。`
  );
}

/** 把一个子会话的收尾状态翻成中文短语。 */
function statusWord(status) {
  if (status === "failed") return "执行失败，需要你判断是否重试";
  if (status === "aborted") return "被中断了（没有正常收尾）";
  return "完成了新一轮工作";
}

/**
 * 把同一父会话在合并窗口内完成的多个子会话压成一条通知。
 * 单个子会话时保持原来的可读性；多个时只列一次工具用法，并按 arm 原因标注订阅回执。
 */
function batchNotice(entries) {
  if (entries.length === 0) return "";
  if (entries.length === 1) {
    return childDoneNotice(entries[0].childId, entries[0].label, entries[0].status, entries[0].reason ?? "spawn");
  }
  const postCount = entries.filter((entry) => entry.reason === "post").length;
  const lines = entries.map(
    (entry) =>
      `- 「${entry.label || entry.childId}」(${entry.childId.slice(0, 8)}…) ${statusWord(entry.status)}` +
      (entry.reason === "post" ? "（订阅回执）" : ""),
  );
  const ids = entries.map((entry) => entry.childId.slice(0, 8)).join("/");
  // 混合原因用中性措辞，但把订阅回执的条数点出来；全是订阅回执时直接说清它们的性质。
  const head =
    postCount === 0
      ? `${entries.length} 个子会话有新进展：`
      : postCount === entries.length
        ? `${entries.length} 个子会话跑完了一轮（都是你 post_to_session 订阅的回执，不代表你收到了它们的全部工作）：`
        : `${entries.length} 个子会话有新进展（含 ${postCount} 条订阅回执：只表示它们跑完了一轮，不代表你收到了全部工作）：`;
  return (
    `${head}\n${lines.join("\n")}\n` +
    `逐个用 query_session({ session_id: "<id>", tail: 1 }) 看；要它们继续就 post_to_session({ session_id: "<id>", message: "..." })。id：${ids}…`
  );
}

/** 生成一个 requestId。 */
function newRequestId() {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `vb-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * 判断一个错误是不是 subagent 的「血缘拒收」。
 *
 * 三种措辞都来自 `packages/subagent/subagent/src/manager.ts`：
 * - `belongs to another parent session`（713-722，durable lineage 不匹配）
 * - `is not a live descendant of agent ...`（211-215）
 * - `delivery requires the exact live parent agent`（725-730）
 * @param error - 捕获到的错误。
 * @returns 是否属于「可以改用 controller 绕行」的那一类。
 */
function isLineageRejection(error) {
  const code = error?.code;
  if (code === "UNAUTHORIZED") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /belongs to another parent session|not a live descendant of agent|requires the exact live parent agent/i.test(message);
}

/**
 * 读一个会话的元数据（日志里第一条 `session` 事件）；没有日志或读不了就返回 undefined。
 * 与 `list_sessions(scope: 'workspace')` 用的是同一套轻量读法：只读、只解开头 256 KB。
 * @param sessionId - 会话 id。
 * @returns `{ id, origin, parentSession, cwd, ... }` 或 undefined。
 */
async function readSessionMetaById(sessionId) {
  const log = await findSessionLog(sessionId);
  if (log === undefined) return undefined;
  try {
    return await readSessionMeta(log);
  } catch {
    return undefined;
  }
}

/**
 * 通信权限矩阵（先判后投，不靠“试了才知道”）。
 *
 * | 发送方 | 接收方 | 结果 |
 * |---|---|---|
 * | 父会话 | 自己的子会话 | `direct`：`subagents.sendMessage`（agent-message，来源保真） |
 * | 父会话 | 另一个顶层会话 | `peer`：controller（controller 写死 source.kind='user'，来源靠正文前缀） |
 * | 父会话 | 别人的子会话 | `reject`：明确拒绝，**不做任何投递尝试** |
 * | 子会话 | 同级兄弟子会话 | `reject`：同上 |
 * | 子会话 | 自己的父会话 | `parent`：回报通道，sendMessage 优先、失败才好 controller |
 *
 * 目标元数据读不到（日志还没落盘）时返回 `unknown`，退回 0.9.0 的旧路径（先试 sendMessage）。
 * @param options - 调用方/目标的 id 与元数据（元数据来自日志首条 `session` 事件）。
 * @returns `{ verdict, reason? }`。
 */
function decideDelivery({ callerId, callerMeta, targetId, targetMeta }) {
  if (targetMeta === undefined) return { verdict: "unknown" };
  const callerOrigin = callerMeta?.origin;
  const callerIsSubagent = callerOrigin === "subagent";
  const targetOrigin = targetMeta?.origin;

  if (targetOrigin === "subagent") {
    if (targetMeta.parentSession === callerId) return { verdict: "direct" };
    const parentId = targetMeta.parentSession ?? "(未知)";
    return {
      verdict: "reject",
      reason:
        `目标是别的父会话的子会话（${targetId}，属 ${parentId}）。` +
        "按设计只允许 父↔自己的子会话 或 父↔父（顶层会话之间）；子会话之间（含同级兄弟）不允许互相投递。",
    };
  }

  // 目标是顶层会话（origin 不是 subagent，或根本没有 origin 字段）。
  if (callerIsSubagent) {
    if (callerMeta?.parentSession === targetId) return { verdict: "parent" };
    return {
      verdict: "reject",
      reason:
        `你是子会话（${callerId}），只能投给自己的父会话（${callerMeta?.parentSession ?? "(未知)"}）` +
        `或自己的直接子会话；不能投给顶层会话 ${targetId}。`,
    };
  }
  return { verdict: "peer" };
}
//#endregion

/**
 * 注册碎碎念中间件与会话工具。
 * @param ctx - Cordis 上下文；所有注册随 ctx 生命周期回收。
 * @param config - 归一化后的插件配置。
 */
function apply(ctx, config) {
  if (!config.enabled) {
    ctx.logger?.info?.("vibe-bridge: disabled by config");
    return;
  }

  // 真正生效的规则表：显式规则按「规则内字段 > 顶层标量 > 内置默认」补齐；
  // rules 为空且用户配过顶层标量/nudgeText 时，用一条隐式规则。
  const resolvedRules = resolveRules(config);

  //#region 按会话注入（nudges.json）
  /** 会话覆盖状态文件（与 wake-state 同一个 home，路径每次都现读 DSH_HOME）。 */
  const nudgesFile = () => path.join(dshHome(), "vibe-bridge", "nudges.json");
  /** 读盘缓存：按 mtime 失效，避免每轮 pre-step 都同步读文件。 */
  const nudgeCache = { mtimeMs: -1, map: new Map(), warned: false };

  /**
   * 归一化一个存下来的 mode。只认 `off` / `sparse` / `full` / `every:N`（N ≥ 1）。
   * @param value - 文件里的原始值。
   * @returns 规范化后的 mode，或 undefined（视为没有覆盖）。
   */
  const normalizeStoredMode = (value) => {
    if (typeof value !== "string") return undefined;
    const text = value.trim().toLowerCase();
    if (text === "off" || text === "sparse" || text === "full") return text;
    const match = /^every:(\d+)$/.exec(text);
    if (match === null) return undefined;
    const every = Number(match[1]);
    return every >= 1 ? `every:${every}` : undefined;
  };

  /**
   * 解析调用方给的模式（工具 / 命令入参）。
   *
   * - `on` / `clear`：只清 mode（保留本会话文案），回落全局节奏；mode 清掉后若没有文案则整条删除；
   * - `purge`：整条删除（文案一并丢弃）；
   * - `off` / `sparse` / `full` / `every:N`：设置 mode（保留已有文案）。
   * @param value - 原始入参。
   * @returns `{ action: 'set', mode }` / `{ action: 'clear' }` / `{ action: 'purge' }` / undefined（非法）。
   */
  const parseNudgeMode = (value) => {
    if (typeof value !== "string") return undefined;
    const text = value.trim().toLowerCase();
    if (text.length === 0) return undefined;
    if (text === "on" || text === "clear") return { action: "clear" };
    if (text === "purge") return { action: "purge" };
    if (text === "off") return { action: "set", mode: "off" };
    // sparse / full / every:N / text: 已移除：会话级节奏与文案改由 rules.json 的规则策略承载。
    return undefined;
  };

  /**
   * `text:` 兼容别名：写/覆盖该会话**第一条规则**的正文（没有规则就建一条 `every-message`）。
   * 空串 = 清空第一条规则（内容为空的规则不合法，所以等价于删掉那一条）；没有规则则无操作。
   * @param sessionId - 会话 id。
   * @param text - 已解码的正文。
   * @returns `{ action: 'created' | 'updated' | 'cleared' | 'noop' }`。
   */
  const applyTextAlias = (sessionId, text) => {
    const list = readSessionRules().get(sessionId) ?? [];
    const body = typeof text === "string" ? text : "";
    const now = new Date().toISOString();
    if (list.length === 0) {
      if (body.trim().length === 0) return { action: "noop" };
      setSessionRules(sessionId, [
        {
          id: `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          type: "rule",
          content: body,
          strategies: ["every-message"],
          everyN: 3,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      return { action: "created" };
    }
    if (body.trim().length === 0) {
      setSessionRules(sessionId, list.slice(1));
      return { action: "cleared" };
    }
    setSessionRules(sessionId, [{ ...list[0], content: body, updatedAt: now }, ...list.slice(1)]);
    return { action: "updated" };
  };

  /** 已移除的调用统一回这句，别让调用方猜。 */
  const REMOVED_HINT =
    "已移除：会话级节奏改由规则策略表达，请用 /vibe-nudge rules:<base64>；off/on/clear/purge 仍可用。";

  /**
   * 读覆盖表（`{}` 也能用）。坏 JSON / 读失败一律当空表，只记一次日志，绝不让 pre-step 抛错。
   * 一条记录可以只有 `mode`（开关）、只有 `text`（本会话文案），或两者都有。
   * @returns `Map<sessionId, { mode?, text?, updatedAt }>`。
   */
  const readNudges = () => {
    try {
      const file = nudgesFile();
      const stat = statSync(file);
      if (stat.mtimeMs === nudgeCache.mtimeMs) return nudgeCache.map;
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const map = new Map();
      for (const [sessionId, entry] of Object.entries(parsed ?? {})) {
        const mode = normalizeStoredMode(entry?.mode);
        const text = typeof entry?.text === "string" && entry.text.length > 0 ? entry.text : undefined;
        if (mode === undefined && text === undefined) continue;
        map.set(sessionId, {
          mode,
          text,
          updatedAt: typeof entry?.updatedAt === "string" ? entry.updatedAt : "",
        });
      }
      nudgeCache.mtimeMs = stat.mtimeMs;
      nudgeCache.map = map;
      return map;
    } catch (error) {
      if (error?.code === "ENOENT") {
        nudgeCache.mtimeMs = -1;
        nudgeCache.map = new Map();
        return nudgeCache.map;
      }
      if (!nudgeCache.warned) {
        nudgeCache.warned = true;
        ctx.logger?.warn?.(`vibe-bridge: nudges.json unreadable, treating it as empty (${error instanceof Error ? error.message : String(error)})`);
      }
      return new Map();
    }
  };

  /**
   * 原子写覆盖表。写完清掉缓存，让下一次读盘看到新内容。
   * @param map - 完整的新表。
   */
  const writeNudges = (map) => {
    const file = nudgesFile();
    const payload = {};
    for (const [sessionId, entry] of map) {
      payload[sessionId] = {
        ...(entry.mode === undefined ? {} : { mode: entry.mode }),
        ...(entry.text === undefined ? {} : { text: entry.text }),
        updatedAt: entry.updatedAt ?? new Date().toISOString(),
      };
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, file);
    nudgeCache.mtimeMs = -1;
    nudgeCache.map = map;
    nudgeCache.warned = false;
  };

  /**
   * 设置/清除一个会话的模式。
   *
   * - `set`：写 `mode`（保留已有 `text`）；
   * - `clear`：**只清 `mode`**，`text` 保留；清完若没有 `text` 就整条删除（不留空壳）；
   * - `purge`：**彻底删除**——`nudges.json` 的条目与该会话在 `rules.json` 里的**全部规则**一起清掉。
   *   规则是 v0.14 之后唯一的注入源，只清 nudges 会让"清除"名不副实（用户点了还在注入）。
   * @param sessionId - 会话 id。
   * @param mode - 已经解析过的动作。
   * @returns `{ session_id, mode, source }`（mode 为 'global' 表示没有覆盖）。
   */
  const setSessionNudge = (sessionId, mode) => {
    const current = new Map(readNudges());
    if (mode.action === "purge") {
      // 先清规则：它是注入源；清空后 writeSessionRules 会把整表空掉并删文件。
      setSessionRules(sessionId, []);
      if (current.delete(sessionId)) writeNudges(current);
      return { session_id: sessionId, mode: "global", source: "global" };
    }
    if (mode.action === "clear") {
      const existing = current.get(sessionId);
      if (existing !== undefined) {
        const next = { ...existing, mode: undefined, updatedAt: new Date().toISOString() };
        if (next.text === undefined) current.delete(sessionId);
        else current.set(sessionId, next);
        writeNudges(current);
      }
      return { session_id: sessionId, mode: "global", source: "global" };
    }
    const existing = current.get(sessionId) ?? {};
    current.set(sessionId, { ...existing, mode: mode.mode, updatedAt: new Date().toISOString() });
    writeNudges(current);
    return { session_id: sessionId, mode: mode.mode, source: "session" };
  };

  /**
   * 设置/清除一个会话的自定义文案（只动 text，保留已有模式）。
   * 空串 = 清除自定义文案（回落全局文案链）。
   * @param sessionId - 会话 id。
   * @param text - 新文案（已解码）。
   * @returns `{ session_id, text: 'custom' | 'global' }`。
   */
  const setSessionText = (sessionId, text) => {
    const current = new Map(readNudges());
    const existing = current.get(sessionId) ?? {};
    const trimmed = typeof text === "string" ? text : "";
    if (trimmed.trim().length === 0) {
      const next = { ...existing, text: undefined, updatedAt: new Date().toISOString() };
      if (next.mode === undefined) current.delete(sessionId);
      else current.set(sessionId, next);
      writeNudges(current);
      return { session_id: sessionId, text: "global" };
    }
    current.set(sessionId, { ...existing, text: trimmed, updatedAt: new Date().toISOString() });
    writeNudges(current);
    return { session_id: sessionId, text: "custom" };
  };


  /**
   * 批量状态（`/vibe-nudge status all`）：给面板一次性拿“所有有覆盖的会话”。
   *
   * 固定格式（客户端按行解析，改格式会破坏面板）：
   * ```
   * global: every 4 · full 12 · from 1
   * <sessionId>: <mode> text=yes|no
   * ```
   * 没有覆盖时只回第 1 行。
   * @returns 多行文本。
   */
  /** 某个会话在 rules.json 里的规则数组（读不到就是空）。 */
  const sessionRulesOf = (sessionId) =>
    typeof sessionId === "string" && sessionId.length > 0 ? readSessionRules().get(sessionId) ?? [] : [];

  /**
   * 批量只读摘要（`/vibe-nudge status all`）：面板一次拿全“每个会话的 mode / 是否有旧文案 / 规则数”。
   *
   * 形状（固定）：
   * ```
   * sessions: 2
   *   me: off text=no rules=2
   *   you: global text=yes rules=0
   * ```
   * 没有全局节奏行了：注入已经只由会话规则决定。
   * @returns 多行文本。
   */
  const nudgeStatusAllText = () => {
    const sessions = new Set([...readNudges().keys(), ...readSessionRules().keys()]);
    const lines = [`sessions: ${sessions.size}`];
    for (const sessionId of sessions) {
      const entry = readNudges().get(sessionId);
      const mode = entry?.mode ?? "global";
      const custom = typeof entry?.text === "string" && entry.text.length > 0 ? "yes" : "no";
      const rules = (readSessionRules().get(sessionId) ?? []).length;
      lines.push(`  ${sessionId}: ${mode} text=${custom} rules=${rules}`);
    }
    return lines.join("\n");
  };

  /**
   * 只读摘要（`/vibe-nudge status`）：给客户端看的“当前生效节奏 + 覆盖 + 本会话预填”。
   *
   * 前 3 行是全局的（`every …` / `rules: …` / `overrides: N (id → mode, …)`），
   * 第 4 行是**当前会话**的，供弹窗预填：`session: mode=<…> text=<base64|empty>`。
   * @param sessionId - 当前会话 id（拿不到时按 global/empty 报）。
   * @returns 多行文本。
   */
  const nudgeStatusText = (sessionId) => {
    const top = topLevelSchedule(config);
    const cadence =
      `every ${top.everyTurns} · full every ${top.fullEveryTurns} · from turn ${top.fromTurn} · ` +
      `skip subagent ${top.skipSubagentSessions ? "on" : "off"} · speak on first seen ${top.speakOnFirstSeen ? "on" : "off"}`;
    const rulesLine =
      resolvedRules.length === 0
        ? "rules: (none)"
        : `rules: ${resolvedRules
            .map((rule) => `${rule.name} every ${rule.everyTurns}/full ${rule.fullEveryTurns}`)
            .join(" | ")}`;
    const overrides = [...readNudges()];
    const shown = overrides
      .slice(0, 5)
      .map(([id, entry]) => `${id} → ${entry.mode ?? "global"}`)
      .join(", ");
    const overrideLine =
      overrides.length === 0 ? "overrides: 0" : `overrides: ${overrides.length} (${shown}${overrides.length > 5 ? ` +${overrides.length - 5}` : ""})`;
    const mine = typeof sessionId === "string" && sessionId.length > 0 ? readNudges().get(sessionId) : undefined;
    const sessionMode = mine?.mode ?? "global";
    const sessionTextB64 = typeof mine?.text === "string" && mine.text.length > 0 ? Buffer.from(mine.text, "utf8").toString("base64") : "empty";
    // 无参两步语义就是要写出来：第一次关闭、第二次回落全局（文案保留），彻底丢弃用 purge。
    const tip = "tip: 无参第一次 = 关闭本会话；第二次 = 回落全局节奏（自定义文案保留）。想彻底丢弃文案用 purge。";
    return `${cadence}\n${rulesLine}\n${overrideLine}\nsession: mode=${sessionMode} text=${sessionTextB64}\n${sessionRuleLines(sessionId).join("\n")}\n${tip}`;
  };
  //#endregion

  //#region 按会话规则（rules.json）
  /**
   * 每会话一套“碎碎念规则”。文件形状：
   * `{ "<sessionId>": [{ id, type, content, strategies, everyN, enabled, createdAt, updatedAt }] }`
   *
   * 与 `nudges.json` 并存：`nudges.json` 的 `mode` 是主开关，`rules.json` 只决定“说什么、什么时候说”。
   */
  const rulesFile = () => path.join(dshHome(), "vibe-bridge", "rules.json");
  /** 读盘缓存：key 用 `mtimeMs:size` —— 同毫秒内连写两次时 size 也会变，避免踩缓存。 */
  const rulesCache = { key: "", map: new Map(), warned: false };
  /** 最近一次读盘的失败原因（status 要能看到，不许静默）。 */
  let rulesErrorText = "";
  /** 规则类型（同时也是注入文本里的中文标签来源）。 */
  const RULE_TYPES = ["rule", "constraint", "preference", "convention", "feedback"];
  /** 注入策略。 */
  const RULE_STRATEGIES = ["every-message", "every-n", "first-message"];
  /** 正文上限。 */
  const RULE_CONTENT_LIMIT = 4000;
  /** 正文前 N 字（状态与列表共用）。 */
  const previewText = (content, limit) => {
    const text = typeof content === "string" ? content.replace(/\s+/g, " ").trim() : "";
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };

  /**
   * 某会话的“会话规则”摘要行（状态工具 / 命令共用）。
   * 0 条 → `会话规则：0 条（不会注入）`；>0 → 一行标题 + 最多 5 条明细。
   * @param sessionId - 会话 id。
   * @returns 文本行数组。
   */
  const sessionRuleLines = (sessionId) => {
    const list = typeof sessionId === "string" && sessionId.length > 0 ? readSessionRules().get(sessionId) ?? [] : [];
    if (list.length === 0) return ["会话规则：0 条（不会注入）"];
    return [
      `会话规则：${list.length} 条`,
      ...list
        .slice(0, 5)
        .map(
          (rule) =>
            `  ${rule.type} / ${rule.strategies[0] ?? "every-message"} / ${previewText(rule.content, 20)} / ${rule.enabled === false ? "disabled" : "enabled"}`,
        ),
    ];
  };

  /** 类型 → 注入文本里的短标签。 */
  const RULE_TYPE_LABELS = { rule: "规则", constraint: "约束", preference: "偏好", convention: "约定", feedback: "反馈" };

  /**
   * 校验并归一化一组规则（整体校验：一条不合法就整体拒绝）。
   * @param value - 客户端/模型给的数组。
   * @returns `{ ok: true, rules }` 或 `{ ok: false, error }`。
   */
  const validateRuleArray = (value) => {
    if (!Array.isArray(value)) return { ok: false, error: "rules 必须是数组" };
    const seen = new Set();
    const rules = [];
    const now = new Date().toISOString();
    for (let index = 0; index < value.length; index += 1) {
      const raw = value[index];
      const where = `第 ${index + 1} 条`;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `${where}必须是对象` };
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (id.length === 0) return { ok: false, error: `${where}缺少 id` };
      if (seen.has(id)) return { ok: false, error: `${where}的 id「${id}」重复` };
      seen.add(id);
      if (!RULE_TYPES.includes(raw.type)) return { ok: false, error: `${where}的 type 非法（可用 ${RULE_TYPES.join(" | ")}）` };
      const content = typeof raw.content === "string" ? raw.content : "";
      if (content.trim().length === 0) return { ok: false, error: `${where}的 content 为空` };
      if (content.length > RULE_CONTENT_LIMIT) return { ok: false, error: `${where}的 content 超过 ${RULE_CONTENT_LIMIT} 字` };
      if (!Array.isArray(raw.strategies) || raw.strategies.length === 0) return { ok: false, error: `${where}至少选一个注入策略` };
      const strategies = [];
      for (const strategy of raw.strategies) {
        if (!RULE_STRATEGIES.includes(strategy)) return { ok: false, error: `${where}的 strategies 含未知值「${String(strategy)}」` };
        if (!strategies.includes(strategy)) strategies.push(strategy);
      }
      const everyN = raw.everyN === undefined ? 3 : Number(raw.everyN);
      if (!Number.isInteger(everyN) || everyN < 1) return { ok: false, error: `${where}的 everyN 必须是 ≥1 的整数` };
      rules.push({
        id,
        type: raw.type,
        content,
        strategies,
        everyN,
        enabled: raw.enabled === undefined ? true : raw.enabled === true,
        createdAt: typeof raw.createdAt === "string" && raw.createdAt.length > 0 ? raw.createdAt : now,
        updatedAt: now,
      });
    }
    return { ok: true, rules };
  };

  /**
   * 读 rules.json。坏 JSON / 读失败一律当空表（只记一次 warn），绝不让 pre-step 抛错。
   * @returns `Map<sessionId, Array<Rule>>`。
   */
  const readSessionRules = () => {
    try {
      const file = rulesFile();
      const stat = statSync(file);
      const key = `${stat.mtimeMs}:${stat.size}`;
      if (key === rulesCache.key) return rulesCache.map;
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const map = new Map();
      let failure = "";
      for (const [sessionId, value] of Object.entries(parsed ?? {})) {
        const checked = validateRuleArray(value);
        if (!checked.ok) {
          // 单会话非法 → 只丢弃这一条（回落旧路径），但把原因留给 status。
          if (failure.length === 0) failure = `invalid rules: ${sessionId}: ${checked.error}`;
          continue;
        }
        if (checked.rules.length === 0) continue;
        map.set(sessionId, checked.rules);
      }
      rulesErrorText = failure;
      rulesCache.key = key;
      rulesCache.map = map;
      return map;
    } catch (error) {
      if (error?.code === "ENOENT") {
        rulesCache.key = "";
        rulesCache.map = new Map();
        rulesErrorText = "";
        return rulesCache.map;
      }
      // 坏 JSON / 读不了：整表当空（回落旧路径），但把原因记下来。
      rulesErrorText = `parse failed: ${error instanceof Error ? error.message : String(error)}`;
      if (!rulesCache.warned) {
        rulesCache.warned = true;
        ctx.logger?.warn?.(`vibe-bridge: rules.json unreadable, falling back to the global rules (${rulesErrorText})`);
      }
      return new Map();
    }
  };

  /**
   * 原子写 rules.json（空数组的会话不落盘；整张表都空时**删掉文件**）。
   *
   * 文件"存在与否"是运维判断有没有走新路径的第一信号，留一个 `{}` 会把归因搞乱，
   * 所以没有任何会话带规则时连空对象都不写。
   */
  const writeSessionRules = (map) => {
    const file = rulesFile();
    const payload = {};
    for (const [sessionId, rules] of map) {
      if (!Array.isArray(rules) || rules.length === 0) continue;
      payload[sessionId] = rules;
    }
    if (Object.keys(payload).length === 0) {
      // 用 unlinkSync：这台机器上 rmSync(单个文件) 会出现"不抛错但也没删掉"的行为。
      try {
        unlinkSync(file);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          /* 删不掉也不影响语义：读侧仍按空表处理 */
        }
      }
      rulesCache.key = "";
      rulesCache.map = new Map();
      rulesCache.warned = false;
      rulesErrorText = "";
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, file);
    rulesCache.key = "";
    rulesCache.map = map;
    rulesCache.warned = false;
    rulesErrorText = "";
  };

  /**
   * 整体替换一个会话的规则数组（空数组 = 删掉该会话的条目）。
   * @param sessionId - 会话 id。
   * @param rules - 已校验的规则数组。
   */
  const setSessionRules = (sessionId, rules) => {
    const current = new Map(readSessionRules());
    if (rules.length === 0) current.delete(sessionId);
    else current.set(sessionId, rules);
    writeSessionRules(current);
  };

  /** 该会话是否曾经被本插件注入过（用于 `first-message` 重启后不重复）。按会话缓存。 */
  const priorInjectionCache = new Map();
  const hasPriorInjection = async (sessionId) => {
    if (priorInjectionCache.has(sessionId)) return priorInjectionCache.get(sessionId);
    let seen = false;
    try {
      const { events, log } = await readSessionEvents(sessionId);
      if (log !== undefined) {
        seen = events.some(
          (event) =>
            event?.type === "user/message" &&
            event.data?.source?.kind === name &&
            event.data?.source?.form === "snapshot" &&
            textOfMessage(event.data).includes("[SYSTEM REMINDER:"),
        );
      }
    } catch {
      seen = false;
    }
    priorInjectionCache.set(sessionId, seen);
    return seen;
  };

  /** 本进程内已经发过 `first-message` 的会话。 */
  const firstMessageSent = new Set();

  /**
   * 旧 `nudges.json` 的 `text` 在运行时当作一条**虚拟规则**（只读，绝不落盘）。
   *
   * 迁移等价推导：`every:N` → `every-n`+N；`full` → `every-message`；其余（含无 mode、`sparse`）→
   * `every-n`+配置的 `everyTurns`；`off` 由调用方在更外层短路（整会话不注入）。
   * @param sessionId - 会话 id。
   * @returns 虚拟规则数组（0 或 1 条）。
   */
  const legacyVirtualRules = (sessionId) => {
    const entry = readNudges().get(sessionId);
    const text = typeof entry?.text === "string" ? entry.text : "";
    if (text.trim().length === 0) return [];
    const mode = typeof entry.mode === "string" ? entry.mode : undefined;
    const top = topLevelSchedule(config);
    let strategies = ["every-n"];
    let everyN = top.everyTurns;
    if (mode !== undefined && mode.startsWith("every:")) {
      const n = Number(mode.slice("every:".length));
      if (Number.isInteger(n) && n >= 1) everyN = n;
    } else if (mode === "full") {
      strategies = ["every-message"];
    }
    return [
      {
        id: `legacy:${sessionId}`,
        type: "rule",
        content: text,
        strategies,
        everyN,
        enabled: true,
        // 只读：status 的 rulesCount 不计入它，也不写进 rules.json。
        legacy: true,
      },
    ];
  };

  /**
   * 按会话规则算这一轮要注入的文本（命中的规则按 type 分组、同一轮合并成一段）。
   *
   * 去重沿用旧路径的 `lastRuleText`：同一会话同一条规则的正文与上次注入完全相同 → 只发一句通用短句，
   * 不每轮重发全文。
   * @param sessionId - 会话 id。
   * @param turn - 当前轮次。
   * @param rules - 该会话的规则（已过滤 enabled）。
   * @returns 注入文本；没有命中返回空串。
   */
  const rulesInjectionText = async (sessionId, turn, rules) => {
    const alreadyInjected = firstMessageSent.has(sessionId) || (await hasPriorInjection(sessionId));
    const hits = [];
    for (const rule of rules) {
      let when = false;
      for (const strategy of rule.strategies) {
        if (strategy === "every-message") when = true;
        else if (strategy === "every-n") when = when || (turn - 1) % (Number(rule.everyN) || 3) === 0;
        else if (strategy === "first-message") when = when || !alreadyInjected;
      }
      if (!when) continue;
      if (rule.strategies.includes("first-message")) firstMessageSent.add(sessionId);
      hits.push(rule);
    }
    if (hits.length === 0) return "";
    // 同轮合并：按数组顺序、type 标签、正文去重（同一句只出现一次）。
    const lines = [];
    const seen = new Set();
    for (const rule of hits) {
      const label = RULE_TYPE_LABELS[rule.type] ?? rule.type;
      const body = rule.content.trim();
      const ruleKey = `${sessionId}#${rule.id}`;
      const previous = lastRuleText.get(ruleKey);
      const line =
        previous === body
          ? // 与上次一字不差：只发短句（沿用旧路径的同一句话），避免每轮重发全文。
            `按「${label}」的规则自检一遍（内容同上一轮，未重复）。`
          : `(${label}) ${body}`;
      lastRuleText.set(ruleKey, body);
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
    return lines.join("\n");
  };
  //#endregion
  // 这个集合是防止重复注入的最后一道闸；进程重启后集合清空，最多多念一次。
  const spoken = new Set();
  // 每条规则在每个会话里"有没有开过口"，用于 speakOnFirstSeen。
  const spokenRules = new Set();
  // 每条规则在每个会话里上一次念过的文案，用于“同文不重发”。
  const lastRuleText = new Map();
  // 本进程内已注入次数（诊断用，不落库）。
  let injected = 0;
  // 本进程内注入的字符总数（诊断用：让用户看得见成本）。
  let injectedChars = 0;
  // 已投递的子会话完成通知数（诊断用）。
  let fedNotices = 0;
  // 本进程内见过的会话轮次（诊断用）。
  const seenTurns = [];
  // 父会话 → 子会话运行状态快照，用来发现“跑完了”。
  const childStatus = new Map();
  // 父会话 → 待注入/待唤醒的完成通知（对象数组，可合并）。
  const pendingNotices = new Map();
  // 合并窗口的定时器。
  let noticeTimer = null;

  // ---- 唤醒状态落盘：重启后仍记得“哪些子会话还在跑 / 已经通知过” ----
  /** 落盘内容：children[childId] = { parentId, label, seenRunning, announced, updatedAt }。 */
  const wakeChildren = new Map();
  let wakeSaveTimer = null;

  const loadWakeState = () => {
    try {
      const parsed = JSON.parse(readFileSync(wakeStateFile(), "utf8"));
      const now = Date.now();
      for (const [childId, entry] of Object.entries(parsed?.children ?? {})) {
        if (entry === null || typeof entry !== "object") continue;
        if (typeof entry.parentId !== "string" || typeof entry.label !== "string") continue;
        // 过期条目直接丢掉，避免文件越滚越大。
        if (typeof entry.updatedAt === "number" && now - entry.updatedAt > config.wakeStateTtlMs) continue;
        const record = {
          parentId: entry.parentId,
          label: entry.label,
          seenRunning: entry.seenRunning === true,
          announced: entry.announced === true,
          // armed = the parent asked for this run and still awaits its notice.
          armed: entry.armed === true,
          // arm 原因也要能挺过重启：补偿通知的措辞靠它（老状态文件没有这个字段 → 按派单处理）。
          reason: entry.reason === "post" ? "post" : "spawn",
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : now,
        };
        wakeChildren.set(childId, record);
        watched.set(childId, {
          parentId: record.parentId,
          label: record.label,
          seenRunning: record.seenRunning,
          armed: record.armed,
          reason: record.reason,
        });
        if (record.announced) announced.add(childId);
      }
    } catch {
      // 文件不存在/损坏都不影响启动。
    }
  };

  const saveWakeState = () => {
    const now = Date.now();
    const children = {};
    for (const [childId, record] of wakeChildren) {
      if (now - record.updatedAt > config.wakeStateTtlMs) continue;
      children[childId] = record;
    }
    try {
      const file = wakeStateFile();
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, children }), "utf8");
      renameSync(tmp, file);
    } catch {
      // 落盘失败不能影响主流程。
    }
  };

  /** 合并写盘：短时间内多次变更只落一次。 */
  const scheduleSaveWakeState = () => {
    if (!config.persistWakeState || wakeSaveTimer !== null) return;
    wakeSaveTimer = setTimeout(() => {
      wakeSaveTimer = null;
      saveWakeState();
    }, 400);
    if (typeof wakeSaveTimer.unref === "function") wakeSaveTimer.unref();
  };

  /** 记一条子会话状态（watched 与落盘记录同步更新）。 */
  const rememberChild = (childId, patch) => {
    const current = wakeChildren.get(childId) ??
      { parentId: "", label: "", seenRunning: false, announced: false, armed: false, reason: "spawn", updatedAt: 0 };
    wakeChildren.set(childId, { ...current, ...patch, updatedAt: Date.now() });
    scheduleSaveWakeState();
  };

  /**
   * 标记“父会话在等这个子会话把当前这轮活干完”。
   * 只有被 arm 过的子会话完成时才会回报父会话；你自己打开子会话聊天不会触发。
   * @param childId - 子会话 id。
   * @param parentId - 父会话 id。
   * @param label - 显示名。
   * @param reason - `spawn`（我派的任务）或 `post`（我用 post_to_session 订阅的）——
   *   决定回报时的措辞：派单就是“完成了新一轮工作”，订阅只是“订阅回执”。
   */
  const armChild = (childId, parentId, label, reason = "spawn") => {
    const current = watched.get(childId);
    const record = {
      parentId: parentId ?? current?.parentId ?? wakeChildren.get(childId)?.parentId ?? "",
      label: label ?? current?.label ?? wakeChildren.get(childId)?.label ?? childId,
      seenRunning: false,
      armed: true,
      reason,
    };
    if (record.parentId === "") return;
    watched.set(childId, record);
    // 新的一次指派重新开始计数：清掉上一轮的去重标记，否则第二轮不会回报。
    announced.delete(childId);
    rememberChild(childId, {
      parentId: record.parentId,
      label: record.label,
      seenRunning: false,
      announced: false,
      armed: true,
      reason,
    });
  };

  /**
   * 一次被指派的运行收尾：只有 armed 的子会话才回报，然后立即解除 arm。
   * @returns 是否入队。
   */
  const completeAssignedRun = (childId, parentId, label, status) => {
    const entry = watched.get(childId);
    const persisted = wakeChildren.get(childId);
    const armed = entry?.armed === true || persisted?.armed === true;
    if (!armed) return false;
    const reason = entry?.reason ?? persisted?.reason ?? "spawn";
    watched.delete(childId);
    rememberChild(childId, { parentId: parentId ?? entry?.parentId, label: label ?? entry?.label, armed: false });
    enqueueNotice(parentId ?? entry?.parentId, childId, label ?? entry?.label, status, reason);
    return true;
  };

  if (config.persistWakeState) loadWakeState();
  // 已通知过的子会话（唤醒 / 下一轮注入共用，避免重复）。
  const announced = new Set();
  // spawn_session 出来的子会话：childId → { parentId, label, seenRunning }。
  const watched = new Map();

  /**
   * 走宿主 sessionController 投递一条消息（跨父投递与唤醒兜底共用的唯一通道）。
   *
   * 这条路只经 `resolveAgent` → `agent.followup()`，**没有** subagent 的 lineage 校验，
   * 所以它能把消息送到「不是自己的子会话」那里；代价是 controller 写死的
   * `source.kind = 'user'`（`packages/api/session-controller/src/index.ts:479`），
   * 来源标注只能靠正文前缀 \[来自会话 X 的消息\] 表达。
   *
   * 服务方法签名是 `prompt(request, signal)`；个别版本把 source 当第二参，
   * 两种都试一次，谁先成功用谁。
   * @returns 成功时返回 requestId，失败返回 undefined。
   */
  const deliverViaController = async (sessionId, text, signal) => {
    const controller = ctx.get?.("sessionController");
    if (controller === undefined || typeof controller.prompt !== "function") return undefined;
    const requestId = newRequestId();
    const request = { requestId, sessionId, mode: "queue", content: [{ type: "text", text }] };
    const attempts = [
      () => controller.prompt(request, signal ?? new AbortController().signal),
      () => controller.prompt(request, { kind: name, form: "relay" }),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
        return requestId;
      } catch {
        // 换下一种调用形状再试。
      }
    }
    return undefined;
  };

  /**
   * 立即唤醒父会话：优先给活着的 Agent 塞一条 followup，退回到 sessionController.prompt。
   * @param parentId - 父会话 id。
   * @param text - 已经合并好的通知正文。
   * @returns 是否已投递。
   */
  const wakeParentText = async (parentId, text) => {
    if (text.length === 0) return true;
    const source = { kind: name, form: "notice" };
    const parent = ctx.agents?.get(parentId);
    if (parent !== undefined && typeof parent.followup === "function") {
      try {
        parent.followup(createUserMessage({ content: [{ type: "text", text }], source }));
        return true;
      } catch {
        // 落到 controller 路径
      }
    }
    const delivered = await deliverViaController(parentId, text);
    return delivered !== undefined;
  };

  /**
   * 入队一条子会话通知；同一父会话在合并窗口内的多条会合成一条再唤醒，
   * 避免 N 个子会话同时结束时打出 N 条消息。
   */
  const enqueueNotice = (parentId, childId, label, status, reason = "spawn") => {
    if (announced.has(childId)) return;
    announced.add(childId);
    // 通知一旦发出，这次指派就结束了；之后的运行（例如你自己在子会话里继续聊）
    // 不再回报父会话，除非父会话又投递了新任务（post_to_session 会重新 arm）。
    rememberChild(childId, { parentId, label, announced: true, armed: false });
    const queue = pendingNotices.get(parentId) ?? [];
    queue.push({ childId, label, status, reason });
    pendingNotices.set(parentId, queue);
    if (noticeTimer !== null) return;
    const window = Math.max(50, config.wakeDebounceMs);
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      void flushNotices();
    }, window);
    if (typeof noticeTimer.unref === "function") noticeTimer.unref();
  };

  /** 把队列里的通知按父会话合并投递；投不出去就留给下一轮 pre-step。 */
  const flushNotices = async () => {
    for (const [parentId, queue] of [...pendingNotices]) {
      if (queue.length === 0) {
        pendingNotices.delete(parentId);
        continue;
      }
      pendingNotices.delete(parentId);
      const delivered = await wakeParentText(parentId, batchNotice(queue));
      if (delivered) fedNotices += 1;
      else pendingNotices.set(parentId, queue);
    }
  };

  /** 从 activation 的 settle 值里读出收尾状态（拿不到就当正常完成）。 */
  const describeSettle = (value) => {
    const reason = value?.stopReason ?? value?.reason ?? value?.status;
    if (reason === "error" || reason === "failed" || reason === "failure") return "failed";
    if (reason === "aborted" || reason === "interrupted" || reason === "cancelled" || reason === "canceled") return "aborted";
    return "done";
  };

  // 唤醒哨兵：本插件指派过的子会话 running → 非 running，就立刻叫醒父会话。
  // 只盯 armed 的条目：你自己打开子会话聊天不会 arm，因此不会打扰父会话。
  if (config.wakeParentOnChildFinish && config.wakePollMs > 0) {
    const timer = setInterval(() => {
      void (async () => {
        for (const [childId, entry] of [...watched]) {
          if (entry.armed !== true) {
            watched.delete(childId);
            continue;
          }
          const status = ctx.agents?.get(childId)?.status;
          if (status === "running") {
            if (!entry.seenRunning) {
              entry.seenRunning = true;
              rememberChild(childId, { parentId: entry.parentId, label: entry.label, seenRunning: true });
            }
            continue;
          }
          if (!entry.seenRunning) continue;
          // 哨兵只知道“跑完了”，不知道收尾状态：按正常完成入队，由合并窗口统一投递。
          completeAssignedRun(childId, entry.parentId, entry.label, "done");
        }
      })();
    }, config.wakePollMs);
    // 让宿主进程不被这个哨兵拖住（Node 的 Timer 支持 unref；测试里也靠它退出）。
    if (typeof timer.unref === "function") timer.unref();
    ctx.effect(() => () => clearInterval(timer), "vibe-bridge.child-watch");
  }

  // 重启补偿：上次进程退出时在跑的子会话，如果现在已经不在跑，补一条“你离线期间完成了”的通知。
  if (config.persistWakeState && config.wakeParentOnChildFinish) {
    const compensation = setTimeout(() => {
      void (async () => {
        for (const [childId, record] of [...wakeChildren]) {
          // 只补发父会话指派过、且还没回报的运行。
          if (!record.armed || !record.seenRunning || record.announced) continue;
          const status = ctx.agents?.get(childId)?.status;
          if (status === "running") continue; // 还在跑，交给哨兵
          watched.delete(childId);
          completeAssignedRun(childId, record.parentId, record.label, "done");
        }
        // 落盘一次，把 announced 标记固化，避免下次启动重复补发。
        saveWakeState();
      })();
    }, 2500);
    if (typeof compensation.unref === "function") compensation.unref();
    ctx.effect(() => () => clearTimeout(compensation), "vibe-bridge.wake-compensation");
  }

  // 卸载/重载时把状态刷到盘上（合并写盘可能有 400ms 窗口）。
  if (config.persistWakeState) {
    ctx.effect(() => () => {
      if (wakeSaveTimer !== null) {
        clearTimeout(wakeSaveTimer);
        wakeSaveTimer = null;
      }
      saveWakeState();
    }, "vibe-bridge.wake-state-flush");
  }

  ctx.on(
    "agent/pre-step",
    async (payload, next) => {
      const decision = await next();
      const { agent, turn, step, signal } = payload ?? {};
      if (!decision || decision.kind === "reject") return decision;
      if (signal?.aborted) return decision;
      // 只在一轮的第一步注入：这样碎碎念落在“这一轮用户说话之后、模型思考之前”。
      if (step !== 1) return decision;
      if (!Array.isArray(decision.messages)) return decision;

      const sessionId = agent?.id ?? agent?.session?.id;
      if (typeof sessionId !== "string") return decision;

      const key = `${sessionId}#${turn}`;
      if (spoken.has(key)) return decision;
      // 已经含着本插件的快照消息（重放/续跑）就不再叠一层。
      if (decision.messages.some((message) => message?.source?.kind === name)) {
        spoken.add(key);
        return decision;
      }

      const entries = [];
      const isSubagentSession = agent?.session?.header?.origin === "subagent";

      // 1) 父会话指派的任务跑完 → 注入一条带 session id 的回报通知。
      //    只认本插件指派过（armed）的子会话：你在子会话里自己聊的轮次不回报。
      if (config.notifyOnChildFinish && typeof ctx.subagents?.listChildren === "function") {
        try {
          const children = await ctx.subagents.listChildren(sessionId, signal);
          const statuses = childStatus.get(sessionId) ?? new Map();
          for (const child of children) {
            if (child?.mode !== "continuable" || typeof child.id !== "string") continue;
            const armed = watched.get(child.id)?.armed === true || wakeChildren.get(child.id)?.armed === true;
            if (!armed) {
              // 清掉这一项的状态快照，避免解除 arm 后旧值残留成一次误判。
              statuses.delete(child.id);
              continue;
            }
            const running = ctx.agents?.get(child.id)?.status === "running";
            const before = statuses.get(child.id);
            if (before === true && running === false) {
              completeAssignedRun(child.id, sessionId, child.label, "done");
            }
            statuses.set(child.id, running);
          }
          childStatus.set(sessionId, statuses);
        } catch {
          // 子会话不可读时不拖累本轮注入。
        }
        const notices = pendingNotices.get(sessionId) ?? [];
        if (notices.length > 0) {
          pendingNotices.delete(sessionId);
          entries.push({ name: "child-done", text: batchNotice(notices) });
          fedNotices += 1;
        }
      }

      // 2) 会话级碎碎念：**只有会话规则会注入**（没有全局兜底；nudgeEnabled 已 deprecated，注入侧不读）
      //    优先级：nudges.json mode:"off"（整会话关闭）> 本会话 rules.json 的 enabled 规则 > 旧 nudges.text（只读虚拟规则）。
      //    都没有 → 零注入。子会话按 skipSubagentSessions 整体跳过。
      const sessionEntry = readNudges().get(sessionId);
      const sessionOverride = sessionEntry?.mode === undefined ? undefined : { mode: sessionEntry.mode };
      const realRules = readSessionRules().get(sessionId) ?? [];
      const activeRules = realRules.filter((rule) => rule.enabled !== false);
      const sessionRules =
        sessionOverride?.mode === "off" || (isSubagentSession && asBool(config.skipSubagentSessions, true))
          ? []
          : realRules.length > 0
            ? activeRules
            : legacyVirtualRules(sessionId);
      if (sessionRules.length > 0) {
        // 命中规则同轮合并成一段（分隔符固定为换行）。
        const text = await rulesInjectionText(sessionId, turn, sessionRules);
        if (text.length > 0) {
          entries.push({ name: "nudge", text });
          spokenRules.add(`${sessionId}#rules`);
        }
      }
      if (entries.length === 0) return decision;

      spoken.add(key);
      injected += 1;
      seenTurns.push({ sessionId, turn, rules: entries.map((entry) => entry.name) });
      if (seenTurns.length > 50) seenTurns.shift();
      const text = renderReminder(entries);
      injectedChars += text.length;
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: "text", text }],
            source: {
              kind: name,
              form: "snapshot",
              sections: entries.map((entry) => ({ name: entry.name, text: entry.text })),
            },
          }),
        ],
      };
    },
    { prepend: true },
  );

  /**
   * 创建子会话的共用实现：`spawn_session` 工具与 `/vibe-spawn` 命令都走这里，
   * 保证两条入口的唤醒/回报行为一致。
   * @param parent - 父会话的 Agent。
   * @param label - 列表里显示的名字。
   * @param task - 第一轮指令。
   * @param cwd - 可选工作目录。
   * @returns 子会话 id。
   */
  const startChild = async (parent, label, task, cwd, signal) => {
    const activation = await ctx.subagents.startActivation({
      provider: config.provider,
      label,
      request: {
        prompt: [{ type: "text", text: task }],
        parent,
        ...(cwd === undefined ? {} : { cwd }),
      },
      signal: signal ?? new AbortController().signal,
      // 自己唤醒时用 caller 交付：避免 DSH 原生通知与插件回报各来一条。
      delivery: config.wakeParentOnChildFinish ? "caller" : "parent",
    });
    const parentId = agentIdOf(parent);
    // 这是父会话指派的一次运行：arm 之后才开始等它的完成回报。
    armChild(activation.childId, parentId, label, "spawn");
    if (config.wakeParentOnChildFinish && activation.result !== undefined) {
      // 子会话整轮结束 → 入队（同一窗口内多个子会话会合并成一条通知）。
      void Promise.resolve(activation.result)
        .then((value) => completeAssignedRun(activation.childId, parentId, label, describeSettle(value)))
        .catch(() => completeAssignedRun(activation.childId, parentId, label, "failed"));
    }
    // 子会话的 runtime 快照里只有“你的父会话是谁”，没有“你自己是谁”。
    // 这里补一条上下文投递，把 id 和回报方式告诉它（fire-and-forget）。
    // 立即唤醒的兜底哨兵也在这里登记。
    watched.set(activation.childId, { parentId, label, seenRunning: false, armed: true, reason: "spawn" });
    rememberChild(activation.childId, { parentId, label, seenRunning: false, announced: false, reason: "spawn" });
    if (config.announceChildId) {
      void ctx.subagents
        .sendMessage(
          parent,
          brandString(activation.childId),
          [
            {
              type: "text",
              text: `[vibe-bridge] 你是子会话 ${activation.childId}，父会话 ${parentId}。完成或卡住都用 send_message 回报父会话。`,
            },
          ],
          {},
        )
        .catch(() => {});
    }
    return activation.childId;
  };

  // 一次性迁移：把 nudges.json 里旧的会话文案搬进 rules.json（幂等；没东西可迁就不碰文件）。

  // 宿主命令：UI 点「创建子会话」时直接建，不用先跟父会话的模型聊一轮。
  if (config.enableSpawn && typeof ctx.commands?.register === "function") {
    ctx.effect(
      () =>
        ctx.commands.register({
          name: "vibe-spawn",
          description: "创建一个子会话（vibe-bridge）：/vibe-spawn <label>|<任务>",
          recordInput: true,
          handler: async ({ agent, rawInput }) => {
            const raw = String(rawInput ?? "").trim();
            const separator = raw.indexOf("|");
            const label = (separator >= 0 ? raw.slice(0, separator) : "child").trim() || "child";
            const task = (separator >= 0 ? raw.slice(separator + 1) : raw).trim();
            if (task.length === 0) return { kind: "error", text: "用法：/vibe-spawn <label>|<任务>" };
            try {
              const childId = await startChild(agent, label, task, config.spawnCwd.length > 0 ? config.spawnCwd : undefined);
              return { kind: "success", text: `session started: ${childId}` };
            } catch (error) {
              return { kind: "error", text: `创建失败：${error instanceof Error ? error.message : String(error)}` };
            }
          },
        }),
      "vibe-bridge.vibe-spawn()",
    );
  }

  // 按会话开关/节奏：模型工具 + 宿主命令（客户端菜单以后走这条命令）。
  if (config.enableNudgeControl) {
    ctx.effect(
      () =>
        ctx.tools.register(
          defineTool({
            name: "nudge_control",
            description:
              "Control prompt nudges for ONE session (stored in $DSH_HOME/vibe-bridge/nudges.json, so it survives restarts). " +
              "`off` = no nudges for that session; `clear` (or `on`) drops only the session mode, keeping its rules; " +
              "`purge` removes the whole entry. Pass `rules` to replace this session's whole rule array in the same call " +
              "(cadence now lives in each rule's strategies, so `mode` may be omitted when `rules` is given). " +
              "Per-session `sparse` / `full` / `every:N` / `text` were removed in favour of rule strategies. " +
              "Returns where the effective setting comes from (`source: 'session' | 'global'`) and the stored rule count.",
            parameters: {
              session_id: { type: "string", required: true, description: "Session whose nudges should change." },
              mode: {
                type: "string",
                description: "off | on | clear | purge. Omit it when you only want to write `rules`.",
              },
              rules: {
                type: "array",
                items: { type: "json" },
                description:
                  "Optional: replace this session's whole rule array (same validation as /vibe-nudge rules:<base64>). " +
                  "Each item: { id, type: rule|constraint|preference|convention|feedback, content (≤4000), " +
                  "strategies: [every-message|every-n|first-message], everyN?, enabled? }. An empty array removes them. " +
                  "When both `rules` and `text` are given, `rules` wins and `text` is ignored.",
              },
              text: {
                type: "string",
                description:
                  "Compatibility alias: write/overwrite the content of this session's FIRST rule (creates one with every-message when there is none). " +
                  "An empty string clears that first rule. Ignored when `rules` is also given.",
              },
            },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  session_id: { type: "string", required: true },
                  mode: { type: "string", required: true },
                  source: { type: "string", required: true, enum: ["session", "global"] },
                  /** 该会话保存后的规则条数（没传 rules 时也报当前条数）。 */
                  rulesCount: { type: "number", required: true },
                },
              },
              render: (args, value) => [
                {
                  type: "text",
                  text:
                    value.source === "session"
                      ? `nudges for ${value.session_id}: ${value.mode} (session override)`
                      : args.mode === "purge"
                        ? `nudges for ${value.session_id}: whole override removed (mode and text)`
                        : `nudges for ${value.session_id}: global rules (no session mode)`,
                },
              ],
            },
            async execute(args) {
              const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
              if (sessionId.length === 0) throw new Error("nudge_control requires session_id");
              const hasMode = typeof args.mode === "string" && args.mode.trim().length > 0;
              const mode = hasMode ? parseNudgeMode(args.mode) : undefined;
              // 非法模式在写盘之前就拒绝：文件内容保持原样。
              if (hasMode && mode === undefined) {
                throw new Error(
                  /^(every:\d+|sparse|full)$/i.test(String(args.mode)) ? REMOVED_HINT : `nudge_control: invalid mode "${String(args.mode)}" (use off | on | clear | purge)`,
                );
              }
              if (!hasMode && !Array.isArray(args.rules) && typeof args.text !== "string") {
                throw new Error("nudge_control requires mode, rules or text");
              }
              // 规则数组：先整体校验，非法就整体拒绝（此时 mode 还没写）。
              let rulesCount = (readSessionRules().get(sessionId) ?? []).length;
              if (Array.isArray(args.rules)) {
                const checked = validateRuleArray(args.rules);
                if (!checked.ok) throw new Error(`nudge_control: rules rejected — ${checked.error}`);
                setSessionRules(sessionId, checked.rules);
                rulesCount = checked.rules.length;
              } else if (typeof args.text === "string") {
                // 兼容别名：rules 优先；只有没给 rules 时才按 text 写第一条规则。
                applyTextAlias(sessionId, args.text);
                rulesCount = (readSessionRules().get(sessionId) ?? []).length;
              }
              if (!hasMode) {
                // 只写规则：模式保持不变，把当前生效值回给调用方。
                const entry = readNudges().get(sessionId);
                const current = entry?.mode ?? "global";
                return { session_id: sessionId, mode: current, source: entry?.mode === undefined ? "global" : "session", rulesCount };
              }
              return { ...setSessionNudge(sessionId, mode), rulesCount };
            },
          }),
        ),
      "vibe-bridge.nudge_control()",
    );

    // 宿主命令 /vibe-nudge：无参 = 当前会话在 off ↔ clear 之间切换；带参 = 指定模式。
    if (typeof ctx.commands?.register === "function") {
      ctx.effect(
        () =>
          ctx.commands.register({
            name: "vibe-nudge",
            description:
              "本会话碎碎念：/vibe-nudge [off|on|clear|purge]（无参 = 开/关切换）；" +
              "无参第一次 = 关闭本会话；第二次 = 回落全局节奏（自定义文案保留）。想彻底丢弃文案用 purge。" +
              "clear 只清节奏（保留规则），purge 整条删除；" +
              "/vibe-nudge rules（回 base64 规则数组）/ rules:<base64>（整体替换）；status = 看当前生效摘要（含本会话预填）。" +
              "会话级 every:N / sparse / full / text: 已移除（改由规则策略表达）。",
            recordInput: true,
            handler: async ({ agent, rawInput }) => {
              try {
                const sessionId = agentIdOf(agent);
                const raw = String(rawInput ?? "").trim();
                if (raw.toLowerCase() === "default-rule") {
                  // 「添加默认规则」：显式把包内 nudge.md 变成一条会话规则（不再自动注入）。
                  const content = await defaultRuleContent();
                  if (content.trim().length === 0) return { kind: "error", text: "包内 nudge.md 为空，无法添加默认规则" };
                  const existing = readSessionRules().get(sessionId) ?? [];
                  const now = new Date().toISOString();
                  const candidate = [
                    ...existing,
                    {
                      id: `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                      type: "rule",
                      content,
                      strategies: ["every-message"],
                      everyN: topLevelSchedule(config).everyTurns,
                      enabled: true,
                      createdAt: now,
                      updatedAt: now,
                    },
                  ];
                  const checked = validateRuleArray(candidate);
                  if (!checked.ok) return { kind: "error", text: `默认规则被拒绝：${checked.error}` };
                  setSessionRules(sessionId, checked.rules);
                  return { kind: "success", text: `已添加默认规则（共 ${checked.rules.length} 条，${sessionId}）` };
                }
                if (raw.toLowerCase() === "rules") {
                  // 该会话的规则数组 → base64(JSON)，供弹窗列表与编辑器预填。
                  const list = readSessionRules().get(sessionId) ?? [];
                  return { kind: "success", text: Buffer.from(JSON.stringify(list), "utf8").toString("base64") };
                }
                if (raw.toLowerCase().startsWith("rules:")) {
                  const payload = raw.slice("rules:".length).trim();
                  let parsed = [];
                  if (payload.length > 0) {
                    try {
                      parsed = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
                    } catch (error) {
                      return { kind: "error", text: `规则被拒绝：无法解码（${error instanceof Error ? error.message : String(error)}）` };
                    }
                  }
                  const checked = validateRuleArray(parsed);
                  // 非法整体拒绝、不写盘。
                  if (!checked.ok) return { kind: "error", text: `规则被拒绝：${checked.error}` };
                  setSessionRules(sessionId, checked.rules);
                  return {
                    kind: "success",
                    text: checked.rules.length === 0 ? `本会话规则已清空（${sessionId}）` : `本会话规则已保存：${checked.rules.length} 条（${sessionId}）`,
                  };
                }
                if (raw.toLowerCase() === "status all") {
                  // 批量：面板一次拿全（父 + 所有子会话），不要每会话发一次命令。
                  return { kind: "success", text: nudgeStatusAllText() };
                }
                if (raw.toLowerCase() === "status") {
                  // 只读摘要：设置页/弹窗拿它显示“覆盖了几个会话”与“本会话当前模式+文案”。
                  return { kind: "success", text: nudgeStatusText(sessionId) };
                }
                // 兼容别名：text:<base64> 写/覆盖该会话第一条规则的正文（旧前端的「应用」还能用）。
                if (raw.toLowerCase().startsWith("text:")) {
                  const payload = raw.slice("text:".length).trim();
                  let decoded = "";
                  if (payload.length > 0) {
                    try {
                      decoded = Buffer.from(payload, "base64").toString("utf8");
                    } catch (error) {
                      return { kind: "error", text: `vibe-nudge: 无法解码 base64 文案（${error instanceof Error ? error.message : String(error)}）` };
                    }
                  }
                  const result = applyTextAlias(sessionId, decoded);
                  const map = { created: "已创建第一条规则", updated: "已更新第一条规则", cleared: "已清空第一条规则", noop: "没有可清空的规则" };
                  return { kind: "success", text: `本会话文案（兼容别名）：${map[result.action]}（${sessionId}）` };
                }
                if (raw.length === 0) {
                  // 无参：off ↔ 全局。
                  const current = readNudges().get(sessionId);
                  const next = current?.mode === "off" ? { action: "clear" } : { action: "set", mode: "off" };
                  const result = setSessionNudge(sessionId, next);
                  return {
                    kind: "success",
                    text:
                      result.source === "session"
                        ? `本会话碎碎念已关闭（${sessionId}，session 覆盖）`
                        : `本会话碎碎念已恢复全局规则（${sessionId}）`,
                  };
                }
                const mode = parseNudgeMode(raw);
                if (mode === undefined) {
                  // 已移除的调用（every:N / sparse / full）统一回这句；其它仍是"未知模式"。
                  if (/^(every:\d+|sparse|full)$/i.test(raw)) return { kind: "error", text: REMOVED_HINT };
                  return { kind: "error", text: `无效模式「${raw}」；可用 off | on | clear | purge | status | rules:<base64>` };
                }
                const result = setSessionNudge(sessionId, mode);
                return {
                  kind: "success",
                  text:
                    mode.action === "purge"
                      ? `本会话碎碎念：整条覆盖已删除（含自定义文案，${sessionId}）`
                      : mode.action === "clear"
                        ? `本会话碎碎念：节奏已回落全局（自定义文案保留，${sessionId}）`
                        : result.source === "session"
                          ? `本会话碎碎念：${result.mode}（${sessionId}，session 覆盖）`
                          : `本会话碎碎念：全局规则（${sessionId}，未覆盖）`,
                };
              } catch (error) {
                return { kind: "error", text: `vibe-nudge 失败：${error instanceof Error ? error.message : String(error)}` };
              }
            },
          }),
        "vibe-bridge.vibe-nudge()",
      );
    }
  }

  if (config.enableSpawn) {
    ctx.effect(
      () =>
        ctx.tools.register(
          defineTool({
            name: "spawn_session",
            description:
              "Create a brand-new independent session (not a throwaway sub-task) and hand it a first instruction. " +
              "The new session has its own conversation history and its own working directory; it keeps running in the background " +
              "and you receive a completion notice when it settles. Use `post_to_session` later to continue it, " +
              "`list_sessions` to discover its id. Unlike one-shot delegation, the returned session can be resumed.",
            parameters: {
              prompt: { type: "string", required: true, description: "The first instruction sent to the new session." },
              label: { type: "string", required: true, description: "A short label (3-5 words) used to identify the session in listings." },
              cwd: { type: "string", description: "Working directory for the new session. Omit to inherit the caller's current directory." },
            },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { sessionId: { type: "string", required: true } },
              },
              render: (_args, value) => [{ type: "text", text: `session started: ${value.sessionId}` }],
            },
            isConcurrencySafe: () => true,
            async execute(args, exec) {
              const parent = exec.agent;
              if (!parent) throw new Error("spawn_session requires a calling agent (exec.agent was undefined)");
              const cwd = args.cwd ?? (config.spawnCwd.length > 0 ? config.spawnCwd : undefined);
              return { sessionId: await startChild(parent, args.label, args.prompt, cwd) };
            },
          }),
        ),
      "vibe-bridge.spawn_session()",
    );
  }

  if (config.enablePost) {
    ctx.effect(
      () =>
        ctx.tools.register(
          defineTool({
            name: "post_to_session",
            description:
              "Deliver a message to another session you are adjacent to. The communication matrix decides what is allowed, " +
              "before anything is sent: 父→自己的子会话 (via the subagent message path, sender attribution preserved), " +
              "父↔父 (top-level ↔ top-level, via the host session controller, attribution degraded to the '[来自会话 <id> 的消息]' " +
              "body prefix), 子→自己的父会话 (return channel). 父→**别人的**子会话 and 子→同级兄弟 are refused outright " +
              "(no delivery attempt at all). A working target receives it at its next step; an idle target starts a new turn with it. " +
              "Check `via` to know whether sender attribution survived. Returns delivery confirmation, not the target's answer.",
            parameters: {
              session_id: { type: "string", required: true, description: "Target session id (from spawn_session or list_sessions)." },
              message: { type: "string", required: true, description: "Message text to deliver." },
              stop_current: {
                type: "boolean",
                description:
                  "Interrupt the target's current turn first, then queue this message (vibe's stop_target). " +
                  "Only a direct child can be interrupted.",
              },
              cross_parent: {
                type: "boolean",
                description:
                  "Parent↔parent delivery switch. Only top-level targets can use the host session controller; " +
                  "pass false to refuse leaving your own lineage. Deliveries to your own child, to your parent, and to " +
                  "another parent's child are decided by the communication matrix, not by this flag: another parent's " +
                  "child (including a sibling) is always refused before any delivery is attempted.",
              },
              notify: {
                type: "string",
                enum: ["once", "never"],
                description:
                  "What a later completion notice means for this delivery. 'once' (default) subscribes the target: its next " +
                  "settle reports back exactly once, worded as a subscription receipt (not as work done for your message). " +
                  "'never' delivers without subscribing — this message produces no completion notice at all.",
              },
            },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  messageId: { type: "string", required: true },
                  via: { type: "string", required: true, enum: ["subagent", "controller"] },
                  notify: { type: "string", required: true, enum: ["once", "never"] },
                },
              },
              render: (args, value) => [
                {
                  type: "text",
                  text:
                    `message delivered to session ${args.session_id}` +
                    (value.via === "controller" ? " (via controller — sender attribution lives in the body prefix; " : " (") +
                    (value.notify === "never"
                      ? "completion notice: not subscribed)"
                      : "completion notice: subscribed)"),
                },
              ],
            },
            async execute(args, exec) {
              const sender = exec.agent;
              if (!sender) throw new Error("post_to_session requires a calling agent (exec.agent was undefined)");
              const senderId = agentIdOf(sender);
              // ---- 先判后投：读自己与目标的元数据（日志首条 session 事件），按通信矩阵定夺 ----
              const headerMeta = sender.session?.header;
              const [callerFromLog, targetMeta] = await Promise.all([
                readSessionMetaById(senderId),
                readSessionMetaById(args.session_id),
              ]);
              const callerMeta =
                callerFromLog ??
                (headerMeta === undefined
                  ? undefined
                  : { id: senderId, origin: headerMeta.origin, parentSession: headerMeta.parentSession });
              const verdict = decideDelivery({
                callerId: senderId,
                callerMeta,
                targetId: args.session_id,
                targetMeta,
              });
              // 矩阵里的 ❌：明确拒绝，连 sendMessage / controller 都不碰。
              if (verdict.verdict === "reject") {
                throw new Error(`post_to_session: ${verdict.reason}`);
              }
              if (verdict.verdict === "peer" && args.cross_parent === false) {
                throw new Error(
                  `post_to_session: 目标是顶层会话（${args.session_id}），属于 父↔父 投递；你显式传了 cross_parent: false，` +
                    "所以按“不离开自己的血缘”拒绝。去掉该参数即可投递。",
                );
              }
              // stop_target：先中断目标当前轮，再把新指令排队（vibe 里 stop_target=true 的语义）。
              if (args.stop_current === true) {
                const children = await ctx.subagents.listChildren(senderId, exec.signal);
                if (!children.some((child) => child.id === args.session_id)) {
                  throw new Error(`post_to_session: stop_current only applies to a direct child (${args.session_id})`);
                }
                ctx.subagents.interrupt(brandString(args.session_id), { kind: "ancestor", agent: sender });
              }
              // 带上来源标注：接收方一眼看出是谁发来的（对应 vibe 里「[来自会话 X 的消息]」）。
              const text = `[来自会话 ${senderId} 的消息]\n${args.message}`;
              const sendViaSubagent = () =>
                ctx.subagents.sendMessage(sender, brandString(args.session_id), [{ type: "text", text }], { signal: exec.signal });
              const sendViaController = async () => {
                const requestId = await deliverViaController(args.session_id, text, exec.signal);
                if (requestId === undefined) {
                  throw new Error(
                    `post_to_session: 目标是顶层会话（${args.session_id}），但本进程没有可用的 sessionController，无法投递。`,
                  );
                }
                return `controller-${requestId}`;
              };

              let messageId;
              let via = "subagent";
              if (verdict.verdict === "peer") {
                // 父↔父：sendMessage 必然被判血缘，直接走 controller（不浪费一次注定失败的调用）。
                messageId = await sendViaController();
                via = "controller";
              } else if (verdict.verdict === "parent") {
                // 子→自己的父会话（回报通道）：优先真实 agent-message，血缘拒收才用 controller。
                try {
                  messageId = await sendViaSubagent();
                } catch (error) {
                  if (!isLineageRejection(error) || config.enableCrossParent !== true) throw error;
                  messageId = await sendViaController();
                  via = "controller";
                }
              } else {
                // direct（父→自己的子会话）/ unknown（拿不到元数据，保留旧行为）。
                try {
                  messageId = await sendViaSubagent();
                } catch (error) {
                  if (args.cross_parent !== true || config.enableCrossParent !== true || !isLineageRejection(error)) throw error;
                  const requestId = await deliverViaController(args.session_id, text, exec.signal);
                  if (requestId === undefined) {
                    throw new Error(
                      `post_to_session: cross-parent delivery to ${args.session_id} failed (${error instanceof Error ? error.message : String(error)})`,
                    );
                  }
                  via = "controller";
                  messageId = `controller-${requestId}`;
                }
              }
              // notify 决定这次投递要不要订阅对方的收尾回报（默认订阅一次）。
              const notify = args.notify === "never" ? "never" : "once";
              if (notify === "once") {
                // 这是一次新的订阅：arm 之后，它这一轮收尾才会回报父会话（措辞按 reason='post' 走订阅回执）。
                armChild(args.session_id, senderId, watched.get(args.session_id)?.label ?? args.session_id, "post");
              }
              // 'never'：只投递，不 arm。也**不动**已有的 arm —— 一条"不订阅"的消息不应该顺手吞掉
              // 之前派单（spawn）还没回报的那条通知。
              return { messageId, via, notify };
            },
          }),
        ),
      "vibe-bridge.post_to_session()",
    );
  }

  // 停子会话：只接受“自己直接起的子会话”，对应 vibe 的 stop_vaw_session（后端校验 nanny 关系）。
  if (config.enableStop) {
    ctx.effect(
      () =>
        ctx.tools.register(
          defineTool({
            name: "stop_session",
            description:
              "Ask a session you started to stop its current turn without deleting queued messages. " +
              "Only a direct child of this session is accepted (the same relation the Host's activation authority checks).",
            parameters: {
              session_id: { type: "string", required: true, description: "Direct child session id to stop." },
            },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { accepted: { type: "boolean", required: true } },
              },
              render: (args, _value) => [{ type: "text", text: `stop requested for session ${args.session_id}` }],
            },
            async execute(args, exec) {
              const caller = exec.agent;
              if (!caller) throw new Error("stop_session requires a calling agent (exec.agent was undefined)");
              const children = await ctx.subagents.listChildren(agentIdOf(caller), exec.signal);
              if (!children.some((child) => child.id === args.session_id)) {
                throw new Error(`stop_session: ${args.session_id} is not a direct child of this session`);
              }
              ctx.subagents.interrupt(brandString(args.session_id), { kind: "ancestor", agent: caller });
              return { accepted: true };
            },
          }),
        ),
      "vibe-bridge.stop_session()",
    );
  }

  if (config.enableList) {
    ctx.effect(
      () =>
        ctx.tools.register(
          defineTool({
            name: "list_sessions",
            description:
              "List sessions with ids, labels, and whether each is running or idle. " +
              "`scope: 'children'` (default) lists the continuable sessions you started plus your own parent; " +
              "`scope: 'workspace'` scans the persisted session store and returns every session with its `parent_id`, " +
              "`workdir`, `workspace`, `origin` and `status` — the way to find who is whose child (and to discover ids " +
              "for post_to_session({ cross_parent: true })). Use the returned ids with post_to_session.",
            parameters: {
              scope: {
                type: "string",
                enum: ["children", "workspace"],
                description:
                  "children (default) = your direct children + your parent; workspace = every session in the local session store.",
              },
            },
            output: {
              schema: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string", required: true },
                    label: { type: "string", required: true },
                    status: { type: "string", required: true, enum: ["running", "inactive", "not-loaded"] },
                    role: { type: "string", enum: ["parent", "child"] },
                    parent_id: { type: "string" },
                    origin: { type: "string" },
                    workdir: { type: "string" },
                    workspace: { type: "string" },
                  },
                },
              },
              render: (args, rows) => {
                if (rows.length === 0) return [{ type: "text", text: "(no sessions)" }];
                if (args.scope !== "workspace") {
                  return [{ type: "text", text: rows.map((row) => `${row.id} [${row.status}] (${row.role}) — ${row.label}`).join("\n") }];
                }
                // workspace：一行一个，父子关系与工作目录直接摆在行里。
                return [
                  {
                    type: "text",
                    text: rows
                      .map((row) => {
                        const parent = row.parent_id === undefined ? "top-level" : `child of ${row.parent_id}`;
                        const cwd = row.workdir === undefined ? "-" : row.workdir;
                        return `${row.id} [${row.status}] (${parent}) — ${row.label}  ·  ${cwd}  ·  ${row.workspace ?? "-"}`;
                      })
                      .join("\n"),
                  },
                ];
              },
            },
            async execute(args, exec) {
              const parent = exec.agent;
              if (!parent) throw new Error("list_sessions requires a calling agent (exec.agent was undefined)");
              const callerId = agentIdOf(parent);
              if (args.scope === "workspace") {
                return listWorkspaceSessions({
                  callerId,
                  statusOf: (id) => {
                    const live = ctx.agents?.get(id);
                    const status = live?.status;
                    return status === "running" || status === "inactive" ? status : "not-loaded";
                  },
                });
              }
              const children = await ctx.subagents.listChildren(callerId, exec.signal);
              const statusOf = (id) => (ctx.agents?.get(id)?.status === "running" ? "running" : "inactive");
              const rows = [];
              // 自己若是子会话，把父会话也列出来（对应 vibe 的 nanny-info：上下两头都能看到）。
              const parentId = parent.session?.header?.parentSession;
              if (typeof parentId === "string") {
                rows.push({ id: parentId, label: "(parent)", status: statusOf(parentId), role: "parent" });
              }
              for (const entry of children) {
                if (entry.mode !== "continuable") continue;
                rows.push({ id: entry.id, label: entry.label, status: statusOf(entry.id), role: "child" });
              }
              return rows;
            },
          }),
        ),
      "vibe-bridge.list_sessions()",
    );
  }

  // 读别的会话的最新内容（对应 vibe 的 query_vaw_session）。
  if (config.enableQuery) {
    ctx.effect(
      () =>
        ctx.tools.register(
          defineTool({
            name: "query_session",
            description:
              "Read another session's recent work from its persisted log: header (title, rounds, status, model, workdir, mode, parent) " +
              "plus the last `tail` rounds with user text, assistant text, and a tool summary. " +
              "Use it on a child session id from spawn_session, list_sessions, or a child-done notice.",
            parameters: {
              session_id: { type: "string", required: true, description: "Session id to read." },
              tail: { type: "number", description: "How many latest rounds to include (default 1)." },
              include_tools: {
                type: "string",
                enum: ["summary", "none"],
                description: "Include a per-round tool-call summary (default) or omit it.",
              },
              verbose: {
                type: "boolean",
                description:
                  "Include Model/Provider/Workdir/Mode and longer text excerpts. Default false keeps the report to what a scheduler needs.",
              },
            },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { report: { type: "string", required: true } },
              },
              render: (_args, value) => [{ type: "text", text: value.report }],
            },
            async execute(args) {
              const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
              if (sessionId.length === 0) throw new Error("query_session requires session_id");
              const tail = Number.isFinite(Number(args.tail)) && Number(args.tail) > 0 ? Math.floor(Number(args.tail)) : 1;
              const { events, log } = await readSessionEvents(sessionId);
              if (log === undefined) throw new Error(`query_session: no persisted log found for session ${sessionId}`);
              return {
                report: summarizeSession(sessionId, events, {
                  tail,
                  includeTools: args.include_tools === "none" ? "none" : "summary",
                  running: ctx.agents?.get(sessionId)?.status === "running",
                  verbose: args.verbose === true,
                }),
              };
            },
          }),
        ),
      "vibe-bridge.query_session()",
    );
  }

  // R2 的查询入口：别的会话还有哪些消息没被消费（三态里的 queued）。
  if (config.enableInbox) {
    ctx.effect(
      () =>
        ctx.tools.register(
          defineTool({
            name: "get_session_inbox",
            description:
              "List what is still waiting in another session's inbox, straight from its persisted log. " +
              "Each pending entry carries target ('next-turn' | 'next-step'), source kind, sender session id (when the " +
              "source records one) and the time it was queued. Pair it with query_session's `- Inbox:` line: queued here " +
              "means nobody has consumed it yet; consumed/dropped entries are already resolved and are only visible there. " +
              "A pending entry on an idle/interrupted target is reported as still queued, never as consumed.",
            parameters: {
              session_id: { type: "string", required: true, description: "Session id whose inbox should be read." },
            },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  session_id: { type: "string", required: true },
                  session_status: { type: "string", required: true, enum: ["running", "inactive", "unknown"] },
                  pending_count: { type: "number", required: true },
                  note: { type: "string", required: true },
                  pending: {
                    type: "array",
                    required: true,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        position: { type: "number", required: true },
                        target: { type: "string", required: true, enum: ["next-turn", "next-step"] },
                        source_kind: { type: "string", required: true },
                        sender_session_id: { type: "string" },
                        queued_at: { type: "string", required: true },
                        preview: { type: "string", required: true },
                      },
                    },
                  },
                },
              },
              render: (_args, value) => {
                const lines = [
                  "## get_session_inbox",
                  `- Session: ${value.session_id}`,
                  `- Status: ${value.session_status}`,
                  `- Pending: ${value.pending_count}`,
                ];
                for (const entry of value.pending) {
                  const who = entry.sender_session_id === undefined ? entry.source_kind : `${entry.source_kind} from ${entry.sender_session_id}`;
                  lines.push(`    #${entry.position} [${entry.target}] ${who} · ${entry.queued_at}`, `       ${entry.preview}`);
                }
                lines.push(`- Note: ${value.note}`);
                return [{ type: "text", text: lines.join("\n") }];
              },
            },
            async execute(args) {
              const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
              if (sessionId.length === 0) throw new Error("get_session_inbox requires session_id");
              const { events, log } = await readSessionEvents(sessionId);
              if (log === undefined) throw new Error(`get_session_inbox: no persisted log found for session ${sessionId}`);
              const live = ctx.agents?.get(sessionId)?.status;
              const sessionStatus = live === "running" || live === "inactive" ? live : "unknown";
              const { queues, records } = replayInbox(events);
              // 队列顺序按 target 分开算（position 是各自队列里的位置），整体按到达顺序排。
              const collected = [];
              for (const target of INBOX_TARGETS) {
                const queue = queues[target] ?? [];
                queue.forEach((message, index) => {
                  const record = records.get(messageKey(message, ""));
                  const who = describeSource(message?.source);
                  const body = textOfMessage(message);
                  collected.push({
                    seq: record?.seq ?? Number.MAX_SAFE_INTEGER,
                    entry: {
                      position: index + 1,
                      target,
                      source_kind: who.kind,
                      ...(who.sender === undefined ? {} : { sender_session_id: who.sender }),
                      queued_at: record === undefined ? "-" : stamp(record.queuedAt),
                      preview: body.length > 0 ? clip(body, 160) : "(no text content)",
                    },
                  });
                });
              }
              collected.sort((left, right) => left.seq - right.seq);
              const pending = collected.map((item) => item.entry);
              const note =
                pending.length === 0
                  ? "nothing queued: every entry was already drained (consumed) or canceled (dropped)"
                  : sessionStatus === "running"
                    ? "target is running: these entries are queued and not yet claimed by a step"
                    : `target is ${sessionStatus}: these entries are still queued and nobody consumed them; ` +
                      "if the target was interrupted they may still be dropped — re-run this tool to see the final state";
              return { session_id: sessionId, session_status: sessionStatus, pending_count: pending.length, note, pending };
            },
          }),
        ),
      "vibe-bridge.get_session_inbox()",
    );
  }

  // 自检工具：回答“插件到底生效了没、跑的是哪一版、念过几次”。
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "vibe_bridge_status",
          description:
            "Report whether the vibe-bridge plugin is live in this process: its version, the nudge rules in effect, " +
            "how many prompts it has injected so far, and the session/turn of the most recent injections.",
          parameters: {},
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                version: { type: "string", required: true },
                enabled: { type: "boolean", required: true },
                provider: { type: "string", required: true },
                injected: { type: "number", required: true },
                injectedChars: { type: "number", required: true },
                rules: {
                  type: "array",
                  required: true,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      name: { type: "string", required: true },
                      everyTurns: { type: "number", required: true },
                      fullEveryTurns: { type: "number", required: true },
                      fromTurn: { type: "number", required: true },
                      toTurn: { type: "number", required: true },
                      source: { type: "string", required: true },
                    },
                  },
                },
                recent: {
                  type: "array",
                  required: true,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      sessionId: { type: "string", required: true },
                      turn: { type: "number", required: true },
                      rules: { type: "array", required: true, items: { type: "string" } },
                    },
                  },
                },
                /** 被单独覆盖的会话数（nudges.json 里的条目数）。 */
                overridesCount: { type: "number", required: true },
                /** rules.json 的读取/校验错误；正常时为空串（不是 undefined/null）。 */
                rulesError: { type: "string", required: true },
                /** 当前会话的规则条数（rules.json；虚拟 legacy 规则不算）。 */
                sessionRulesCount: { type: "number", required: true },
                /** 当前会话的规则明细：最多 5 条。 */
                sessionRules: {
                  type: "array",
                  required: true,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      type: { type: "string", required: true },
                      strategy: { type: "string", required: true },
                      content: { type: "string", required: true },
                      enabled: { type: "boolean", required: true },
                    },
                  },
                },
                /** 覆盖详情：最多 5 条，超出部分靠 overridesCount 表达。 */
                overrides: {
                  type: "array",
                  required: true,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      sessionId: { type: "string", required: true },
                      /** 生效模式；没有 mode 的条目（只有自定义文案）报 "global"（所以声明为可选，值总在）。 */
                      mode: { type: "string" },
                      /** 该会话是否有自定义文案。 */
                      textCustom: { type: "boolean", required: true },
                      /** 自定义文案前 40 字；没有则空串。 */
                      textPreview: { type: "string", required: true },
                      updatedAt: { type: "string", required: true },
                    },
                  },
                },
              },
            },
            render: (_args, value) => {
              const shown = value.overrides.slice(0, 5);
              const extra = value.overridesCount - shown.length;
              const overrideLines =
                value.overridesCount === 0
                  ? "  (no session override)"
                  : `  覆盖会话：${value.overridesCount} 个\n` +
                    shown.map((entry) => `    • ${entry.sessionId} → ${entry.mode}${entry.textCustom ? " · 自定义文案" : ""}`).join("\n") +
                    (extra > 0 ? `\n    +${extra}` : "");
              return [
                {
                  type: "text",
                  text:
                    `vibe-bridge ${value.version} — live, injected ${value.injected} time(s)\n` +
                    `  成本：${value.injectedChars} 字符 ≈ ${Math.round(value.injectedChars / 2)} token（本进程累计，粗估）\n` +
                    overrideLines +
                    "\n" +
                    (value.sessionRulesCount === 0
                      ? "  会话规则：0 条（不会注入）"
                      : "  会话规则：" +
                        value.sessionRulesCount +
                        " 条\n" +
                        value.sessionRules
                          .map((rule) => `    • ${rule.type} / ${rule.strategy} / ${rule.content} / ${rule.enabled ? "enabled" : "disabled"}`)
                          .join("\n")) +
                    (value.rulesError.length > 0 ? `\n  rules: ${value.rulesError}` : "") +
                    (value.recent.length === 0 ? "\n  (no injection yet)" : `\n  last: ${JSON.stringify(value.recent.at(-1))}`),
                },
              ];
            },
          },
          execute(_args, context) {
            // 拿不到调用方会话（例如离线诊断）时按空 id 处理，不抛错。
            const agentId =
              typeof context?.agent?.id === "string"
                ? context.agent.id
                : typeof context?.agent?.session?.id === "string"
                  ? context.agent.session.id
                  : "";
            const overrides = [...readNudges()]
              .sort((left, right) => (right[1].updatedAt ?? "").localeCompare(left[1].updatedAt ?? ""))
              .map(([sessionId, entry]) => {
                const custom = typeof entry.text === "string" && entry.text.length > 0;
                return {
                  sessionId,
                  // 没有 mode 的条目（只有自定义文案）报 global —— 语义就是“节奏跟随全局”。
                  mode: entry.mode ?? "global",
                  textCustom: custom,
                  textPreview: custom ? entry.text.slice(0, 40) : "",
                  updatedAt: entry.updatedAt ?? "",
                };
              });
            return Promise.resolve({
              version: VERSION,
              enabled: config.enabled,
              provider: config.provider,
              injected,
              injectedChars,
              // 报的是“真正生效”的节奏：规则内字段 > 顶层标量 > 内置默认，隐式规则也算一条。
              rules: resolvedRules.map((rule) => ({
                name: rule.name,
                everyTurns: rule.everyTurns,
                fullEveryTurns: rule.fullEveryTurns,
                fromTurn: rule.fromTurn,
                toTurn: rule.toTurn,
                source:
                  rule.implicit === true
                    ? config.nudgeText.trim().length > 0
                      ? `nudgeText: ${config.nudgeText.slice(0, 40)}`
                      : "(built-in nudge.md)"
                    : rule.file.length > 0
                      ? rule.file
                      : rule.text.slice(0, 40),
              })),
              overridesCount: overrides.length,
              overrides: overrides.slice(0, 5),
              // 读一次 rules.json，让 rulesError 反映最新一次读盘结果（正常是空串）。
              rulesError: (readSessionRules(), rulesErrorText),
              sessionRulesCount: sessionRulesOf(agentId).length,
              sessionRules: sessionRulesOf(agentId)
                .slice(0, 5)
                .map((rule) => ({
                  type: rule.type,
                  strategy: rule.strategies[0] ?? "every-message",
                  content: previewText(rule.content, 20),
                  enabled: rule.enabled !== false,
                })),
              recent: seenTurns.slice(-5),
            });
          },
        }),
      ),
    "vibe-bridge.vibe_bridge_status()",
  );

  ctx.logger?.info?.(`vibe-bridge ${VERSION}: active (rules=${config.rules.length}, provider=${config.provider})`);
}

export { Config, apply, inject, name };

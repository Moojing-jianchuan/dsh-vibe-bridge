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
import { readFile, readdir } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** Cordis 插件名，同时作为注入消息的 `source.kind`。 */
const name = "vibe-bridge";

/** 版本号：`vibe_bridge_status` 会回报它，用来确认当前进程里跑的是哪一版代码。 */
const VERSION = "0.7.0";

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
  /** 间隔多少轮提醒一次；0 = 只做全量提醒。 */
  everyTurns: z.number().default(1),
  /** 每多少轮来一次“全量”提醒；0 = 永不。 */
  fullEveryTurns: z.number().default(5),
  /** 从第几轮开始生效（1 = 第一轮）。 */
  fromTurn: z.number().default(1),
  /** 到第几轮为止；0 = 不限制。 */
  toTurn: z.number().default(0),
  /** 子会话（origin === 'subagent'）里不念：碎碎念通常只对主对话有意义。 */
  skipSubagentSessions: z.boolean().default(true),
  /**
   * 第一次在这个会话里遇到该规则时（哪怕已经是第 N 轮）立刻念一次全量。
   * 没有它，插件在会话中途装上时要等到下一个轮次节点才开口，看着像没生效。
   */
  speakOnFirstSeen: z.boolean().default(true),
});

/** 插件配置。 */
const Config = z.object({
  /** 总开关：关掉后既不加碎碎念，也不注册任何工具。 */
  enabled: z.boolean().default(true),
  rules: z.array(Rule).default([]),
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

/** 取全量文案：`file` 优先，读失败回落到 `text`。 */
async function fullTextOf(rule) {
  if (rule.file) {
    try {
      const raw = await readFile(rule.file, "utf8");
      if (raw.trim().length > 0) return raw.trim();
    } catch (error) {
      // 文件暂时读不到（被删/权限）时不要让整轮请求挂掉，退回内联文案。
      return rule.text.trim();
    }
  }
  return rule.text.trim();
}

/** 稀疏文案：显式给了就用，否则截全量文案的前 N 行。 */
function sparseTextOf(rule, fullText, sparseLines) {
  if (rule.sparseText.trim().length > 0) return rule.sparseText.trim();
  const lines = fullText.split(/\r?\n/);
  return lines.slice(0, Math.max(1, sparseLines)).join("\n").trim();
}

/**
 * 决定某一轮要不要念、念哪一种。
 * @param rule - 规则。
 * @param turn - 当前轮次（从 1 开始）。
 * @returns `full` / `sparse` / `null`（不念）。
 */
function plan(rule, turn) {
  if (!rule.enabled) return null;
  if (!Number.isFinite(turn) || turn < 1) return null;
  if (turn < rule.fromTurn) return null;
  if (rule.toTurn > 0 && turn > rule.toTurn) return null;
  const offset = turn - rule.fromTurn;
  if (offset === 0) return "full";
  if (rule.fullEveryTurns > 0 && offset % rule.fullEveryTurns === 0) return "full";
  if (rule.everyTurns <= 0) return null;
  if (offset % rule.everyTurns === 0) return "sparse";
  return null;
}

/** 拼装最终注入的文本块。 */
function renderReminder(entries) {
  const body = entries.map((entry) => `[SYSTEM REMINDER:${entry.name}]\n${entry.text}\n[/SYSTEM REMINDER]`).join("\n\n");
  return `\n\n${body}\n\n`;
}

//#region session-log —— 读别的会话的落盘日志（query_session 的实现基础）
/** DSH 的 home 目录；会话日志在 `<home>/sessions/<workspace-slug>/<dir>/session.v*.jsonl*`。 */
const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), ".dsh");

/** 唤醒状态的落盘位置（重启补偿用）。 */
const WAKE_STATE_FILE = path.join(DSH_HOME, "vibe-bridge", "wake-state.json");

/** 按 id 找到某个会话的日志文件（父会话目录名带 `session-` 前缀，子会话直接是 uuid）。 */
async function findSessionLog(sessionId) {
  const root = path.join(DSH_HOME, "sessions");
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
function decodeLog(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
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
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length;
    try {
      text += zstdDecompressSync(buffer.subarray(starts[index], end)).toString("utf8");
    } catch {
      // 最后一帧可能还在写，忽略解不开的一段。
    }
  }
  return text;
}

/** 读一个会话的完整事件流。 */
async function readSessionEvents(sessionId) {
  const log = await findSessionLog(sessionId);
  if (log === undefined) return { events: [], log: undefined };
  const buffer = await readFile(log);
  const events = decodeLog(buffer)
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
  return { events, log };
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

  if (totalRounds === 0) {
    lines.push("", "(no turns yet)");
    return lines.join("\n");
  }

  lines.push("", `# Rounds ${visible[0] ?? 0}-${visible[visible.length - 1] ?? 0} (of ${totalRounds})`);
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
/** 生成一条“子会话完成”的通知正文。 */
function childDoneNotice(childId, label, status) {
  const name = typeof label === "string" && label.length > 0 ? label : childId;
  const word = statusWord(status);
  return (
    `会话「${name}」（session id: ${childId}）${word}。` +
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
 * 单个子会话时保持原文（不改变既有可读性），多个时只列一次工具用法。
 */
function batchNotice(entries) {
  if (entries.length === 0) return "";
  if (entries.length === 1) return childDoneNotice(entries[0].childId, entries[0].label, entries[0].status);
  const lines = entries.map(
    (entry) =>
      `- 「${entry.label || entry.childId}」(${entry.childId.slice(0, 8)}…) ${statusWord(entry.status)}`,
  );
  const ids = entries.map((entry) => entry.childId.slice(0, 8)).join("/");
  return (
    `${entries.length} 个子会话有新进展：\n${lines.join("\n")}\n` +
    `逐个用 query_session({ session_id: "<id>", tail: 1 }) 看；要它们继续就 post_to_session({ session_id: "<id>", message: "..." })。id：${ids}…`
  );
}

/** 生成一个 requestId。 */
function newRequestId() {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `vb-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
//#endregion

/**
 * 注册碎碎念中间件与三个会话工具。
 * @param ctx - Cordis 上下文；所有注册随 ctx 生命周期回收。
 * @param config - 归一化后的插件配置。
 */
function apply(ctx, config) {
  if (!config.enabled) {
    ctx.logger?.info?.("vibe-bridge: disabled by config");
    return;
  }

  // 同一次进程内，同一个 (session, turn) 只念一次。pre-step 在重试时会对同一轮再跑一次，
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
      const parsed = JSON.parse(readFileSync(WAKE_STATE_FILE, "utf8"));
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
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : now,
        };
        wakeChildren.set(childId, record);
        watched.set(childId, {
          parentId: record.parentId,
          label: record.label,
          seenRunning: record.seenRunning,
          armed: record.armed,
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
      mkdirSync(path.dirname(WAKE_STATE_FILE), { recursive: true });
      const tmp = `${WAKE_STATE_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, children }), "utf8");
      renameSync(tmp, WAKE_STATE_FILE);
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
      { parentId: "", label: "", seenRunning: false, announced: false, armed: false, updatedAt: 0 };
    wakeChildren.set(childId, { ...current, ...patch, updatedAt: Date.now() });
    scheduleSaveWakeState();
  };

  /**
   * 标记“父会话在等这个子会话把当前这轮活干完”。
   * 只有被 arm 过的子会话完成时才会回报父会话；你自己打开子会话聊天不会触发。
   */
  const armChild = (childId, parentId, label) => {
    const current = watched.get(childId);
    const record = {
      parentId: parentId ?? current?.parentId ?? wakeChildren.get(childId)?.parentId ?? "",
      label: label ?? current?.label ?? wakeChildren.get(childId)?.label ?? childId,
      seenRunning: false,
      armed: true,
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
    });
  };

  /**
   * 一次被指派的运行收尾：只有 armed 的子会话才回报，然后立即解除 arm。
   * @returns 是否入队。
   */
  const completeAssignedRun = (childId, parentId, label, status) => {
    const entry = watched.get(childId);
    const armed = entry?.armed === true || wakeChildren.get(childId)?.armed === true;
    if (!armed) return false;
    watched.delete(childId);
    rememberChild(childId, { parentId: parentId ?? entry?.parentId, label: label ?? entry?.label, armed: false });
    enqueueNotice(parentId ?? entry?.parentId, childId, label ?? entry?.label, status);
    return true;
  };

  if (config.persistWakeState) loadWakeState();
  // 已通知过的子会话（唤醒 / 下一轮注入共用，避免重复）。
  const announced = new Set();
  // spawn_session 出来的子会话：childId → { parentId, label, seenRunning }。
  const watched = new Map();

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
    const controller = ctx.get?.("sessionController");
    if (controller !== undefined && typeof controller.prompt === "function") {
      try {
        await controller.prompt(
          {
            requestId: newRequestId(),
            sessionId: parentId,
            mode: "queue",
            content: [{ type: "text", text }],
          },
          source,
        );
        return true;
      } catch {
        // 落到“下一轮注入”
      }
    }
    return false;
  };

  /**
   * 入队一条子会话通知；同一父会话在合并窗口内的多条会合成一条再唤醒，
   * 避免 N 个子会话同时结束时打出 N 条消息。
   */
  const enqueueNotice = (parentId, childId, label, status) => {
    if (announced.has(childId)) return;
    announced.add(childId);
    // 通知一旦发出，这次指派就结束了；之后的运行（例如你自己在子会话里继续聊）
    // 不再回报父会话，除非父会话又投递了新任务（post_to_session 会重新 arm）。
    rememberChild(childId, { parentId, label, announced: true, armed: false });
    const queue = pendingNotices.get(parentId) ?? [];
    queue.push({ childId, label, status });
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

      // 2) 碎碎念规则
      for (const rule of config.rules) {
        if (isSubagentSession && rule.skipSubagentSessions) continue;
        const ruleKey = `${sessionId}#${rule.name}`;
        // 首次在这个会话里遇到这条规则就先念一次全量：插件中途装上也能立刻看见效果。
        const firstSeen =
          rule.speakOnFirstSeen &&
          !spokenRules.has(ruleKey) &&
          turn >= rule.fromTurn &&
          (rule.toTurn <= 0 || turn <= rule.toTurn);
        const mode = firstSeen ? "full" : plan(rule, turn);
        if (mode === null) continue;
        const full = await fullTextOf(rule);
        if (full.length === 0) continue;
        let text = mode === "full" ? full : sparseTextOf(rule, full, config.sparseLines);
        if (text.length === 0) continue;
        // 稀疏提醒如果和上一轮一字不差，就只发一行短标记：节奏还在，重复文案不再进历史。
        if (mode === "sparse") {
          const previous = lastRuleText.get(ruleKey);
          if (previous === text) {
            text = `按「${rule.name}」的规则自检一遍（内容同上一轮，未重复）。`;
          } else {
            lastRuleText.set(ruleKey, text);
          }
        } else {
          lastRuleText.set(ruleKey, text);
        }
        entries.push({ name: rule.name, text });
        spokenRules.add(ruleKey);
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
    armChild(activation.childId, parentId, label);
    if (config.wakeParentOnChildFinish && activation.result !== undefined) {
      // 子会话整轮结束 → 入队（同一窗口内多个子会话会合并成一条通知）。
      void Promise.resolve(activation.result)
        .then((value) => completeAssignedRun(activation.childId, parentId, label, describeSettle(value)))
        .catch(() => completeAssignedRun(activation.childId, parentId, label, "failed"));
    }
    // 子会话的 runtime 快照里只有“你的父会话是谁”，没有“你自己是谁”。
    // 这里补一条上下文投递，把 id 和回报方式告诉它（fire-and-forget）。
    // 立即唤醒的兜底哨兵也在这里登记。
    watched.set(activation.childId, { parentId, label, seenRunning: false, armed: true });
    rememberChild(activation.childId, { parentId, label, seenRunning: false, announced: false });
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
              "Deliver a message to another session you are adjacent to (a session you started, or your own parent). " +
              "A working target receives it at its next step; an idle target starts a new turn with it. " +
              "Returns delivery confirmation, not the target's answer.",
            parameters: {
              session_id: { type: "string", required: true, description: "Target session id (from spawn_session or list_sessions)." },
              message: { type: "string", required: true, description: "Message text to deliver." },
              stop_current: {
                type: "boolean",
                description:
                  "Interrupt the target's current turn first, then queue this message (vibe's stop_target). " +
                  "Only a direct child can be interrupted.",
              },
            },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { messageId: { type: "string", required: true } },
              },
              render: (args, _value) => [{ type: "text", text: `message delivered to session ${args.session_id}` }],
            },
            async execute(args, exec) {
              const sender = exec.agent;
              if (!sender) throw new Error("post_to_session requires a calling agent (exec.agent was undefined)");
              // stop_target：先中断目标当前轮，再把新指令排队（vibe 里 stop_target=true 的语义）。
              if (args.stop_current === true) {
                const children = await ctx.subagents.listChildren(agentIdOf(sender), exec.signal);
                if (!children.some((child) => child.id === args.session_id)) {
                  throw new Error(`post_to_session: stop_current only applies to a direct child (${args.session_id})`);
                }
                ctx.subagents.interrupt(brandString(args.session_id), { kind: "ancestor", agent: sender });
              }
              // 带上来源标注：接收方一眼看出是谁发来的（对应 vibe 里「[来自会话 X 的消息]」）。
              const senderId = agentIdOf(sender);
              const messageId = await ctx.subagents.sendMessage(
                sender,
                brandString(args.session_id),
                [{ type: "text", text: `[来自会话 ${senderId} 的消息]\n${args.message}` }],
                { signal: exec.signal },
              );
              // 这是一次新的父→子指派：重新 arm，它这一轮干完才会回报父会话。
              armChild(args.session_id, senderId, watched.get(args.session_id)?.label ?? args.session_id);
              return { messageId };
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
              "List the continuable sessions you started, with ids, labels, and whether each is running or idle. " +
              "Use the returned ids with post_to_session.",
            parameters: {},
            output: {
              schema: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string", required: true },
                    label: { type: "string", required: true },
                    status: { type: "string", required: true, enum: ["running", "inactive"] },
                    role: { type: "string", required: true, enum: ["parent", "child"] },
                  },
                },
              },
              render: (_args, rows) =>
                rows.length === 0
                  ? [{ type: "text", text: "(no sessions)" }]
                  : [{ type: "text", text: rows.map((row) => `${row.id} [${row.status}] (${row.role}) — ${row.label}`).join("\n") }],
            },
            async execute(_args, exec) {
              const parent = exec.agent;
              if (!parent) throw new Error("list_sessions requires a calling agent (exec.agent was undefined)");
              const children = await ctx.subagents.listChildren(agentIdOf(parent), exec.signal);
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
              },
            },
            render: (_args, value) => [
              {
                type: "text",
                text:
                  `vibe-bridge ${value.version} — live, ${value.rules.length} rule(s), injected ${value.injected} time(s)\n` +
                  `  成本：${value.injectedChars} 字符 ≈ ${Math.round(value.injectedChars / 2)} token（本进程累计，粗估）\n` +
                  value.rules
                    .map(
                      (rule) =>
                        `  • ${rule.name}: every ${rule.everyTurns} turn(s), full every ${rule.fullEveryTurns}, ` +
                        `turn ${rule.fromTurn}..${rule.toTurn === 0 ? "∞" : rule.toTurn}, source=${rule.source}`,
                    )
                    .join("\n") +
                  (value.recent.length === 0 ? "\n  (no injection yet)" : `\n  last: ${JSON.stringify(value.recent.at(-1))}`),
              },
            ],
          },
          execute() {
            return Promise.resolve({
              version: VERSION,
              enabled: config.enabled,
              provider: config.provider,
              injected,
              injectedChars,
              rules: config.rules.map((rule) => ({
                name: rule.name,
                everyTurns: rule.everyTurns,
                fullEveryTurns: rule.fullEveryTurns,
                fromTurn: rule.fromTurn,
                toTurn: rule.toTurn,
                source: rule.file.length > 0 ? rule.file : rule.text.slice(0, 40),
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

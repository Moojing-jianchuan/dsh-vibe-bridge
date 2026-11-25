/**
 * vibe-bridge 冒烟测试：不启动完整 harness，用假的 ctx 验证
 *   1) Config 归一化
 *   2) 碎碎念按轮次节奏注入（全量/稀疏/生效区间/去重）
 *   3) spawn_session / post_to_session / list_sessions 的调用契约
 *
 * 运行：node test/smoke.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { apply, Config, name } from "../lib/index.js";
import { assertSupportedJsonSchema, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

/**
 * 会话日志用例使用临时 DSH_HOME：绝不碰真实的 ~/.dsh 会话库。
 * （lib/index.js 里的 dshHome() 每次现读 env，所以在这里设也来得及。）
 */
const TEST_HOME = mkdtempSync(path.join(tmpdir(), "vb-smoke-"));
process.env.DSH_HOME = TEST_HOME;
process.on("exit", () => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const results = [];
function check(title, fn) {
  try {
    fn();
    results.push(`PASS  ${title}`);
  } catch (error) {
    results.push(`FAIL  ${title}\n      ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

/** 造一个最小可用的假 Cordis 上下文。 */
function makeCtx(
  config,
  { agentsStatus = "running", children = [], postFailure = {}, sessionController = undefined } = {},
) {
  const preStep = [];
  const tools = new Map();
  const activations = [];
  const messages = [];
  const interrupted = [];
  const woke = [];
  const commands = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on(event, handler) {
      if (event === "agent/pre-step") preStep.push(handler);
    },
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    subagents: {
      async startActivation(spec) {
        activations.push(spec);
        // 每次给新 id，批量通知的用例需要区分不同子会话
        const childId = `child-session-${String(activations.length).padStart(4, "0")}`;
        return { childId, result: Promise.resolve({}) };
      },
      async sendMessage(sender, target, content, options) {
        // 模拟 subagent 的血缘拒收（跨父投递用例）
        const failure = postFailure[target];
        if (failure !== undefined) throw new Error(failure);
        messages.push({ sender, target, content, options });
        return "inbox-message-0001";
      },
      async listChildren(parentId) {
        return [
          { kind: "child", mode: "continuable", id: "child-session-0001", label: "reviewer" },
          { kind: "child", mode: "one-shot", id: "child-session-0002", label: "scout" },
        ];
      },
      interrupt(id, options) {
        interrupted.push({ id, options });
      },
    },
    agents: {
      get(id) {
        if (typeof agentsStatus === "object" && agentsStatus !== null) {
          return {
            status: agentsStatus[id],
            followup: (message) => woke.push({ id, message }),
          };
        }
        return { status: agentsStatus, followup: (message) => woke.push({ id, message }) };
      },
    },
    // 只有配了假 sessionController 时才提供 ctx.get（其余用例保持“服务缺失”的老行为）
    ...(sessionController === undefined
      ? {}
      : { get: (service) => (service === "sessionController" ? sessionController : undefined) }),
    commands: {
      register(definition) {
        commands.push(definition);
        return () => {};
      },
    },
  };
  apply(ctx, config);
  return { ctx, preStep, tools, activations, messages, interrupted, woke, agentsStatus, commands };
}

/** 模拟一次 pre-step：返回合并后的 decision。 */
async function step(handler, { turn, step: stepNo = 1, messages = [], agent = { id: "session-parent", session: { id: "session-parent" } } }) {
  const next = async () => ({ kind: "continue", messages });
  return handler({ agent, turn, step: stepNo, signal: { aborted: false } }, next);
}

const baseRules = [
  {
    name: "task",
    text: "第一条规则：盯着当前目标，别跑题。\n第二行：别把没验证的结论当成结论。\n第三行：改文件前先读。\n第四行：这行只应出现在全量提醒里。",
    sparseText: "第一条规则（稀疏）：盯住目标，先验证再下结论。",
    everyTurns: 1,
    fullEveryTurns: 5,
  },
];

// 测试里关掉落盘：不要往真实的 ~/.dsh 里写状态（落盘由 test/wake-state-probe.mjs 用临时目录验证）。
const config = Config({ enabled: true, rules: baseRules, provider: "spawn", persistWakeState: false });

check("Config 归一化：默认值补齐", () => {
  assert.equal(config.provider, "spawn");
  assert.equal(config.enableSpawn, true);
  assert.equal(config.enablePost, true);
  assert.equal(config.enableList, true);
  assert.equal(config.spawnCwd, "");
  assert.equal(config.sparseLines, 3);
  assert.equal(config.rules.length, 1);
  assert.equal(config.rules[0].fromTurn, 1);
  assert.equal(config.rules[0].toTurn, 0);
});

const { preStep, tools, activations, messages, interrupted, commands } = makeCtx(config);

check("注册了 1 个中间件 + 8 个工具", () => {
  assert.equal(preStep.length, 1);
  assert.deepEqual([...tools.keys()].sort(), [
    "get_session_inbox",
    "list_sessions",
    "nudge_control",
    "post_to_session",
    "query_session",
    "spawn_session",
    "stop_session",
    "vibe_bridge_status",
  ]);
});

const run = async () => {
  // ---- 碎碎念节奏 ----
  const turn1 = await step(preStep[0], { turn: 1 });
  const injected1 = turn1.messages.filter((m) => m.source?.kind === name);
  assert.equal(injected1.length, 1, "turn 1 应注入一条");
  const text1 = injected1[0].content.map((p) => p.text).join("");
  assert.match(text1, /\[SYSTEM REMINDER:task\]/, "应带标记");
  assert.match(text1, /这行只应出现在全量提醒里/, "turn 1 应为全量文案");
  assert.equal(injected1[0].source.form, "snapshot");
  results.push("PASS  turn 1 注入全量碎碎念");

  const turn2 = await step(preStep[0], { turn: 2 });
  const text2 = turn2.messages.filter((m) => m.source?.kind === name).map((m) => m.content.map((p) => p.text).join("")).join("");
  assert.match(text2, /稀疏/, "turn 2 应为稀疏文案");
  assert.doesNotMatch(text2, /第四行/);
  results.push("PASS  turn 2 注入稀疏碎碎念");

  const turn3 = await step(preStep[0], { turn: 3 });
  const text3 = turn3.messages.filter((m) => m.source?.kind === name).map((m) => m.content.map((p) => p.text).join("")).join("");
  // 稀疏文案与上一轮完全相同 → 只发一行短标记，不再重复整段
  assert.match(text3, /内容同上一轮/, "turn 3 应命中“同文不重发”");
  assert.doesNotMatch(text3, /稀疏/, "重复的稀疏正文不应再出现");
  results.push("PASS  turn 3 稀疏同文 → 只发短标记（省 token，节奏不变）");

  // 换了文案就应重新发全文：改 nudge 文件后清掉记忆，验证仍给完整稀疏文案
  const freshRules = Config({
    enabled: true,
    rules: [{ name: "task", text: "甲行\n乙行\n丙行\n丁行", sparseText: "另一段稀疏文案", everyTurns: 1, fullEveryTurns: 0 }],
  });
  const fresh = makeCtx(freshRules);
  await step(fresh.preStep[0], { turn: 1 });
  const freshTurn2 = await step(fresh.preStep[0], { turn: 2 });
  const freshText = freshTurn2.messages.filter((m) => m.source?.kind === name).map((m) => m.content.map((p) => p.text).join("")).join("");
  assert.match(freshText, /另一段稀疏文案/, "内容变化时不应被压缩成标记");
  results.push("PASS  稀疏文案变化时照常发全文");

  const turn6 = await step(preStep[0], { turn: 6 });
  const text6 = turn6.messages.filter((m) => m.source?.kind === name).map((m) => m.content.map((p) => p.text).join("")).join("");
  assert.match(text6, /第四行/, "turn 6 偏移 5 % 5 === 0，应为全量文案");
  results.push("PASS  turn 6 命中全量节奏（首轮 + 每 5 轮）");

  const throttle = Config({ enabled: true, rules: [{ name: "t2", text: "隔两轮", everyTurns: 2, fullEveryTurns: 0 }] });
  const th = makeCtx(throttle);
  const hits = [];
  for (const turn of [1, 2, 3, 5]) {
    const decision = await step(th.preStep[0], { turn });
    hits.push([turn, decision.messages.filter((m) => m.source?.kind === name).length]);
  }
  assert.deepEqual(hits, [[1, 1], [2, 0], [3, 1], [5, 1]], "everyTurns=2 应为 1、3、5 轮命中");
  results.push("PASS  everyTurns 节流");

  const stepTwo = await step(preStep[0], { turn: 7, step: 2 });
  assert.equal(stepTwo.messages.filter((m) => m.source?.kind === name).length, 0, "非第一步不注入");
  results.push("PASS  同一轮的第二 step 不重复注入");

  const replay = await step(preStep[0], { turn: 1 });
  assert.equal(replay.messages.filter((m) => m.source?.kind === name).length, 0, "同一 (session, turn) 不重复注入");
  results.push("PASS  同轮重试不重复注入");

  const childAgent = { id: "session-child", session: { id: "session-child", header: { origin: "subagent" } } };
  const inChild = await step(preStep[0], { turn: 1, agent: childAgent });
  assert.equal(inChild.messages.filter((m) => m.source?.kind === name).length, 0, "子会话默认不念");
  const forceChild = Config({ enabled: true, rules: [{ name: "all", text: "子会话也念", skipSubagentSessions: false }] });
  const forced = makeCtx(forceChild);
  const forcedDecision = await step(forced.preStep[0], { turn: 1, agent: childAgent });
  assert.equal(forcedDecision.messages.filter((m) => m.source?.kind === name).length, 1, "关掉 skip 后子会话也念");
  results.push("PASS  skipSubagentSessions 只对子会话生效");

  const ruleOff = Config({ enabled: true, rules: [{ name: "later", text: "第 10 轮才念", fromTurn: 10, toTurn: 12 }] });  const off = makeCtx(ruleOff);
  for (const turn of [1, 9, 11, 13]) {
    const decision = await step(off.preStep[0], { turn });
    const count = decision.messages.filter((m) => m.source?.kind === name).length;
    const expected = turn === 11 ? 1 : 0;
    assert.equal(count, expected, `fromTurn/toTurn 区间内才注入（turn=${turn}）`);
  }
  results.push("PASS  fromTurn/toTurn 生效区间");

  // speakOnFirstSeen：插件中途装上（会话已经到第 7 轮）也要立刻看见效果
  const late = Config({ enabled: true, rules: [{ name: "late", text: "全量文案\n第二行\n第三行", everyTurns: 4, fullEveryTurns: 12 }] });
  const lateCtx = makeCtx(late);
  const firstAt7 = await step(lateCtx.preStep[0], { turn: 7 });
  const t7 = firstAt7.messages.filter((m) => m.source?.kind === name).map((m) => m.content.map((p) => p.text).join("")).join("");
  assert.match(t7, /第三行/, "第 7 轮首次遇到应念全量");
  const at8 = await step(lateCtx.preStep[0], { turn: 8 });
  assert.equal(at8.messages.filter((m) => m.source?.kind === name).length, 0, "第 8 轮不满足节奏");
  const at9 = await step(lateCtx.preStep[0], { turn: 9 });
  assert.equal(at9.messages.filter((m) => m.source?.kind === name).length, 1, "第 9 轮满足 everyTurns=4");
  const noFirst = Config({ enabled: true, rules: [{ name: "late2", text: "X", everyTurns: 4, fullEveryTurns: 12, speakOnFirstSeen: false }] });
  const nf = makeCtx(noFirst);
  const nfAt7 = await step(nf.preStep[0], { turn: 7 });
  assert.equal(nfAt7.messages.filter((m) => m.source?.kind === name).length, 0, "关掉 speakOnFirstSeen 后不抢跑");
  results.push("PASS  speakOnFirstSeen 让中途装载也能立刻开口");

  // ---- 工具契约 ----
  const spawned = await tools.get("spawn_session").execute(
    { prompt: "把 A 模块的测试补齐", label: "补齐测试", cwd: "D:/work/a" },
    { agent: { id: "session-parent" }, signal: undefined },
  );
  assert.equal(spawned.sessionId, "child-session-0001");
  const spec = activations.at(-1);
  assert.equal(spec.provider, "spawn");
  assert.equal(spec.delivery, "caller", "开启立即唤醒时用 caller 交付，避免和原生通知重复");
  assert.equal(spec.label, "补齐测试");
  assert.deepEqual(spec.request.prompt, [{ type: "text", text: "把 A 模块的测试补齐" }]);
  assert.equal(spec.request.cwd, "D:/work/a");
  assert.equal(spec.request.parent.id, "session-parent");
  results.push("PASS  spawn_session 调用 startActivation 的参数正确");

  // 创建后补一条“你的 id 是 X”的上下文投递
  assert.ok(messages.length >= 1, "应补发一条自我介绍消息");
  const announced = messages.at(-1);
  assert.equal(announced.target, "child-session-0001");
  assert.match(announced.content[0].text, /你是子会话 child-session-0001/);
  assert.match(announced.content[0].text, /父会话 session-parent/);
  assert.ok(announced.content[0].text.length < 120, "自我介绍应保持短文案");
  results.push("PASS  spawn_session 告诉子会话自己的 session id");

  const postedResult = await tools.get("post_to_session").execute(
    { session_id: "child-session-0001", message: "补一条边界用例" },
    { agent: { id: "session-parent" }, signal: undefined },
  );
  assert.equal(postedResult.messageId, "inbox-message-0001");
  const posted = messages.filter((entry) => entry.content[0].text.startsWith("[来自会话"));
  assert.equal(posted.length, 1, "应只有一条带来源标注的投递");
  assert.match(posted[0].content[0].text, /^\[来自会话 session-parent 的消息\]\n补一条边界用例$/);
  results.push("PASS  post_to_session 投递成功且带来源标注");

  // stop_current：先中断再投递（vibe 的 stop_target）；非直接子会话要拒绝
  const before = interrupted.length;
  await tools.get("post_to_session").execute(
    { session_id: "child-session-0001", message: "改做另一件事", stop_current: true },
    { agent: { id: "session-parent" }, signal: undefined },
  );
  assert.equal(interrupted.length, before + 1, "应先中断目标");
  let stopRefused = "";
  try {
    await tools.get("post_to_session").execute(
      { session_id: "someone-else", message: "x", stop_current: true },
      { agent: { id: "session-parent" }, signal: undefined },
    );
  } catch (error) {
    stopRefused = error.message;
  }
  assert.match(stopRefused, /only applies to a direct child/);
  results.push("PASS  post_to_session(stop_current) 先中断再投递，且只对直接子会话");

  const listed = await tools.get("list_sessions").execute({}, { agent: { id: "session-parent" }, signal: undefined });
  assert.deepEqual(listed, [{ id: "child-session-0001", label: "reviewer", status: "running", role: "child" }]);
  results.push("PASS  list_sessions 只列 continuable 并带状态/角色");

  // 子会话视角：把自己的父会话也列出来（nanny-info 那种上下都能看到）
  const childView = await tools.get("list_sessions").execute(
    {},
    { agent: { id: "session-child", session: { id: "session-child", header: { origin: "subagent", parentSession: "session-parent" } } } },
  );
  assert.equal(childView[0].role, "parent");
  assert.equal(childView[0].id, "session-parent");
  results.push("PASS  list_sessions 在子会话里带上父会话");

  // stop_session：只接受直接子会话
  let refused = "";
  try {
    await tools.get("stop_session").execute({ session_id: "someone-else" }, { agent: { id: "session-parent" } });
  } catch (error) {
    refused = error.message;
  }
  assert.match(refused, /not a direct child/);
  const stopped = await tools.get("stop_session").execute({ session_id: "child-session-0001" }, { agent: { id: "session-parent" } });
  assert.equal(stopped.accepted, true);
  assert.equal(interrupted.at(-1).id, "child-session-0001");
  results.push("PASS  stop_session 只停自己的直接子会话");

  let queryError = "";
  try {
    await tools.get("query_session").execute({ session_id: "no-such-session-0000" }, { agent: { id: "session-parent" } });
  } catch (error) {
    queryError = error.message;
  }
  assert.match(queryError, /no persisted log/);
  results.push("PASS  query_session 对未知会话报错");

  // 宿主命令 /vibe-spawn：UI 直接建子会话，不必走一遍父会话的模型轮次
  const spawnCommand = commands.find((definition) => definition.name === "vibe-spawn");
  assert.ok(spawnCommand, "应注册 vibe-spawn 命令");
  const commandResult = await spawnCommand.handler({ agent: { id: "session-parent" }, rawInput: "ui-child|从 UI 建一个子会话" });
  assert.equal(commandResult.kind, "success");
  assert.match(commandResult.text, /session started: child-session-\d{4}/);
  const commandSpec = activations.at(-1);
  assert.equal(commandSpec.label, "ui-child");
  assert.deepEqual(commandSpec.request.prompt, [{ type: "text", text: "从 UI 建一个子会话" }]);
  assert.equal(commandSpec.request.parent.id, "session-parent");
  const emptyTask = await spawnCommand.handler({ agent: { id: "session-parent" }, rawInput: "label-only|" });
  assert.equal(emptyTask.kind, "error");
  results.push("PASS  /vibe-spawn 命令直接创建子会话（含空任务校验）");

  // 成本可见：status 报注入字符数
  const statusValue = await tools.get("vibe_bridge_status").execute({}, {});
  assert.equal(typeof statusValue.injectedChars, "number");
  assert.ok(statusValue.injectedChars > 0, "本次会话已有注入，字符数应大于 0");
  results.push("PASS  vibe_bridge_status 报成本（注入字符数）");

  console.log(results.join("\n"));
};

// 立即唤醒：子会话 running → idle 后，父会话应立刻收到一条 followup（不等下一轮）。
const wakeCheck = async () => {
  const statuses = { "session-parent": "inactive", "child-session-0001": "running" };
  const wakeConfig = Config({ enabled: true, provider: "spawn", rules: [], wakePollMs: 40, wakeDebounceMs: 40, wakeParentOnChildFinish: true, persistWakeState: false });
  const wakeCtx = makeCtx(wakeConfig, { agentsStatus: statuses });
  await wakeCtx.tools.get("spawn_session").execute(
    { prompt: "跑个小任务", label: "waker" },
    { agent: { id: "session-parent" }, signal: undefined },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  statuses["child-session-0001"] = "inactive";
  await new Promise((resolve) => setTimeout(resolve, 250));
  check("立即唤醒：子会话跑完后父会话直接收到 followup", () => {
    assert.ok(wakeCtx.woke.length >= 1, "应唤醒父会话");
    const call = wakeCtx.woke.at(-1);
    assert.equal(call.id, "session-parent");
    const text = call.message.content.map((part) => part.text).join("");
    assert.match(text, /child-session-0001/);
    assert.match(text, /完成了新一轮工作/);
  });
  console.log(results.filter((line) => line.includes("立即唤醒")).join("\n"));

  // 批量合并：两个子会话在窗口内先后结束 → 只唤醒一次，正文列两条
  const batchStatuses = { "session-parent": "inactive" };
  const batchConfig = Config({
    enabled: true,
    provider: "spawn",
    rules: [],
    wakePollMs: 0,
    wakeDebounceMs: 60,
    wakeParentOnChildFinish: true,
    persistWakeState: false,
  });
  const batchCtx = makeCtx(batchConfig, { agentsStatus: batchStatuses });
  await batchCtx.tools.get("spawn_session").execute({ prompt: "甲任务", label: "甲" }, { agent: { id: "session-parent" } });
  await batchCtx.tools.get("spawn_session").execute({ prompt: "乙任务", label: "乙" }, { agent: { id: "session-parent" } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  check("批量合并：两个子会话只唤醒一次，正文含两条", () => {
    assert.equal(batchCtx.woke.length, 1, `应只有 1 条唤醒消息，实际 ${batchCtx.woke.length}`);
    const text = batchCtx.woke[0].message.content.map((part) => part.text).join("");
    assert.match(text, /2 个子会话/);
    assert.match(text, /甲/);
    assert.match(text, /乙/);
  });
  console.log(results.filter((line) => line.includes("批量合并")).join("\n"));

  // 只有“父会话指派过的运行”才回报：你自己在子会话里聊天不会打扰父会话。
  const manualStatuses = { "session-parent": "inactive", "child-session-0001": "running" };
  const manualConfig = Config({
    enabled: true,
    provider: "spawn",
    rules: [],
    wakePollMs: 40,
    wakeDebounceMs: 40,
    wakeParentOnChildFinish: true,
    persistWakeState: false,
  });
  const manualCtx = makeCtx(manualConfig, { agentsStatus: manualStatuses });
  const parent = { id: "session-parent", session: { header: { origin: "parent" } } };
  const continueDecision = async () => ({ kind: "continue", messages: [] });
  // 两个轮次：第一轮看到子会话在跑，第二轮看到它停了 —— 但它从未被指派，所以不该回报。
  await manualCtx.preStep[0]({ agent: parent, turn: 1, step: 1 }, continueDecision);
  await new Promise((resolve) => setTimeout(resolve, 120));
  manualStatuses["child-session-0001"] = "inactive";
  const manualTurn2 = await manualCtx.preStep[0]({ agent: parent, turn: 2, step: 1 }, continueDecision);
  await new Promise((resolve) => setTimeout(resolve, 200));
  check("手动跟子会话对话不回报父会话", () => {
    const injected = manualTurn2.messages.filter((message) => message.source?.kind === name);
    const text = injected.map((message) => message.content.map((part) => part.text).join("")).join("");
    assert.doesNotMatch(text, /child-session-0001/, "未指派的子会话不该出现在回报里");
    assert.equal(manualCtx.woke.length, 0, "未指派的子会话完成不该唤醒父会话");
  });
  console.log(results.filter((line) => line.includes("手动跟子会话")).join("\n"));

  // 父会话再投递一条任务（post_to_session）会重新 arm：这一轮干完才回报，且只回报一次。
  manualStatuses["child-session-0001"] = "inactive";
  await manualCtx.tools.get("post_to_session").execute(
    { session_id: "child-session-0001", message: "接着干第二轮" },
    { agent: parent },
  );
  manualStatuses["child-session-0001"] = "running";
  await new Promise((resolve) => setTimeout(resolve, 150));
  manualStatuses["child-session-0001"] = "inactive";
  await new Promise((resolve) => setTimeout(resolve, 250));
  check("post_to_session 重新授权一次回报", () => {
    assert.equal(manualCtx.woke.length, 1, `应恰好收到 1 条回报，实际 ${manualCtx.woke.length}`);
    const text = manualCtx.woke[0].message.content.map((part) => part.text).join("");
    assert.match(text, /child-session-0001/);
  });
  console.log(results.filter((line) => line.includes("post_to_session 重新授权")).join("\n"));
};

// ---------------------------------------------------------------------------
// R1 / R2 / R3 / R4：注入可见性、投递三态、跨父投递、workspace 列表
// ---------------------------------------------------------------------------

/** 异步版 check：新用例基本都要 await 工具调用。 */
async function checkAsync(title, fn) {
  try {
    await fn();
    results.push(`PASS  ${title}`);
  } catch (error) {
    results.push(`FAIL  ${title}\n      ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

/**
 * 按真实 harness 的口径校验工具输出：`output.schema` 必须是受支持子集，
 * 返回值必须通过校验，且不能带 `undefined` 值的键（快照会把它当成非法 JSON）。
 */
function assertOutputContract(toolMap, toolName, value) {
  const definition = toolMap.get(toolName);
  assert.ok(definition !== undefined, `${toolName} 应已注册`);
  const walk = (node, where) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${where}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(node)) {
      assert.notEqual(entry, undefined, `${where}.${key} 不该是 undefined（快照不接受）`);
      walk(entry, `${where}.${key}`);
    }
  };
  walk(value, toolName);
  // defineTool 已经把 author DSL 编成 raw JSON Schema 存进 output.schema，
  // 这里直接按 harness 的方式校验（register 时 assertSupported、execute 后 validate）。
  const schema = definition.output.schema;
  assertSupportedJsonSchema(schema);
  const violations = validateJsonSchemaValue(schema, JSON.parse(JSON.stringify(value)), "value");
  assert.deepEqual(violations, [], `${toolName} 输出不符合 output.schema：${violations.join("; ")}`);
}

const SESSIONS_ROOT = path.join(TEST_HOME, "sessions");
const WS_SLUG = "--D-fake-workspace--";
const INBOX_SESSION = "child-inbox-0001";
const PARENT_SESSION = "session-parent";
const T0 = 1793713794745;

/**
 * 写一个假的会话日志：多帧 zstd + JSONL（和真实 `session.v4.jsonl.zstd` 同形）。
 * 故意切成两帧：解码必须能把多帧拼起来。
 */
const fixtureIds = [];
function writeSessionFixture(sessionId, events, slug = WS_SLUG) {
  const dir = path.join(SESSIONS_ROOT, slug, sessionId);
  mkdirSync(dir, { recursive: true });
  const text = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const half = Math.floor(text.length / 2);
  const frames = [
    zstdCompressSync(Buffer.from(text.slice(0, half), "utf8")),
    zstdCompressSync(Buffer.from(text.slice(half), "utf8")),
  ];
  writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), Buffer.concat(frames));
  if (!fixtureIds.includes(sessionId)) fixtureIds.push(sessionId);
  return dir;
}

/** 只有元数据（首条 session 事件）的夹具：权限判定只读这一条。 */
function metaOnlyEvents({ id, parentSession, origin, createdAt, cwd = "D:/fake-workspace", depth = 0 }) {
  const session = { type: "session", version: 4, id, createdAt, cwd, delegationDepth: depth };
  if (parentSession !== undefined) session.parentSession = parentSession;
  if (origin !== undefined) session.origin = origin;
  return [session, { type: "turn/start", seq: 1, time: createdAt + 1, data: { turn: 1 } }];
}

/**
 * 通信权限矩阵夹具：真实会话 id + 真实父子关系（对应线上的 81cf4265 / dacd984b / 30989533 / 15d41732 / 680bacb8）。
 * 判定只读日志首条 `session` 事件里的 `origin` / `parentSession`，所以这些夹具足够代表线上形状。
 */
const TOP_A = "session-81cf4265-9e95-480b-8878-0653eabf3f8e"; // 顶层父会话
const CHILD_A = "dacd984b-2ea9-418d-b3af-2bbdcfacb60a"; // TOP_A 的子会话
const SIBLING_A = "680bacb8-5868-4a68-8a1d-e3dcf1aed1e6"; // TOP_A 的另一个子会话（兄弟）
const TOP_B = "session-30989533-b404-44fa-97ca-eaa9a173060a"; // 另一个顶层父会话
const CHILD_B = "15d41732-b6c3-4f70-8209-a36a4226bfb6"; // TOP_B 的子会话
const MATRIX_FIXTURES = [
  { id: TOP_A, createdAt: T0 - 5000 },
  { id: CHILD_A, parentSession: TOP_A, origin: "subagent", createdAt: T0 - 4000, depth: 1 },
  { id: SIBLING_A, parentSession: TOP_A, origin: "subagent", createdAt: T0 - 3000, depth: 1 },
  { id: TOP_B, createdAt: T0 - 2000 },
  { id: CHILD_B, parentSession: TOP_B, origin: "subagent", createdAt: T0 - 1000, depth: 1 },
];

/** 一条消息（DSH 的 UserMessage 形状）。 */
function inboxMessage(id, text, source) {
  return { id, content: [{ type: "text", text }], source };
}

const SOURCE_AGENT = { kind: "agent-message", form: "relay", senderSessionId: PARENT_SESSION };
const SOURCE_USER = { kind: "user" };
const SOURCE_BRIDGE = { kind: "vibe-bridge", form: "notice" };
/** 1094 字符：默认 160 截断，verbose 1200 保持完整。 */
const LONG_TEXT = `D:长正文 ${"x".repeat(1080)} END-D`;

/**
 * 夹具：三条注入分别走「插入未移除 / 移除 / 移除+canceled」，外加两种 user 来源形态：
 *   - `msg-user`：**只有 splice、没有 user/message**（冷会话 resume 的真实日志形状，R1 的缺口）；
 *   - `msg-both`：splice 与 user/message 都有（运行中的会话，[user] 段已经渲染）。
 * 终态：pending 2（U、A）、consumed 2（B、D）、dropped 1（C）；`msg-both` 被消费且不进 [inject]。
 */
function inboxFixtureEvents() {
  return [
    {
      type: "session",
      version: 4,
      id: INBOX_SESSION,
      createdAt: T0,
      cwd: "D:/fake-workspace",
      parentSession: PARENT_SESSION,
      origin: "subagent",
      delegationDepth: 1,
    },
    { type: "session/title", seq: 0, time: T0 + 1, data: { title: "假日志：注入可见性" } },
    { type: "turn/start", seq: 1, time: T0 + 2, data: { turn: 1 } },
    {
      type: "agent/inbox/spliced",
      seq: 2,
      time: T0 + 10,
      data: { target: "next-turn", start: 0, inserted: [inboxMessage("msg-user", "U: 冷会话注入，只有 splice 没有 user/message。", SOURCE_USER)] },
    },
    {
      type: "agent/inbox/spliced",
      seq: 3,
      time: T0 + 20,
      data: { target: "next-turn", start: 1, inserted: [inboxMessage("msg-a", "A: 关键路径纠正：工具在 tools/ 子目录，不在包根。", SOURCE_AGENT)] },
    },
    {
      type: "agent/inbox/spliced",
      seq: 4,
      time: T0 + 30,
      data: { target: "next-turn", start: 2, inserted: [inboxMessage("msg-b", "B: 基线确认：先跑 smoke 再改。", SOURCE_AGENT)] },
    },
    { type: "agent/inbox/spliced", seq: 5, time: T0 + 40, data: { target: "next-turn", start: 2, removedCount: 1, inserted: [] } },
    {
      type: "agent/inbox/spliced",
      seq: 6,
      time: T0 + 50,
      data: { target: "next-turn", start: 2, inserted: [inboxMessage("msg-c", "C: 这条被中断丢弃。", SOURCE_BRIDGE)] },
    },
    {
      type: "agent/inbox/spliced",
      seq: 7,
      time: T0 + 60,
      data: { target: "next-turn", start: 2, removedCount: 1, inserted: [], outcome: "canceled" },
    },
    {
      type: "agent/inbox/spliced",
      seq: 8,
      time: T0 + 70,
      data: { target: "next-turn", start: 2, inserted: [inboxMessage("msg-d", LONG_TEXT, SOURCE_AGENT)] },
    },
    { type: "agent/inbox/spliced", seq: 9, time: T0 + 80, data: { target: "next-turn", start: 2, removedCount: 1, inserted: [] } },
    // 「两边都有」：先 splice 入队，再被消费；同一 id 另有一条 user/message（运行中会话的真实形状）
    {
      type: "agent/inbox/spliced",
      seq: 10,
      time: T0 + 85,
      data: { target: "next-turn", start: 2, inserted: [inboxMessage("msg-both", "BOTH-VISIBLE: 这条 splice 与 user/message 都有。", SOURCE_USER)] },
    },
    { type: "agent/inbox/spliced", seq: 11, time: T0 + 86, data: { target: "next-turn", start: 2, removedCount: 1, inserted: [] } },
    {
      type: "user/message",
      seq: 12,
      time: T0 + 87,
      data: { id: "msg-both", role: "user", source: SOURCE_USER, content: [{ type: "text", text: "BOTH-VISIBLE: 这条 splice 与 user/message 都有。" }] },
    },
    // 反例守卫：agent-message 也会被写成 user/message，但它必须仍然留在 [inject] 段
    {
      type: "user/message",
      seq: 13,
      time: T0 + 88,
      data: { id: "msg-a", role: "user", source: SOURCE_AGENT, content: [{ type: "text", text: "A: 关键路径纠正：工具在 tools/ 子目录，不在包根。" }] },
    },
    {
      type: "assistant/message",
      seq: 14,
      time: T0 + 90,
      data: { message: { content: [{ type: "text", text: "子会话的回答。" }] } },
    },
  ];
}

const deliveryCheck = async () => {
  const firstNew = results.length;
  // ---- 夹具：一个子会话（有注入）+ 它自己的父会话（workspace 列表用）----
  writeSessionFixture(INBOX_SESSION, inboxFixtureEvents());
  writeSessionFixture(PARENT_SESSION, [
    { type: "session", version: 4, id: PARENT_SESSION, createdAt: T0 - 1000, cwd: "D:/fake-workspace", delegationDepth: 0 },
    { type: "turn/start", seq: 1, time: T0 - 900, data: { turn: 1 } },
  ]);
  // ---- 通信矩阵夹具：真实会话 id + 真实父子关系（只读日志首条 session 事件即可判定）----
  for (const fixture of MATRIX_FIXTURES) writeSessionFixture(fixture.id, metaOnlyEvents(fixture));

  const inboxConfig = Config({ enabled: true, provider: "spawn", rules: [], persistWakeState: false });
  // agentsStatus 用字符串：任何 id 都报 inactive，用来验证「idle 时不谎报 consumed」。
  const inboxCtx = makeCtx(inboxConfig, { agentsStatus: "inactive" });

  // ---- R1：[inject] 段 ----
  const report = (
    await inboxCtx.tools.get("query_session").execute({ session_id: INBOX_SESSION, tail: 1 }, { agent: { id: PARENT_SESSION } })
  ).report;
  const verboseReport = (
    await inboxCtx.tools.get("query_session").execute(
      { session_id: INBOX_SESSION, tail: 1, verbose: true },
      { agent: { id: PARENT_SESSION } },
    )
  ).report;

  await checkAsync("R1 注入进会话记录：[inject] 段带时间/来源/状态，[user] 已渲染的不重复", () => {
    assert.match(report, /--- \[inject\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · agent-message from session-parent · queued ---/);
    assert.match(report, /A: 关键路径纠正/);
    assert.match(report, /--- \[inject\] .* · agent-message from session-parent · consumed ---/);
    assert.match(report, /--- \[inject\] .* · vibe-bridge · dropped ---/);
    // user 来源的注入现在照样进 [inject]（冷会话路径），标注就是 user
    assert.match(report, /--- \[inject\] .* · user · queued ---/);
    assert.ok(report.includes("U: 冷会话注入"), "只有 splice 的 user 注入必须可见");
    // 既有段位不退化
    assert.match(report, /--- \[user\] Round 1 ---/);
    assert.match(report, /--- \[assistant\] Round 1 ---/);
    assert.match(report, /- Title: 假日志：注入可见性/);
    assert.match(report, /- Parent: session-parent/);
  });

  await checkAsync("R1 缺口修复：冷会话（只有 splice、没有 user/message）的注入不再消失", () => {
    // 真实形状：agent/inbox/spliced → turn/start → 再被消费，全程没有 user/message
    const coldSession = "session-cold-0001";
    writeSessionFixture(coldSession, [
      { type: "session", version: 4, id: coldSession, createdAt: T0, cwd: "D:/fake-workspace", delegationDepth: 0 },
      {
        type: "agent/inbox/spliced",
        seq: 1,
        time: T0 + 100,
        data: {
          target: "next-turn",
          start: 0,
          inserted: [inboxMessage("cold-1", "COLD: [来自会话 session-30989533 的消息] 别动同一个仓库", SOURCE_USER)],
        },
      },
      { type: "turn/start", seq: 2, time: T0 + 110, data: { turn: 61 } },
      { type: "agent/inbox/spliced", seq: 3, time: T0 + 120, data: { target: "next-turn", start: 0, removedCount: 1, inserted: [] } },
      { type: "turn/end", seq: 4, time: T0 + 130, data: { turn: 61 } },
    ]);
    return (async () => {
      const coldReport = (
        await inboxCtx.tools.get("query_session").execute({ session_id: coldSession, tail: 1 }, { agent: { id: PARENT_SESSION } })
      ).report;
      assert.match(coldReport, /--- \[user\] Round 61 ---\n\(no user message\)/, "冷会话没有 user/message，[user] 段应为空");
      assert.match(coldReport, /--- \[inject\] .* · user · consumed ---/, "被消费的冷会话注入必须带状态出现");
      assert.ok(coldReport.includes("别动同一个仓库"), "注入正文必须可见");
      assert.match(coldReport, /- Inbox: 0 pending, 1 consumed, 0 dropped/);
    })();
  });

  await checkAsync("R1 去重：splice 与 user/message 都有时只在 [user] 出现一次", () => {
    assert.equal(report.split("BOTH-VISIBLE").length - 1, 1, "[user] 段里应恰好出现一次");
    assert.doesNotMatch(report, /\[inject\][^\n]*\nBOTH-VISIBLE/, "同一 id 不该再进 [inject] 段");
    // [user] 段确实渲染了它（对照：冷会话那条没有 user/message 才走 [inject]）
    const userSection = report.split("--- [inject] ")[0];
    assert.match(userSection, /BOTH-VISIBLE/, "[user] 段应包含它");
  });

  await checkAsync("R1 去重口径：agent-message 也被写成 user/message 时仍留在 [inject]", () => {
    // 夹具里 msg-a 同时有 user/message（source.kind='agent-message'），[user] 段不渲染它，
    // 所以它必须留在 [inject] —— 按「事件存在」去重会把它抹掉。
    assert.match(report, /--- \[inject\] .* · agent-message from session-parent · queued ---/);
    assert.match(report, /A: 关键路径纠正/);
  });

  await checkAsync("R1 汇总行 + 三态原因（consumed/dropped 各自说明）", () => {
    // 汇总 = [inject] 段里的条目：2 条仍在队列、2 条已被消费、1 条被丢弃。
    assert.match(report, /- Inbox: 2 pending, 2 consumed, 1 dropped/);
    assert.match(report, /\(consumed at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} — drained into the next request\)/);
    assert.match(report, /\(dropped at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} — removed or canceled before consuming\)/);
  });

  await checkAsync("R1 正文截断：默认 160 字，verbose 1200 字", () => {
    assert.ok(!report.includes("END-D"), "默认应截断长正文");
    assert.match(report, /…\[\+\d+ chars\]/);
    assert.ok(verboseReport.includes("END-D"), "verbose 应保留 1094 字正文");
  });

  // ---- R2：三态 + get_session_inbox ----
  const inbox = await inboxCtx.tools.get("get_session_inbox").execute({ session_id: INBOX_SESSION }, { agent: { id: PARENT_SESSION } });

  await checkAsync("R2 三态：get_session_inbox 只列 queued，三态在报告里可分辨", () => {
    const reportStatuses = report
      .split("\n")
      .filter((line) => line.startsWith("--- [inject] "))
      .map((line) => line.replace(/.*· /, "").replace(/ ---$/, ""));
    assert.deepEqual(reportStatuses, ["queued", "queued", "consumed", "dropped", "consumed"], "三态应为 queued(U)/queued(A)/consumed(B)/dropped(C)/consumed(D)");
  });

  await checkAsync("R2 get_session_inbox 结构（position/target/source_kind/sender/queued_at/preview）", () => {
    assert.equal(inbox.session_id, INBOX_SESSION);
    assert.equal(inbox.pending_count, 2);
    assert.deepEqual(inbox.pending.map((entry) => entry.position), [1, 2]);
    assert.deepEqual(inbox.pending.map((entry) => entry.target), ["next-turn", "next-turn"]);
    assert.equal(inbox.pending[0].source_kind, "user");
    assert.equal(inbox.pending[1].source_kind, "agent-message");
    assert.equal(inbox.pending[1].sender_session_id, "session-parent");
    assert.match(inbox.pending[1].queued_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.match(inbox.pending[1].preview, /A: 关键路径纠正/);
    // 只有 queued：B（consumed）/C（dropped）不在列表里
    const all = JSON.stringify(inbox.pending);
    assert.ok(!all.includes("B: 基线确认"), "consumed 的注入不该出现在 inbox");
    assert.ok(!all.includes("C: 这条被中断丢弃"), "dropped 的注入不该出现在 inbox");
    assert.ok(!all.includes("END-D"), "consumed 的长正文不该出现在 inbox");
  });

  await checkAsync("R2 目标空闲时仍报 queued 并给出说明（不谎报 consumed）", () => {
    assert.equal(inbox.session_status, "inactive");
    assert.match(inbox.note, /still queued/);
    const rendered = inboxCtx.tools.get("get_session_inbox").output.render({ session_id: INBOX_SESSION }, inbox);
    const text = rendered.map((part) => part.text).join("");
    assert.match(text, /## get_session_inbox/);
    assert.match(text, /agent-message from session-parent/);
  });

  await checkAsync("R2 get_session_inbox 对未知会话报错", async () => {
    await assert.rejects(
      inboxCtx.tools.get("get_session_inbox").execute({ session_id: "no-such-session-9999" }, {}),
      /no persisted log/,
    );
  });

  // ---- R4：list_sessions(scope: 'workspace') ----
  // 父会话的 status 有值、子会话不在内存里 → not-loaded
  const workspaceCtx = makeCtx(inboxConfig, { agentsStatus: { [PARENT_SESSION]: "inactive" } });
  const workspaceRows = await workspaceCtx.tools
    .get("list_sessions")
    .execute({ scope: "workspace" }, { agent: { id: PARENT_SESSION } });

  await checkAsync("R4 workspace 列表带 parent_id / workdir / origin / status", () => {
    // 列出的会话集合必须与写入的夹具集合完全一致（不靠魔数维持）
    assert.deepEqual(
      workspaceRows.map((row) => row.id).sort(),
      [...fixtureIds].sort(),
      `应列出全部夹具会话，实际 ${JSON.stringify(workspaceRows.map((row) => row.id))}`,
    );
    const child = workspaceRows.find((row) => row.id === INBOX_SESSION);
    assert.ok(child !== undefined, "应列出子会话");
    assert.equal(child.parent_id, PARENT_SESSION);
    assert.equal(child.workdir, "D:/fake-workspace");
    assert.equal(child.origin, "subagent");
    assert.equal(child.status, "not-loaded");
    assert.equal(child.workspace, WS_SLUG);
    const parent = workspaceRows.find((row) => row.id === PARENT_SESSION);
    assert.ok(parent !== undefined, "应列出父会话自身");
    assert.equal(parent.parent_id, undefined, "顶层会话没有 parent_id");
    assert.equal(parent.status, "inactive");
  });

  await checkAsync("R4 渲染能看清谁是谁的子会话", () => {
    const rendered = workspaceCtx.tools
      .get("list_sessions")
      .output.render({ scope: "workspace" }, workspaceRows)
      .map((part) => part.text)
      .join("");
    assert.match(rendered, new RegExp(`${INBOX_SESSION} \\[not-loaded\\] \\(child of ${PARENT_SESSION}\\)`));
    assert.match(rendered, /\(top-level\)/);
  });

  await checkAsync("R4 scope 默认值仍是 children（向后兼容）", async () => {
    const legacyRows = await workspaceCtx.tools.get("list_sessions").execute({}, { agent: { id: PARENT_SESSION } });
    assert.deepEqual(legacyRows, [{ id: "child-session-0001", label: "reviewer", status: "inactive", role: "child" }]);
  });

  // ---- R3：跨父投递 ----
  const crossConfig = Config({ enabled: true, provider: "spawn", rules: [], persistWakeState: false });
  const lineageError = 'subagent "other-parent-child" belongs to another parent session';
  const controllerCalls = [];
  const signalController = {
    async prompt(request, signal) {
      // 真实服务签名是 prompt(request, signal)：第二参必须是 AbortSignal
      if (typeof signal?.throwIfAborted !== "function") throw new TypeError("signal.throwIfAborted is not a function");
      controllerCalls.push({ request, arg: signal });
      return { accepted: true };
    },
  };
  const crossCtx = makeCtx(crossConfig, {
    postFailure: { "other-parent-child": lineageError, "broken-target": "boom: transport is down" },
    sessionController: signalController,
  });

  await checkAsync("R3 默认路径：血缘拒收原样抛出（不带 cross_parent 不放行）", async () => {
    await assert.rejects(
      crossCtx.tools.get("post_to_session").execute({ session_id: "other-parent-child", message: "同步边界" }, { agent: { id: PARENT_SESSION } }),
      /belongs to another parent session/,
    );
    assert.equal(controllerCalls.length, 0, "默认路径不该碰 controller");
  });

  await checkAsync("R3 cross_parent:true 回落到 controller，via:'controller' 且正文带来源前缀", async () => {
    const result = await crossCtx.tools
      .get("post_to_session")
      .execute({ session_id: "other-parent-child", message: "两个会话别改同一个仓库", cross_parent: true }, { agent: { id: PARENT_SESSION } });
    assert.equal(result.via, "controller");
    assert.match(result.messageId, /^controller-/);
    assert.equal(controllerCalls.length, 1);
    const { request } = controllerCalls[0];
    assert.equal(request.sessionId, "other-parent-child");
    assert.equal(request.mode, "queue");
    assert.match(request.content[0].text, /^\[来自会话 session-parent 的消息\]\n两个会话别改同一个仓库$/);
  });

  await checkAsync("R3 默认路径仍走 subagent（via:'subagent'，保留 agent-message 来源）", async () => {
    const result = await crossCtx.tools
      .get("post_to_session")
      .execute({ session_id: "child-session-0001", message: "接着干" }, { agent: { id: PARENT_SESSION } });
    assert.equal(result.via, "subagent");
    assert.equal(result.messageId, "inbox-message-0001");
  });

  await checkAsync("R3 非血缘错误在 cross_parent 下照旧抛出", async () => {
    await assert.rejects(
      crossCtx.tools
        .get("post_to_session")
        .execute({ session_id: "broken-target", message: "x", cross_parent: true }, { agent: { id: PARENT_SESSION } }),
      /transport is down/,
    );
  });

  await checkAsync("R3 controller 只认 (request, source) 时也能投递", async () => {
    const sourceOnlyCalls = [];
    const sourceOnlyController = {
      async prompt(request, arg) {
        if (arg?.kind !== name) throw new Error("expected a MessageSource here");
        sourceOnlyCalls.push(request);
      },
    };
    const altCtx = makeCtx(crossConfig, {
      postFailure: { "other-parent-child": lineageError },
      sessionController: sourceOnlyController,
    });
    const result = await altCtx.tools
      .get("post_to_session")
      .execute({ session_id: "other-parent-child", message: "备用签名", cross_parent: true }, { agent: { id: PARENT_SESSION } });
    assert.equal(result.via, "controller");
    assert.equal(sourceOnlyCalls.length, 1);
  });

  // ---- R3 通信权限矩阵：先判后投（真实会话 id + 真实父子关系做元数据来源）----
  const matrixCalls = [];
  const matrixController = {
    async prompt(request, signal) {
      if (typeof signal?.throwIfAborted !== "function") throw new TypeError("signal.throwIfAborted is not a function");
      matrixCalls.push({ request });
      return { accepted: true };
    },
  };
  const matrixCtx = makeCtx(crossConfig, { sessionController: matrixController });
  const matrixPost = (args, agentId) =>
    matrixCtx.tools.get("post_to_session").execute(args, { agent: { id: agentId } });
  const sentCount = () => matrixCtx.messages.length;
  const controllerCount = () => matrixCalls.length;

  await checkAsync("R3 矩阵① 父→自己的子会话：via:'subagent'（来源保真）", async () => {
    const sentBefore = sentCount();
    const controllerBefore = controllerCount();
    const result = await matrixPost({ session_id: CHILD_A, message: "继续干活" }, TOP_A);
    assert.equal(result.via, "subagent");
    assert.equal(result.messageId, "inbox-message-0001");
    assert.equal(sentCount(), sentBefore + 1, "应走 subagents.sendMessage");
    assert.equal(controllerCount(), controllerBefore, "不该碰 controller");
    assert.equal(matrixCtx.messages.at(-1).target, CHILD_A);
    assert.match(matrixCtx.messages.at(-1).content[0].text, new RegExp(`^\\[来自会话 ${TOP_A} 的消息\\]\\n继续干活$`));
  });

  await checkAsync("R3 矩阵② 父→别人的子会话：明确拒绝，且不碰 sendMessage / controller", async () => {
    const sentBefore = sentCount();
    const controllerBefore = controllerCount();
    await assert.rejects(matrixPost({ session_id: CHILD_A, message: "越界", cross_parent: true }, TOP_B), (error) => {
      assert.match(error.message, /别的父会话的子会话/);
      assert.match(error.message, new RegExp(`属 ${TOP_A}`));
      assert.match(error.message, /父↔父/);
      return true;
    });
    assert.equal(sentCount(), sentBefore, "拒绝路径不该调用 sendMessage");
    assert.equal(controllerCount(), controllerBefore, "拒绝路径不该调用 controller");
  });

  await checkAsync("R3 矩阵③ 子→同级兄弟：明确拒绝，且不碰 sendMessage / controller", async () => {
    const sentBefore = sentCount();
    const controllerBefore = controllerCount();
    await assert.rejects(matrixPost({ session_id: SIBLING_A, message: "兄弟私聊", cross_parent: true }, CHILD_A), (error) => {
      assert.match(error.message, /别的父会话的子会话/);
      assert.match(error.message, /同级兄弟/);
      return true;
    });
    assert.equal(sentCount(), sentBefore);
    assert.equal(controllerCount(), controllerBefore);
  });

  await checkAsync("R3 矩阵④ 父↔父（顶层↔顶层）：via:'controller'", async () => {
    const sentBefore = sentCount();
    const controllerBefore = controllerCount();
    const result = await matrixPost({ session_id: TOP_B, message: "两个会话别改同一个仓库" }, TOP_A);
    assert.equal(result.via, "controller");
    assert.match(result.messageId, /^controller-/);
    assert.equal(sentCount(), sentBefore, "顶层目标不该先试注定失败的血缘路径");
    assert.equal(controllerCount(), controllerBefore + 1);
    const { request } = matrixCalls.at(-1);
    assert.equal(request.sessionId, TOP_B);
    assert.equal(request.mode, "queue");
    assert.match(request.content[0].text, new RegExp(`^\\[来自会话 ${TOP_A} 的消息\\]\\n两个会话别改同一个仓库$`));
  });

  await checkAsync("R3 矩阵⑤ 子→自己的父会话：回报通道仍可用（sendMessage）", async () => {
    const sentBefore = sentCount();
    const controllerBefore = controllerCount();
    const result = await matrixPost({ session_id: TOP_B, message: "阶段回报" }, CHILD_B);
    assert.equal(result.via, "subagent");
    assert.equal(sentCount(), sentBefore + 1);
    assert.equal(controllerCount(), controllerBefore);
    assert.equal(matrixCtx.messages.at(-1).target, TOP_B);
  });

  await checkAsync("R3 矩阵补充：子→别的顶层会话 拒绝；父↔父 显式 cross_parent:false 拒绝", async () => {
    const sentBefore = sentCount();
    const controllerBefore = controllerCount();
    await assert.rejects(matrixPost({ session_id: TOP_B, message: "x" }, CHILD_A), /不能投给顶层会话/);
    await assert.rejects(
      matrixPost({ session_id: TOP_B, message: "x", cross_parent: false }, TOP_A),
      /cross_parent: false/,
    );
    assert.equal(sentCount(), sentBefore);
    assert.equal(controllerCount(), controllerBefore);
  });

  // ---- 输出契约：真实 harness 会拿 output.schema 校验每个成功返回值 ----
  await checkAsync("输出契约：query_session / get_session_inbox / list_sessions / post_to_session 都过 schema", async () => {
    const queryValue = await inboxCtx.tools
      .get("query_session")
      .execute({ session_id: INBOX_SESSION }, { agent: { id: PARENT_SESSION } });
    assertOutputContract(inboxCtx.tools, "query_session", queryValue);
    assertOutputContract(inboxCtx.tools, "get_session_inbox", inbox);
    assertOutputContract(inboxCtx.tools, "list_sessions", [
      { id: "child-session-0001", label: "reviewer", status: "running", role: "child" },
    ]);
    assertOutputContract(workspaceCtx.tools, "list_sessions", workspaceRows);
    const crossResult = await crossCtx.tools
      .get("post_to_session")
      .execute({ session_id: "other-parent-child", message: "再来一条", cross_parent: true }, { agent: { id: PARENT_SESSION } });
    assertOutputContract(crossCtx.tools, "post_to_session", crossResult);
  });

  console.log(results.slice(firstNew).join("\n"));
};

// ---------------------------------------------------------------------------
// 通知语义：notify = once / never，以及按 arm 原因（派单 vs 订阅）区分的措辞
// ---------------------------------------------------------------------------
const notifyCheck = async () => {
  const firstNew = results.length;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const noticeText = (entry) => entry.message.content.map((part) => part.text).join("");
  const makeWakeCtx = (statuses, overrides = {}) =>
    makeCtx(
      Config({
        enabled: true,
        provider: "spawn",
        rules: [],
        wakePollMs: 40,
        wakeDebounceMs: 60,
        wakeParentOnChildFinish: true,
        persistWakeState: false,
        ...overrides,
      }),
      { agentsStatus: statuses },
    );

  // ① notify:'never' —— 投递但不订阅
  const neverStatuses = { [PARENT_SESSION]: "inactive", "child-session-0002": "running" };
  const neverCtx = makeWakeCtx(neverStatuses);
  const neverResult = await neverCtx.tools.get("post_to_session").execute(
    { session_id: "child-session-0002", message: "看一眼就好，别回执", notify: "never" },
    { agent: { id: PARENT_SESSION } },
  );
  await sleep(150); // 让哨兵看到它确实在跑
  neverStatuses["child-session-0002"] = "inactive";
  await sleep(350);
  await checkAsync("通知① notify:'never'：投递成功、不订阅，收尾不产生任何通知", () => {
    assert.equal(neverResult.via, "subagent");
    assert.equal(neverResult.notify, "never");
    assert.equal(neverCtx.woke.length, 0, `不该有任何回报，实际 ${neverCtx.woke.length}`);
    const rendered = neverCtx.tools
      .get("post_to_session")
      .output.render({ session_id: "child-session-0002" }, neverResult)
      .map((part) => part.text)
      .join("");
    assert.match(rendered, /completion notice: not subscribed/);
  });

  // ② notify 默认 'once' —— 订阅一次，措辞是“订阅回执”
  const onceStatuses = { [PARENT_SESSION]: "inactive", "child-session-0002": "running" };
  const onceCtx = makeWakeCtx(onceStatuses);
  const onceResult = await onceCtx.tools.get("post_to_session").execute(
    { session_id: "child-session-0002", message: "订阅一下" },
    { agent: { id: PARENT_SESSION } },
  );
  await sleep(150);
  onceStatuses["child-session-0002"] = "inactive";
  await sleep(350);
  await checkAsync("通知② notify:'once'（默认）：收尾回报 1 条，措辞是“订阅回执”", () => {
    assert.equal(onceResult.notify, "once");
    assert.equal(onceCtx.woke.length, 1, `应恰好 1 条，实际 ${onceCtx.woke.length}`);
    const text = noticeText(onceCtx.woke[0]);
    assert.match(text, /订阅回执/);
    assert.match(text, /不代表这一轮是为你那条消息专门做的/);
    assert.match(text, /notify: "never"/);
    const rendered = onceCtx.tools
      .get("post_to_session")
      .output.render({ session_id: "child-session-0002" }, onceResult)
      .map((part) => part.text)
      .join("");
    assert.match(rendered, /completion notice: subscribed/);
  });

  // ③ spawn 派单的回报保持原措辞（回归）
  const spawnStatuses = { [PARENT_SESSION]: "inactive" };
  const spawnCtx = makeWakeCtx(spawnStatuses);
  await spawnCtx.tools.get("spawn_session").execute({ prompt: "跑个真任务", label: "派单" }, { agent: { id: PARENT_SESSION } });
  await sleep(400);
  await checkAsync("通知③ spawn 派单的回报不含“订阅回执”（措辞回归）", () => {
    assert.equal(spawnCtx.woke.length, 1);
    const text = noticeText(spawnCtx.woke[0]);
    assert.match(text, /完成了新一轮工作/);
    assert.match(text, /要它继续就 post_to_session/);
    assert.doesNotMatch(text, /订阅回执/);
  });

  // ④ 合并通知里混有订阅回执 → 中性措辞 + 标明条数
  const mixedStatuses = { [PARENT_SESSION]: "inactive", "child-session-0001": "running", "child-session-0002": "running" };
  const mixedCtx = makeWakeCtx(mixedStatuses, { wakeDebounceMs: 400 });
  await mixedCtx.tools.get("spawn_session").execute({ prompt: "甲任务", label: "甲" }, { agent: { id: PARENT_SESSION } });
  await mixedCtx.tools
    .get("post_to_session")
    .execute({ session_id: "child-session-0002", message: "订阅乙" }, { agent: { id: PARENT_SESSION } });
  await sleep(150);
  mixedStatuses["child-session-0001"] = "inactive";
  mixedStatuses["child-session-0002"] = "inactive";
  await sleep(700);
  await checkAsync("通知④ 合并通知混有订阅回执时标明“含 1 条订阅回执”", () => {
    assert.equal(mixedCtx.woke.length, 1, `合并窗口内应只有 1 条通知，实际 ${mixedCtx.woke.length}`);
    const text = noticeText(mixedCtx.woke[0]);
    assert.match(text, /2 个子会话/);
    assert.match(text, /含 1 条订阅回执/);
    assert.match(text, /（订阅回执）/);
  });

  console.log(results.slice(firstNew).join("\n"));
};

// ---------------------------------------------------------------------------
// A：节奏提升为顶层标量（规则内字段 > 顶层标量 > 内置默认）
// ---------------------------------------------------------------------------
const scheduleCheck = async () => {
  const firstNew = results.length;
  /** 跑若干轮，返回每轮有没有注入，以及每轮注入的正文。 */
  const patternOf = async (ctx, turns) => {
    const pattern = [];
    const texts = new Map();
    for (const turn of turns) {
      const decision = await step(ctx.preStep[0], { turn });
      const injected = decision.messages.filter((message) => message.source?.kind === name);
      pattern.push(injected.length > 0);
      texts.set(turn, injected.map((message) => message.content.map((part) => part.text).join("")).join(""));
    }
    return { pattern, texts };
  };
  const base = { enabled: true, provider: "spawn", persistWakeState: false };

  const scalarCtx = makeCtx(
    Config({ ...base, rules: [], everyTurns: 2, fullEveryTurns: 4, fromTurn: 1, speakOnFirstSeen: false }),
  );
  await checkAsync("A1 只给顶层标量（rules:[]）→ everyTurns=2 决定节奏（1/3/5 命中，2/4 不命中）", async () => {
    const { pattern, texts } = await patternOf(scalarCtx, [1, 2, 3, 4, 5]);
    assert.deepEqual(pattern, [true, false, true, false, true]);
    assert.match(texts.get(1), /\[SYSTEM REMINDER:nudge\]/, "隐式规则的标记名应为 nudge");
  });

  const overrideCtx = makeCtx(
    Config({ ...base, rules: [{ name: "r", text: "MARK-RULE", everyTurns: 1 }], everyTurns: 2, speakOnFirstSeen: false }),
  );
  await checkAsync("A2 规则内 everyTurns=1 覆盖顶层 everyTurns=2 → 每轮都注入", async () => {
    const { pattern } = await patternOf(overrideCtx, [1, 2, 3]);
    assert.deepEqual(pattern, [true, true, true]);
  });

  const legacyCtx = makeCtx(
    Config({ ...base, rules: [{ name: "legacy", text: "LEGACY-TEXT", everyTurns: 4, fullEveryTurns: 12 }] }),
  );
  await checkAsync("A3 老配置（规则内 everyTurns=4/fullEveryTurns=12，无顶层键）行为不变", async () => {
    const { pattern, texts } = await patternOf(legacyCtx, [1, 2, 3, 4, 5]);
    assert.deepEqual(pattern, [true, false, false, false, true]);
    assert.match(texts.get(1), /LEGACY-TEXT/);
    assert.match(texts.get(1), /\[SYSTEM REMINDER:legacy\]/);
  });

  console.log(results.slice(firstNew).join("\n"));
};

// ---------------------------------------------------------------------------
// B：按会话注入（nudges.json > rules[] > 顶层标量 > 默认）
// ---------------------------------------------------------------------------
const sessionNudgeCheck = async () => {
  const firstNew = results.length;
  const baseConfig = {
    enabled: true,
    provider: "spawn",
    persistWakeState: false,
    rules: [],
    nudgeText: "MARK-SESSION",
    everyTurns: 2,
    fullEveryTurns: 4,
    speakOnFirstSeen: false,
  };
  // 全局节奏（everyTurns=2, fromTurn=1）：第 1、3、5 轮命中。
  const ctx = makeCtx(Config(baseConfig));
  const control = () => ctx.tools.get("nudge_control");
  const nudgesPath = path.join(TEST_HOME, "vibe-bridge", "nudges.json");
  /** 某个会话的某一轮有没有注入。 */
  const injectedAt = async (target, sessionId, turn) => {
    const decision = await step(target.preStep[0], { turn, agent: { id: sessionId, session: { id: sessionId } } });
    return decision.messages.filter((message) => message.source?.kind === name).length > 0;
  };

  const off = await control().execute({ session_id: "session-off", mode: "off" }, {});
  const everyOne = await control().execute({ session_id: "session-every", mode: "every:1" }, {});

  await checkAsync("B1 off：该会话零注入，其它会话不受影响", async () => {
    assert.equal(off.mode, "off");
    assert.equal(off.source, "session");
    assert.equal(await injectedAt(ctx, "session-off", 1), false);
    assert.equal(await injectedAt(ctx, "session-off", 3), false);
    assert.equal(await injectedAt(ctx, "session-other", 1), true, "其它会话仍按全局节奏");
  });

  await checkAsync("B2 every:1：该会话每轮都注入（全局第 2 轮本来不注入）", async () => {
    assert.equal(everyOne.mode, "every:1");
    assert.equal(everyOne.source, "session");
    assert.equal(await injectedAt(ctx, "session-every", 2), true);
    assert.equal(await injectedAt(ctx, "session-every", 3), true);
  });

  await checkAsync("B3 clear：删除覆盖、回落全局（第 5 轮命中），返回 source:'global'", async () => {
    const cleared = await control().execute({ session_id: "session-every", mode: "clear" }, {});
    assert.equal(cleared.source, "global");
    assert.equal(cleared.mode, "global");
    // 第 4 轮全局不命中、第 5 轮命中 —— 证明真的回到了全局节奏
    assert.equal(await injectedAt(ctx, "session-every", 4), false);
    assert.equal(await injectedAt(ctx, "session-every", 5), true);
  });

  await checkAsync("B4 重新 apply（模拟重启）后覆盖仍生效（读盘）", async () => {
    await control().execute({ session_id: "session-persist", mode: "off" }, {});
    const restarted = makeCtx(Config(baseConfig));
    assert.equal(await injectedAt(restarted, "session-persist", 1), false, "重启后覆盖应仍生效");
    assert.equal(await injectedAt(restarted, "session-persist-other", 1), true);
    // 状态文件形状符合约定：{ "<sessionId>": { mode, updatedAt } }
    const parsed = JSON.parse(readFileSync(nudgesPath, "utf8"));
    assert.equal(parsed["session-persist"].mode, "off");
    assert.match(parsed["session-persist"].updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  await checkAsync("B5 非法 mode 抛错且不写盘", async () => {
    const before = readFileSync(nudgesPath, "utf8");
    await assert.rejects(control().execute({ session_id: "session-off", mode: "bogus" }, {}), /invalid mode/);
    await assert.rejects(control().execute({ session_id: "session-off", mode: "every:0" }, {}), /invalid mode/);
    assert.equal(readFileSync(nudgesPath, "utf8"), before, "非法调用不该改动状态文件");
    // 顺手校验输出契约
    const value = await control().execute({ session_id: "session-off", mode: "full" }, {});
    assertOutputContract(ctx.tools, "nudge_control", value);
  });

  await checkAsync("B6 坏 JSON：视作空表，pre-step 不抛错", async () => {
    writeFileSync(nudgesPath, "{ this is not json", "utf8");
    const broken = makeCtx(Config(baseConfig));
    assert.equal(await injectedAt(broken, "session-off", 1), true, "坏表等于没有覆盖，应回到全局节奏");
  });

  await checkAsync("B7 /vibe-nudge：无参在 off↔全局之间切换，带参设置模式", async () => {
    const readState = () => JSON.parse(readFileSync(nudgesPath, "utf8"));
    // 坏 JSON 之后文件是坏的，先让工具重建一份干净的表。
    await control().execute({ session_id: "session-cmd", mode: "clear" }, {});
    const command = ctx.commands.find((definition) => definition.name === "vibe-nudge");
    assert.ok(command !== undefined, "应注册 /vibe-nudge 命令");
    const first = await command.handler({ agent: { id: "session-cmd" }, rawInput: "" });
    assert.equal(first.kind, "success");
    assert.match(first.text, /关闭/);
    assert.equal(readState()["session-cmd"].mode, "off");
    const second = await command.handler({ agent: { id: "session-cmd" }, rawInput: "" });
    assert.match(second.text, /恢复全局/);
    assert.equal(readState()["session-cmd"], undefined, "再次切换应删掉覆盖");
    const third = await command.handler({ agent: { id: "session-cmd" }, rawInput: "every:3" });
    assert.equal(third.kind, "success");
    assert.equal(readState()["session-cmd"].mode, "every:3");
    const bogus = await command.handler({ agent: { id: "session-cmd" }, rawInput: "nonsense" });
    assert.equal(bogus.kind, "error");
  });

  await checkAsync("B8 /vibe-nudge status：回传当前节奏 + 覆盖数（给设置页读）", async () => {
    const command = ctx.commands.find((definition) => definition.name === "vibe-nudge");
    const status = await command.handler({ agent: { id: "session-cmd" }, rawInput: "status" });
    assert.equal(status.kind, "success");
    assert.match(status.text, /every 2 · full every 4 · from turn 1/);
    assert.match(status.text, /skip subagent on/);
    assert.match(status.text, /rules: /);
    assert.match(status.text, /overrides: \d+/);
    assert.match(status.text, /session-cmd → every:3/, "覆盖条目应逐条列出");
  });

  console.log(results.slice(firstNew).join("\n"));
};

// ---------------------------------------------------------------------------
// C：按会话文案（text:<base64>）+ status 的 session:/status all 形状
// ---------------------------------------------------------------------------
const nudgeTextCheck = async () => {
  const firstNew = results.length;
  const nudgesPath = path.join(TEST_HOME, "vibe-bridge", "nudges.json");
  const baseConfig = {
    enabled: true,
    provider: "spawn",
    persistWakeState: false,
    rules: [],
    nudgeText: "GLOBAL-TEXT",
    everyTurns: 2,
    fullEveryTurns: 4,
    speakOnFirstSeen: false,
  };
  writeFileSync(nudgesPath, "{}", "utf8");
  const ctx = makeCtx(Config(baseConfig));
  const command = ctx.commands.find((definition) => definition.name === "vibe-nudge");
  const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
  /** 某会话某轮注入的正文（没有注入返回空串）。 */
  const textAt = async (sessionId, turn) => {
    const decision = await step(ctx.preStep[0], { turn, agent: { id: sessionId, session: { id: sessionId } } });
    return decision.messages
      .filter((message) => message.source?.kind === name)
      .map((message) => message.content.map((part) => part.text).join(""))
      .join("");
  };

  await command.handler({ agent: { id: "session-t1" }, rawInput: `text:${b64("CUSTOM-ONE")}` });

  await checkAsync("C1 会话自定义文案：该会话注入自定义文案，其它会话不受影响", async () => {
    assert.match(await textAt("session-t1", 1), /CUSTOM-ONE/);
    const other = await textAt("session-t2", 1);
    assert.match(other, /GLOBAL-TEXT/);
    assert.doesNotMatch(other, /CUSTOM-ONE/);
  });

  await checkAsync("C2 text: 清空 → 回落全局文案", async () => {
    await command.handler({ agent: { id: "session-t1" }, rawInput: "text:" });
    const text = await textAt("session-t1", 3);
    assert.match(text, /GLOBAL-TEXT/);
    assert.doesNotMatch(text, /CUSTOM-ONE/);
    assert.equal(JSON.parse(readFileSync(nudgesPath, "utf8"))["session-t1"], undefined, "无模式也没文案时应整条删除");
  });

  await checkAsync("C3 off 与文案共存：off 不注入，但文案仍在盘上", async () => {
    await command.handler({ agent: { id: "session-t3" }, rawInput: `text:${b64("KEEP-ME")}` });
    await command.handler({ agent: { id: "session-t3" }, rawInput: "off" });
    assert.equal(await textAt("session-t3", 1), "", "off 时不该注入");
    const entry = JSON.parse(readFileSync(nudgesPath, "utf8"))["session-t3"];
    assert.equal(entry.mode, "off");
    assert.equal(entry.text, "KEEP-ME", "文案应保留在盘上");
  });

  await checkAsync("C4 status 的 session: 行（有自定义 / 无自定义两种形状）", async () => {
    await command.handler({ agent: { id: "session-t1" }, rawInput: `text:${b64("AGAIN")}` });
    const withText = await command.handler({ agent: { id: "session-t1" }, rawInput: "status" });
    assert.match(withText.text, new RegExp(`^session: mode=\\S+ text=${b64("AGAIN")}$`, "m"));
    const plain = await command.handler({ agent: { id: "session-t9" }, rawInput: "status" });
    assert.match(plain.text, /^session: mode=global text=empty$/m);
    // 前 3 行保持原状（客户端设置卡片依赖它）
    assert.match(plain.text, /^every \d+ · full every \d+ · from turn \d+/m);
    assert.match(plain.text, /^overrides: \d+/m);
  });

  await checkAsync("C5 status all：固定格式（global 行 + 只列有覆盖的会话）", async () => {
    const all = await command.handler({ agent: { id: "session-t1" }, rawInput: "status all" });
    const lines = all.text.split("\n");
    assert.equal(lines[0], "global: on · every 2 · full 4 · from 1");
    assert.ok(lines.includes("session-t1: global text=yes"), all.text);
    assert.ok(lines.includes("session-t3: off text=yes"), all.text);
    assert.ok(!lines.some((line) => line.startsWith("session-t9:")), "没有覆盖的会话不该出现");
  });

  await checkAsync("C6 status all：没有任何覆盖时只回 global 行", async () => {
    writeFileSync(nudgesPath, "{}", "utf8");
    const fresh = makeCtx(Config(baseConfig));
    const freshCommand = fresh.commands.find((definition) => definition.name === "vibe-nudge");
    const all = await freshCommand.handler({ agent: { id: "session-z" }, rawInput: "status all" });
    assert.equal(all.text, "global: on · every 2 · full 4 · from 1");
  });

  // ---- 全局开关（nudgeEnabled）----
  await checkAsync("C7 nudgeEnabled:false → 任何会话零注入（含 full 覆盖），通知不受影响", async () => {
    writeFileSync(nudgesPath, JSON.stringify({ "session-g1": { mode: "full", updatedAt: new Date().toISOString() } }), "utf8");
    const off = makeCtx(Config({ ...baseConfig, nudgeEnabled: false }));
    const offCommand = off.commands.find((definition) => definition.name === "vibe-nudge");
    const textAt = async (sessionId, turn) => {
      const decision = await step(off.preStep[0], { turn, agent: { id: sessionId, session: { id: sessionId } } });
      return decision.messages
        .filter((message) => message.source?.kind === name)
        .map((message) => message.content.map((part) => part.text).join(""))
        .join("");
    };
    assert.equal(await textAt("session-g1", 1), "", "full 覆盖也不该在全局关闭时注入");
    assert.equal(await textAt("session-g2", 1), "", "普通会话也不注入");
    // status 首行带 global off
    const all = await offCommand.handler({ agent: { id: "session-g1" }, rawInput: "status all" });
    assert.equal(all.text.split("\n")[0], "global: off · every 2 · full 4 · from 1");
    const single = await offCommand.handler({ agent: { id: "session-g1" }, rawInput: "status" });
    assert.match(single.text.split("\n")[0], /global off$/);
  });

  await checkAsync("C8 nudgeEnabled:true + 会话 off：该会话零注入，其它会话正常（两开关不互相干扰）", async () => {
    writeFileSync(nudgesPath, JSON.stringify({ "session-h1": { mode: "off", updatedAt: new Date().toISOString() } }), "utf8");
    const on = makeCtx(Config({ ...baseConfig, nudgeEnabled: true }));
    const textAt = async (sessionId, turn) => {
      const decision = await step(on.preStep[0], { turn, agent: { id: sessionId, session: { id: sessionId } } });
      return decision.messages
        .filter((message) => message.source?.kind === name)
        .map((message) => message.content.map((part) => part.text).join(""))
        .join("");
    };
    assert.equal(await textAt("session-h1", 1), "", "会话 off 应零注入");
    assert.match(await textAt("session-h2", 1), /GLOBAL-TEXT/, "其它会话照常注入");
  });

  await checkAsync("C9 status / status all 首行的 global on|off 前缀（两种状态）", async () => {
    writeFileSync(nudgesPath, "{}", "utf8");
    const on = makeCtx(Config({ ...baseConfig, nudgeEnabled: true }));
    const onCommand = on.commands.find((definition) => definition.name === "vibe-nudge");
    assert.equal((await onCommand.handler({ agent: { id: "s" }, rawInput: "status all" })).text.split("\n")[0], "global: on · every 2 · full 4 · from 1");
    assert.match((await onCommand.handler({ agent: { id: "s" }, rawInput: "status" })).text.split("\n")[0], /· global on$/);
    const off = makeCtx(Config({ ...baseConfig, nudgeEnabled: false }));
    const offCommand = off.commands.find((definition) => definition.name === "vibe-nudge");
    assert.equal((await offCommand.handler({ agent: { id: "s" }, rawInput: "status all" })).text.split("\n")[0], "global: off · every 2 · full 4 · from 1");
    assert.match((await offCommand.handler({ agent: { id: "s" }, rawInput: "status" })).text.split("\n")[0], /· global off$/);
  });

  console.log(results.slice(firstNew).join("\n"));
};

// ---------------------------------------------------------------------------
// D：tester 报的四个缺陷（只有 text 的条目 / clear 语义 / status 形状 / 连点两次）
// ---------------------------------------------------------------------------
const defectCheck = async () => {
  const firstNew = results.length;
  const nudgesPath = path.join(TEST_HOME, "vibe-bridge", "nudges.json");
  const baseConfig = {
    enabled: true,
    provider: "spawn",
    persistWakeState: false,
    rules: [],
    nudgeText: "GLOBAL-D",
    everyTurns: 2,
    fullEveryTurns: 4,
    speakOnFirstSeen: false,
  };
  const state = () => JSON.parse(readFileSync(nudgesPath, "utf8"));
  const seed = (value) => writeFileSync(nudgesPath, JSON.stringify(value), "utf8");
  const textAt = async (ctx, sessionId, turn) => {
    const decision = await step(ctx.preStep[0], { turn, agent: { id: sessionId, session: { id: sessionId } } });
    return decision.messages
      .filter((message) => message.source?.kind === name)
      .map((message) => message.content.map((part) => part.text).join(""))
      .join("");
  };

  await checkAsync("D1 只有 text 的条目：status 通过自己的 output schema，mode 报 global + textCustom/textPreview", async () => {
    seed({ "session-text-only": { text: "ONLY-TEXT", updatedAt: new Date().toISOString() } });
    const ctx = makeCtx(Config(baseConfig));
    const value = await ctx.tools.get("vibe_bridge_status").execute({}, { agent: { id: "runner" } });
    // 拿工具自己声明的 output.schema 校验返回值（缺陷 1 就是这里会炸）
    assertOutputContract(ctx.tools, "vibe_bridge_status", value);
    const row = value.overrides.find((entry) => entry.sessionId === "session-text-only");
    assert.ok(row !== undefined, "应列出该覆盖");
    assert.equal(row.mode, "global", "没有 mode 的条目应报 global");
    assert.equal(row.textCustom, true);
    assert.equal(row.textPreview, "ONLY-TEXT");
  });

  await checkAsync("D2 状态矩阵：仅 text / 仅 mode / 两者，三种都能通过 schema", async () => {
    seed({
      "only-text": { text: "T1", updatedAt: new Date().toISOString() },
      "only-mode": { mode: "every:2", updatedAt: new Date().toISOString() },
      both: { mode: "off", text: "T2", updatedAt: new Date().toISOString() },
    });
    const ctx = makeCtx(Config(baseConfig));
    const value = await ctx.tools.get("vibe_bridge_status").execute({}, { agent: { id: "runner" } });
    assertOutputContract(ctx.tools, "vibe_bridge_status", value);
    for (const row of value.overrides) {
      assert.equal(typeof row.mode, "string", `${row.sessionId} 的 mode 必须是字符串`);
      assert.equal(typeof row.textCustom, "boolean");
      assert.equal(typeof row.textPreview, "string");
    }
    const both = value.overrides.find((entry) => entry.sessionId === "both");
    assert.equal(both.mode, "off");
    assert.equal(both.textPreview, "T2", "两者都有的条目应带文案预览");
    const onlyMode = value.overrides.find((entry) => entry.sessionId === "only-mode");
    assert.equal(onlyMode.textCustom, false);
    assert.equal(onlyMode.textPreview, "");
  });

  await checkAsync("D3 clear 只清 mode 保留 text；purge 才整条删除", async () => {
    seed({ "session-clear": { mode: "every:2", text: "PROBE_TEXT_SHOULD_SURVIVE", updatedAt: new Date().toISOString() } });
    const ctx = makeCtx(Config(baseConfig));
    const control = ctx.tools.get("nudge_control");
    const cleared = await control.execute({ session_id: "session-clear", mode: "clear" }, {});
    assert.equal(cleared.source, "global");
    const afterClear = state()["session-clear"];
    assert.equal(afterClear.text, "PROBE_TEXT_SHOULD_SURVIVE", "clear 不该丢文案");
    assert.equal("mode" in afterClear, false, "clear 应删掉 mode 键");
    // purge 才整条删除
    await control.execute({ session_id: "session-clear", mode: "purge" }, {});
    assert.equal(state()["session-clear"], undefined, "purge 应整条删除");
  });

  await checkAsync("D4 nudge_control 一次写 mode + text；text:\"\" 只清文案", async () => {
    seed({});
    const ctx = makeCtx(Config(baseConfig));
    const control = ctx.tools.get("nudge_control");
    const set = await control.execute({ session_id: "session-both", mode: "every:3", text: "BOTH-TEXT" }, {});
    assert.equal(set.mode, "every:3");
    const entry = state()["session-both"];
    assert.equal(entry.mode, "every:3");
    assert.equal(entry.text, "BOTH-TEXT");
    await control.execute({ session_id: "session-both", mode: "every:3", text: "" }, {});
    const clearedText = state()["session-both"];
    assert.equal(clearedText.mode, "every:3", "清文案不该动 mode");
    assert.equal("text" in clearedText, false);
  });

  await checkAsync("D5 无参切换两次：文案仍在、mode 缺失（不再整条删除）", async () => {
    seed({ "session-toggle": { text: "KEEP-ME", updatedAt: new Date().toISOString() } });
    const ctx = makeCtx(Config(baseConfig));
    const command = ctx.commands.find((definition) => definition.name === "vibe-nudge");
    await command.handler({ agent: { id: "session-toggle" }, rawInput: "" });
    assert.equal(state()["session-toggle"].mode, "off", "第一次点击应关闭（保留文案）");
    assert.equal(state()["session-toggle"].text, "KEEP-ME");
    await command.handler({ agent: { id: "session-toggle" }, rawInput: "" });
    const after = state()["session-toggle"];
    assert.ok(after !== undefined, "第二次点击不该删掉条目");
    assert.equal("mode" in after, false, "第二次点击应清掉 mode");
    assert.equal(after.text, "KEEP-ME", "文案必须保留");
  });

  await checkAsync("D6 回归：既有三条数据（off / every:3+text / 仅 text）的 status 与注入都正确", async () => {
    seed({
      "session-a": { mode: "off", updatedAt: new Date().toISOString() },
      "session-b": { mode: "every:3", text: "SESSION-B-TEXT", updatedAt: new Date().toISOString() },
      "session-c": { text: "SESSION-C-TEXT", updatedAt: new Date().toISOString() },
    });
    const ctx = makeCtx(Config(baseConfig));
    const value = await ctx.tools.get("vibe_bridge_status").execute({}, { agent: { id: "runner" } });
    assertOutputContract(ctx.tools, "vibe_bridge_status", value);
    const byId = (id) => value.overrides.find((entry) => entry.sessionId === id);
    assert.equal(byId("session-a").mode, "off");
    assert.equal(byId("session-a").textCustom, false);
    assert.equal(byId("session-b").mode, "every:3");
    assert.equal(byId("session-b").textPreview, "SESSION-B-TEXT");
    assert.equal(byId("session-c").mode, "global", "只有文案的会话节奏仍是 global");
    assert.equal(byId("session-c").textCustom, true);
    // 注入：a 关闭、b 用自定义文案每 3 轮、c 用自定义文案按全局（every 2 → 第 1 轮命中）
    assert.equal(await textAt(ctx, "session-a", 1), "");
    assert.match(await textAt(ctx, "session-b", 1), /SESSION-B-TEXT/);
    assert.match(await textAt(ctx, "session-c", 1), /SESSION-C-TEXT/);
    assert.doesNotMatch(await textAt(ctx, "session-c", 1), /GLOBAL-D/);
  });

  console.log(results.slice(firstNew).join("\n"));
};

run()
  .then(wakeCheck)
  .then(deliveryCheck)
  .then(notifyCheck)
  .then(scheduleCheck)
  .then(sessionNudgeCheck)
  .then(nudgeTextCheck)
  .then(defectCheck)
  .then(() => {
    const failed = results.filter((line) => line.startsWith("FAIL"));
    console.log("");
    console.log(`[smoke] ${results.length - failed.length} passed, ${failed.length} failed (total ${results.length})`);
    if (failed.length > 0) console.log(failed.join("\n"));
  })
  .catch((error) => {
    process.exitCode = 1;
    console.log(results.join("\n"));
    console.error("SMOKE ERROR:", error);
  });

/**
 * vibe-bridge 冒烟测试：不启动完整 harness，用假的 ctx 验证
 *   1) Config 归一化
 *   2) 碎碎念按轮次节奏注入（全量/稀疏/生效区间/去重）
 *   3) spawn_session / post_to_session / list_sessions 的调用契约
 *
 * 运行：node test/smoke.mjs
 */
import assert from "node:assert/strict";
import { apply, Config, name } from "../lib/index.js";

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
function makeCtx(config, { agentsStatus = "running", children = [] } = {}) {
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

check("注册了 1 个中间件 + 6 个工具", () => {
  assert.equal(preStep.length, 1);
  assert.deepEqual([...tools.keys()].sort(), [
    "list_sessions",
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

run()
  .then(wakeCheck)
  .catch((error) => {
    process.exitCode = 1;
    console.log(results.join("\n"));
    console.error("SMOKE ERROR:", error);
  });

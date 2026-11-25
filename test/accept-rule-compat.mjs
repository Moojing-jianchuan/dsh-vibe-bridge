/**
 * 门槛 2 的三段对照（离线，临时 DSH_HOME）。全局注入路径已砍掉，这里改成**同义对照**：
 *
 *   A 虚拟规则 vs 显式规则：同一段文案（旧 `nudges.json.text` 的只读虚拟规则）与
 *     "同内容 + 等价策略"的显式规则 → 逐轮注入的条数 / `source.kind` / `source.sections`
 *     byte-equal，正文一致（去掉 `(类型) ` 标签）。
 *   B 隔离：会话 X 有规则时，会话 Y（无规则）**零注入**（不再有全局兜底）。
 *   C 开关：`mode:"off"` + 有规则 → 零注入；`nudgeEnabled:false` + 有规则 → **仍然注入**。
 *     另含：`apply` 前后两个状态文件字节不变、真实 home 目录快照。
 *
 * 运行：node test/accept-rule-compat.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const REAL_HOME = process.env.DSH_HOME ?? path.join(homedir(), ".dsh");
const snapshot = (file) => {
  try {
    return readFileSync(file).toString("base64");
  } catch {
    return undefined;
  }
};
const realBefore = {
  rules: snapshot(path.join(REAL_HOME, "vibe-bridge", "rules.json")),
  nudges: snapshot(path.join(REAL_HOME, "vibe-bridge", "nudges.json")),
};

const HOME = mkdtempSync(path.join(tmpdir(), "vb-compat-"));
process.env.DSH_HOME = HOME;
mkdirSync(path.join(HOME, "vibe-bridge"), { recursive: true });
const NUDGES = path.join(HOME, "vibe-bridge", "nudges.json");
const RULES = path.join(HOME, "vibe-bridge", "rules.json");
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));

const results = [];
const check = async (title, fn) => {
  try {
    await fn();
    results.push(`PASS  ${title}`);
  } catch (error) {
    results.push(`FAIL  ${title}\n      ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

const mod = await import(pathToFileURL(path.resolve("lib/index.js")).href);

const boot = (overrides = {}) => {
  const hooks = [];
  const commands = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    effect: (fn) => fn(),
    on: (name, handler) => hooks.push({ name, handler }),
    tools: { register: () => () => {} },
    subagents: { listChildren: async () => [], sendMessage: async () => "x", startActivation: async () => ({ childId: "x" }) },
    agents: { get: () => undefined },
    commands: { register: (definition) => (commands.push(definition), () => {}) },
  };
  mod.apply(ctx, mod.Config({ enabled: true, provider: "spawn", persistWakeState: false, rules: [], everyTurns: 2, fullEveryTurns: 4, ...overrides }));
  const preStep = hooks.find((hook) => hook.name === "agent/pre-step");
  return { preStep: preStep.handler, commands };
};

const collect = async (host, sessionId, turns) => {
  const out = [];
  for (const turn of turns) {
    const decision = await host.preStep({ turn, step: 1, agent: { id: sessionId, session: { id: sessionId } } }, async () => ({ kind: "continue", messages: [] }));
    out.push((decision?.messages ?? []).filter((message) => message.source?.kind === mod.name));
  }
  return out;
};

const textOf = (message) => message.content.map((part) => part.text).join("");
/** 去掉注入行首的 `(类型) ` 标签（虚拟/显式规则的标签差异）。 */
const stripLabel = (text) => text.replace(/\((规则|约束|偏好|约定|反馈)\) /g, "");

// ---- A：虚拟规则 vs 等价显式规则 ----
writeFileSync(NUDGES, JSON.stringify({ "s-legacy": { text: "同一段提醒文案", updatedAt: new Date().toISOString() } }), "utf8");
utimesSync(NUDGES, new Date(), new Date(Date.now() + 1000)); // 这一行是防缓存假象：把 mtime 推到不同值，别删
writeFileSync(RULES, "{}", "utf8");
utimesSync(RULES, new Date(), new Date(Date.now() + 2000));
const virtualHost = boot();
const virtualRuns = await collect(virtualHost, "s-legacy", [1, 2, 3, 4, 5]);

writeFileSync(NUDGES, "{}", "utf8");
utimesSync(NUDGES, new Date(), new Date(Date.now() + 3000));
writeFileSync(
  RULES,
  JSON.stringify({
    "s-legacy": [{ id: "explicit", type: "rule", content: "同一段提醒文案", strategies: ["every-n"], everyN: 2, enabled: true }],
  }),
  "utf8",
);
utimesSync(RULES, new Date(), new Date(Date.now() + 4000));
const explicitHost = boot();
const explicitRuns = await collect(explicitHost, "s-legacy", [1, 2, 3, 4, 5]);

await check("A1 命中轮次逐轮一致（虚拟规则 vs 等价显式规则）", () => {
  const hits = (runs) => runs.map((messages) => messages.length > 0);
  assert.deepEqual(hits(virtualRuns), hits(explicitRuns), JSON.stringify({ virtual: hits(virtualRuns), explicit: hits(explicitRuns) }));
});

await check("A2 条数 / source.kind / source.sections byte-equal", () => {
  for (let index = 0; index < virtualRuns.length; index += 1) {
    assert.equal(explicitRuns[index].length, virtualRuns[index].length, `第 ${index + 1} 轮条数`);
    for (let k = 0; k < virtualRuns[index].length; k += 1) {
      assert.equal(explicitRuns[index][k].source.kind, virtualRuns[index][k].source.kind);
      assert.equal(JSON.stringify(explicitRuns[index][k].source.sections ?? null), JSON.stringify(virtualRuns[index][k].source.sections ?? null));
    }
  }
});

await check("A3 文案：去掉 `(类型) ` 标签后一致；短句轮次两边都是短句", () => {
  for (let index = 0; index < virtualRuns.length; index += 1) {
    const left = virtualRuns[index].map(textOf).map(stripLabel).join("\n");
    const right = explicitRuns[index].map(textOf).map(stripLabel).join("\n");
    assert.equal(right, left, `第 ${index + 1} 轮`);
    if (left.includes("自检一遍")) assert.ok(right.includes("自检一遍"));
  }
});

// ---- B：无规则会话零注入 ----
writeFileSync(NUDGES, "{}", "utf8");
utimesSync(NUDGES, new Date(), new Date(Date.now() + 5000));
writeFileSync(RULES, JSON.stringify({ "s-with": [{ id: "r1", type: "rule", content: "只有 X 有规则", strategies: ["every-message"], everyN: 3, enabled: true }] }), "utf8");
utimesSync(RULES, new Date(), new Date(Date.now() + 6000));
const isolateHost = boot();
const withRules = await collect(isolateHost, "s-with", [1, 2, 3]);
const withoutRules = await collect(isolateHost, "s-none", [1, 2, 3]);

await check("B1 有规则的会话逐轮注入", () => {
  assert.deepEqual(withRules.map((messages) => messages.length), [1, 1, 1]);
});

await check("B2 无规则会话逐轮零注入（不再有全局兜底）", () => {
  assert.deepEqual(withoutRules.map((messages) => messages.length), [0, 0, 0]);
});

// ---- C：开关语义 ----
writeFileSync(NUDGES, JSON.stringify({ "s-off": { mode: "off", updatedAt: new Date().toISOString() } }), "utf8");
utimesSync(NUDGES, new Date(), new Date(Date.now() + 7000));
writeFileSync(RULES, JSON.stringify({ "s-off": [{ id: "r-off", type: "rule", content: "不该出现", strategies: ["every-message"], everyN: 3, enabled: true }] }), "utf8");
utimesSync(RULES, new Date(), new Date(Date.now() + 8000));
const offHost = boot();
const offRuns = await collect(offHost, "s-off", [1, 2, 3]);

await check("C1 mode=off 压过规则：逐轮零注入", () => {
  assert.deepEqual(offRuns.map((messages) => messages.length), [0, 0, 0]);
});

writeFileSync(NUDGES, "{}", "utf8");
utimesSync(NUDGES, new Date(), new Date(Date.now() + 9000));
// 换一个会话 id：同一会话同一轮只会注入一次（spoken 去重），这里要的是"新会话也照样注入"。
writeFileSync(RULES, JSON.stringify({ "s-disabled": [{ id: "r-d", type: "rule", content: "全局关掉也要注入", strategies: ["every-message"], everyN: 3, enabled: true }] }), "utf8");
utimesSync(RULES, new Date(), new Date(Date.now() + 9500));
const snapshotBefore = { rules: snapshot(RULES), nudges: snapshot(NUDGES) };
const disabledHost = boot({ nudgeEnabled: false });
const disabledRuns = await collect(disabledHost, "s-disabled", [1, 2, 3]);

await check("C2 nudgeEnabled:false 仍然注入会话规则（与上一版相反）", () => {
  assert.deepEqual(disabledRuns.map((messages) => messages.length), [1, 1, 1]);
  assert.equal(snapshot(RULES), snapshotBefore.rules, "apply 不该写 rules.json");
  assert.equal(snapshot(NUDGES), snapshotBefore.nudges, "apply 不该写 nudges.json");
});

await check("C3 真实 home 未被写（临时 DSH_HOME 生效）", () => {
  assert.ok(HOME.includes("vb-compat-"));
  assert.equal(snapshot(path.join(REAL_HOME, "vibe-bridge", "rules.json")), realBefore.rules);
  assert.equal(snapshot(path.join(REAL_HOME, "vibe-bridge", "nudges.json")), realBefore.nudges);
});

console.log(results.join("\n"));
const failed = results.filter((line) => line.startsWith("FAIL")).length;
console.log(`\n[accept-rule-compat] ${results.length - failed} passed, ${failed} failed (total ${results.length})`);

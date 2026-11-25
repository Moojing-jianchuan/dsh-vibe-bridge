/**
 * 门槛 2 的三段对照（离线，临时 DSH_HOME）：
 *   A 转移/结构：命中轮次逐轮一致；source.kind / sections 名称 / 条数 byte-equal
 *   B 文案：去掉 `(类型) ` 前缀后 byte-equal；旧版发通用短句的轮次，新版也是通用短句
 *   C 只读：apply 不写 nudges.json / rules.json（字节不变）；off 逐字节一致；mode=off 压过规则零注入
 *
 * 运行：node test/accept-rule-compat.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

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

/** 造一个最小宿主 ctx（只要 pre-step 与命令）。 */
const boot = (configOverrides = {}) => {
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
  mod.apply(
    ctx,
    mod.Config({ enabled: true, provider: "spawn", persistWakeState: false, rules: [], everyTurns: 2, fullEveryTurns: 4, ...configOverrides }),
  );
  const preStep = hooks.find((h) => h.name === "agent/pre-step");
  return { preStep: preStep.handler, commands };
};

/** 跑若干轮，收集每轮注入的 message 数组（结构化，便于 byte-equal）。 */
const collect = async (host, sessionId, turns) => {
  const out = [];
  for (const turn of turns) {
    const decision = await host.preStep({ turn, agent: { id: sessionId, session: { id: sessionId } } }, async () => ({}));
    out.push((decision?.messages ?? []).filter((message) => message.source?.kind === mod.name));
  }
  return out;
};

const textOf = (message) => message.content.map((part) => part.text).join("");
/** 去掉注入行首的 `(类型) ` 前缀。 */
const stripPrefix = (text) => text.replace(/\((规则|约束|偏好|约定|反馈)\) /g, "");
const GENERIC = "自检一遍";

await check("C0 真实 home 未被写（临时 DSH_HOME 生效）", () => {
  assert.ok(HOME.includes("vb-compat-"), "DSH_HOME 应指向临时目录");
});

// 前置：旧数据只在 nudges.json 里（无 rules.json）
writeFileSync(NUDGES, JSON.stringify({ "s-legacy": { text: "同一段提醒文案", updatedAt: new Date().toISOString() } }), "utf8");
const nudgesBytes = readFileSync(NUDGES, "utf8");
const rulesMissing = !readFileSync;
const legacyHost = boot({ nudgeText: "同一段提醒文案" });
const legacy = await collect(legacyHost, "s-legacy", [1, 2, 3, 4, 5]);

// 新版：同一份 nudges.json（现在走虚拟规则）
const virtualHost = boot({ nudgeText: "同一段提醒文案" });
const virtual = await collect(virtualHost, "s-legacy", [1, 2, 3, 4, 5]);

await check("A1 命中轮次逐轮一致（旧路径 vs 虚拟规则）", () => {
  const hits = (runs) => runs.map((messages) => messages.length > 0);
  assert.deepEqual(hits(virtual), hits(legacy), `旧 ${JSON.stringify(hits(legacy))} / 新 ${JSON.stringify(hits(virtual))}`);
});

await check("A2 条数与 source.kind / sections 名称 byte-equal", () => {
  for (let index = 0; index < legacy.length; index += 1) {
    assert.equal(virtual[index].length, legacy[index].length, `第 ${index + 1} 轮条数`);
    for (let k = 0; k < legacy[index].length; k += 1) {
      const oldMessage = legacy[index][k];
      const newMessage = virtual[index][k];
      assert.equal(newMessage.source.kind, oldMessage.source.kind);
      assert.equal(
        JSON.stringify(newMessage.source.sections ?? null),
        JSON.stringify(oldMessage.source.sections ?? null),
        `第 ${index + 1} 轮 sections 结构`,
      );
    }
  }
});

await check("B1 文案：去掉 `(类型) ` 前缀后 byte-equal；短句轮次也是短句", () => {
  for (let index = 0; index < legacy.length; index += 1) {
    const oldText = legacy[index].map(textOf).join("\n");
    const newText = virtual[index].map(textOf).map(stripPrefix).join("\n");
    assert.equal(newText, oldText, `第 ${index + 1} 轮文案`);
    if (oldText.includes(GENERIC)) assert.ok(newText.includes(GENERIC), `第 ${index + 1} 轮旧版是短句，新版也必须是短句`);
  }
});

await check("C1 apply 之后 nudges.json 字节不变、rules.json 仍不存在", () => {
  assert.equal(readFileSync(NUDGES, "utf8"), nudgesBytes, "nudges.json 不该被 apply 改写");
  let exists = true;
  try {
    readFileSync(RULES);
  } catch {
    exists = false;
  }
  assert.equal(exists, false, "没有写盘就不该创建 rules.json");
});

await check("C2 mode=off 逐字节一致 + 压过规则（零注入）", async () => {
  // 旧：off（无规则）
  writeFileSync(NUDGES, JSON.stringify({ "s-off": { mode: "off", updatedAt: new Date().toISOString() } }), "utf8");
  utimesSync(NUDGES, new Date(), new Date(Date.now() + 1000)); // 换 mtime，绕开同毫秒缓存
  const nudgesOffBytes = readFileSync(NUDGES, "utf8");
  const offHost = boot({ nudgeText: "同一段提醒文案" });
  const offRuns = await collect(offHost, "s-off", [1, 2, 3]);
  assert.deepEqual(
    offRuns.map((messages) => messages.length),
    [0, 0, 0],
    "off 时逐轮零注入",
  );
  // 新：off + 真实规则（规则必须被压住）
  writeFileSync(
    RULES,
    JSON.stringify({ "s-off": [{ id: "r1", type: "rule", content: "不该出现", strategies: ["every-message"], everyN: 3, enabled: true }] }),
    "utf8",
  );
  utimesSync(RULES, new Date(), new Date(Date.now() + 2000));
  const offWithRules = boot({ nudgeText: "同一段提醒文案" });
  const offWithRulesRuns = await collect(offWithRules, "s-off", [1, 2, 3]);
  assert.deepEqual(
    offWithRulesRuns.map((messages) => messages.length),
    [0, 0, 0],
    "mode=off 必须压过 rules.json",
  );
  assert.equal(readFileSync(NUDGES, "utf8"), nudgesOffBytes, "两个文件都不该被写");
});

console.log(results.join("\n"));
const failed = results.filter((line) => line.startsWith("FAIL")).length;
console.log(`\n[accept-rule-compat] ${results.length - failed} passed, ${failed} failed (total ${results.length})`);

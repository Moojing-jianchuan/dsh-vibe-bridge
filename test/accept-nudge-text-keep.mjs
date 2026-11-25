/**
 * vibe-bridge 碎碎念缺陷验收用例（独立于仓库既有 smoke）
 *
 * 覆盖 4 条已实测缺陷：
 *   A. 只有 text 的条目必须让 vibe_bridge_status 输出合法（mode 不许 undefined）
 *   B. clear 只回落节奏，自定义文案必须保留
 *   C. /vibe-nudge 无参连点两次不得删除文案
 *   D. 三条既有数据（off / every:3+text / 仅 text）状态可见且不回退
 *
 * 运行：node test/accept-nudge-text-keep.mjs
 * 旧代码上 A/B/C 必须 FAIL —— 先用它证明测量能看见问题，再用于验收修复。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { apply, Config, name } from "../lib/index.js";
import { assertSupportedJsonSchema, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

const TEST_HOME = mkdtempSync(path.join(tmpdir(), "vb-accept-"));
process.env.DSH_HOME = TEST_HOME;
process.on("exit", () => rmSync(TEST_HOME, { recursive: true, force: true }));

const NUDGES = path.join(TEST_HOME, "vibe-bridge", "nudges.json");

/**
 * 插件的 readNudges() 用 mtimeMs 做缓存判据（lib/index.js:1049），
 * 同毫秒内连续写文件会读到旧 map —— 那是测量假象，不是修复生效。
 * 这里每次写都把 mtime 推到单调递增的不同值，保证下一次读必然重新解析。
 */
let mtimeSeq = 0;
function writeNudges(payload) {
  mkdirSync(path.dirname(NUDGES), { recursive: true });
  writeFileSync(NUDGES, JSON.stringify(payload, null, 2), "utf8");
  const stamp = Date.now() / 1000 + ++mtimeSeq;
  utimesSync(NUDGES, stamp, stamp);
}
function readNudges() {
  try {
    return JSON.parse(readFileSync(NUDGES, "utf8"));
  } catch {
    return {};
  }
}

/** 最小假 ctx：够 apply() 注册 agent/pre-step、tools、commands。 */
function makeCtx(config) {
  const preStep = [];
  const tools = new Map();
  const commands = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
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
      async startActivation() {
        return { childId: "child-accept-0001", result: Promise.resolve({}) };
      },
      async sendMessage() {},
      async listChildren() {
        return [];
      },
      interrupt() {},
    },
    agents: {
      get() {
        return { status: "idle", followup() {} };
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
    },
  };
  apply(ctx, config);
  return { ctx, preStep, tools, commands };
}

const results = [];
function check(title, fn) {
  try {
    fn();
    results.push(`PASS  ${title}`);
  } catch (error) {
    results.push(`FAIL  ${title}\n        ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

async function main() {
  const { tools, commands } = makeCtx(Config({}));

  // ---------- A：只有 text 的条目，status 输出必须合法 ----------
  writeNudges({
    "session-text-only": { text: "KEEP-ME", updatedAt: "2026-11-25T00:00:00.000Z" },
  });
  const definition = tools.get("vibe_bridge_status");
  const value = await definition.execute({}, {});

  check("A1 overrides[].mode 不是 undefined（宿主 schema 要求 string）", () => {
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
    walk(value, "vibe_bridge_status");
  });

  check("A2 输出通过 output.schema 校验（宿主不会报 not lossless JSON）", () => {
    const schema = definition.output.schema;
    assertSupportedJsonSchema(schema);
    const violations = validateJsonSchemaValue(schema, JSON.parse(JSON.stringify(value)), "value");
    assert.deepEqual(violations, [], violations.join("; "));
  });

  check("A3 状态能看出「该会话文案是自定义的」", () => {
    const row = (value.overrides ?? []).find((entry) => entry.sessionId === "session-text-only");
    assert.ok(row, "overrides 里应包含 session-text-only");
    const marksCustom =
      row.textCustom === true ||
      row.mode === "global" ||
      (typeof row.mode === "string" && row.mode.includes("text"));
    assert.ok(marksCustom, `看不出文案来自自定义：${JSON.stringify(row)}`);
  });

  // ---------- B：clear 不得删除自定义文案 ----------
  writeNudges({
    "session-clear": { mode: "every:2", text: "PROBE_TEXT_SHOULD_SURVIVE", updatedAt: "2026-11-25T00:00:00.000Z" },
  });
  await tools.get("nudge_control").execute({ session_id: "session-clear", mode: "clear" }, {});

  check("B1 clear 后条目仍在且 text 保留", () => {
    const entry = readNudges()["session-clear"];
    assert.ok(entry, "clear 把整条删掉了：自定义文案丢失");
    assert.equal(entry.text, "PROBE_TEXT_SHOULD_SURVIVE", "自定义文案被改动/删除");
  });

  check("B2 clear 后节奏已回落（mode 不是原来的 every:2）", () => {
    const entry = readNudges()["session-clear"] ?? {};
    assert.notEqual(entry.mode, "every:2", "节奏没有回落");
  });

  // ---------- B3/B4：clear 只清 mode 的空壳；purge 才整条删 ----------
  writeNudges({
    "session-mode-only": { mode: "every:5", updatedAt: "2026-11-25T00:00:00.000Z" },
  });
  await tools.get("nudge_control").execute({ session_id: "session-mode-only", mode: "clear" }, {});

  check("B3 没有 text 的条目 clear 后整条删除（不留空壳）", () => {
    assert.equal(readNudges()["session-mode-only"], undefined, "只清 mode 却留下了空壳条目");
  });

  writeNudges({
    "session-purge": { mode: "every:2", text: "DROP-ME", updatedAt: "2026-11-25T00:00:00.000Z" },
  });
  await tools.get("nudge_control").execute({ session_id: "session-purge", mode: "purge" }, {});

  check("B4 purge 整条删除（文案一并丢弃，这是显式语义）", () => {
    assert.equal(readNudges()["session-purge"], undefined, "purge 没有删除整条");
  });

  // ---------- C：无参连点两次不得删文案 ----------
  writeNudges({
    "session-toggle": { text: "KEEP-TOGGLE", updatedAt: "2026-11-25T00:00:00.000Z" },
  });
  const command = commands.get("vibe-nudge");
  const agent = { id: "session-toggle", session: { id: "session-toggle" } };
  await command.handler({ agent, rawInput: "" });
  const afterFirst = JSON.parse(JSON.stringify(readNudges()["session-toggle"] ?? null));
  await command.handler({ agent, rawInput: "" });
  const afterSecond = JSON.parse(JSON.stringify(readNudges()["session-toggle"] ?? null));

  check("C1 第一次无参切换后文案还在", () => {
    assert.ok(afterFirst, "第一次切换就把条目删了");
    assert.equal(afterFirst.text, "KEEP-TOGGLE");
  });

  check("C2 第二次无参切换后文案还在（连点两次不蒸发）", () => {
    assert.ok(afterSecond, `第二次切换删掉了整条：${JSON.stringify(afterFirst)} → 消失了`);
    assert.equal(afterSecond.text, "KEEP-TOGGLE", "第二次切换把文案删了");
  });

  // ---------- D：三条既有数据可见且不回退 ----------
  writeNudges({
    "session-a": { mode: "off", updatedAt: "2026-11-25T00:00:00.000Z" },
    "session-b": { mode: "every:3", text: "你好", updatedAt: "2026-11-25T00:00:00.000Z" },
    "session-7a95e98a": { text: "【自检纠偏】…", updatedAt: "2026-11-25T00:00:00.000Z" },
  });
  const statusValue = await tools.get("vibe_bridge_status").execute({}, {});

  check("D1 三条既有覆盖都能被 status 报出来", () => {
    assert.equal(statusValue.overridesCount, 3, `overridesCount=${statusValue.overridesCount}`);
    const ids = (statusValue.overrides ?? []).map((entry) => entry.sessionId).sort();
    assert.deepEqual(ids, ["session-7a95e98a", "session-a", "session-b"]);
  });

  check("D2 off 会话仍显示 off，every:3 会话仍显示 every:3", () => {
    const byId = Object.fromEntries((statusValue.overrides ?? []).map((entry) => [entry.sessionId, entry]));
    assert.equal(byId["session-a"].mode, "off");
    assert.equal(byId["session-b"].mode, "every:3");
  });

  check("D3 status 渲染文本可读（不含 undefined）", () => {
    const rendered = definition.output.render
      ? definition.output.render({}, statusValue)
      : [{ type: "text", text: "" }];
    const text = rendered.map((part) => part.text ?? "").join("\n");
    assert.ok(!text.includes("undefined"), `渲染文本里出现 undefined：\n${text}`);
  });

  console.log(results.join("\n"));
  const failed = results.filter((line) => line.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
}

await main();

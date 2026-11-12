/**
 * 验证「唤醒状态落盘 + 重启补偿」：
 *   phase 1：假装子会话还在跑（activation.result 永不 resolve，status=running），让状态落盘；
 *   模拟进程退出（不 dispose、直接换一个模块实例）。
 *   phase 2：用同一个 DSH_HOME 重新加载插件，模拟重启 —— 子会话已不在内存里（拿不到 status），
 *            补偿逻辑应补发一条「你离线期间完成了」的通知。
 *
 * 跑法：node test/wake-state-probe.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";

const home = mkdtempSync(path.join(tmpdir(), "vb-wake-"));
process.env.DSH_HOME = home;
const stateFile = path.join(home, "vibe-bridge", "wake-state.json");
const CHILD = "child-persist-0001";
const PARENT = "session-parent";

const makeCtx = (statuses, woke, tools) => ({
  logger: { info: () => {} },
  on: () => {},
  effect: (fn) => {
    const dispose = fn();
    return () => dispose?.();
  },
  tools: { register: (definition) => void tools.set(definition.name, definition) ?? (() => {}) },
  subagents: {
    // 子会话这一轮永不结束：模拟“进程退出时它还在跑”
    startActivation: async () => ({ childId: CHILD, result: new Promise(() => {}) }),
    sendMessage: async () => "msg",
    listChildren: async () => [],
    interrupt: () => {},
  },
  agents: {
    get(id) {
      const status = statuses[id];
      return status === undefined ? undefined : { status, followup: (message) => woke.push({ id, message }) };
    },
  },
  commands: { register: () => () => {} },
});

const load = async (tag) => import(`../lib/index.js?probe=${tag}`);

// ---- phase 1：让它记下“这个子会话在跑” ----
{
  const { apply, Config } = await load("phase1");
  const woke = [];
  const tools = new Map();
  const statuses = { [PARENT]: "inactive", [CHILD]: "running" };
  const ctx = makeCtx(statuses, woke, tools);
  apply(ctx, Config({ enabled: true, provider: "spawn", rules: [], wakePollMs: 40, wakeDebounceMs: 40 }));
  await tools.get("spawn_session").execute({ prompt: "长任务", label: "persist" }, { agent: { id: PARENT } });
  await new Promise((resolve) => setTimeout(resolve, 700)); // 等哨兵看到 running + 落盘
}

assert.ok(existsSync(stateFile), "状态文件应已写出");
const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
assert.equal(persisted.children[CHILD]?.seenRunning, true, "应该记下 seenRunning");
assert.equal(persisted.children[CHILD]?.announced, false, "还没通知过");
console.log(`PASS  phase1 落盘：${JSON.stringify(persisted.children[CHILD])}`);

// ---- phase 2：模拟重启（新模块实例 + 子会话已不在内存）----
{
  const { apply, Config } = await load("phase2");
  const woke = [];
  const tools = new Map();
  const statuses = { [PARENT]: "inactive" }; // 注意：CHILD 没有 status → 视为重启后不在跑
  const ctx = makeCtx(statuses, woke, tools);
  apply(ctx, Config({ enabled: true, provider: "spawn", rules: [], wakePollMs: 40, wakeDebounceMs: 40 }));
  await new Promise((resolve) => setTimeout(resolve, 3200)); // 等补偿（2.5s）+ 合并窗口
  assert.ok(woke.length >= 1, "重启后应补发通知");
  const text = woke[0].message.content.map((part) => part.text).join("");
  assert.match(text, new RegExp(CHILD), "通知里要有子会话 id");
  assert.match(text, /完成了新一轮工作/);
  console.log(`PASS  phase2 重启补偿：${text.slice(0, 80)}…`);
  const after = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(after.children[CHILD]?.announced, true, "补发后应把 announced 固化，避免下次重复");
  console.log("PASS  announced 已固化，不会重复补发");
}

rmSync(home, { recursive: true, force: true });
console.log("PASS  临时 DSH_HOME 已清理");

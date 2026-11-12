/**
 * 用真实会话日志验证 query_session 的报告文本（不经过模型）。
 * 运行：node test/query-probe.mjs <sessionId> [tail] [--verbose]
 */
import { apply, Config } from "../lib/index.js";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const positional = args.filter((arg) => !arg.startsWith("--"));
const sessionId = positional[0];
const tail = Number(positional[1] ?? 1);
if (!sessionId) {
  console.error("usage: node test/query-probe.mjs <sessionId> [tail] [--verbose]");
  process.exit(2);
}

const tools = new Map();
const ctx = {
  logger: { info: () => {} },
  effect: (fn) => fn(),
  on: () => {},
  tools: { register: (definition) => void tools.set(definition.name, definition) ?? (() => {}) },
  subagents: { listChildren: async () => [], sendMessage: async () => "x", startActivation: async () => ({ childId: "x" }) },
  agents: { get: () => ({ status: "inactive" }) },
  commands: { register: () => () => {} },
};

apply(ctx, Config({ enabled: true, provider: "spawn", rules: [] }));
const value = await tools.get("query_session").execute(
  { session_id: sessionId, tail, include_tools: "summary", ...(verbose ? { verbose: true } : {}) },
  { agent: { id: "probe" } },
);
console.log(value.report);
console.log(`\n[长度] ${value.report.length} 字符（${verbose ? "verbose" : "默认"}）`);

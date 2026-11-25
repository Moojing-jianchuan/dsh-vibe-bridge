/**
 * 客户端那一半（lib/client.js）的冒烟测试。
 *
 * 不开浏览器，复刻 dsh-client-modules 的加载契约：
 *   window.__ModuleLoader__.load({ id, factory })  →  factory(require)  →  { apply, inject }
 * 用假的 slots / locale / configForms / layout / remote 跑一遍 apply，断言：
 *   1) 注册了哪些面：左侧栏入口、主页面、一个会话菜单项、两个 overlay、设置卡片；
 *   2) 面板新布局：用法并入描述、父/子对话展示、树头「创建子会话」、逐会话碎碎念规则；
 *   3) 右键「碎碎念编辑」弹窗：标题、打开/关闭/编辑（base64 文案）、关闭按钮；
 *   4) 设置卡片：字段、保存/放弃、摘要。
 *
 * 运行：node test/client-smoke.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const results = [];
/** 支持异步断言的 check（顶层 await 逐个等待，保证顺序与失败可见）。 */
const check = async (title, fn) => {
  try {
    await fn();
    results.push(`PASS  ${title}`);
  } catch (error) {
    results.push(`FAIL  ${title}\n      ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

// ---- 伪造模块加载器环境 ----
let registration;
const jsxRuntime = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: "Fragment",
};
const reactStub = {
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
};
/** 表单模型桩：形状与真实 SettingsFormModel 一致（field/shell/actions/bind/plan/dispose）。 */
const models = [];
class SettingsFormModelStub {
  constructor(scope, specs) {
    this.scope = scope;
    this.specs = new Map(specs.map((spec) => [spec.field, spec]));
    this.staged = new Map();
    this.savedValues = new Map();
    this.saved = 0;
    this.disposed = false;
    models.push(this);
  }
  field(name) {
    const spec = this.specs.get(name);
    const staged = this.staged.get(name);
    const saved = this.savedValues.get(name);
    const raw = saved !== undefined ? saved : this.scope?.value?.[name];
    return { text: staged !== undefined ? staged : spec.format(raw), overridden: false, invalid: false };
  }
  shell() {
    return { available: true, writable: true, dirty: this.staged.size > 0, invalid: false, saving: false, failed: false };
  }
  actions() {
    return {
      edit: (field, text) => {
        this.lastEdit = [field, text];
        this.staged.set(field, text);
      },
      resetField: (field) => this.staged.delete(field),
      save: () => {
        this.saved += 1;
        for (const [key, value] of this.staged) this.savedValues.set(key, value === "true" ? true : value === "false" ? false : value);
        this.staged.clear();
      },
      discard: () => this.staged.clear(),
    };
  }
  bind(projection) {
    return () => projection();
  }
  plan() {
    return [...this.staged.keys()].map((key) => ({ op: "set", path: [key] }));
  }
  dispose() {
    this.disposed = true;
  }
}
const primitivesStub = {
  MenuItemButton: "MenuItemButton",
  IconPlusOutlineRegular: "IconPlus",
  IconCordisPluginOutlineRegular: "IconCordis",
  SettingsFormModel: SettingsFormModelStub,
  SettingsForm: "SettingsForm",
  SettingsValueField: "SettingsValueField",
  settingsNumberField: (field) => ({
    field,
    format: (value) => (typeof value === "number" ? String(value) : ""),
    parse: (text) => (text.trim() === "" ? { kind: "clear" } : Number.isFinite(Number(text)) ? { kind: "set", value: Number(text) } : undefined),
  }),
  settingsTextField: (field) => ({
    field,
    format: (value) => (typeof value === "string" ? value : ""),
    parse: (text) => (text.trim() === "" ? { kind: "clear" } : { kind: "set", value: text }),
  }),
};
const moduleTable = {
  "react/jsx-runtime": jsxRuntime,
  react: reactStub,
  "@deepseek-ai/dsh-client-ui-primitives": primitivesStub,
};
globalThis.window = { __ModuleLoader__: { load: (entry) => (registration = entry) } };

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
new Function("window", source)(globalThis.window);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await check("bundle 已向模块加载器注册", () => assert.ok(registration));
await check("id 与 package.json name 一致", () => assert.equal(registration.id, pkg.name));

const loaded = registration.factory((specifier) => {
  const found = moduleTable[specifier];
  if (found === undefined) throw new Error(`unexpected require: ${specifier}`);
  return found;
});

await check("导出 apply / inject（含 remote.session / remote.commands）", () => {
  assert.equal(typeof loaded.apply, "function");
  assert.deepEqual(loaded.inject, ["slots", "locale", "configForms", "layout", "remote", "remote.session", "remote.commands"]);
});

// ---- 伪造浏览器侧服务 ----
const registered = [];
const locales = [];
const injectedSlots = [];
const panels = [];
const prompts = [];
const commands = [];
const fakeForm = { value: { everyTurns: 4, fullEveryTurns: 12, fromTurn: 1, nudgeText: "" }, getSnapshot: () => fakeForm };
const statusText = "every 4 · full every 12 · from turn 1\nrules: nudge every 4/full 12\noverrides: 2 (session-a → off, session-b → every:3)\nsession: mode=every:3 text=";
const statusAllText = "global: every 4 · full 12 · from 1\nchild-aaaa-1111: off text=no\nchild-bbbb-2222: every:3 text=yes";
/** 面板父/子展示的数据源（与 session.list 桩一致）。 */
const SAMPLE_SESSIONS = [
  {
    sessionId: "session-parent-1",
    projections: {
      sessionTitle: { title: "父对话标题" },
      subagentCatalog: [
        { id: "child-aaaa-1111", label: "甲", task: "给 A 模块补测试，完成后回报结果，不要改其它文件", running: true },
        { id: "child-bbbb-2222", label: "乙", task: "分析日志", running: false },
      ],
    },
  },
];
const ctx = {
  effect: (fn) => {
    const dispose = fn();
    return () => dispose?.();
  },
  locale: {
    register: (key, dicts) => locales.push({ key, dicts }),
    bind: (key) => (text) => (locales.find((entry) => entry.key === key)?.dicts.zh ?? {})[text] ?? text,
  },
  configForms: {
    get: (namespace) => ({ ...fakeForm, namespace }),
    whileServed: (namespaces, register) => register(new Set(namespaces)),
  },
  layout: { selectPanel: (id) => panels.push(id) },
  remote: {
    session: {
      list: async () => ({
        items: [
          {
            sessionId: "session-parent-1",
            projections: {
              sessionTitle: { title: "父对话标题" },
              subagentCatalog: [
                { id: "child-aaaa-1111", label: "甲", task: "给 A 模块补测试，完成后回报结果，不要改其它文件", running: true },
                { id: "child-bbbb-2222", label: "乙", task: "分析日志", running: false },
              ],
            },
          },
        ],
      }),
      prompt: async (request) => {
        prompts.push(request);
        return { messageId: "msg-1" };
      },
    },
    commands: {
      execute: async (sessionId, line, attachments) => {
        commands.push({ sessionId, line, attachments });
        if (line === "/vibe-nudge status all") return { ok: true, value: { result: { kind: "success", text: statusAllText } } };
        if (line === "/vibe-nudge status") return { ok: true, value: { result: { kind: "success", text: statusText } } };
        if (line.startsWith("/vibe-nudge")) return { ok: true, value: { result: { kind: "success", text: "ok" } } };
        return { ok: true, value: { result: { kind: "success", text: "session started: child-from-command" } } };
      },
    },
  },
  slots: {
    inject(name, fn) {
      injectedSlots.push(name);
      const result = fn();
      // 真实槽位会把生成器逐项消费掉；这里同样 drain，否则菜单项不会被注册。
      if (result !== null && typeof result === "object" && typeof result[Symbol.iterator] === "function") {
        for (const _ of result) void _;
      }
      return result;
    },
    register(meta, component) {
      registered.push({ meta, component });
      return () => {};
    },
  },
};

loaded.apply(ctx);

const byName = (name) => registered.filter((entry) => entry.meta.name === name);
const byId = (id) => registered.find((entry) => entry.meta.id === id);
const dict = locales[0].dicts.zh;
const t = (key) => dict[key];

/** 把渲染产物里所有文本拼起来。 */
function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.props?.children);
}
/** 在渲染树里找第一个满足条件的节点。 */
const find = (node, predicate) => {
  if (node === null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
};
/** 收集所有满足条件的节点。 */
const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  collect(node.props?.children, predicate, out);
  return out;
};

await check("注册了六个面", () => {
  assert.equal(registered.length, 6, JSON.stringify(registered.map((entry) => entry.meta.id)));
  assert.deepEqual([...new Set(injectedSlots)].sort(), [
    "main",
    "plugins.item",
    "shell.overlay",
    "sidebar.panellist",
    "sidebar.workspaces.session.menu.item",
  ]);
});

await check("左侧栏入口与主页面 key 正确", () => {
  assert.equal(byName("sidebar.panellist")[0].meta.id, "vibe-bridge");
  assert.equal(byName("main")[0].meta.key, "vibe-bridge");
});

// ---------------------------------------------------------------------------
// 会话右键菜单：只剩「碎碎念编辑」
// ---------------------------------------------------------------------------
await check("菜单只剩一项「碎碎念编辑」，旧的创建/调度台/开关项已删除", () => {
  const items = byName("sidebar.workspaces.session.menu.item");
  assert.equal(items.length, 1);
  assert.equal(items[0].meta.id, "vibe-nudge-edit");
  for (const removed of ["vibe-create-child", "vibe-console", "vibe-nudge-off", "vibe-nudge-reset"]) {
    assert.equal(byId(removed), undefined, `${removed} 不应再注册`);
  }
});

await check("点击「碎碎念编辑」打开弹窗并关闭菜单", () => {
  const { component, meta } = byId("vibe-nudge-edit");
  const face = meta.inject();
  let closed = false;
  const element = component({
    sessionId: "session-abcdef1234",
    useMenuOpenState: () => [true, (next) => (closed = next === false)],
    openNudgeEditor: face.openNudgeEditor,
    t,
  });
  assert.equal(element.type, "MenuItemButton");
  assert.equal(element.props.children, "碎碎念编辑");
  element.props.onSelect();
  assert.equal(closed, true, "点完应关闭菜单");
});

// ---------------------------------------------------------------------------
// 碎碎念编辑弹窗
// ---------------------------------------------------------------------------
const nudgeOverlay = registered.find((entry) => entry.meta.id === "vibe-bridge-nudge-dialog");
const nudgeFace = nudgeOverlay.meta.inject();
const renderDialog = () => nudgeOverlay.component({ t, ...nudgeFace });

await check("弹窗：标题含会话 id 前 8 位，且带说明与关闭按钮", () => {
  const rendered = renderDialog();
  assert.ok(rendered, "编辑弹窗应渲染");
  const text = textOf(rendered);
  assert.match(text, /碎碎念 · session-/, "标题应是 碎碎念 · id 前 8 位");
  assert.match(text, /仅作用于本次对话；子会话同样适用。/);
  const closeBtn = find(rendered, (node) => node.type === "button" && node.props?.["aria-label"] === "关闭");
  assert.ok(closeBtn !== undefined, "右上角应有关闭按钮");
});

await check("弹窗：关闭 / 打开 分别发 /vibe-nudge off 与 on", async () => {
  const before = commands.length;
  const rendered = renderDialog();
  const offBtn = find(rendered, (node) => node.type === "button" && node.props?.["data-action"] === "off");
  offBtn.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const onBtn = find(renderDialog(), (node) => node.type === "button" && node.props?.["data-action"] === "open");
  onBtn.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const nudgeCalls = commands.slice(before).filter((call) => call.line === "/vibe-nudge off" || call.line === "/vibe-nudge on");
  assert.deepEqual(
    nudgeCalls.map((call) => [call.sessionId, call.line]),
    [
      ["session-abcdef1234", "/vibe-nudge off"],
      ["session-abcdef1234", "/vibe-nudge on"],
    ],
  );
  assert.deepEqual(nudgeCalls[0].attachments, []);
});

// 编辑：展开 → 保存（base64）

await check("弹窗：预填解析 session: 行（mode + 解码后的文案）", async () => {
  const custom = Buffer.from("本会话文案", "utf8").toString("base64");
  const original = ctx.remote.commands.execute;
  ctx.remote.commands.execute = async (sessionId, line, attachments) => {
    if (line === "/vibe-nudge status") {
      commands.push({ sessionId, line, attachments });
      return { ok: true, value: { result: { kind: "success", text: `overrides: 1\nsession: mode=off text=${custom}` } } };
    }
    return original(sessionId, line, attachments);
  };
  const parsed = await nudgeFace.nudgeLoad("session-abcdef1234");
  ctx.remote.commands.execute = original;
  assert.deepEqual(parsed, { mode: "off", text: "本会话文案" });
  const text = textOf(renderDialog());
  // 关闭但文案还在：文案必须被明说"已保留"，否则用户会以为丢了（缺陷 2/4 的观感）。
  assert.match(text, /已关闭/);
  assert.match(text, /自定义文案已保留/);
});

// ---------------------------------------------------------------------------
// 面板新布局
// ---------------------------------------------------------------------------
const pageEntry = byName("main")[0];
const pageFace = pageEntry.meta.inject();
const pageProps = {
  t,
  useForm: pageFace.hooks?.useForm,
  openSpawn: pageFace.openSpawn,
  listSessions: pageFace.listSessions,
  sendToSession: pageFace.sendToSession,
  pendingTarget: pageFace.pendingTarget,
  // 直接喂数据，避免依赖 useEffect 拉列表
  sessions: SAMPLE_SESSIONS,
};

await check("面板：用法并入描述（一行一句），不再有独立「用法」区块", () => {
  const text = textOf(pageEntry.component({ ...pageProps }));
  assert.match(text, /spawn_session\(prompt, label\) → session id/);
  assert.match(text, /list_sessions\(\) → id \/ label \/ 运行状态/);
  assert.match(text, /post_to_session\(session_id, message\) → message id/);
  assert.match(text, /vibe_bridge_status 可看版本与注入次数/);
  assert.equal(text.match(/用法/g)?.length ?? 0, 0, "不应再有「用法」小节");
});

await check("面板：父对话与子对话展示（父 id8 + 子 id8 + 任务描述）", () => {
  const text = textOf(pageEntry.component({ ...pageProps }));
  assert.match(text, /父对话及?其?子对话|父对话及其子对话/);
  assert.match(text, /父对话 session- · 父对话标题/);
  assert.match(text, /子会话 child-aa · 甲 · 给 A 模块补测试/);
  assert.match(text, /子会话 child-bb · 乙 · 分析日志/);
});

await check("面板：「创建子会话」在会话树区块，点击打开 VibeSpawnDialog", () => {
  const opens = [];
  const element = pageEntry.component({ ...pageProps, openSpawn: (parentId) => opens.push(parentId) });
  const button = find(element, (node) => node.type === "button" && node.props?.["data-action"] === "create-child");
  assert.ok(button !== undefined, "树头应有创建按钮");
  assert.equal(button.props.children, "创建子会话");
  button.props.onClick();
  assert.deepEqual(opens, ["session-parent-1"], "以第一个父会话为默认父会话");
  // 不再有父会话 id / 任务的输入框
  assert.equal(find(element, (node) => node.type === "textarea"), undefined, "调度台表单应已移除");
});

await check("面板：碎碎念规则逐会话列出（已关闭 / 每 N 轮）", () => {
  const rows = [
    { kind: "parent", sessionId: "session-parent-1", mode: "global", custom: false, every: 4 },
    { kind: "child", sessionId: "child-aaaa-1111", mode: "off", custom: false, every: 4 },
    { kind: "child", sessionId: "child-bbbb-2222", mode: "every:3", custom: true, every: 3 },
  ];
  const text = textOf(pageEntry.component({ ...pageProps, nudgeRows: rows, nudgeGlobalEvery: 4 }));
  assert.match(text, /父对话 session- · 每 4 轮（全局文案）/);
  assert.match(text, /子会话 child-aa · 已关闭/);
  assert.match(text, /子会话 child-bb · 每 3 轮（本会话文案）/);
});

await check("面板：不再出现 cordis.patch.yml 与整块兜底文案", () => {
  const text = textOf(pageEntry.component({ ...pageProps }));
  assert.doesNotMatch(text, /cordis\.patch\.yml/);
  assert.doesNotMatch(text, /Host 没有响应/);
  assert.doesNotMatch(text, /取不到（Host/);
});

await check("面板：批量状态解析（status all）→ 无覆盖会话显示「跟随全局」", async () => {
  const rows = await pageFace.refreshNudgeRows([
    { kind: "parent", sessionId: "session-parent-1" },
    { kind: "child", sessionId: "child-aaaa-1111" },
    { kind: "child", sessionId: "child-bbbb-2222" },
  ]);
  assert.equal(pageFace.nudgeGlobalEvery(), 4);
  assert.deepEqual(
    rows.map((row) => [row.sessionId, row.mode, row.custom, row.every]),
    [
      ["session-parent-1", "global", false, 4],
      ["child-aaaa-1111", "off", false, 4],
      ["child-bbbb-2222", "every:3", true, 3],
    ],
  );
  const text = textOf(pageEntry.component({ ...pageProps, nudgeRows: rows, nudgeGlobalEvery: 4 }));
  assert.match(text, /父对话 session- · 每 4 轮（全局文案）/, "没有覆盖的会话应显示跟随全局");
  const call = commands.find((entry) => entry.line === "/vibe-nudge status all");
  assert.ok(call !== undefined, "应只发一次批量命令");
});

// ---------------------------------------------------------------------------
// 设置卡片（保持不变）
// ---------------------------------------------------------------------------
const cardEntry = registered.find((entry) => entry.meta.name === "plugins.item" && entry.meta.id === "vibe-bridge");
const cardFace = cardEntry.meta.inject();

await check("设置卡片：注册在 plugins.item 上（不再是只读行）", () => {
  assert.equal(cardEntry.meta.order, 40);
  assert.equal(cardEntry.meta.label(), "碎碎念节奏");
  assert.equal(byId("vibe-bridge-status"), undefined, "有表单模型时不该再注册只读行");
});

await check("设置卡片：五个数字/布尔字段 + 多行文案 + 保存/放弃", () => {
  const rendered = cardEntry.component({ t, ...cardFace.hooks, ...cardFace });
  const form = collect(rendered, (node) => node.type === "SettingsForm");
  assert.equal(form.length, 1);
  assert.equal(typeof form[0].props.onSave, "function");
  assert.equal(typeof form[0].props.onDiscard, "function");
  const fields = collect(rendered, (node) => node.type === "SettingsValueField");
  assert.equal(fields.length, 5);
  assert.ok(collect(rendered, (node) => node.type === "textarea").length === 1);
});

await check("设置卡片：dirty 后保存调用 actions().save()", () => {
  const model = models.at(-1);
  cardFace.edit("everyTurns", "6");
  const dirty = cardFace.hooks.useVibeBridgeCard((value) => value);
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.everyTurns.text, "6");
  const rendered = cardEntry.component({ t, ...cardFace.hooks, ...cardFace });
  find(rendered, (node) => node.type === "SettingsForm").props.onSave();
  assert.equal(model.saved, 1);
});

{
  await cardFace.refreshNudgeStatus();
  await check("设置卡片摘要：显示当前节奏与覆盖数", () => {
    const text = textOf(cardEntry.component({ t, ...cardFace.hooks, ...cardFace }));
    assert.match(text, /当前生效/);
    assert.match(text, /every 4 · full every 12 · from turn 1/);
    assert.match(text, /被单独覆盖的会话: 2/);
  });
}

// ---------------------------------------------------------------------------
// 弹窗补齐：设置轮次 / 稀疏 / 全量 / 全局开关
// ---------------------------------------------------------------------------


await check("弹窗：全局开启 + 全局关闭按钮，点击走 SettingsFormModel 的 edit+save", async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const model = models.at(-1);
  const savedBefore = model.saved;
  const rendered = renderDialog();
  const text = textOf(rendered);
  assert.match(text, /全局：开启/);
  const offBtn = find(rendered, (node) => node.type === "button" && node.props?.["data-action"] === "global-off");
  assert.ok(offBtn !== undefined, "应有「全局关闭」按钮");
  assert.equal(offBtn.props.children, "全局关闭");
  offBtn.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(model.lastEdit, ["nudgeEnabled", "false"], "应通过表单模型 edit nudgeEnabled");
  assert.equal(model.saved, savedBefore + 1, "应调用 save()");
  assert.equal(nudgeFace.nudgeGlobal.value, false, "读回应为关闭");
});

await check("弹窗：全局关闭时状态行显示“全局已关闭（本会话设置不生效）”", async () => {
  await nudgeFace.nudgeLoad("session-abcdef1234");
  const text = textOf(renderDialog());
  assert.match(text, /生效：全局已关闭（本会话设置不生效）/);
  assert.match(text, /全局关闭期间不会注入任何碎碎念/, "还要有“不注入”的提示");
  assert.match(text, /全局：已关闭/);
  // 复原，别影响后面的面板/卡片用例
  await nudgeFace.nudgeGlobal.set(true);
  assert.equal(nudgeFace.nudgeGlobal.value, true);
});

await check("面板：规则区首行显示全局开关，全局关闭时逐会话行带（全局关闭）", () => {
  const rows = [
    { kind: "parent", sessionId: "session-parent-1", mode: "global", custom: false, every: 4, globalOn: true },
    { kind: "child", sessionId: "child-aaaa-1111", mode: "off", custom: false, every: 4, globalOn: true },
  ];
  const onText = textOf(pageEntry.component({ ...pageProps, nudgeRows: rows, nudgeGlobalEvery: 4, nudgeGlobalOn: () => true }));
  assert.match(onText, /全局：开启（每 4 轮）/);
  const offText = textOf(
    pageEntry.component({
      ...pageProps,
      nudgeRows: rows.map((row) => ({ ...row, globalOn: false })),
      nudgeGlobalEvery: 4,
      nudgeGlobalOn: () => false,
    }),
  );
  assert.match(offText, /全局：已关闭/);
  assert.match(offText, /子会话 child-aa · 已关闭（全局关闭）/);
});


// ---------------------------------------------------------------------------
// 规则列表（面板）+ 规则编辑器（弹窗打开即编辑）
// ---------------------------------------------------------------------------
const RULES_FIXTURE = [
  { id: "r-1", type: "constraint", content: "不要用 print 调试", strategies: ["every-message"], everyN: 3, enabled: true },
  { id: "r-2", type: "preference", content: "回答先说结论", strategies: ["every-n"], everyN: 3, enabled: false },
];







/** 用最近一次的 props 重新渲染弹窗（模块级状态已经是新的了）。 */

// ---------------------------------------------------------------------------
// 回归守卫：这两类缺陷在真机上表现为"入口点了没反应"，纯函数渲染测不出来
//   1) 组件引用了未定义的模块级状态仓（ReferenceError: dialog is not defined）
//   2) 在 hook 之前早退（React #310: Rendered more hooks than during the previous render）
// ---------------------------------------------------------------------------
await check("弹窗状态仓都已定义（避免 ReferenceError）", () => {
  for (const declaration of ["const dialog = {", "const setDialog =", "const subscribeDialog =", "const nudgeEditor ="]) {
    assert.ok(source.includes(declaration), `lib/client.js 缺少声明：${declaration}`);
  }
});

await check("弹窗组件在最后一个 hook 之前不早退（避免 React #310）", () => {
  for (const component of ["VibeSpawnDialog", "NudgeEditorDialog"]) {
    const start = source.indexOf(`function ${component}(`);
    assert.ok(start >= 0, `找不到组件 ${component}`);
    // 组件体的边界：下一个顶层 function 或下一个 #region，谁先到算谁；再兜底截前 8000 字。
    const candidates = [source.indexOf("\n\t\tfunction ", start + 10), source.indexOf("\n\t\t//#region", start + 10)].filter(
      (index) => index > start,
    );
    const end = Math.min(candidates.length === 0 ? source.length : Math.min(...candidates), start + 8000);
    // 先剥掉注释：注释里出现的 "return null" 不算早退（我自己就踩过这个假阳性）。
    const body = source
      .slice(start, end)
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    const lastHook = Math.max(
      body.lastIndexOf("react.useState("),
      body.lastIndexOf("react.useEffect("),
      body.lastIndexOf("react.useMemo("),
      body.lastIndexOf("react.useRef("),
    );
    const firstEarlyReturn = body.indexOf("return null");
    assert.ok(lastHook >= 0, `${component} 里没有 hook？`);
    assert.ok(
      firstEarlyReturn === -1 || firstEarlyReturn > lastHook,
      `${component} 在 hook 之前 return null，会让 hook 数量在开/关之间变化（React #310）`,
    );
  }
});

console.log(results.join("\n"));

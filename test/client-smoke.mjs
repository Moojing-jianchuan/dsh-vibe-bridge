/**
 * 客户端那一半（lib/client.js）的冒烟测试。
 *
 * 不开浏览器，复刻 dsh-client-modules 的加载契约：
 *   window.__ModuleLoader__.load({ id, factory })  →  factory(require)  →  { apply, inject }
 * 用假的 slots / locale / configForms / layout / remote 跑一遍 apply，断言：
 *   1) 注册了五个面：左侧栏入口、主页面、设置行、两个会话菜单项；
 *   2) 会话菜单项点下去会把 sessionId 交给调度台并关掉菜单；
 *   3) 主页面在三种配置状态下渲染，且提交表单会调到 spawnChild。
 *
 * 运行：node test/client-smoke.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const results = [];
const check = (title, fn) => {
  try {
    fn();
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
    this.saved = 0;
    this.disposed = false;
    models.push(this);
  }
  field(name) {
    const spec = this.specs.get(name);
    const staged = this.staged.get(name);
    return {
      text: staged !== undefined ? staged : spec.format(this.scope?.value?.[name]),
      overridden: false,
      invalid: false,
    };
  }
  shell() {
    return { available: true, writable: true, dirty: this.staged.size > 0, invalid: false, saving: false, failed: false };
  }
  actions() {
    return {
      edit: (field, text) => this.staged.set(field, text),
      resetField: (field) => this.staged.delete(field),
      save: () => {
        this.saved += 1;
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

check("bundle 已向模块加载器注册", () => assert.ok(registration));
check("id 与 package.json name 一致", () => assert.equal(registration.id, pkg.name));

const loaded = registration.factory((specifier) => {
  const found = moduleTable[specifier];
  if (found === undefined) throw new Error(`unexpected require: ${specifier}`);
  return found;
});

check("导出 apply / inject（含 remote.session / remote.commands）", () => {
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
const statusText = "every 4 · full every 12 · from turn 1\nrules: nudge every 4/full 12\noverrides: 2 (session-a → off, session-b → every:3)";
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
    // 真实服务在命名空间被服务时回调；桩里直接当作“已服务”。
    whileServed: (namespaces, register) => register(new Set(namespaces)),
  },
  layout: { selectPanel: (id) => panels.push(id) },
  remote: {
    session: {
      list: async () => ({ items: [{ sessionId: "session-anchor" }] }),
      prompt: async (request) => {
        prompts.push(request);
        return { messageId: "msg-1" };
      },
    },
    commands: {
      execute: async (sessionId, line, attachments) => {
        commands.push({ sessionId, line, attachments });
        if (line === "/vibe-nudge status") {
          return { ok: true, value: { result: { kind: "success", text: statusText } } };
        }
        if (line.startsWith("/vibe-nudge")) {
          return { ok: true, value: { result: { kind: "success", text: "本会话碎碎念：ok" } } };
        }
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

check("注册了八个面（含可编辑设置卡片）", () => {
  assert.equal(registered.length, 8);
  assert.deepEqual([...new Set(injectedSlots)].sort(), [
    "main",
    "plugins.item",
    "shell.overlay",
    "sidebar.panellist",
    "sidebar.workspaces.session.menu.item",
  ]);
});

check("左侧栏入口：id/order/label 正确", () => {
  const { meta } = byName("sidebar.panellist")[0];
  assert.equal(meta.id, "vibe-bridge");
  assert.equal(meta.order, 40);
  assert.equal(meta.label(), "Vibe Bridge");
});

check("主页面：key 与入口 id 一致", () => {
  const { meta } = byName("main")[0];
  assert.equal(meta.key, "vibe-bridge");
  assert.equal(meta.locale, "vibeBridge");
});

check("设置卡片：注册在 plugins.item 上（不再是只读行）", () => {
  const { meta } = registered.find((entry) => entry.meta.name === "plugins.item" && entry.meta.id === "vibe-bridge");
  assert.equal(meta.name, "plugins.item");
  assert.equal(meta.order, 40);
  assert.equal(meta.label(), "碎碎念节奏");
  assert.equal(byId("vibe-bridge-status"), undefined, "有表单模型时不该再注册只读行");
});

check("会话菜单：四个菜单项 id/order 正确", () => {
  const create = byId("vibe-create-child");
  const consoleItem = byId("vibe-console");
  const off = byId("vibe-nudge-off");
  const reset = byId("vibe-nudge-reset");
  for (const item of [create, consoleItem, off, reset]) {
    assert.equal(item.meta.name, "sidebar.workspaces.session.menu.item");
  }
  assert.deepEqual([create.meta.order, consoleItem.meta.order, off.meta.order, reset.meta.order], [460, 461, 462, 463]);
});

check("菜单项「创建子会话」打开弹窗并关闭菜单", () => {
  const { component } = byId("vibe-create-child");
  let closed = false;
  const element = component({
    sessionId: "session-abc",
    useMenuOpenState: () => [true, (next) => (closed = next === false)],
    t,
  });
  assert.equal(element.type, "MenuItemButton");
  assert.equal(element.props.children, "创建子会话");
  element.props.onSelect();
  assert.equal(closed, true);
});

check("弹窗：菜单点过后渲染出任务输入框与创建按钮", () => {
  const overlay = byId("vibe-bridge-spawn-dialog");
  const face = overlay.meta.inject();
  const rendered = overlay.component({ t, spawnChild: async () => {}, ...face });
  assert.ok(rendered, "弹窗应渲染");
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
  assert.ok(find(rendered, (node) => node.type === "textarea"), "应有任务输入框");
  assert.ok(
    find(rendered, (node) => node.type === "button" && node.props?.children === "创建子会话"),
    "应有创建按钮",
  );
});

// 提交是异步的：单独跑，避免同步 check 抢跑。
{
  const overlay = byId("vibe-bridge-spawn-dialog");
  const face = overlay.meta.inject();
  const props = { t };
  const rendered = overlay.component({ ...props, ...face });
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
  find(rendered, (node) => node.type === "textarea").props.onChange({ target: { value: "给 A 模块补测试" } });
  find(rendered, (node) => node.type === "button" && node.props?.children === "创建子会话").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("弹窗提交：走宿主命令 /vibe-spawn 直接建会话，成功后关闭", () => {
    const call = commands.at(-1);
    assert.equal(call.sessionId, "session-abc", "命令要跑在被点中的父会话上");
    assert.equal(call.line, "/vibe-spawn child|给 A 模块补测试");
    assert.deepEqual(call.attachments, []);
    assert.equal(prompts.length, 0, "不应再往父会话投 prompt（那样要等模型一轮）");
    assert.equal(overlay.component({ ...props, ...face }), null, "拿到 id 后弹窗关闭");
  });
}

check("菜单项「打开调度台」不预设父会话", () => {
  const { component, meta } = byId("vibe-console");
  const face = meta.inject();
  let closed = false;
  const element = component({
    useMenuOpenState: () => [true, (next) => (closed = next === false)],
    openConsole: face.openConsole,
    t,
  });
  element.props.onSelect();
  assert.equal(closed, true);
  const page = byName("main")[0];
  assert.equal(page.meta.inject().pendingTarget, "", "空 id 打开时不应带父会话");
});

/** 把渲染产物里所有文本拼起来。 */
function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.props?.children);
}

check("主页面：无快照时给出说明，且带调度台表单", () => {
  const text = textOf(byName("main")[0].component({ t, spawnChild: async () => {}, useForm: () => undefined }));
  assert.match(text, /Vibe Bridge/);
  assert.match(text, /已激活/);
  assert.match(text, /调度台/);
  assert.match(text, /父会话 id/);
  assert.match(text, /创建子会话/);
  assert.match(text, /取不到配置快照/);
});

check("主页面：带会话树区块，且 face 暴露 listSessions / sendToSession", () => {
  const face = byName("main")[0].meta.inject();
  assert.equal(typeof face.listSessions, "function");
  assert.equal(typeof face.sendToSession, "function");
  const text = textOf(byName("main")[0].component({ t, useForm: () => undefined, ...face }));
  assert.match(text, /会话树/);
});

check("主页面：有规则时逐条列出", () => {
  const text = textOf(
    byName("main")[0].component({
      t,
      spawnChild: async () => {},
      useForm: () => ({ value: { rules: [{ name: "verify", everyTurns: 4, fullEveryTurns: 12, fromTurn: 1, toTurn: 0 }] } }),
    }),
  );
  assert.match(text, /verify/);
  assert.match(text, /turn 1\.\.∞/);
});

check("主页面：预置父会话 id 会填进输入框", () => {
  const page = byName("main")[0];
  const element = page.component({ t, spawnChild: async () => {}, pendingTarget: "session-xyz", useForm: () => undefined });
  const texts = JSON.stringify(element);
  assert.ok(texts.includes("session-xyz"), "预置父会话 id 应出现在渲染树里");
});

// ---------------------------------------------------------------------------
// C：可编辑设置卡片 + 会话菜单里的按会话开关
// ---------------------------------------------------------------------------
const cardEntry = registered.find((entry) => entry.meta.name === "plugins.item" && entry.meta.id === "vibe-bridge");
const cardFace = cardEntry.meta.inject();
/** 渲染卡片：hooks 与动作都在 face 里。 */
const renderCard = (extra = {}) => cardEntry.component({ t, ...cardFace.hooks, ...cardFace, ...extra });
/** 在渲染树里找所有满足条件的节点。 */
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

check("C1 设置卡片：五个数字/布尔字段 + 多行文案 + 保存/放弃", () => {
  const rendered = renderCard();
  assert.equal(rendered.type === "div", true, "卡片根节点应为容器");
  const form = collect(rendered, (node) => node.type === "SettingsForm");
  assert.equal(form.length, 1, "应渲染一个 SettingsForm");
  assert.equal(typeof form[0].props.onSave, "function");
  assert.equal(typeof form[0].props.onDiscard, "function");
  const fields = collect(rendered, (node) => node.type === "SettingsValueField");
  assert.equal(fields.length, 5, `应有 5 个 SettingsValueField（3 数字 + 2 布尔），实际 ${fields.length}`);
  const ids = fields.map((field) => field.props.id).join(",");
  for (const key of ["everyTurns", "fullEveryTurns", "fromTurn", "skipSubagentSessions", "speakOnFirstSeen"]) {
    assert.ok(ids.includes(`vibe-bridge-${key}`), `缺少字段 ${key}`);
  }
  assert.equal(fields.filter((field) => field.props.numeric === true).length, 3, "三个节奏字段应是数字框");
  assert.ok(collect(rendered, (node) => node.type === "textarea").length === 1, "文案应是一个多行输入框");
});

check("C2 保存/放弃：绑到表单模型的 actions，dirty 决定可用态", () => {
  const model = models.at(-1);
  const clean = cardFace.hooks.useVibeBridgeCard((value) => value);
  assert.equal(clean.dirty, false, "未编辑时 dirty=false");
  cardFace.edit("everyTurns", "6");
  const dirty = cardFace.hooks.useVibeBridgeCard((value) => value);
  assert.equal(dirty.dirty, true, "编辑后 dirty=true");
  assert.equal(dirty.everyTurns.text, "6", "受控输入应反映 staged 值");
  const rendered = renderCard();
  const form = collect(rendered, (node) => node.type === "SettingsForm")[0];
  assert.equal(form.props.state.dirty, true, "SettingsForm 拿到的 state 应是 dirty");
  form.props.onSave();
  assert.equal(model.saved, 1, "点击保存应调用模型的 save()");
  cardFace.discard();
  assert.equal(model.staged.size, 0, "放弃应清空 staged");
});

{
  // 摘要：先刷一次 `/vibe-nudge status`，再渲染卡片看“当前生效”。
  await cardFace.refreshNudgeStatus();
  check("C3 摘要区：渲染当前生效节奏与被覆盖会话数", () => {
    const text = textOf(renderCard());
    assert.match(text, /当前生效/);
    assert.match(text, /节奏/);
    assert.match(text, /every 4 · full every 12 · from turn 1/);
    assert.match(text, /被单独覆盖的会话: 2/);
    const statusCall = commands.find((call) => call.line === "/vibe-nudge status");
    assert.ok(statusCall !== undefined, "摘要应通过宿主命令读取");
    assert.equal(statusCall.sessionId, "session-anchor", "用一个会话作锚点");
    assert.deepEqual(statusCall.attachments, []);
  });
}

check("C4 菜单项「本会话关闭/恢复全局」：点击走 /vibe-nudge 命令", () => {
  for (const [id, line] of [
    ["vibe-nudge-off", "/vibe-nudge off"],
    ["vibe-nudge-reset", "/vibe-nudge on"],
  ]) {
    const entry = byId(id);
    const face = entry.meta.inject();
    let closed = false;
    const element = entry.component({
      sessionId: "session-row-1",
      useMenuOpenState: () => [true, (next) => (closed = next === false)],
      nudgeCommand: face.nudgeCommand,
      t,
    });
    assert.equal(element.type, "MenuItemButton");
    element.props.onSelect();
    assert.equal(closed, true, "点完应关闭菜单");
  }
  const nudgeCalls = commands.filter((call) => call.line === "/vibe-nudge off" || call.line === "/vibe-nudge on");
  assert.deepEqual(
    nudgeCalls.map((call) => [call.sessionId, call.line]),
    [
      ["session-row-1", "/vibe-nudge off"],
      ["session-row-1", "/vibe-nudge on"],
    ],
  );
  assert.deepEqual(nudgeCalls[0].attachments, []);
});

console.log(results.join("\n"));

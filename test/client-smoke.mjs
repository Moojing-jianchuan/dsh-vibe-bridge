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
const primitivesStub = {
  MenuItemButton: "MenuItemButton",
  IconPlusOutlineRegular: "IconPlus",
  IconCordisPluginOutlineRegular: "IconCordis",
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
const fakeForm = { value: undefined, getSnapshot: () => fakeForm };
const ctx = {
  effect: (fn) => {
    const dispose = fn();
    return () => dispose?.();
  },
  locale: { register: (key, dicts) => locales.push({ key, dicts }) },
  configForms: { get: (namespace) => ({ ...fakeForm, namespace }) },
  layout: { selectPanel: (id) => panels.push(id) },
  remote: {
    session: {
      prompt: async (request) => {
        prompts.push(request);
        return { messageId: "msg-1" };
      },
    },
    commands: {
      execute: async (sessionId, line, attachments) => {
        commands.push({ sessionId, line, attachments });
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

check("注册了六个面", () => {
  assert.equal(registered.length, 6);
  assert.deepEqual([...new Set(injectedSlots)].sort(), [
    "main",
    "settings.general.item",
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

check("设置行：id/order 正确", () => {
  const { meta } = byId("vibe-bridge-status");
  assert.equal(meta.order, 88);
});

check("会话菜单：两个菜单项 id/order 正确", () => {
  const create = byId("vibe-create-child");
  const console = byId("vibe-console");
  assert.equal(create.meta.name, "sidebar.workspaces.session.menu.item");
  assert.equal(create.meta.order, 460);
  assert.equal(console.meta.order, 461);
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

check("设置行：标题 + 已激活徽标", () => {
  const text = textOf(byId("vibe-bridge-status").component({ t, useForm: () => undefined }));
  assert.match(text, /Vibe Bridge/);
  assert.match(text, /已激活/);
});

console.log(results.join("\n"));

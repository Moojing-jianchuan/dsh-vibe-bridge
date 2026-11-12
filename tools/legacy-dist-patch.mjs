/**
 * 方案 A 的 dist 补丁 v2：把 subagent 子会话作为**可折叠**的缩进子行插进左侧栏。
 *
 * 改的是装好的客户端 bundle：
 *   @deepseek-ai/dsh-client-ui-workspace/lib/client.js
 *
 * 做了什么：
 *   1. 行派生后插入父会话 catalog 里的子会话（depth=1，缩进 22px）；
 *   2. 父行在有子会话时渲染一个 ▾/▸ 按钮，折叠状态复用视图 store 的 groupExpansion
 *      （key 为 `session:<id>`），点一下就走 setGroupExpanded → 触发 React 重渲染；
 *   3. 子行不占水位线、不可拖拽；
 *   4. retainAccountKeys 保留 `session:` 前缀的键，避免折叠状态被工作区清理顺手删掉。
 *
 * 用法：
 *   node patch-workspace-tree.mjs --revert    # 还原（从 .vibe-bridge-backup.js）
 *   node patch-workspace-tree.mjs --dry-run   # 只校验锚点
 *   node patch-workspace-tree.mjs             # 打补丁（幂等：已打过会提示）
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const TARGET = process.argv.find((arg) => arg.endsWith("client.js"))
  ?? "D:/CloudMusic/resources/app/dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js";
const BACKUP = `${TARGET}.vibe-bridge-backup.js`;
const mode = process.argv.includes("--revert") ? "revert" : process.argv.includes("--dry-run") ? "dry" : "apply";
const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** 子行展开 + 折叠状态读取的助手，插在 sessionNode 之前。 */
const HELPER = `		let vbGroupExpansion = {};
		let vbToggleChildRows = null;
		function vbChildCollapsed(id) {
			return vbGroupExpansion["session:" + id] === false;
		}
		function expandChildRows(rows, list, statuses) {
			const out = [];
			for (const row of rows) {
				const catalog = row && row.id !== void 0 ? list.projectionsBySession[row.id]?.values.subagentCatalog : void 0;
				const childCount = Array.isArray(catalog) ? catalog.length : 0;
				const expanded = !vbChildCollapsed(row.id);
				out.push(childCount > 0 ? { ...row, childCount, childExpanded: expanded } : row);
				if (childCount === 0 || !expanded) continue;
				for (const child of catalog) {
					if (!child || typeof child.id !== "string") continue;
					const summary = list.byId[child.id];
					const status = statuses.get(child.id);
					out.push({
						id: child.id,
						title: typeof child.label === "string" && child.label.length > 0 ? child.label : summary !== void 0 ? sessionTitle(summary) : child.id.slice(0, 8),
						blank: false,
						running: status?.running ?? summary?.running ?? false,
						runningSubagentCount: 0,
						completed: status?.completionUnread === true,
						pinned: false,
						archived: false,
						updatedAt: summary?.updatedAt ?? 0,
						depth: 1,
						childOf: row.id
					});
				}
			}
			return out;
		}
		`;

const CHEVRON = `						node.childCount > 0 ? (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: Rows_module_css_default.slot,
							"aria-label": "toggle child sessions",
							"aria-expanded": node.childExpanded !== false,
							onClick: (event) => {
								event.stopPropagation();
								if (vbToggleChildRows !== null) vbToggleChildRows(node.id);
							},
							children: node.childExpanded === false ? "\\u25B8" : "\\u25BE"
						}) : null,
						`;

const EDITS = [
  {
    name: "插入 expandChildRows + 折叠状态助手",
    from: "function sessionNode(s, list, statuses, pinned, archived) {",
    to: `${HELPER}function sessionNode(s, list, statuses, pinned, archived) {`,
  },
  {
    name: "分组派生：包一层 expandChildRows",
    from: "sessions: expanded ? sectionMembers(g.sessions, pinned, archived).map((session) => sessionNode(session, list, statuses, pinned, archived)) : []",
    to: "sessions: expanded ? expandChildRows(sectionMembers(g.sessions, pinned, archived).map((session) => sessionNode(session, list, statuses, pinned, archived)), list, statuses) : []",
  },
  {
    name: "扁平派生：改用 expandChildRows",
    from: "\t\t\treturn sectionMembers(sessionIds.flatMap((id) => {",
    to: "\t\t\treturn expandChildRows(sectionMembers(sessionIds.flatMap((id) => {",
  },
  {
    name: "扁平派生：补第二个/第三个参数",
    from: "}), pinned, archived).map((session) => sessionNode(session, list, statuses, pinned, archived));",
    to: "}), pinned, archived).map((session) => sessionNode(session, list, statuses, pinned, archived)), list, statuses);",
  },
  {
    name: "子行缩进（复用 --dsh-workspace-indent）",
    from: '"data-row-key": `session:${node.id}`,',
    to: '"data-row-key": `session:${node.id}`,\n\t\t\t\t\tstyle: node.depth === 1 ? { "--dsh-workspace-indent": "22px" } : void 0,',
  },
  {
    name: "子行不可拖拽",
    from: "const draggable = drag !== void 0 && !row.blank && !row.archived;",
    to: "const draggable = drag !== void 0 && !row.blank && !row.archived && row.childOf === void 0;",
  },
  {
    name: "子行不占水位线",
    from: "\t\t\tconst rows = sessions.filter((session) => {\n\t\t\t\tif (session.blank) return true;",
    to: "\t\t\tconst rows = sessions.filter((session) => {\n\t\t\t\tif (session.childOf !== void 0) return true;\n\t\t\t\tif (session.blank) return true;",
  },
  {
    name: "SessionTree 暴露折叠开关",
    from: "\t\tfunction SessionTree({ list, useSessionStatus, startSession, open, workspaces, ungroupedSessionIds, rowState, onLeaveArchivedOnly, workspaceReady, animationResetKey, usePanelInfo, onRenameRequest, onDeleteRequest, onSessionRenameRequest, renderSlot, insertWorkspaceBefore, nestWorkspaces, groupExpansion, setGroupExpanded, setSessionOrder, home, t, revealSessionId, onSessionRevealed, shortcuts }) {",
    to: "\t\tfunction SessionTree({ list, useSessionStatus, startSession, open, workspaces, ungroupedSessionIds, rowState, onLeaveArchivedOnly, workspaceReady, animationResetKey, usePanelInfo, onRenameRequest, onDeleteRequest, onSessionRenameRequest, renderSlot, insertWorkspaceBefore, nestWorkspaces, groupExpansion, setGroupExpanded, setSessionOrder, home, t, revealSessionId, onSessionRevealed, shortcuts }) {\n\t\t\tvbGroupExpansion = groupExpansion ?? {};\n\t\t\tvbToggleChildRows = (id) => {\n\t\t\t\tsetGroupExpanded(\"session:\" + id, vbChildCollapsed(id));\n\t\t\t};",
  },
  {
    name: "父行渲染 ▾/▸ 折叠按钮",
    from: '\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tref: titleRef,',
    to: `${CHEVRON}(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tref: titleRef,`,
  },
  {
    name: "折叠状态不被工作区清理掉",
    from: '\t\t\t\t\td.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)));',
    to: '\t\t\t\t\td.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion).filter(([key]) => retained.has(key) || key.startsWith("session:")));',
  },
];

if (mode === "revert") {
  if (!existsSync(BACKUP)) {
    console.error(`没有备份可还原：${BACKUP}`);
    process.exit(1);
  }
  copyFileSync(BACKUP, TARGET);
  console.log(`已还原（${path.basename(BACKUP)} → ${path.basename(TARGET)}）`);
  process.exit(0);
}

const original = readFileSync(TARGET, "utf8");
console.log(`目标：${TARGET}`);
console.log(`当前 sha256: ${sha(original)}（${original.length} 字节）`);

if (original.includes("function expandChildRows(")) {
  console.log("检测到已经打过补丁；先 --revert 再重新打。");
  process.exit(0);
}

// 源码版实现上线后，这个产物补丁就该退役了：源码构建出来的 client.js 自带
// CHILD_ROWS_KEY_PREFIX / ChildRowsToggle，再打一次 dist 补丁只会覆盖掉它。
if (original.includes("CHILD_ROWS_KEY_PREFIX") || original.includes("ChildRowsToggle")) {
  console.log("这个文件已经是「源码构建版」（含子会话行实现），不需要 dist 补丁；");
  console.log("如需回退到官方产物：node install-source-bundle.mjs --restore");
  process.exit(0);
}

let patched = original;
for (const edit of EDITS) {
  const count = patched.split(edit.from).length - 1;
  if (count !== 1) {
    console.error(`锚点数量异常（期望 1，实际 ${count}）：${edit.name}`);
    console.error(`  片段：${JSON.stringify(edit.from.slice(0, 110))}`);
    process.exit(1);
  }
  patched = patched.replace(edit.from, () => edit.to);
  console.log(`  ✓ ${edit.name}`);
}

if (mode === "dry") {
  console.log("dry-run：锚点全部匹配，未写入。");
  process.exit(0);
}

if (!existsSync(BACKUP)) {
  copyFileSync(TARGET, BACKUP);
  console.log(`已备份：${path.basename(BACKUP)}`);
}
writeFileSync(TARGET, patched, "utf8");
console.log(`已写入，新 sha256: ${sha(patched)}（${patched.length} 字节）`);
console.log("撤销：node patch-workspace-tree.mjs --revert");

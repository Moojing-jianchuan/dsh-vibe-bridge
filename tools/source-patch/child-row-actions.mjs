#!/usr/bin/env node
/**
 * 给原生侧栏的**子会话行**补两个动作：复制 session id、打开碎碎念编辑。
 *
 *   node tools/source-patch/child-row-actions.mjs [--restore]
 *
 * 为什么要单独打这个补丁：侧栏是 DSH 自己的 UI（`dsh-client-ui-workspace`），
 * 子行的 action 槽位（`sidebar.workspaces.session.childRow.action`）只注册了「归档」。
 * 本插件在自己的 bundle 里把 `openNudgeEditor` / `copyId` 挂到 `globalThis.__vibeBridge`，
 * 这里注入的两个按钮就调用那份实现，避免把逻辑抄两遍。
 *
 * 幂等：带 MARKER 的注入块已存在就跳过；`--restore` 从 `.vibe-bridge-child-actions.bak` 还原。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

const MARKER = '/* vibe-bridge: child row actions */'
const ANCHOR = `ctx.slots.inject("sidebar.workspaces.session.childRow.action", function* () {`

const args = process.argv.slice(2)
const dshModules =
  args.find((arg) => arg.startsWith('--dsh-node-modules='))?.split('=')[1] ??
  'D:/CloudMusic/resources/app/dsh/node_modules'
const target = path.join(dshModules, '@deepseek-ai/dsh-client-ui-workspace/lib/client.js')
const backup = `${target}.vibe-bridge-child-actions.bak`

if (!existsSync(target)) throw new Error(`找不到侧栏产物：${target}`)

if (args.includes('--restore')) {
  if (!existsSync(backup)) throw new Error(`没有备份：${backup}`)
  copyFileSync(backup, target)
  console.log('restored', target)
  process.exit(0)
}

const source = readFileSync(target, 'utf8')
if (source.includes(MARKER)) {
  console.log('already patched:', target)
  process.exit(0)
}

const anchorIndex = source.indexOf(ANCHOR)
if (anchorIndex < 0) throw new Error('找不到 childRow.action 注入锚点，侧栏产物版本可能变了')

// 找到这段 inject 调用的结尾（按大括号/小括号配对）
let depth = 0
let index = anchorIndex
for (; index < source.length; index += 1) {
  const char = source[index]
  if (char === '(' || char === '{') depth += 1
  if (char === ')' || char === '}') {
    depth -= 1
    if (depth === 0) break
  }
}
const insertAt = source.indexOf(';', index) + 1

const injection = `

			${MARKER}
			// 子会话行：复制 id / 碎碎念编辑。实现来自插件暴露的 globalThis.__vibeBridge，
			// 侧栏这边不重复实现剪贴板与弹窗逻辑。
			const VibeChildRowActions = (props) => {
				const sessionId = String(props?.sessionId ?? "");
				const bridge = globalThis.__vibeBridge;
				const labels = bridge?.labels ?? {};
				const style = {
					marginLeft: "4px",
					padding: "0 6px",
					fontSize: "11px",
					lineHeight: "18px",
					borderRadius: "6px",
					border: "0.5px solid var(--dsw-alias-border-l2)",
					background: "transparent",
					color: "var(--dsw-alias-label-secondary)",
					cursor: "pointer"
				};
				const button = (action, label, onClick) =>
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						"data-vibe-action": action,
						"data-session-id": sessionId,
						title: sessionId,
						style,
						onClick: (event) => {
							event.stopPropagation();
							onClick();
						},
						children: label
					}, action);
				return (0, react_jsx_runtime.jsx)("span", {
					style: { display: "inline-flex", alignItems: "center", gap: "2px" },
					children: [
						button("copy-id", labels.copy ?? "复制 id", () => {
							if (typeof bridge?.copyId === "function") void bridge.copyId(sessionId);
						}),
						button("row-nudge", labels.nudge ?? "碎碎念", () => {
							if (typeof bridge?.openNudgeEditor === "function") bridge.openNudgeEditor(sessionId);
						})
					]
				});
			};
			ctx.slots.inject("sidebar.workspaces.session.childRow.action", function* () {
				yield ctx.slots.register({
					name: "sidebar.workspaces.session.childRow.action",
					id: "vibe-child-actions",
					order: 300,
					locale: NS
				}, VibeChildRowActions);
			});
`

copyFileSync(target, backup)
const patched = `${source.slice(0, insertAt)}${injection}${source.slice(insertAt)}`
writeFileSync(target, patched, 'utf8')
console.log('patched', target)
console.log('backup', backup)
console.log('marker present:', patched.includes(MARKER), '| bytes', patched.length)

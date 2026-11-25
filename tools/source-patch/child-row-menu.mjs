#!/usr/bin/env node
/**
 * 让原生侧栏的**子会话行**拥有和父会话行一样的右键/省略号菜单
 *（里面就有原生的「复制 Session ID」和本插件的「碎碎念编辑」）。
 *
 *   node tools/source-patch/child-row-menu.mjs [--restore]
 *
 * 侧栏产物里，父行渲染 `<Menu>` + `sidebar.workspaces.session.menu.item` 槽位，
 * 子行只渲染 `sidebar.workspaces.session.childRow.action`（归档/垃圾桶）。
 * 本补丁在子行的 actions 里插入同一个 Menu（复用行组件作用域里的
 * menuOpen/setMenuOpen/menuOpenState），因此菜单项与父行完全一致。
 *
 * 幂等：带 MARKER 就跳过；`--restore` 从备份还原。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

const MARKER = '/* vibe-bridge: child row menu */'
const CHILD_ANCHOR = 'children: renderSlot("sidebar.workspaces.session.childRow.action", {'

const args = process.argv.slice(2)
const dshModules =
  args.find((arg) => arg.startsWith('--dsh-node-modules='))?.split('=')[1] ??
  'D:/CloudMusic/resources/app/dsh/node_modules'
const target = path.join(dshModules, '@deepseek-ai/dsh-client-ui-workspace/lib/client.js')
const backup = `${target}.vibe-bridge-child-menu.bak`
// 上一版（行内两个按钮）的备份：如果存在，先还原掉它，避免叠加
const legacyBackup = `${target}.vibe-bridge-child-actions.bak`

if (!existsSync(target)) throw new Error(`找不到侧栏产物：${target}`)

if (args.includes('--restore')) {
  if (!existsSync(backup)) throw new Error(`没有备份：${backup}`)
  copyFileSync(backup, target)
  console.log('restored', target)
  process.exit(0)
}

let source = readFileSync(target, 'utf8')

// 1) 撤掉旧的「行内两个按钮」注入
if (source.includes('/* vibe-bridge: child row actions */')) {
  if (!existsSync(legacyBackup)) throw new Error('发现旧按钮注入但没有备份，停下')
  source = readFileSync(legacyBackup, 'utf8')
  console.log('reverted legacy inline buttons from', legacyBackup)
}

if (source.includes(MARKER)) {
  console.log('already patched:', target)
  process.exit(0)
}

const anchorIndex = source.indexOf(CHILD_ANCHOR)
if (anchorIndex < 0) throw new Error('找不到 childRow.action 渲染锚点')

// 锚点所在表达式到下一个 `})`（renderSlot 调用结束）
const slotEnd = source.indexOf('})', anchorIndex)
if (slotEnd < 0) throw new Error('找不到 childRow.action 表达式结尾')
const insertAt = slotEnd + 2

const menuBlock = `
							children: [${MARKER}
								(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
									open: menuOpen,
									onClose: () => {
										setMenuOpen(false);
									},
									portal: true,
									closeOnPointerLeave: true,
									anchor: (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: Rows_module_css_default.iconButton,
										"aria-label": t("actions.session.aria", { name: title }),
										onClick: () => {
											setMenuOpen((v) => !v);
										},
										children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEllipsisOutlineRegular, {})
									}),
									children: renderSlot("sidebar.workspaces.session.menu.item", {
										sessionId: node.id,
										displayTitle: row.title
									}, { hookContext: menuOpenState })
								}),
								renderSlot("sidebar.workspaces.session.childRow.action", {
									sessionId: node.id,
									displayTitle: row.title
								})
							]`

// 用注入块替换原来的 `children: renderSlot(...childRow.action...)`（整段到 insertAt）
source = `${source.slice(0, anchorIndex)}${menuBlock.trimStart()}${source.slice(insertAt)}`

if (!existsSync(backup)) copyFileSync(target, backup)
writeFileSync(target, source, 'utf8')
console.log('patched', target)
console.log('backup', backup)
console.log('bytes', source.length, '| marker', source.includes(MARKER))

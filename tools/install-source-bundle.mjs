/**
 * 把「源码构建版」的 @deepseek-ai/dsh-client-ui-workspace 装进已安装的 DSH 应用。
 *
 *   node install-source-bundle.mjs            # 安装源码构建产物（源码版实现）
 *   node install-source-bundle.mjs --restore  # 还回官方产物
 *   node install-source-bundle.mjs --dry-run  # 只看会做什么
 *
 * 背景：子会话缩进行 / 折叠按钮现在是**源码修改 + 构建产物**，不再是 dist 打补丁
 * （见 patch-workspace-tree.mjs，已退役）。升级 DSH 后重跑本脚本即可。
 */
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";

const APP_NODE_MODULES = String.raw`D:\CloudMusic\resources\app\dsh\node_modules`;
const PACKAGE = path.join(APP_NODE_MODULES, "@deepseek-ai", "dsh-client-ui-workspace", "lib", "client.js");
const SOURCE_BUILD = String.raw`D:\ds_work\dsh-src\packages\client\ui-workspace\lib\client.js`;
const RESTORE_COPY = `${PACKAGE}.vibe-bridge-original.js`;

const mode = process.argv.includes("--restore")
  ? "restore"
  : process.argv.includes("--dry-run")
    ? "dry"
    : "install";

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
const hasFeature = (file) =>
  /CHILD_ROWS_KEY_PREFIX|ChildRowsToggle/.test(readFileSync(file, "utf8"));

if (!existsSync(PACKAGE)) {
  console.error(`找不到目标：${PACKAGE}`);
  process.exit(1);
}

if (mode === "restore") {
  if (!existsSync(RESTORE_COPY)) {
    console.error(`找不到官方产物备份：${RESTORE_COPY}`);
    process.exit(1);
  }
  if (mode !== "dry") copyFileSync(RESTORE_COPY, PACKAGE);
  console.log(`已还原官方产物（${sha(PACKAGE)}，${statSync(PACKAGE).size} 字节）`);
  process.exit(0);
}

if (!existsSync(SOURCE_BUILD)) {
  console.error(`找不到源码构建产物：${SOURCE_BUILD}`);
  console.error("先在源码仓库构建：cd D:\\ds_work\\dsh-src && pnpm run build:artifacts");
  process.exit(1);
}
if (!hasFeature(SOURCE_BUILD)) {
  console.error("源码构建产物里没有子会话行实现，先确认补丁已应用并重新构建。");
  process.exit(1);
}

// 第一次安装时把官方产物留一份备份，后面 --restore 用。
if (!existsSync(RESTORE_COPY) && !hasFeature(PACKAGE)) {
  if (mode !== "dry") copyFileSync(PACKAGE, RESTORE_COPY);
  console.log(`已备份官方产物 → ${path.basename(RESTORE_COPY)}（${sha(PACKAGE)}）`);
}

if (mode !== "dry") copyFileSync(SOURCE_BUILD, PACKAGE);
console.log(`${mode === "dry" ? "[dry-run] 将" : "已"}安装源码构建产物：${sha(SOURCE_BUILD)} → ${sha(PACKAGE)}`);
console.log(`大小：${statSync(PACKAGE).size} 字节；子会话行实现：${hasFeature(PACKAGE) ? "在" : "缺失"}`);
console.log("重启 DSH（或刷新页面）后生效。");

window.__ModuleLoader__.load({
	id: "dsh-vibe-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region 常量
		/** 本地化命名空间。 */
		const NS = "vibeBridge";
		/** 左侧栏入口 id，同时也是 `main` 槽位的 key。 */
		const PANEL_ID = "vibe-bridge";
		/** Host 侧 Loader entry id（配置命名空间）。 */
		const ENTRY_ID = "vibe-bridge";
		/** 从会话菜单打开调度台时记下的目标会话 id。 */
		let pendingTarget = "";
		//#endregion

		//#region locales
		/** English copy. */
		const en = {
			title: "Vibe Bridge",
			description: "Prompt nudges by turn, child sessions, and cross-session messaging.",
			active: "Active",
			rules: "Nudge rules",
			noRules: "No nudge rules configured (tools only).",
			waiting: "Configuration snapshot unavailable here; the host's current config still applies.",
			hint: "Ask the agent to call vibe_bridge_status for version and injection counts.",
			capabilities: "What this plugin adds",
			nudge: "Nudge",
			nudgeDesc: "Injects a reminder prompt at chosen turns, before the model starts thinking.",
			spawn: "Child sessions",
			spawnDesc: "Creates an independent, resumable session with its own working directory.",
			messaging: "Session messaging",
			messagingDesc: "Delivers a message to a child session or to the parent session.",
			tools: "Model tools",
			usage: "Usage",
			usageLine1: "spawn_session(prompt, label) → session id",
			usageLine2: "list_sessions() → id / label / running",
			usageLine3: "post_to_session(session_id, message) → message id",
			status: "Status line also appears in Settings → General.",
			"menu.createChild": "Create child session",
			"menu.nudgeEdit": "Edit reminders",
			usageLine4: "Ask the Agent to call vibe_bridge_status for the version and injection counts.",
			parentsTitle: "Parent and child conversations",
			parentRow: "Parent",
			childRow: "Child",
			rulesTitle: "Reminder rules in effect",
			rulesEmpty: "(no sessions yet)",
			nudgeEditorTitle: "Reminders",
			nudgeOpen: "Enable",
			nudgeOffButton: "Pause",
			nudgeEditButton: "Edit text",
			nudgeOnlyThis: "Applies to this conversation only; child sessions work the same way.",
			nudgeEffective: "In effect",
			nudgeTextSource: "Text",
			nudgeStateGlobal: "global",
			nudgeStateOff: "turned off",
			nudgeStateSparse: "sparse",
			nudgeStateFull: "full",
			nudgeEveryN: "every {n} turns",
			nudgeTextCustom: "this session's text",
			nudgeTextGlobal: "global text",
			nudgeTextCustomActive: "this session's text (active)",
			nudgeOffTextKept: "turned off — the custom text is kept and applies again once reopened",
			nudgeLoadFailed: "unavailable",
			nudgePurgeButton: "Delete everything (rules + text)",
			nudgeToggleHint:
				"Pause stops this session only and keeps every rule; Delete everything removes this session's rules and text for good.",
			ruleTemplatePlaceholder: "Add from template",
			ruleTemplate_verify: "Verify first",
			ruleTemplate_conclusion: "Conclusion first",
			ruleTemplate_danger: "No destructive commands",
			ruleNew: "New rule",
			ruleEdit: "Edit",
			ruleDelete: "Delete",
			ruleToggle: "Enable / disable",
			ruleDisabled: "disabled",
			ruleListTitle: "Rules in this session",
			ruleEmptyShort: "No rules yet",
			ruleEmptyNoInject: "No rules for this conversation (nothing is injected)",
			ruleAddDefault: "Add default rule",
			ruleExpand: "Expand",
			ruleCollapse: "Collapse",
			ruleTypeRule: "Rule",
			ruleTypeConstraint: "Constraint",
			ruleTypePreference: "Preference",
			ruleTypeConvention: "Convention",
			ruleTypeFeedback: "Feedback",
			ruleTypeLabel: "Type",
			ruleContentLabel: "Content",
			ruleStrategiesLabel: "Inject when",
			ruleInvalid: "Pick at least one strategy, keep the content non-empty and ≤ 4000 characters, and use a whole N ≥ 1.",
			rulesEmptyHint: "No rules yet — add one with “+” or pick a template.",
			strategyEveryMessage: "every message",
			strategyEveryN: "every {n} messages",
			strategyFirstMessage: "first message only",
			strategyNone: "no strategy",
			ruleCountShort: "{n} rule(s)",
			ruleEnabledShort: "{n} enabled",
			nudgeAllDisabled: "all disabled, nothing is injected",
			nudgePausedState: "this session is paused",
			nudgeNoRules: "no rules for this session (nothing is injected)",
			nudgeLegacyTextNote: "old per-session text still applies as a rule",
			close: "Close",
			settingsTitle: "Nudge schedule",
			settingsSummary: "Global turn cadence and prompt text; per-session overrides stay untouched.",
			everyTurns: "Sparse cadence (turns)",
			everyTurnsHint: "Remind every N turns. 0 = only the full pass.",
			fullEveryTurns: "Full cadence (turns)",
			fullEveryTurnsHint: "Send the full text every N turns. 0 = never.",
			fromTurn: "Start at turn",
			fromTurnHint: "First turn the schedule applies to.",
			nudgeText: "Nudge text",
			nudgeTextHint: "Empty = use the rule's file (or the bundled nudge.md).",
			skipSubagent: "Skip subagent sessions",
			skipSubagentHint: "true / false — leave empty to use the default (true).",
			speakFirstSeen: "Speak on first seen",
			speakFirstSeenHint: "true / false — inject once as soon as the plugin loads mid-session.",
			overriddenLabel: "overridden",
			resetLabel: "reset",
			invalidNumber: "Enter a number, or leave blank for the default.",
			invalidBoolean: "Enter true or false.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The Host did not accept these values; they were left for you to correct.",
			discard: "Discard",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			effective: "In effect now",
			effectiveCadence: "Cadence",
			effectiveOverrides: "Sessions with their own override",
			effectiveUnknown: "unavailable (the Host did not answer)",
			statusUnavailable: "Schedule comes from the configuration; override count unavailable.",
			console: "Dispatcher",
			consoleHint: "Pick the parent session, describe the child's job, then create. The parent session's agent calls spawn_session.",
			parent: "Parent session id",
			childLabel: "Child name",
			task: "Task for the child session",
			taskPlaceholder: "e.g. add tests for module A and report back",
			create: "Create child session",
			creating: "Creating…",
			created: "Delivered to the parent session.",
			failed: "The Host refused the prompt.",
			needBoth: "Fill in the parent session id and the task first.",
			cancel: "Cancel",
			tree: "Session tree",
			treeHint: "Parent sessions and the child sessions they spawned, mirroring the VAW console.",
			treeEmpty: "No child sessions yet. Right-click a session and pick “Create child session”.",
			treeLoading: "Loading sessions…",
			refresh: "Refresh",
			open: "Copy id",
			copyId: "Copy id",
			copied: "Copied",
			rowNudge: "Reminder",
			rowSpawn: "Spawn child",
			send: "Send",
			sendPlaceholder: "Message to this session…",
		};
		/** 中文文案。 */
		const zh = {
			title: "Vibe Bridge",
			description: "按轮次注入提示词、子会话、会话间通信。",
			active: "已激活",
			rules: "碎碎念规则",
			noRules: "未配置碎碎念规则（仅三个工具生效）。",
			waiting: "此处取不到配置快照；仍以宿主当前配置为准。",
			hint: "在对话里让 Agent 调 vibe_bridge_status 可看版本与注入次数。",
			capabilities: "这个插件带来什么",
			nudge: "碎碎念",
			nudgeDesc: "在指定轮次注入一段提醒提示词，注入点在“用户说完、模型开始想”之间。",
			spawn: "子会话",
			spawnDesc: "创建独立、可续聊的子会话，可指定自己的工作目录。",
			messaging: "会话通信",
			messagingDesc: "向子会话投递消息，子会话也能回投给父会话。",
			tools: "模型工具",
			usage: "用法",
			usageLine1: "spawn_session(prompt, label) → session id",
			usageLine2: "list_sessions() → id / label / 运行状态",
			usageLine3: "post_to_session(session_id, message) → message id",
			status: "同一状态也会出现在 设置 → 通用设置。",
			"menu.createChild": "创建子会话",
			"menu.nudgeEdit": "碎碎念编辑",
			usageLine4: "对话里让 Agent 调 vibe_bridge_status 可看版本与注入次数",
			parentsTitle: "父对话及其子对话",
			parentRow: "父对话",
			childRow: "子会话",
			rulesTitle: "碎碎念规则",
			rulesEmpty: "（还没有会话）",
			nudgeEditorTitle: "碎碎念",
			nudgeOpen: "开启注入",
			nudgeOffButton: "暂停注入",
			nudgeEditButton: "编辑",
			nudgeOnlyThis: "仅作用于本次对话；子会话同样适用。",
			nudgeEffective: "生效",
			nudgeTextSource: "文案",
			nudgeStateGlobal: "全局",
			nudgeStateOff: "已关闭",
			nudgeStateSparse: "稀疏",
			nudgeStateFull: "全量",
			nudgeEveryN: "每 {n} 轮",
			nudgeTextCustom: "本会话文案",
			nudgeTextGlobal: "全局文案",
			nudgeTextCustomActive: "本会话自定义文案（已生效）",
			nudgeOffTextKept: "已关闭 — 自定义文案已保留，重新打开即恢复生效",
			nudgeLoadFailed: "取不到",
			nudgeCadenceLabel: "每",
			nudgePurgeButton: "彻底删除（含规则与文案）",
			nudgeToggleHint: "「暂停注入」只停本会话，规则与文案都保留；「彻底删除」会把本会话的规则和文案一起抹掉。",
			ruleTemplatePlaceholder: "从模板添加",
			ruleTemplate_verify: "验证优先",
			ruleTemplate_conclusion: "先说结论",
			ruleTemplate_danger: "别用危险命令",
			ruleNew: "新建规则",
			ruleEdit: "编辑",
			ruleDelete: "删除",
			ruleToggle: "启用 / 停用",
			ruleDisabled: "已停用",
			ruleListTitle: "已设置的规则",
			ruleEmptyShort: "还没有规则",
			ruleEmptyNoInject: "本会话未配置规则（不会注入）",
			ruleAddDefault: "添加默认规则",
			ruleExpand: "展开",
			ruleCollapse: "收起",
			ruleTypeRule: "规则",
			ruleTypeConstraint: "约束",
			ruleTypePreference: "偏好",
			ruleTypeConvention: "约定",
			ruleTypeFeedback: "反馈",
			ruleTypeLabel: "类型",
			ruleContentLabel: "内容",
			ruleStrategiesLabel: "注入策略",
			ruleInvalid: "至少要选一个策略；正文不能为空且不超过 4000 字；N 必须是 ≥1 的整数。",
			rulesEmptyHint: "还没有规则，点「+」或「从模板添加」开始。",
			strategyEveryMessage: "每条消息",
			strategyEveryN: "每 {n} 条消息",
			strategyFirstMessage: "仅首条消息",
			strategyNone: "未设策略",
			ruleCountShort: "{n} 条规则",
			ruleEnabledShort: "{n} 条启用",
			nudgeAllDisabled: "全部停用，不会注入",
			nudgePausedState: "本会话已暂停注入",
			nudgeNoRules: "本会话未配置规则（不会注入）",
			nudgeLegacyTextNote: "旧版会话文案仍按规则生效",
			close: "关闭",
			settingsTitle: "碎碎念节奏",
			settingsSummary: "全局轮次节奏与文案；单个会话的覆盖不受影响。",
			everyTurns: "稀疏节奏（每 N 轮）",
			everyTurnsHint: "每 N 轮提醒一次；0 = 只发全量。",
			fullEveryTurns: "全量节奏（每 N 轮）",
			fullEveryTurnsHint: "每 N 轮发一次完整文案；0 = 永不。",
			fromTurn: "从第几轮开始",
			fromTurnHint: "节奏从这一轮开始生效。",
			nudgeText: "碎碎念文案",
			nudgeTextHint: "留空 = 用规则的文件（或包内 nudge.md）。",
			skipSubagent: "跳过子会话",
			skipSubagentHint: "true / false —— 留空表示用默认值（true）。",
			speakFirstSeen: "首次遇到就念",
			speakFirstSeenHint: "true / false —— 插件在会话中途装上时立刻念一次。",
			overriddenLabel: "已覆盖",
			resetLabel: "恢复默认",
			invalidNumber: "请填数字；留空表示使用默认值。",
			invalidBoolean: "请填 true 或 false。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "Host 没有接受这些值，已保留供你修改。",
			discard: "放弃",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			effective: "当前生效",
			effectiveCadence: "节奏",
			effectiveOverrides: "被单独覆盖的会话",
			effectiveUnknown: "取不到（Host 没有回应）",
			statusUnavailable: "节奏来自配置；覆盖数暂时读不到。",
			console: "调度台",
			consoleHint: "选父会话、写清子会话要做什么，然后创建；实际创建由父会话的 Agent 调 spawn_session 完成。",
			parent: "父会话 id",
			childLabel: "子会话名字",
			task: "子会话任务",
			taskPlaceholder: "例如：给 A 模块补测试，完成后回报结果",
			create: "创建子会话",
			creating: "创建中…",
			created: "已投递给父会话。",
			failed: "Host 拒绝了这次投递。",
			needBoth: "先填父会话 id 和任务。",
			cancel: "取消",
			tree: "会话树",
			treeHint: "父会话 + 它派生出来的子会话，对应 VAW 控制台里那种缩进列表。",
			treeEmpty: "还没有子会话。右键任一会话选「创建子会话」即可。",
			treeLoading: "正在读取会话…",
			refresh: "刷新",
			open: "复制 id",
			copyId: "复制 id",
			copied: "已复制",
			rowNudge: "碎碎念",
			rowSpawn: "建子会话",
			send: "发送",
			sendPlaceholder: "给这个会话发一句话…",
		};
		//#endregion

		//#region styles
		const page = {
			container: { height: "100%", overflowY: "auto", padding: "32px 40px 56px", boxSizing: "border-box" },
			inner: { maxWidth: "760px", margin: "0 auto" },
			head: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
			h1: { margin: "0", fontSize: "22px", lineHeight: "30px", fontWeight: "600" },
			subtitle: { marginTop: "6px", fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-secondary)" },
			badge: {
				display: "inline-flex",
				alignItems: "center",
				gap: "6px",
				fontSize: "12px",
				lineHeight: "18px",
				padding: "2px 10px",
				borderRadius: "999px",
				border: "0.5px solid var(--dsw-alias-border-l2)",
			},
			dot: { width: "6px", height: "6px", borderRadius: "999px", background: "#22c55e" },
			sectionTitle: {
				margin: "28px 0 10px",
				fontSize: "13px",
				fontWeight: "600",
				letterSpacing: "0.02em",
				color: "var(--dsw-alias-label-secondary)",
			},
			card: {
				border: "0.5px solid var(--dsw-alias-border-l2)",
				borderRadius: "12px",
				padding: "14px 16px",
				background: "var(--dsw-alias-bg-l1)",
			},
			rowTitle: { fontSize: "14px", lineHeight: "20px", fontWeight: "500" },
			rowDesc: { marginTop: "2px", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
			mono: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: "12px",
				lineHeight: "20px",
				color: "var(--dsw-alias-label-secondary)",
				whiteSpace: "pre-line",
			},
			label: { display: "block", marginTop: "12px", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
			input: {
				marginTop: "4px",
				width: "100%",
				boxSizing: "border-box",
				padding: "8px 10px",
				fontSize: "13px",
				lineHeight: "20px",
				borderRadius: "8px",
				border: "0.5px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "inherit",
				fontFamily: "inherit",
			},
			textarea: {
				marginTop: "4px",
				width: "100%",
				minHeight: "76px",
				boxSizing: "border-box",
				padding: "8px 10px",
				fontSize: "13px",
				lineHeight: "20px",
				borderRadius: "8px",
				border: "0.5px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "inherit",
				fontFamily: "inherit",
				resize: "vertical",
			},
			button: {
				marginTop: "12px",
				padding: "6px 14px",
				fontSize: "13px",
				lineHeight: "20px",
				borderRadius: "8px",
				border: "0.5px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-l2)",
				color: "inherit",
				cursor: "pointer",
				fontFamily: "inherit",
			},
			notice: { marginTop: "8px", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
			footer: { marginTop: "24px", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
		};
		//#endregion

		//#region 小工具
		/** 把一条规则渲染成一行可读摘要。 */
		function describeRule(rule) {
			const name = typeof rule.name === "string" ? rule.name : "nudge";
			const every = Number(rule.everyTurns);
			const full = Number(rule.fullEveryTurns);
			const from = Number(rule.fromTurn);
			const to = Number(rule.toTurn);
			const parts = [Number.isFinite(every) && every > 0 ? `every ${every}` : "global cadence"];
			if (Number.isFinite(full) && full > 0) parts.push(`full every ${full}`);
			if (Number.isFinite(from)) parts.push(`turn ${from}..${to > 0 ? to : "∞"}`);
			return `• ${name}: ${parts.join(", ")}`;
		}
		/** 设置卡片可编辑的顶层键（设置表单只支持单元素路径，所以节奏必须是顶层标量）。 */
		const FORM_FIELDS = ["everyTurns", "fullEveryTurns", "fromTurn", "nudgeText", "skipSubagentSessions", "speakOnFirstSeen"];
		/**
		 * 布尔字段的编辑器：`SettingsValueField` 只渲染文本框（没有开关控件），
		 * 所以这两个键也走文本，按 `true` / `false` 解析；清空 = 用默认值。
		 * @param field - 顶层键名。
		 * @returns 表单模型要的字段规格。
		 */
		function settingsBooleanField(field) {
			return {
				field,
				format: (value) => (typeof value === "boolean" ? String(value) : typeof value === "string" ? value : ""),
				parse: (text) => {
					const value = String(text ?? "").trim().toLowerCase();
					if (value === "") return { kind: "clear" };
					if (value === "true") return { kind: "set", value: true };
					if (value === "false") return { kind: "set", value: false };
					return undefined;
				},
			};
		}
		/** 共享表单外框的文案（`SettingsForm` 要求这几个键）。 */
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving"),
			};
		}
		/**
		 * 一条能力卡片。
		 * @param jsx - 单子元素构造器。
		 * @param jsxs - 多子元素构造器。
		 * @param first - 是否第一张（决定上边距）。
		 * @param title - 标题。
		 * @param desc - 描述。
		 * @returns 卡片元素。
		 */
		function capability(jsx, jsxs, first, title, desc) {
			return jsxs("div", {
				style: { ...page.card, marginTop: first ? "0" : "10px" },
				children: [
					jsx("div", { style: page.rowTitle, children: title }),
					jsx("div", { style: page.rowDesc, children: desc }),
				],
			});
		}
		/** 生成一个 requestId。 */
		function newRequestId() {
			const crypto = globalThis.crypto;
			if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
			return `vb-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		}
		//#endregion

		//#region 碎碎念编辑弹窗的状态
		/**
		 * 弹窗状态：右键「碎碎念编辑」或面板里的铅笔/新建时打开（**打开即编辑器**）。
		 * `mode`/`text` 来自宿主 `/vibe-nudge status` 的 `session:` 行。
		 */
		const nudgeEditor = {
			open: false,
			sessionId: "",
			mode: "unknown",
			text: "",
			/** 该会话已有的规则数组（保存时整体写回）。 */
			rules: [],
			/** 是否已经从宿主拉到过规则数组（菜单入口才需要异步拉）。 */
			loaded: false,
			/** 正在编辑的规则。 */
			draft: undefined,
			/** 内容/策略区是否展开（U3：默认折叠，点类型展开）。 */
			expanded: false,
			/** N 输入（字符串，便于原样展示非法值）。 */
			everyN: "3",
			template: "",
			busy: false,
			notice: "",
			error: "",
		};
		/** 状态变化的订阅者。 */
		const nudgeListeners = new Set();
		/** 合并式更新弹窗状态并通知订阅者。 */
		function setNudgeEditor(patch) {
			Object.assign(nudgeEditor, patch);
			for (const listener of nudgeListeners) listener();
		}
		/** 订阅弹窗状态。 */
		function subscribeNudgeEditor(listener) {
			nudgeListeners.add(listener);
			return () => nudgeListeners.delete(listener);
		}
		/**
		 * 复制一段文本到剪贴板：优先 Clipboard API，取不到就退回隐藏 textarea + execCommand。
		 * 面板行与原生侧栏补丁（经 `globalThis.__vibeBridge.copyId`）共用这一份实现。
		 * @param value - 要复制的文本。
		 * @returns 是否成功。
		 */
		async function copyTextToClipboard(value) {
			const text = String(value ?? "");
			if (text.length === 0) return false;
			try {
				if (typeof navigator !== "undefined" && navigator.clipboard?.writeText !== undefined) {
					await navigator.clipboard.writeText(text);
					return true;
				}
				if (typeof document !== "undefined") {
					const area = document.createElement("textarea");
					area.value = text;
					area.style.position = "fixed";
					area.style.opacity = "0";
					document.body.appendChild(area);
					area.select();
					const done = document.execCommand("copy");
					document.body.removeChild(area);
					return done !== false;
				}
			} catch (_error) {
				return false;
			}
			return false;
		}
		/**
		 * 打开弹窗（菜单项 / 面板的铅笔与「+ 新建」都走这里）：打开即编辑器。
		 * `options.rule` 给了就预填该条，否则用一条空规则；`options.rules` 是面板已拿到的规则数组。
		 * @param sessionId - 目标会话。
		 * @param options - `{ rule?, rules? }`。
		 */
		function openNudgeEditor(sessionId, options = {}) {
			const rule = options.rule;
			const rules = Array.isArray(options.rules) ? options.rules : [];
			setNudgeEditor({
				open: true,
				sessionId: typeof sessionId === "string" ? sessionId : "",
				mode: "unknown",
				text: "",
				rules,
				loaded: Array.isArray(options.rules),
				draft: rule === undefined ? emptyNudgeRule() : { ...rule, strategies: [primaryStrategy(rule)] },
				expanded: rule !== undefined,
				everyN: String(rule?.everyN ?? 3),
				template: "",
				busy: false,
				notice: "",
				error: "",
			});
		}
		//#endregion


		//#region 左侧栏图标
		/**
		 * 左侧栏图标：两个节点 + 连接线，表示“会话之间”。
		 * @param props - 侧栏给的图标尺寸。
		 * @returns 图标元素。
		 */
		function VibeBridgeIcon({ size }) {
			const jsx = react_jsx_runtime.jsx;
			const edge = typeof size === "number" && size > 0 ? size : 18;
			return jsx("svg", {
				width: edge,
				height: edge,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.6,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					jsx("circle", { cx: 5.2, cy: 12, r: 2.4 }),
					jsx("circle", { cx: 18.8, cy: 12, r: 2.4 }),
					jsx("path", { d: "M7.6 12h8.8" }),
					jsx("path", { d: "M12 9.6v4.8" }),
				],
			});
		}
		//#endregion

		//#region 会话右键菜单项
		/**
		 * 「碎碎念编辑」：记住右键点中的会话并打开编辑弹窗（子会话行同样会出现）。
		 * @param props - 行身份、菜单开关与文案。
		 * @returns 菜单项。
		 */
		function NudgeEditMenuItem(props) {
			const jsx = react_jsx_runtime.jsx;
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const [, setMenuOpen] = props.useMenuOpenState();
			return jsx(primitives.MenuItemButton, {
				icon: jsx(primitives.IconCordisPluginOutlineRegular, {}),
				onSelect: () => {
					setMenuOpen(false);
					props.openNudgeEditor(props.sessionId ?? "");
				},
				children: t("menu.nudgeEdit"),
			});
		}
		//#endregion

		//#region 创建子会话弹窗
		/**
		 * 「创建子会话」弹窗的状态：模块级 store + 订阅。
		 * 面板树头与右键菜单都通过 `openSpawn` 写它，`shell.overlay` 里的弹窗订阅它。
		 */
		const dialog = { open: false, parentId: "", label: "child", task: "", busy: false, notice: "" };
		const dialogListeners = new Set();
		/** 订阅弹窗状态变化。 @returns 取消订阅函数。 */
		const subscribeDialog = (listener) => {
			dialogListeners.add(listener);
			return () => dialogListeners.delete(listener);
		};
		/** 合并写入弹窗状态并通知订阅者。 */
		const setDialog = (patch) => {
			Object.assign(dialog, patch);
			for (const listener of dialogListeners) listener();
		};
		/**
		 * 右键菜单里点「创建子会话」后弹出的输入框：父会话已定，只填任务。
		 * @param props - 投递函数与本地化读取器。
		 * @returns 弹窗元素；未打开时为 null。
		 */
		function VibeSpawnDialog(props) {
			const jsx = react_jsx_runtime.jsx;
			const jsxs = react_jsx_runtime.jsxs;
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const [, force] = react.useState(0);
			react.useEffect(() => subscribeDialog(() => force((value) => value + 1)), []);
			if (!dialog.open) return null;
			const submit = async () => {
				if (dialog.busy) return;
				if (dialog.task.trim().length === 0) {
					setDialog({ notice: t("needBoth") });
					return;
				}
				setDialog({ busy: true, notice: t("creating") });
				try {
					// 直接走宿主命令建子会话：不再等父会话的模型轮次。
					const report = await props.createChild(dialog.parentId, dialog.label.trim() || "child", dialog.task.trim());
					const id = /session started: (\S+)/.exec(report ?? "")?.[1];
					setDialog({
						open: id === undefined,
						busy: false,
						task: "",
						notice: id === undefined ? t("created") : `${t("created")} ${id}`,
					});
				} catch (error) {
					// 把 Host 的真实拒绝原因显示出来，别只写“失败了”。
					const reason = error && error.message ? String(error.message) : String(error);
					setDialog({ busy: false, notice: `${t("failed")} ${reason}` });
				}
			};
			return jsx("div", {
				style: {
					position: "fixed",
					inset: "0",
					background: "rgba(0,0,0,.32)",
					display: "grid",
					placeItems: "center",
					zIndex: 1000,
				},
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) setDialog({ open: false });
				},
				children: jsxs("div", {
					role: "dialog",
					"aria-modal": "true",
					style: {
						width: "460px",
						maxWidth: "90vw",
						background: "var(--dsw-alias-bg-l1, #ffffff)",
						borderRadius: "14px",
						border: "0.5px solid var(--dsw-alias-border-l2)",
						padding: "18px 20px",
						boxShadow: "0 12px 40px rgba(0,0,0,.18)",
					},
					children: [
						jsx("div", { style: { fontSize: "15px", fontWeight: 600, lineHeight: "22px" }, children: t("menu.createChild") }),
						jsx("div", { style: page.rowDesc, children: t("consoleHint") }),
						jsx("label", { style: page.label, children: t("parent") }),
						jsx("div", { style: { ...page.mono, marginTop: "2px" }, children: dialog.parentId.length > 0 ? dialog.parentId : "-" }),
						jsx("label", { style: page.label, children: t("childLabel") }),
						jsx("input", {
							style: page.input,
							value: dialog.label,
							placeholder: "child",
							onChange: (event) => setDialog({ label: event.target.value }),
						}),
						jsx("label", { style: page.label, children: t("task") }),
						jsx("textarea", {
							style: page.textarea,
							value: dialog.task,
							placeholder: t("taskPlaceholder"),
							autoFocus: true,
							onChange: (event) => setDialog({ task: event.target.value }),
							onKeyDown: (event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									void submit();
								}
							},
						}),
						dialog.notice.length > 0 ? jsx("div", { style: page.notice, children: dialog.notice }) : null,
						jsxs("div", {
							style: { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "14px" },
							children: [
								jsx("button", {
									type: "button",
									style: { ...page.button, marginTop: 0 },
									onClick: () => setDialog({ open: false }),
									children: t("cancel"),
								}),
								jsx("button", {
									type: "button",
									style: { ...page.button, marginTop: 0 },
									disabled: dialog.busy,
									onClick: () => void submit(),
									children: dialog.busy ? t("creating") : t("create"),
								}),
							],
						}),
					],
				}),
			});
		}
		//#endregion

		//#region 碎碎念编辑弹窗（单条规则编辑器）
		/**
		 * 内置模板：选中后填进编辑器（用户可改再保存）。
		 * `type` / `strategies` 与宿主的校验枚举一致。
		 */
		const NUDGE_TEMPLATES = [
			{
				key: "verify",
				type: "rule",
				content: "先验证再下结论：任何「已完成」都要有可复现的证据（命令输出、测试结果）。",
				strategy: "every-message",
			},
			{
				key: "conclusion",
				type: "preference",
				content: "回答先说结论，再给理由与证据。",
				strategy: "first-message",
			},
			{
				key: "danger",
				type: "constraint",
				content: "不要执行破坏性命令（rm -rf、git reset --hard、强制推送）。",
				strategy: "every-message",
			},
		];
		/** 规则类型 → locale key。 */
		const RULE_TYPE_LABEL_KEYS = {
			rule: "ruleTypeRule",
			constraint: "ruleTypeConstraint",
			preference: "ruleTypePreference",
			convention: "ruleTypeConvention",
			feedback: "ruleTypeFeedback",
		};
		/** 一条空规则（新建时用）。 */
		function emptyNudgeRule() {
			const stamp = Date.now().toString(36);
			const random = Math.random().toString(36).slice(2, 6);
			return {
				id: `r-${stamp}${random}`,
				type: "rule",
				content: "",
				strategies: ["every-message"],
				everyN: 3,
				enabled: true,
			};
		}
		/** 历史数据可能是多值策略：取第一个（UI 已是单选）。 */
		function primaryStrategy(rule) {
			const list = Array.isArray(rule?.strategies) ? rule.strategies : [];
			return list.length > 0 ? list[0] : "every-message";
		}
		/** 内容前 N 字摘要（列表里用）。 */
		function previewOf(content, limit) {
			const text = typeof content === "string" ? content.replace(/\s+/g, " ").trim() : "";
			return text.length > limit ? `${text.slice(0, limit)}…` : text;
		}
		/** 单条规则的策略摘要（单选后就是一句）。 */
		function strategySummary(rule, t) {
			const strategy = primaryStrategy(rule);
			if (strategy === "every-n") return t("strategyEveryN").replace("{n}", String(rule.everyN ?? 3));
			if (strategy === "first-message") return t("strategyFirstMessage");
			return t("strategyEveryMessage");
		}
		/**
		 * 右键菜单 / 面板「铅笔」打开的弹窗：**打开即编辑器**（一次编辑一条规则）。
		 *
		 * 只作用于当前会话（子会话同样适用）；保存时整体写回该会话的规则数组
		 * （`/vibe-nudge rules:<base64>`），客户端不读也不写 `rules.json`。
		 * @param props - 本地化读取器、规则读写、会话级开关与命令投递。
		 * @returns 弹窗元素；未打开时为 null。
		 */
		function NudgeEditorDialog(props) {
			const jsx = react_jsx_runtime.jsx;
			const jsxs = react_jsx_runtime.jsxs;
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const [, force] = react.useState(0);
			react.useEffect(() => subscribeNudgeEditor(() => force((value) => value + 1)), []);
			const sessionId = nudgeEditor.sessionId;
			const close = () => setNudgeEditor({ open: false, draft: undefined, error: "" });
			const run = async (action) => {
				if (nudgeEditor.busy) return;
				setNudgeEditor({ busy: true, error: "" });
				try {
					await action();
					if (typeof props.nudgeLoad === "function") await props.nudgeLoad(sessionId);
				} catch (error) {
					setNudgeEditor({ error: error && error.message ? String(error.message) : String(error) });
				}
				setNudgeEditor({ busy: false });
			};
			// 打开时（菜单入口只给了 sessionId）补一次状态与规则数组。
			// 注意：这个 effect 必须排在 `return null` 之前 —— 否则关闭/打开会让 hook 数量变化，
			// React 会抛 #310（Rendered more hooks than during the previous render）。
			react.useEffect(() => {
				if (!nudgeEditor.open || nudgeEditor.loaded) return;
				void (async () => {
					let list = [];
					try {
						list = typeof props.nudgeLoadRules === "function" ? await props.nudgeLoadRules(sessionId) : [];
					} catch (_error) {
						list = [];
					}
					setNudgeEditor({ rules: Array.isArray(list) ? list : [], loaded: true });
					if (typeof props.nudgeLoad === "function") await props.nudgeLoad(sessionId);
				})();
			}, [nudgeEditor.open, sessionId, nudgeEditor.loaded]);
			if (!nudgeEditor.open) return null;
			// 宿主/旧状态可能给不出数组：统一走局部 rules，避免渲染时 rules.length 抛错把槽位打空。
			const rules = Array.isArray(nudgeEditor.rules) ? nudgeEditor.rules : [];
			const current = nudgeEditor.draft ?? emptyNudgeRule();
			const strategy = primaryStrategy(current);
			const everyRaw = String(nudgeEditor.everyN ?? "").trim();
			const everyN = Number(everyRaw);
			const everyValid = everyRaw.length > 0 && Number.isInteger(everyN) && everyN >= 1;
			const contentValid = current.content.trim().length > 0 && current.content.length <= 4000;
			const draftValid = contentValid && (strategy !== "every-n" || everyValid);
			const stateLine = (() => {
				if (nudgeEditor.mode === "unknown") return `${t("nudgeEffective")}：${t("nudgeLoadFailed")}`;
				// 全局模型已删除：这里只描述**本会话**。规则是唯一注入源，没有规则就不会注入。
				const enabledCount = rules.filter((rule) => rule.enabled !== false).length;
				if (nudgeEditor.mode === "off") {
				// 暂停时如果还有旧版会话文案，明确说它没丢（上一轮缺陷 2/4 的观感要求）。
				const paused = `${t("nudgeEffective")}：${t("nudgePausedState")}`;
				return nudgeEditor.text.length > 0 ? `${paused} · ${t("nudgeLegacyTextNote")}` : paused;
			}
				if (rules.length === 0) return `${t("nudgeEffective")}：${t("nudgeNoRules")}`;
				// 全部停用也要说清"不会注入"，否则用户以为还有东西在跑。
			if (enabledCount === 0) {
				return `${t("nudgeEffective")}：${t("ruleCountShort").replace("{n}", String(rules.length))}（${t("nudgeAllDisabled")}）`;
			}
			const head = `${t("nudgeEffective")}：${t("ruleCountShort").replace("{n}", String(rules.length))}（${t("ruleEnabledShort").replace("{n}", String(enabledCount))}）`;
				// 旧 nudges.json 的 text 仍按虚拟规则参与注入：单独说明来源，别让人以为是"全局文案"。
				return nudgeEditor.text.length > 0 ? `${head} · ${t("nudgeLegacyTextNote")}` : head;
			})();
			const pill = (active, extra) => ({
				...page.button,
				marginTop: 0,
				padding: "2px 10px",
				fontSize: "12px",
				fontWeight: active ? 600 : 400,
				borderColor: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-border-l2)",
				...extra,
			});
			/** 保存：把这条规则写回数组（新增或替换），然后整体提交。 */
			const saveDraft = () => {
				if (!draftValid) return;
				const rule = {
					...current,
					// 单选存储：永远是单元素数组（历史多值在这里被归一）。
					strategies: [strategy],
					everyN: strategy === "every-n" ? everyN : current.everyN ?? 3,
					updatedAt: new Date().toISOString(),
				};
				const exists = rules.some((entry) => entry.id === rule.id);
				const next = exists
					? rules.map((entry) => (entry.id === rule.id ? rule : entry))
					: [...rules, rule];
				void run(async () => {
					await props.nudgeSaveRules(sessionId, next);
					setNudgeEditor({ rules: next, draft: undefined });
				});
			};
			return jsx("div", {
				style: { position: "fixed", inset: "0", background: "rgba(0,0,0,.32)", display: "grid", placeItems: "center", zIndex: 1000 },
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) close();
				},
				onKeyDown: (event) => {
					if (event.key === "Escape") close();
				},
				children: jsxs("div", {
					role: "dialog",
					"aria-modal": "true",
					style: {
						width: "520px",
						maxWidth: "92vw",
						maxHeight: "86vh",
						overflowY: "auto",
						background: "var(--dsw-alias-bg-l1, #ffffff)",
						borderRadius: "14px",
						border: "0.5px solid var(--dsw-alias-border-l2)",
						padding: "18px 20px",
						boxShadow: "0 12px 40px rgba(0,0,0,.18)",
					},
					children: [
						jsxs("div", {
							style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
							children: [
								jsx("div", {
									style: { fontSize: "15px", fontWeight: 600, lineHeight: "22px" },
									children: `${t("nudgeEditorTitle")} · ${String(sessionId).slice(0, 8)}`,
								}),
								jsx("button", {
									type: "button",
									"aria-label": t("close"),
									style: { ...page.button, marginTop: 0, padding: "0 8px" },
									onClick: close,
									children: "✕",
								}),
							],
						}),
						jsx("div", { style: { ...page.mono, marginTop: "8px" }, children: stateLine }),
						// ---- 会话级：打开 / 关闭 / 清除 ----
						jsxs("div", {
							style: { display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" },
							children: [
								jsx("button", {
									type: "button",
									"data-action": "open",
									style: { ...page.button, marginTop: 0 },
									disabled: nudgeEditor.busy,
									onClick: () => void run(() => props.nudgeSet(sessionId, "on")),
									children: t("nudgeOpen"),
								}),
								jsx("button", {
									type: "button",
									"data-action": "off",
									style: { ...page.button, marginTop: 0 },
									disabled: nudgeEditor.busy,
									onClick: () => void run(() => props.nudgeSet(sessionId, "off")),
									children: t("nudgeOffButton"),
								}),
								jsx("button", {
									type: "button",
									"data-action": "purge",
									style: { ...page.button, marginTop: 0 },
									disabled: nudgeEditor.busy,
									onClick: () => void run(() => props.nudgeSet(sessionId, "purge")),
									children: t("nudgePurgeButton"),
								}),
							],
						}),
						jsx("div", { style: { ...page.rowDesc, marginTop: "4px", fontSize: "11px" }, children: t("nudgeToggleHint") }),
						// ---- F1：已设置的规则（先看到“有什么”，而不是铺满表单）----
						jsx("div", {
							style: { marginTop: "12px", paddingTop: "10px", borderTop: "0.5px solid var(--dsw-alias-border-l2)" },
							children: jsxs("div", {
								children: [
									jsxs("div", {
										style: { display: "flex", alignItems: "center", gap: "8px" },
										children: [
											jsx("div", { style: page.label, children: `${t("ruleListTitle")}（${rules.length}）` }),
											jsx("button", {
												type: "button",
												"data-action": "default-rule",
												style: { ...page.button, marginTop: 0, padding: "0 8px", fontSize: "11px" },
												disabled: nudgeEditor.busy,
												onClick: () =>
													void run(async () => {
														const list = await props.nudgeAddDefaultRule(sessionId);
														setNudgeEditor({ rules: Array.isArray(list) ? list : nudgeEditor.rules });
													}),
												children: t("ruleAddDefault"),
											}),
										],
									}),
									rules.length === 0
										? jsx("div", { style: { ...page.rowDesc, marginTop: "6px" }, children: t("ruleEmptyShort") })
										: jsx("div", {
												style: { marginTop: "6px", display: "flex", flexDirection: "column", gap: "6px" },
												children: rules.map((rule, index) =>
													jsxs("div", {
														"data-rule-id": rule.id,
														style: {
															...page.card,
															display: "flex",
															alignItems: "flex-start",
															gap: "8px",
															padding: "6px 8px",
															opacity: rule.enabled === false ? 0.55 : 1,
														},
														// 注意：`jsxs(type, props, key)` 的第三个参数是 key，
														// children 必须放进 props，否则渲染成空卡片（真机上就是一个空白条）。
														children: [
															jsxs("div", {
																style: { flex: "1 1 auto", minWidth: 0, cursor: "pointer" },
																// 点整条 → 把这条填进上方表单
																onClick: () => setNudgeEditor({ draft: { ...rule, strategies: [primaryStrategy(rule)] }, everyN: String(rule.everyN ?? 3), expanded: true }),
																children: [
																	jsx("span", { style: { ...page.rowDesc, fontSize: "11px", minWidth: "18px" }, "data-role": "rule-index", children: `${index + 1}.` }),
																	jsx("span", { style: { ...page.badge, fontSize: "11px", padding: "0 6px" }, children: t(RULE_TYPE_LABEL_KEYS[rule.type] ?? "ruleTypeRule") }),
																	jsx("span", { style: { ...page.rowTitle, marginLeft: "6px", fontSize: "12px" }, children: previewOf(rule.content, 40) }),
																	jsx("div", { style: { ...page.rowDesc, fontSize: "11px" }, children: strategySummary(rule, t) }),
																],
															}),
															jsxs("div", {
																style: { display: "flex", gap: "2px", flex: "0 0 auto" },
																children: [
																	jsx("button", {
																		type: "button",
																		"data-action": "rule-toggle",
																		title: t("ruleToggle"),
																		style: { ...page.button, marginTop: 0, padding: "0 5px", fontSize: "12px" },
																		onClick: () =>
																			void run(() =>
																				props.nudgeSaveRules(
																					sessionId,
																					rules.map((entry) =>
																						entry.id === rule.id ? { ...entry, enabled: entry.enabled === false } : entry,
																					),
																				).then((saved) => setNudgeEditor({ rules: Array.isArray(saved) ? saved : rules })),
																			),
																		children: rule.enabled === false ? "○" : "●",
																	}),
																	jsx("button", {
																		type: "button",
																		"data-action": "rule-edit",
																		title: t("ruleEdit"),
																		style: { ...page.button, marginTop: 0, padding: "0 5px", fontSize: "12px" },
																		onClick: () =>
																			setNudgeEditor({ draft: { ...rule, strategies: [primaryStrategy(rule)] }, everyN: String(rule.everyN ?? 3), expanded: true }),
																		children: "✎",
																	}),
																	jsx("button", {
																		type: "button",
																		"data-action": "rule-delete",
																		title: t("ruleDelete"),
																		style: { ...page.button, marginTop: 0, padding: "0 5px", fontSize: "12px" },
																		onClick: () =>
																			void run(() =>
																				props
																					.nudgeSaveRules(
																						sessionId,
																						rules.filter((entry) => entry.id !== rule.id),
																					)
																					.then((saved) => setNudgeEditor({ rules: Array.isArray(saved) ? saved : rules })),
																			),
																		children: "🗑",
																	}),
																],
															}),
														],
													}),
												),
											}),
								],
							}),
						}),
						// ---- 编辑器：类型胶囊常驻；内容/策略默认折叠（U3）----
						jsxs("div", {
							style: { marginTop: "12px", paddingTop: "10px", borderTop: "0.5px solid var(--dsw-alias-border-l2)" },
							children: [
								jsxs("div", {
									style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
									children: [
										jsx("div", { style: page.label, children: t("ruleTypeLabel") }),
										jsx("button", {
											type: "button",
											"data-action": "toggle-expand",
											"aria-expanded": nudgeEditor.expanded ? "true" : "false",
											style: { ...page.button, marginTop: 0, padding: "0 8px", fontSize: "11px" },
											onClick: () => setNudgeEditor({ expanded: !nudgeEditor.expanded }),
											children: nudgeEditor.expanded ? t("ruleCollapse") : t("ruleExpand"),
										}),
									],
								}),
								jsx("div", {
									style: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "4px" },
									children: ["rule", "constraint", "preference", "convention", "feedback"].map((type) =>
										jsx(
											"button",
											{
												type: "button",
												"data-type": type,
												style: pill(current.type === type),
												// 点类型：选中并展开；再点同一个类型 → 收起
												onClick: () =>
													setNudgeEditor({
														draft: { ...current, type },
														expanded: current.type === type ? !nudgeEditor.expanded : true,
													}),
												children: t(RULE_TYPE_LABEL_KEYS[type]),
											},
											type,
										),
									),
								}),
								nudgeEditor.expanded
									? jsxs("div", {
											"data-role": "editor-body",
											children: [
												jsx("div", { style: { ...page.label, marginTop: "10px" }, children: t("ruleContentLabel") }),
												jsx("textarea", {
													"data-role": "rule-content",
													style: page.textarea,
													value: current.content,
													onChange: (event) => setNudgeEditor({ draft: { ...current, content: event.target.value } }),
												}),
												jsx("div", {
													style: { ...page.rowDesc, textAlign: "right", color: current.content.length > 4000 ? "#dc2626" : undefined },
													children: `${current.content.length}/4000`,
												}),
												jsx("div", { style: { ...page.label, marginTop: "6px" }, children: t("ruleStrategiesLabel") }),
												jsxs("div", {
													style: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "4px" },
													children: [
														jsx("button", {
															type: "button",
															"data-strategy": "every-message",
															"aria-pressed": strategy === "every-message",
															style: pill(strategy === "every-message"),
															onClick: () => setNudgeEditor({ draft: { ...current, strategies: ["every-message"] } }),
															children: t("strategyEveryMessage"),
														}),
														jsx("button", {
															type: "button",
															"data-strategy": "every-n",
															"aria-pressed": strategy === "every-n",
															style: pill(strategy === "every-n"),
															onClick: () =>
																setNudgeEditor({ draft: { ...current, strategies: ["every-n"] }, everyN: String(current.everyN ?? 3) }),
															children: t("strategyEveryN").replace("{n}", everyRaw.length > 0 ? everyRaw : "3"),
														}),
														jsx("button", {
															type: "button",
															"data-strategy": "first-message",
															"aria-pressed": strategy === "first-message",
															style: pill(strategy === "first-message"),
															onClick: () => setNudgeEditor({ draft: { ...current, strategies: ["first-message"] } }),
															children: t("strategyFirstMessage"),
														}),
														strategy === "every-n"
															? jsx("input", {
																	type: "number",
																	"data-role": "rule-every-n",
																	min: 1,
																	style: {
																		...page.input,
																		marginTop: 0,
																		width: "64px",
																		padding: "2px 6px",
																		borderColor: everyValid ? "var(--dsw-alias-border-l2)" : "#dc2626",
																	},
																	value: everyRaw,
																	onChange: (event) => setNudgeEditor({ everyN: event.target.value }),
																})
															: null,
													],
												}),
												jsxs("div", {
													style: { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "10px" },
													children: [
														jsx("button", {
															type: "button",
															style: { ...page.button, marginTop: 0 },
															onClick: close,
															children: t("cancel"),
														}),
														jsx("button", {
															type: "button",
															"data-action": "save-rule",
															style: { ...page.button, marginTop: 0 },
															disabled: !draftValid || nudgeEditor.busy,
															onClick: saveDraft,
															children: nudgeEditor.busy ? t("saving") : t("save"),
														}),
													],
												}),
											],
										})
									: null,
							],
						}),
						nudgeEditor.error.length > 0 ? jsx("div", { style: { ...page.notice, color: "#dc2626" }, children: nudgeEditor.error }) : null,
						// ---- U4 + U5：校验提示与“仅作用于本次对话”合并成底部一行 ----
						jsx("div", {
							"data-role": "footer-note",
							style: { ...page.notice, marginTop: "10px", color: draftValid ? undefined : "#dc2626" },
							children: `${t("ruleInvalid")} ${t("nudgeOnlyThis")}`,
						}),

					],
				}),
			});
		}
		//#endregion

		//#endregion

		/**
		 * Vibe Bridge 主页面（左侧栏入口打开的就是它）。
		 *
		 * 自上而下：标题 + 用法说明 → 父对话及其子对话（只读展示）→ 会话树（创建/刷新 + 每行投递）
		 * → 这个插件带来什么（一段文字）→ 碎碎念规则（逐会话实际生效配置）。
		 * @param props - 本地化读取器、会话列表、投递与弹窗入口、逐会话碎碎念状态。
		 * @returns 页面元素。
		 */
		function VibeBridgePage(props) {
			const jsx = react_jsx_runtime.jsx;
			const jsxs = react_jsx_runtime.jsxs;
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const [tree, setTree] = react.useState({ phase: "loading", items: [], error: "" });
			const [drafts, setDrafts] = react.useState({});
			const [nudges, setNudges] = react.useState(null);
			/** 规则列表：按“当前查看的会话”展示（父/子各自一套）。 */
			const [rulesState, setRulesState] = react.useState({ sessionId: "", list: [] });
			/** 刚复制过的会话 id（按钮上短暂显示“已复制”）。 */
			const [copiedId, setCopiedId] = react.useState("");
			/**
			 * 复制会话 id：优先用剪贴板 API，取不到就退回隐藏 textarea + execCommand。
			 * 面板里每行都有这个按钮——子会话"操作不了"首先就是拿不到 id。
			 */
			const copySessionId = async (sessionId) => {
				const ok = await copyTextToClipboard(sessionId);
				setCopiedId(ok ? String(sessionId) : "");
			};;
			/** 测试/预览可以直接喂 props.rulesList，省掉一次异步拉取。 */
			const rulesView = Array.isArray(props.rulesList)
				? { sessionId: props.rulesSessionId ?? "", list: props.rulesList }
				: rulesState;
			const setRulesView = (patch) => setRulesState(patch);
			/** 把规则数组整体写回宿主，成功后刷新本地列表。 */
			const persistRuleList = async (list) => {
				const sessionId = rulesSessionId;
				if (sessionId.length === 0) return;
				try {
					await props.nudgeSaveRules(sessionId, list);
					setRulesState({ sessionId, list });
				} catch (error) {
					setTree((prev) => ({ ...prev, error: String(error?.message ?? error) }));
				}
			};
			const loadTree = async () => {
				setTree((prev) => ({ ...prev, phase: "loading" }));
				try {
					const value = await props.listSessions();
					setTree({ phase: "ready", items: Array.isArray(value?.items) ? value.items : [], error: "" });
				} catch (error) {
					setTree({ phase: "error", items: [], error: String(error?.message ?? error) });
				}
			};
			react.useEffect(() => {
				void loadTree();
			}, []);
			/** 子会话标题：优先 projections 里的标题，其次 id 前 8 位。 */
			const titleOf = (item) => {
				const projection = item?.projections;
				const candidates = [projection?.sessionTitle?.title, projection?.sessionTitle, projection?.title];
				for (const candidate of candidates) {
					if (typeof candidate === "string" && candidate.length > 0) return candidate;
				}
				return String(item?.sessionId ?? "").slice(0, 8);
			};
			// 允许直接喂数据（测试/预览）：不传时用 loadTree 拉到的列表。
			const items = Array.isArray(props.sessions) ? props.sessions : tree.items;
			/** 按父会话分组：父会话本身 + 它的子会话（来自 subagentCatalog 投影）。 */
			const groups = [];
			{
				for (const item of items) {
					const catalog = item?.projections?.subagentCatalog;
					if (!Array.isArray(catalog) || catalog.length === 0) continue;
					const children = catalog
						.map((entry) => ({
							sessionId: entry?.id ?? entry?.sessionId,
							label: typeof entry?.label === "string" ? entry.label : "",
							task: typeof entry?.task === "string" ? entry.task : typeof entry?.prompt === "string" ? entry.prompt : "",
							running: entry?.running === true,
						}))
						.filter((entry) => typeof entry.sessionId === "string" && entry.sessionId.length > 0);
					if (children.length > 0) groups.push({ parentId: item.sessionId, parentTitle: titleOf(item), children });
				}
				groups.sort((left, right) => (left.parentId < right.parentId ? -1 : 1));
			}
			// 逐会话碎碎念：优先吃 props（测试/预览），否则用加载到的状态。
			/** 规则列表的会话下拉：父对话 + 各自的子会话。 */
			const sessionChoices = [];
			for (const group of groups) {
				sessionChoices.push({ kind: "parent", sessionId: group.parentId });
				for (const child of group.children) sessionChoices.push({ kind: "child", sessionId: child.sessionId });
			}
			/** 当前查看规则的会话：默认第一个父对话。 */
			const rulesSessionId = rulesView.sessionId.length > 0 ? rulesView.sessionId : sessionChoices[0]?.sessionId ?? "";
			const nudgeRows = Array.isArray(props.nudgeRows) ? props.nudgeRows : Array.isArray(nudges) ? nudges : [];
			react.useEffect(() => {
				if (typeof props.refreshNudgeRows !== "function") return;
				const entries = [];
				for (const group of groups) {
					entries.push({ kind: "parent", sessionId: group.parentId });
					for (const child of group.children) entries.push({ kind: "child", sessionId: child.sessionId });
				}
				void props.refreshNudgeRows(entries).then((rows) => {
					if (Array.isArray(rows)) setNudges(rows);
				});
			}, []);
			/** 一行“本会话规则 / 模式”：`3 条规则` / `已关闭` / `未配置规则`。 */
			const modeLine = (row) => {
				const rules = Number.isFinite(Number(row.rules)) ? Number(row.rules) : 0;
				if (row.mode === "off") return t("nudgeStateOff");
				if (rules === 0) return t("ruleEmptyNoInject");
				return `${t("ruleCountShort").replace("{n}", String(rules))}`;
			};
			const sendToChild = async (parent, childId) => {
				const text = (drafts[childId] ?? "").trim();
				if (text.length === 0) return;
				try {
					await props.sendToSession(parent, childId, text);
					setDrafts((prev) => ({ ...prev, [childId]: "" }));
				} catch (error) {
					setTree((prev) => ({ ...prev, error: String(error?.message ?? error) }));
				}
			};
			const firstParent = groups.length > 0 ? groups[0].parentId : "";
			return jsx("div", {
				style: page.container,
				children: jsxs("div", {
					style: page.inner,
					children: [
						jsxs("div", {
							style: page.head,
							children: [
								jsx("h1", { style: page.h1, children: t("title") }),
								jsxs("span", {
									style: page.badge,
									children: [jsx("span", { style: page.dot }), jsx("span", { children: t("active") })],
								}),
							],
						}),
						jsx("div", { style: page.subtitle, children: t("description") }),
						// 原有「用法」区块并入描述：一行一句
						jsx("div", {
							style: { ...page.mono, marginTop: "8px" },
							children: [t("usageLine1"), t("usageLine2"), t("usageLine3"), t("usageLine4")].join("\n"),
						}),
						// ---- 父对话及其子对话 ----
						jsx("div", { style: page.sectionTitle, children: t("parentsTitle") }),
						jsx("div", {
							style: page.card,
							children:
								tree.error.length > 0
									? jsx("div", { style: page.notice, children: tree.error })
									: groups.length === 0 && tree.phase === "ready"
										? jsx("div", { style: page.mono, children: t("treeEmpty") })
										: jsx("div", {
												children: groups.map((group) =>
													jsxs("div", {
														style: { marginTop: "10px" },
														children: [
															jsx("div", {
																style: { ...page.mono, color: "var(--dsw-alias-label-primary)" },
																children: [
																	jsx("span", {
																		children: `${t("parentRow")} ${String(group.parentId).slice(0, 8)} · ${group.parentTitle}`,
																	}),
																	jsx("button", {
																		type: "button",
																		"data-action": "copy-id",
																		"data-session-id": group.parentId,
																		title: group.parentId,
																		style: { ...page.button, marginTop: 0, marginLeft: "6px", padding: "0 6px", fontSize: "11px" },
																		onClick: () => void copySessionId(group.parentId),
																		children: copiedId === group.parentId ? t("copied") : t("copyId"),
																	}),
																],
															}),
															...group.children.map((child) =>
																jsx("div", {
																	"data-role": "child-row",
																	style: { ...page.mono, paddingLeft: "18px", marginTop: "4px" },
																	children: [
																		jsx("span", {
																			children:
																				`${t("childRow")} ${String(child.sessionId).slice(0, 8)} · ${child.label || "-"}` +
																				(child.task.length > 0 ? ` · ${child.task.slice(0, 40)}` : ""),
																		}),
																		// 每行的动作：拿 id / 编辑它的碎碎念 / 以它为父再建一个。
																		jsx("button", {
																			type: "button",
																			"data-action": "copy-id",
																			"data-session-id": child.sessionId,
																			title: child.sessionId,
																			style: { ...page.button, marginTop: 0, marginLeft: "6px", padding: "0 6px", fontSize: "11px" },
																			onClick: () => void copySessionId(child.sessionId),
																			children: copiedId === child.sessionId ? t("copied") : t("copyId"),
																		}),
																		jsx("button", {
																			type: "button",
																			"data-action": "row-nudge",
																			"data-session-id": child.sessionId,
																			style: { ...page.button, marginTop: 0, marginLeft: "4px", padding: "0 6px", fontSize: "11px" },
																			onClick: () => props.openNudgeEditor?.(child.sessionId),
																			children: t("rowNudge"),
																		}),
																		jsx("button", {
																			type: "button",
																			"data-action": "row-spawn",
																			"data-session-id": child.sessionId,
																			style: { ...page.button, marginTop: 0, marginLeft: "4px", padding: "0 6px", fontSize: "11px" },
																			onClick: () => props.openSpawn?.(child.sessionId),
																			children: t("rowSpawn"),
																		}),
																	],
																}),
															),
														],
													}),
												),
											}),
						}),
						// ---- 会话树：创建入口与刷新都挪到这里 ----
						jsxs("div", {
							style: { ...page.sectionTitle, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
							children: [
								jsx("span", { children: t("tree") }),
								jsxs("span", {
									style: { display: "flex", gap: "8px" },
									children: [
										jsx("button", {
											type: "button",
											"data-action": "create-child",
											style: { ...page.button, marginTop: 0, padding: "3px 10px", fontSize: "12px" },
											onClick: () => props.openSpawn?.(firstParent),
											children: t("create"),
										}),
										jsx("button", {
											type: "button",
											style: { ...page.button, marginTop: 0, padding: "3px 10px", fontSize: "12px" },
											onClick: () => void loadTree(),
											children: t("refresh"),
										}),
									],
								}),
							],
						}),
						jsxs("div", {
							style: page.card,
							children: [
								jsx("div", { style: page.rowDesc, children: t("treeHint") }),
								tree.phase === "loading" ? jsx("div", { style: page.mono, children: t("treeLoading") }) : null,
								tree.error.length > 0 ? jsx("div", { style: page.notice, children: tree.error }) : null,
								tree.phase === "ready" && groups.length === 0
									? jsx("div", { style: { ...page.mono, marginTop: "8px" }, children: t("treeEmpty") })
									: null,
								...groups.map((group) =>
									jsxs(
										"div",
										{
											style: { marginTop: "12px" },
											children: [
												jsxs("div", {
													style: { ...page.mono, color: "var(--dsw-alias-label-primary)" },
													children: [`▾ ${String(group.parentId).slice(0, 12)}…`, ` (${group.children.length})`],
												}),
												...group.children.map((child) =>
													jsxs(
														"div",
														{
															style: { marginTop: "6px", paddingLeft: "18px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
															children: [
																jsx("span", {
																	style: {
																		width: "6px",
																		height: "6px",
																		borderRadius: "999px",
																		background: child.running ? "#22c55e" : "var(--dsw-alias-border-l2)",
																	},
																}),
																jsx("span", { style: page.rowTitle, children: child.label || String(child.sessionId).slice(0, 8) }),
																jsx("span", {
																	style: { ...page.mono, fontSize: "11px" },
																	children: `${String(child.sessionId).slice(0, 8)}… ${child.running ? "running" : "idle"}`,
																}),
																jsx("input", {
																	style: { ...page.input, marginTop: 0, width: "180px" },
																	placeholder: t("sendPlaceholder"),
																	value: drafts[child.sessionId] ?? "",
																	onChange: (event) => setDrafts((prev) => ({ ...prev, [child.sessionId]: event.target.value })),
																}),
																jsx("button", {
																	type: "button",
																	style: { ...page.button, marginTop: 0 },
																	onClick: () => void sendToChild(group.parentId, child.sessionId),
																	children: t("send"),
																}),
															],
														},
													),
												),
											],
										},
									),
								),
							],
						}),
						// ---- 这个插件带来什么：三张卡片改成一段文字 ----
						jsx("div", { style: page.sectionTitle, children: t("capabilities") }),
						jsx("div", {
							style: page.card,
							children: jsx("div", {
								style: page.mono,
								children: [t("nudgeDesc"), t("spawnDesc"), t("messagingDesc")].join("\n"),
							}),
						}),
						// ---- 碎碎念规则：逐会话实际生效配置 + 该会话的规则列表 ----
						jsx("div", { style: page.sectionTitle, children: t("rulesTitle") }),
						jsxs("div", {
							style: page.card,
							children: [
								nudgeRows.length === 0
									? jsx("div", { style: { ...page.mono, marginTop: "6px" }, children: t("rulesEmpty") })
									: jsx("div", {
											style: { ...page.mono, marginTop: "6px" },
											children: nudgeRows
												.map(
													(row) =>
														`${row.kind === "parent" ? t("parentRow") : t("childRow")} ${String(row.sessionId).slice(0, 8)} · ${modeLine(row)}`,
												)
												.join("\n"),
										}),
								// ---- 规则列表（按当前查看的会话）：模板 / 新建 / 卡片 ----
								jsxs("div", {
									style: {
										marginTop: "12px",
										paddingTop: "10px",
										borderTop: "0.5px solid var(--dsw-alias-border-l2)",
										display: "flex",
										gap: "8px",
										flexWrap: "wrap",
										alignItems: "center",
									},
									children: [
										jsx("select", {
											"data-role": "rules-session",
											style: { ...page.input, marginTop: 0, width: "200px" },
											value: rulesSessionId,
											onChange: (event) => {
												const sessionId = event.target.value;
												setRulesView({ sessionId, list: [] });
												if (typeof props.nudgeLoadRules === "function") {
													void props.nudgeLoadRules(sessionId).then((list) => setRulesView({ sessionId, list: Array.isArray(list) ? list : [] }));
												}
											},
											children: sessionChoices.map((choice) =>
												jsx(
													"option",
													{ value: choice.sessionId, children: `${choice.kind === "parent" ? t("parentRow") : t("childRow")} ${String(choice.sessionId).slice(0, 8)}` },
													choice.sessionId,
												),
											),
										}),
										jsx("select", {
											"data-role": "rules-template",
											style: { ...page.input, marginTop: 0, width: "150px" },
											value: "",
											onChange: (event) => {
												const found = NUDGE_TEMPLATES.find((entry) => entry.key === event.target.value);
												if (found === undefined) return;
												// 模板只负责“打开编辑器并预填”；保存仍由用户确认。
												props.openNudgeEditor?.(rulesSessionId, {
													rules: rulesView.list,
													rule: { ...emptyNudgeRule(), type: found.type, content: found.content, strategies: [found.strategy] },
												});
											},
											children: [
												jsx("option", { value: "", children: t("ruleTemplatePlaceholder") }),
												...NUDGE_TEMPLATES.map((template) =>
													jsx("option", { value: template.key, children: t(`ruleTemplate_${template.key}`) }, template.key),
												),
											],
										}),
										jsx("button", {
											type: "button",
											"data-action": "new-rule",
											style: { ...page.button, marginTop: 0, padding: "2px 10px", fontSize: "13px" },
											onClick: () => props.openNudgeEditor?.(rulesSessionId, { rules: rulesView.list }),
											children: `+ ${t("ruleNew")}`,
										}),
									],
								}),
								rulesView.list.length === 0
									? jsx("div", { style: { ...page.mono, marginTop: "8px" }, children: t("ruleEmptyNoInject") })
									: jsx("div", {
											style: { marginTop: "8px", display: "flex", flexDirection: "column", gap: "8px" },
											children: rulesView.list.map((rule) =>
												jsxs(
													"div",
													{
														"data-rule-id": rule.id,
														style: { ...page.card, display: "flex", alignItems: "flex-start", gap: "8px", opacity: rule.enabled === false ? 0.55 : 1 },
													},
													[
														jsxs("div", {
															style: { flex: "1 1 auto", minWidth: 0, cursor: "pointer" },
															onClick: () => props.openNudgeEditor?.(rulesSessionId, { rules: rulesView.list, rule }),
															children: [
																jsxs("div", {
																	style: { display: "flex", gap: "6px", alignItems: "center" },
																	children: [
																		jsx("span", { style: { ...page.badge, fontSize: "11px", padding: "0 6px" }, children: t(RULE_TYPE_LABEL_KEYS[rule.type] ?? "ruleTypeRule") }),
																		rule.enabled === false
																			? jsx("span", { style: { ...page.rowDesc, fontSize: "11px" }, children: t("ruleDisabled") })
																			: null,
																	],
																}),
																jsx("div", {
																	style: {
																		...page.rowTitle,
																		marginTop: "4px",
																		overflow: "hidden",
																		display: "-webkit-box",
																		WebkitLineClamp: 2,
																		WebkitBoxOrient: "vertical",
																	},
																	children: rule.content,
																}),
																jsx("div", { style: { ...page.rowDesc, marginTop: "2px" }, children: strategySummary(rule, t) }),
															],
														}),
														jsxs("div", {
															style: { display: "flex", gap: "2px", flex: "0 0 auto" },
															children: [
																jsx("button", {
																	type: "button",
																	"data-action": "toggle-rule",
																	title: t("ruleToggle"),
																	style: { ...page.button, marginTop: 0, padding: "0 6px" },
																	onClick: () =>
																		void persistRuleList(
																			rulesView.list.map((entry) => (entry.id === rule.id ? { ...entry, enabled: entry.enabled === false } : entry)),
																		),
																	children: rule.enabled === false ? "○" : "●",
																}),
																jsx("button", {
																	type: "button",
																	"data-action": "edit-rule",
																	title: t("ruleEdit"),
																	style: { ...page.button, marginTop: 0, padding: "0 6px" },
																	onClick: () => props.openNudgeEditor?.(rulesSessionId, { rules: rulesView.list, rule }),
																	children: "✎",
																}),
																jsx("button", {
																	type: "button",
																	"data-action": "delete-rule",
																	title: t("ruleDelete"),
																	style: { ...page.button, marginTop: 0, padding: "0 6px" },
																	onClick: () => void persistRuleList(rulesView.list.filter((entry) => entry.id !== rule.id)),
																	children: "🗑",
																}),
															],
														}),
													],
												),
											),
										}),
							],
						}),
						jsx("div", { style: page.footer, children: t("hint") }),
						jsx("div", { style: page.footer, children: t("status") }),
					],
				}),
			});
		}
		//#endregion

		//#region 设置页：可编辑卡片（plugins.item）
		/**
		 * 插件设置卡片：六个顶层字段 + 保存/放弃 + 只读的“当前生效”摘要。
		 *
		 * 字段状态来自 `SettingsFormModel` 的 store（`form.bind`），按钮走 `form.actions()`；
		 * 只读摘要里的“被覆盖会话数”靠宿主命令 `/vibe-nudge status`（客户端读不了 nudges.json）。
		 * @param props - 视图（summary / 卡片）、本地化读取器、表单 store、表单动作与状态刷新函数。
		 * @returns 摘要一行，或完整卡片。
		 */
		function VibeBridgeCard(props) {
			const jsx = react_jsx_runtime.jsx;
			const jsxs = react_jsx_runtime.jsxs;
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const state = props.useVibeBridgeCard((value) => value);
			if (props.view === "summary") return t("settingsSummary");
			// 打开时刷一次状态：拿“被覆盖的几个会话”；失败就退回只显示配置里的节奏。
			react.useEffect(() => {
				if (typeof props.refreshNudgeStatus === "function") void props.refreshNudgeStatus();
			}, []);
			const fieldOf = (key, options) => {
				const view = state[key] ?? { text: "", overridden: false, invalid: false };
				return jsx(primitives.SettingsValueField, {
					id: `vibe-bridge-${key}`,
					label: t(options.label),
					hint: t(options.hint),
					overriddenLabel: t("overriddenLabel"),
					resetLabel: t("resetLabel"),
					invalidLabel: t(options.invalid),
					numeric: options.numeric === true,
					disabled: !state.writable,
					text: view.text,
					overridden: view.overridden === true,
					invalid: view.invalid === true,
					onEdit: (text) => props.edit(key, text),
					onReset: () => props.resetField(key),
				});
			};
			const summary = typeof props.nudgeSummary === "function" ? props.nudgeSummary() : {};
			const cadence =
				typeof summary.cadence === "string" && summary.cadence.length > 0
					? summary.cadence
					: [state.everyTurns?.text, state.fullEveryTurns?.text, state.fromTurn?.text].filter(Boolean).join(" / ");
			const overrides = typeof summary.overrides === "number" ? String(summary.overrides) : t("effectiveUnknown");
			const nudgeTextView = state.nudgeText ?? { text: "", overridden: false };
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "10px" },
				children: [
					jsx("div", { style: page.rowTitle, children: t("settingsTitle") }),
					jsx("div", { style: page.rowDesc, children: t("settingsSummary") }),
					jsx(primitives.SettingsForm, {
						labels: formLabels(t),
						state,
						onSave: props.save,
						onDiscard: props.discard,
						children: [
							fieldOf("everyTurns", { label: "everyTurns", hint: "everyTurnsHint", invalid: "invalidNumber", numeric: true }),
							fieldOf("fullEveryTurns", { label: "fullEveryTurns", hint: "fullEveryTurnsHint", invalid: "invalidNumber", numeric: true }),
							fieldOf("fromTurn", { label: "fromTurn", hint: "fromTurnHint", invalid: "invalidNumber", numeric: true }),
							fieldOf("skipSubagentSessions", { label: "skipSubagent", hint: "skipSubagentHint", invalid: "invalidBoolean" }),
							fieldOf("speakOnFirstSeen", { label: "speakFirstSeen", hint: "speakFirstSeenHint", invalid: "invalidBoolean" }),
							// 文案要多行：SettingsValueField 只有单行 input，这里单独渲染一个 textarea。
							jsxs("div", {
								style: { display: "flex", flexDirection: "column", gap: "4px" },
								children: [
									jsxs("div", {
										style: { display: "flex", alignItems: "center", gap: "8px" },
										children: [
											jsx("label", { style: page.rowTitle, children: t("nudgeText") }),
											nudgeTextView.overridden === true
												? jsx("button", {
														type: "button",
														style: { ...page.button, marginTop: 0, padding: "0 8px", fontSize: "11px" },
														disabled: !state.writable,
														onClick: () => props.resetField("nudgeText"),
														children: t("resetLabel"),
													})
												: null,
										],
									}),
									jsx("textarea", {
										id: "vibe-bridge-nudgeText",
										style: page.textarea,
										value: nudgeTextView.text ?? "",
										disabled: !state.writable,
										placeholder: t("nudgeTextHint"),
										onChange: (event) => props.edit("nudgeText", event.target.value),
									}),
									jsx("div", { style: page.rowDesc, children: t("nudgeTextHint") }),
								],
							}),
						],
					}),
					jsxs("div", {
						style: { ...page.card, marginTop: "4px" },
						children: [
							jsx("div", { style: { ...page.sectionTitle, margin: "0 0 6px" }, children: t("effective") }),
							jsx("div", {
								style: page.mono,
								children: `${t("effectiveCadence")}: ${cadence.length > 0 ? cadence : "-"}\n${t("effectiveOverrides")}: ${overrides}`,
							}),
						],
					}),
				],
			});
		}
		//#endregion

		//#region 设置页状态行（老版 DSH 的兜底）
		/**
		 * 设置 → 通用设置 里的一行状态。
		 * @param props - 配置表单快照与本地化读取器。
		 * @returns 状态行。
		 */
		function VibeBridgeRow(props) {
			const jsx = react_jsx_runtime.jsx;
			const jsxs = react_jsx_runtime.jsxs;
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const snapshot = typeof props.useForm === "function" ? props.useForm((value) => value) : undefined;
			const config = snapshot?.value;
			const rules = config && Array.isArray(config.rules) ? config.rules : null;
			return jsxs("div", {
				style: {
					display: "flex",
					alignItems: "flex-start",
					justifyContent: "space-between",
					gap: "24px",
					padding: "16px 0",
					borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
				},
				children: [
					jsxs("div", {
						children: [
							jsx("div", { style: page.rowTitle, children: t("title") }),
							jsx("div", { style: page.rowDesc, children: t("description") }),
							jsx("div", {
								style: { ...page.mono, marginTop: "6px" },
								children:
									rules === null
										? t("waiting")
										: rules.length === 0
											? t("noRules")
											: rules.map(describeRule).join("\n"),
							}),
						],
					}),
					jsxs("span", {
						style: page.badge,
						children: [jsx("span", { style: page.dot }), jsx("span", { children: t("active") })],
					}),
				],
			});
		}
		//#endregion

		//#region apply
		/** 依赖的浏览器侧服务。remote 的用法要连服务名一起声明，否则取 ctx.remote.xxx 会抛 inject 错误。 */
		const inject = ["slots", "locale", "configForms", "layout", "remote", "remote.session", "remote.commands"];

		/**
		 * 注册左侧栏入口、主页面、会话右键菜单项与设置行。
		 * @param ctx - 浏览器侧插件上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { en, zh }));
			const t = typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : (key) => key;
			let form;
			try {
				form = ctx.configForms.get(ENTRY_ID);
			} catch (_error) {
				form = undefined;
			}
			// 设置卡片：SettingsFormModel 只支持顶层标量，所以节奏键必须是顶层的（见宿主 Config）。
			let cardModel;
			let cardStore;
			if (form !== undefined && typeof primitives.SettingsFormModel === "function") {
				try {
					cardModel = new primitives.SettingsFormModel(form, [
						primitives.settingsNumberField("everyTurns"),
						primitives.settingsNumberField("fullEveryTurns"),
						primitives.settingsNumberField("fromTurn"),
						primitives.settingsTextField("nudgeText"),
						settingsBooleanField("skipSubagentSessions"),
						settingsBooleanField("speakOnFirstSeen"),
						// 全局开关：弹窗/面板通过 nudgeGlobal 读写这个键（不自己写文件）。
						settingsBooleanField("nudgeEnabled"),
					]);
					cardStore = cardModel.bind(() => {
						const projection = { ...cardModel.shell() };
						for (const key of FORM_FIELDS) projection[key] = cardModel.field(key);
						return projection;
					});
					ctx.effect(() => () => cardModel.dispose(), "vibe-bridge: settings form");
				} catch (_error) {
					cardModel = undefined;
					cardStore = undefined;
				}
			}
			/** `/vibe-nudge status` 的最近一次结果（只读摘要用；客户端读不了 nudges.json）。 */
			const statusCache = { text: "", cadence: "", overrides: undefined };
			/**
			 * 刷新只读摘要：拿一个会话当锚点调宿主命令（命令本身只读全局状态）。
			 * @returns 命令输出文本；拿不到返回空串。
			 */
			const refreshNudgeStatus = async () => {
				try {
					const list = await ctx.remote.session.list({});
					const items = Array.isArray(list?.items) ? list.items : [];
					const anchor = items.find((item) => typeof item?.sessionId === "string");
					if (anchor === undefined) return "";
					const result = await ctx.remote.commands.execute(anchor.sessionId, "/vibe-nudge status", []);
					const outcome = result?.value?.result;
					if (result?.ok === false || outcome?.kind !== "success") return "";
					const text = String(outcome.text ?? "");
					const [cadence = "", , overrideLine = ""] = text.split("\n");
					statusCache.text = text;
					statusCache.cadence = cadence;
					const match = /overrides: (\d+)/.exec(overrideLine);
					statusCache.overrides = match === null ? 0 : Number(match[1]);
					return text;
				} catch (_error) {
					return "";
				}
			};
			/**
			 * 往某个会话投一条宿主命令（会话菜单用）。失败静默：菜单项不能把菜单弄崩。
			 * @param sessionId - 右键点中的会话。
			 * @param line - 命令行，如 `/vibe-nudge off`。
			 */
			const nudgeCommand = async (sessionId, line) => {
				if (typeof sessionId !== "string" || sessionId.length === 0) return;
				try {
					await ctx.remote.commands.execute(sessionId, line, []);
				} catch (_error) {
					// 静默：旧版 Host 没有这个命令时，菜单项也不该报错。
				}
			};
			// ---- 碎碎念：批量状态（`status all`）+ 弹窗用的单会话预填 ----
			const statusAll = { rows: new Map() };
			/**
			 * 解析 `status all`（固定格式，客户端按行解析）：
			 * `sessions: N` 之后每行 `  <id>: <mode> text=yes|no rules=<n>`。
			 * @param text - 命令输出。
			 * @returns `{ rows: Map<sessionId, { mode, custom, rules }> }`。
			 */
			const parseStatusAll = (text) => {
				const rows = new Map();
				for (const line of String(text ?? "").split("\n")) {
					const trimmed = line.trim();
					if (trimmed.length === 0 || trimmed.startsWith("sessions:")) continue;
					const match = /^(\S+):\s*(\S+)\s+text=(yes|no)(?:\s+rules=(\d+))?$/.exec(trimmed);
					if (match !== null) {
						rows.set(match[1], { mode: match[2], custom: match[3] === "yes", rules: match[4] === undefined ? 0 : Number(match[4]) });
					}
				}
				return { rows };
			};
			/**
			 * 解析单会话 `status` 的 `session:` 行（弹窗预填）。
			 * @param text - 命令输出。
			 * @returns `{ mode, text }`（text 已 base64 解码）。
			 */
			const parseSessionLine = (text) => {
				const line = String(text ?? "")
					.split("\n")
					.find((entry) => entry.trim().startsWith("session:"));
				if (line === undefined) return { mode: "global", text: "" };
				const modeMatch = /mode=(\S+)/.exec(line);
				const textMatch = /text=(\S+)/.exec(line);
				let decoded = "";
				if (textMatch !== null && textMatch[1] !== "empty") {
					try {
						decoded = decodeURIComponent(escape(atob(textMatch[1])));
					} catch (_error) {
						decoded = "";
					}
				}
				return { mode: modeMatch === null ? "global" : modeMatch[1], text: decoded };
			};
			/** 拿一个会话当命令锚点（宿主命令不关心是哪个会话）。 */
			const anchorSession = async () => {
				const list = await ctx.remote.session.list({});
				const items = Array.isArray(list?.items) ? list.items : [];
				const found = items.find((item) => typeof item?.sessionId === "string");
				return found === undefined ? "" : found.sessionId;
			};
			/**
			 * 批量刷新面板“碎碎念规则”区：一次 `status all`，再按传入的会话表拼行。
			 * @param entries - `[{ kind: 'parent'|'child', sessionId }]`。
			 * @returns 行数组（失败返回空数组，面板显示“取不到”）。
			 */
			const refreshNudgeRows = async (entries) => {
				try {
					const anchor = await anchorSession();
					if (anchor.length === 0) return [];
					const result = await ctx.remote.commands.execute(anchor, "/vibe-nudge status all", []);
					const outcome = result?.value?.result;
					if (result?.ok === false || outcome?.kind !== "success") return [];
					const parsed = parseStatusAll(outcome.text);
					statusAll.rows = parsed.rows;
					return (Array.isArray(entries) ? entries : []).map((entry) => {
						const hit = parsed.rows.get(entry.sessionId);
						const mode = hit === undefined ? "global" : hit.mode;
						// 会话级节奏只剩 every:N 这种历史写法；规则数来自 status all 的 rules= 字段。
						const every = mode.startsWith("every:") ? Number(mode.slice("every:".length)) : 0;
						return {
							kind: entry.kind,
							sessionId: entry.sessionId,
							mode,
							custom: hit === undefined ? false : hit.custom === true,
							every: Number.isFinite(every) && every > 0 ? every : 0,
							rules: hit === undefined ? 0 : hit.rules ?? 0,
						};
					});
				} catch (_error) {
					return [];
				}
			};
			/**
			 * 弹窗预填：读该会话的 `status` 的 `session:` 行并写进弹窗状态。
			 * @param sessionId - 目标会话。
			 */
			const loadNudgeStatus = async (sessionId) => {
				if (typeof sessionId !== "string" || sessionId.length === 0) return { mode: "unknown", text: "" };
				try {
					const result = await ctx.remote.commands.execute(sessionId, "/vibe-nudge status", []);
					const outcome = result?.value?.result;
					if (result?.ok === false || outcome?.kind !== "success") throw new Error("status failed");
					const parsed = parseSessionLine(outcome.text);
					setNudgeEditor({ mode: parsed.mode, text: parsed.text, error: "" });
					return parsed;
				} catch (error) {
					setNudgeEditor({ mode: "unknown", text: "", error: error && error.message ? String(error.message) : String(error) });
					return { mode: "unknown", text: "" };
				}
			};
			/** 弹窗：打开 / 关闭（`on` / `off`）。 */
			const nudgeSet = async (sessionId, mode) => {
				await ctx.remote.commands.execute(sessionId, `/vibe-nudge ${mode}`, []);
			};
			/** 弹窗：读该会话的规则数组（`/vibe-nudge rules` → base64(JSON)）。 */
			const nudgeLoadRules = async (sessionId) => {
				try {
					const result = await ctx.remote.commands.execute(sessionId, "/vibe-nudge rules", []);
					const outcome = result?.value?.result;
					if (result?.ok === false || outcome?.kind !== "success") return [];
					const text = String(outcome.text ?? "").trim();
					if (text.length === 0) return [];
					const decoded = decodeURIComponent(escape(atob(text)));
					const parsed = JSON.parse(decoded);
					return Array.isArray(parsed) ? parsed : [];
				} catch (_error) {
					return [];
				}
			};
			/** 弹窗/面板：「添加默认规则」= 把包内 nudge.md 写成一条会话规则（显式动作）。 */
			const nudgeAddDefaultRule = async (sessionId) => {
				const result = await ctx.remote.commands.execute(sessionId, "/vibe-nudge default-rule", []);
				const outcome = result?.value?.result;
				if (result?.ok === false || outcome?.kind === "error") throw new Error(String(outcome?.text ?? "default rule failed"));
				return await nudgeLoadRules(sessionId);
			};
			/**
			 * 弹窗：整体替换该会话的规则数组（`/vibe-nudge rules:<base64>`）。
			 * @returns 写盘后重新读回的数组（**必须**返回数组，见下方注释）。
			 */
			const nudgeSaveRules = async (sessionId, rules) => {
				const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(Array.isArray(rules) ? rules : []))));
				const result = await ctx.remote.commands.execute(sessionId, `/vibe-nudge rules:${encoded}`, []);
				const outcome = result?.value?.result;
				if (result?.ok === false) throw new Error(result.error?.message ?? "rules save failed");
				if (outcome?.kind === "error") throw new Error(String(outcome.text ?? "rules rejected"));
				// 调用方写的是 `.then((saved) => setNudgeEditor({ rules: saved }))`：这里若返回 undefined，
				// 弹窗的 rules 就变成 undefined，下一次渲染 `rules.length` 抛错、整个 overlay 槽位崩掉。
				// 真机症状就是「点了电源开关，弹窗从此打不开」。
				return await nudgeLoadRules(sessionId);
			};
			/** 打开「创建子会话」弹窗（父会话 id 记为点中的那一行）。 */
			const openSpawn = (parentSessionId) => {
				pendingTarget = typeof parentSessionId === "string" ? parentSessionId : "";
				setDialog({ open: true, parentId: pendingTarget, label: "child", task: "", busy: false, notice: "" });
			};
			/**
			 * 直接建子会话：走宿主命令 `/vibe-spawn <label>|<任务>`，
			 * 不再往父会话投一条 prompt（那样要等模型一轮才建出来）。
			 * @returns 宿主返回的文本（含 session id）。
			 */
			const spawnChildDirect = async (parentSessionId, label, task) => {
				const result = await ctx.remote.commands.execute(parentSessionId, `/vibe-spawn ${label}|${task}`, []);
				if (result?.ok === false) throw new Error(result.error?.message ?? "command failed");
				if (result?.value === undefined) throw new Error("vibe-spawn command is not available on this Host");
				const outcome = result.value.result;
				if (outcome?.kind === "error") throw new Error(outcome.text ?? "command error");
				return String(outcome?.text ?? "");
			};
			/** 兜底：命令不可用（旧版 Host）时，退回“让父会话的 Agent 去建”。 */
			const spawnChild = async (parentSessionId, task) => {
				await ctx.remote.session.prompt({
					requestId: newRequestId(),
					sessionId: parentSessionId,
					mode: "queue",
					content: [
						{
							type: "text",
							text: `请用 spawn_session 创建一个子会话（label 用 "child"），任务如下；创建完成后把子会话的 session id 回报给我：\n\n${task}`,
						},
					],
				});
			};
			/** 创建入口：优先直接建，失败再退回对话式创建。 */
			const createChild = async (parentSessionId, label, task) => {
				try {
					return await spawnChildDirect(parentSessionId, label, task);
				} catch (error) {
					if (!(error instanceof Error) || !error.message.includes("not available")) throw error;
					await spawnChild(parentSessionId, task);
					return "";
				}
			};
			const face = () => ({
				...(form === undefined ? {} : { hooks: { useForm: form } }),
				spawnChild,
				createChild,
				/** 会话列表（含 parentSessionId），给面板画会话树。 */
				listSessions: () => ctx.remote.session.list({}),
				/** 往某个子会话投一条消息（同样带来源标注）。 */
				sendToSession: async (parentSessionId, childSessionId, text) => {
					await ctx.remote.session.prompt({
						requestId: newRequestId(),
						sessionId: childSessionId,
						mode: "queue",
						content: [{ type: "text", text: `[来自会话 ${parentSessionId} 的消息]\n${text}` }],
					});
				},
				get pendingTarget() {
					return pendingTarget;
				},
				/** 面板树头的「创建子会话」：打开弹窗并预设父会话。 */
				openSpawn,
				/** 面板「碎碎念规则」：一次批量取，失败返回空数组。 */
				refreshNudgeRows,
				/** 设置卡片用：刷新并读取只读摘要。 */
				refreshNudgeStatus,
				nudgeSummary: () => ({ cadence: statusCache.cadence, overrides: statusCache.overrides }),
			});
			/** 设置卡片的注入面：表单 store + 表单动作 + 摘要刷新。 */
			const cardFace = () => ({
				hooks: { useVibeBridgeCard: cardStore },
				nudgeSummary: () => ({ cadence: statusCache.cadence, overrides: statusCache.overrides }),
				refreshNudgeStatus,
				...(cardModel === undefined
					? { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} }
					: cardModel.actions()),
			});

			// 左侧栏入口
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{ name: "sidebar.panellist", id: PANEL_ID, order: 40, label: () => "Vibe Bridge", locale: NS },
					VibeBridgeIcon,
				),
			);

			// 入口打开的主页面
			ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS, inject: face }, VibeBridgePage),
			);

			// 原生侧栏的子会话行由侧栏补丁渲染，拿不到本插件的组件：
			// 暴露一个最小全局桥，让补丁里的「复制 id / 碎碎念」两个按钮能调到同一份实现。
			ctx.effect(() => {
				const previous = globalThis.__vibeBridge;
				globalThis.__vibeBridge = {
					openNudgeEditor: (sessionId) => openNudgeEditor(sessionId),
					copyId: async (sessionId) => copyTextToClipboard(sessionId),
					// 侧栏补丁用同一套文案，避免硬编码两份中文。
					labels: { copy: t("copyId"), nudge: t("rowNudge") },
					// 版本号来自 package.json，客户端半里没有常量，这里不重复声明。
				};
				return () => {
					if (previous === undefined) delete globalThis.__vibeBridge;
					else globalThis.__vibeBridge = previous;
				};
			});

			// 会话右键菜单：只剩「碎碎念编辑」（子会话行同样适用）
			ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
				yield ctx.slots.register(
					{ name: "sidebar.workspaces.session.menu.item", id: "vibe-nudge-edit", order: 460, locale: NS, inject: () => ({ openNudgeEditor }) },
					NudgeEditMenuItem,
				);
			});

			// 创建子会话的弹窗（树头的「创建子会话」打开）
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{ name: "shell.overlay", id: "vibe-bridge-spawn-dialog", locale: NS, inject: () => ({ createChild }) },
					VibeSpawnDialog,
				),
			);

			// 碎碎念编辑弹窗（右键菜单打开）
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "vibe-bridge-nudge-dialog",
						locale: NS,
						inject: () => ({
							nudgeLoad: loadNudgeStatus,
							nudgeSet,
							nudgeLoadRules,
							nudgeSaveRules,
							nudgeAddDefaultRule,
						}),
					},
					NudgeEditorDialog,
				),
			);

			if (cardModel !== undefined) {
				// 设置页：插件卡片（配置表单只服务本命名空间时才出现）
				ctx.effect(
					() =>
						ctx.configForms.whileServed([ENTRY_ID], () =>
							ctx.slots.inject("plugins.item", () =>
								ctx.slots.register(
									{ name: "plugins.item", id: ENTRY_ID, order: 40, label: () => t("settingsTitle"), locale: NS, inject: cardFace },
									VibeBridgeCard,
								),
							),
						),
					"vibe-bridge: settings card",
				);
			} else {
				// 老版 DSH（没有 SettingsFormModel / 配置未服务）：保留只读状态行。
				ctx.slots.inject("settings.general.item", () =>
					ctx.slots.register(
						{ name: "settings.general.item", id: "vibe-bridge-status", order: 88, locale: NS, inject: face },
						VibeBridgeRow,
					),
				);
			}
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

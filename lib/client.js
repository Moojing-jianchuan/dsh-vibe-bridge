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
			waiting: "Configuration snapshot unavailable here; rules live in cordis.patch.yml.",
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
			"menu.console": "Open Vibe console",
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
			waiting: "此处取不到配置快照；规则以 cordis.patch.yml 为准。",
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
			"menu.console": "打开 Vibe 调度台",
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
			const parts = [every > 0 ? `every ${every}` : "full only"];
			if (full > 0) parts.push(`full every ${full}`);
			if (Number.isFinite(from)) parts.push(`turn ${from}..${to > 0 ? to : "∞"}`);
			return `• ${name}: ${parts.join(", ")}`;
		}
		/** 一条能力卡片。 */
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

		//#region 创建子会话的弹窗状态
		/** 弹窗状态：菜单里点「创建子会话」时打开，提交后投递给父会话。 */
		const dialog = { open: false, parentId: "", label: "child", task: "", busy: false, notice: "" };
		/** 状态变化的订阅者。 */
		const listeners = new Set();
		/** 合并式更新弹窗状态并通知订阅者。 */
		function setDialog(patch) {
			Object.assign(dialog, patch);
			for (const listener of listeners) listener();
		}
		/** 订阅弹窗状态。 */
		function subscribeDialog(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
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
		 * 「创建子会话」：把该会话记为父会话，打开调度台填任务。
		 * @param props - 行身份、菜单开关、调度台跳转与文案。
		 * @returns 菜单项。
		 */
		function CreateChildMenuItem(props) {
			const jsx = react_jsx_runtime.jsx;
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const [, setMenuOpen] = props.useMenuOpenState();
			return jsx(primitives.MenuItemButton, {
				icon: jsx(primitives.IconPlusOutlineRegular, {}),
				onSelect: () => {
					setMenuOpen(false);
					// 直接在菜单里弹输入框：父会话 id 就是右键点中的那一行。
					setDialog({ open: true, parentId: props.sessionId ?? "", label: "child", task: "", busy: false, notice: "" });
				},
				children: t("menu.createChild"),
			});
		}
		/**
		 * 「打开 Vibe 调度台」：不预设父会话，直接开面板。
		 * @param props - 菜单开关、面板跳转与文案。
		 * @returns 菜单项。
		 */
		function OpenConsoleMenuItem(props) {
			const jsx = react_jsx_runtime.jsx;
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const [, setMenuOpen] = props.useMenuOpenState();
			return jsx(primitives.MenuItemButton, {
				icon: jsx(primitives.IconCordisPluginOutlineRegular, {}),
				onSelect: () => {
					setMenuOpen(false);
					props.openConsole("");
				},
				children: t("menu.console"),
			});
		}
		//#endregion

		//#region 创建子会话弹窗
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

		/**
		 * Vibe Bridge 主页面（左侧栏入口打开的就是它），含调度台。
		 * @param props - 本地化读取器、配置表单钩子、投递函数与预置父会话 id。
		 * @returns 页面元素。
		 */
		function VibeBridgePage(props) {
			const jsx = react_jsx_runtime.jsx;
			const jsxs = react_jsx_runtime.jsxs;
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const snapshot = typeof props.useForm === "function" ? props.useForm((value) => value) : undefined;
			const config = snapshot?.value;
			const rules = config && Array.isArray(config.rules) ? config.rules : null;
			const [parentId, setParentId] = react.useState(props.pendingTarget ?? "");
			const [task, setTask] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState("");
			// 会话树：父会话 + 子会话（对应 VAW 控制台那个缩进列表）
			const [tree, setTree] = react.useState({ phase: "loading", items: [], error: "" });
			const [drafts, setDrafts] = react.useState({});
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
			/** 按父会话分组；子会话不在 session/list 里，从父会话的 subagentCatalog 投影取。 */
			const groups = [];
			{
				for (const item of tree.items) {
					const catalog = item?.projections?.subagentCatalog;
					if (!Array.isArray(catalog) || catalog.length === 0) continue;
					const children = catalog
						.map((entry) => ({
							sessionId: entry?.id ?? entry?.sessionId,
							label: typeof entry?.label === "string" ? entry.label : "",
							mode: entry?.mode,
							running: entry?.running === true,
						}))
						.filter((entry) => typeof entry.sessionId === "string" && entry.sessionId.length > 0);
					if (children.length > 0) groups.push({ parent: item.sessionId, children });
				}
				groups.sort((left, right) => (left.parent < right.parent ? -1 : 1));
			}
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
			const submit = async () => {
				if (busy) return;
				if (parentId.trim().length === 0 || task.trim().length === 0) {
					setNotice(t("needBoth"));
					return;
				}
				setBusy(true);
				setNotice(t("creating"));
				try {
					// 和弹窗同一条路径：宿主命令直接建，不等父会话的模型轮次。
					const report = await props.createChild(parentId.trim(), "child", task.trim());
					const id = /session started: (\S+)/.exec(report ?? "")?.[1];
					setNotice(id === undefined ? t("created") : `${t("created")} ${id}`);
					setTask("");
				} catch (error) {
					const reason = error && error.message ? String(error.message) : String(error);
					setNotice(`${t("failed")} ${reason}`);
				}
				setBusy(false);
			};
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
						jsx("div", { style: page.sectionTitle, children: t("console") }),
						jsxs("div", {
							style: page.card,
							children: [
								jsx("div", { style: page.rowDesc, children: t("consoleHint") }),
								jsx("label", { style: page.label, children: t("parent") }),
								jsx("input", {
									style: page.input,
									value: parentId,
									placeholder: "session-xxxxxxxx",
									onChange: (event) => setParentId(event.target.value),
								}),
								jsx("label", { style: page.label, children: t("task") }),
								jsx("textarea", {
									style: page.textarea,
									value: task,
									placeholder: t("taskPlaceholder"),
									onChange: (event) => setTask(event.target.value),
								}),
								jsx("button", {
									type: "button",
									style: page.button,
									disabled: busy,
									onClick: () => void submit(),
									children: busy ? t("creating") : t("create"),
								}),
								notice.length === 0 ? null : jsx("div", { style: page.notice, children: notice }),
							],
						}),
						jsx("div", { style: page.sectionTitle, children: t("tree") }),
						jsxs("div", {
							style: page.card,
							children: [
								jsxs("div", {
									style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" },
									children: [
										jsx("div", { style: page.rowDesc, children: t("treeHint") }),
										jsx("button", {
											type: "button",
											style: { ...page.button, marginTop: 0 },
											onClick: () => void loadTree(),
											children: t("refresh"),
										}),
									],
								}),
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
													children: [
														`▾ ${String(group.parent).slice(0, 12)}…`,
														` (${group.children.length})`,
													],
												}),
												...group.children.map((child) =>
													jsxs(
														"div",
														{
															style: {
																marginTop: "6px",
																paddingLeft: "18px",
																display: "flex",
																alignItems: "center",
																gap: "8px",
																flexWrap: "wrap",
															},
															children: [
																jsx("span", {
																	style: {
																		width: "6px",
																		height: "6px",
																		borderRadius: "999px",
																		background: child.running ? "#22c55e" : "var(--dsw-alias-border-l2)",
																	},
																}),
																jsx("span", { style: page.rowTitle, children: titleOf(child) }),
																jsx("span", {
																	style: { ...page.mono, fontSize: "11px" },
																	children: `${String(child.sessionId).slice(0, 8)}… ${child.running ? "running" : "idle"}`,
																}),
																jsx("input", {
																	style: { ...page.input, marginTop: 0, width: "180px" },
																	placeholder: t("sendPlaceholder"),
																	value: drafts[child.sessionId] ?? "",
																	onChange: (event) =>
																		setDrafts((prev) => ({ ...prev, [child.sessionId]: event.target.value })),
																}),
																jsx("button", {
																	type: "button",
																	style: { ...page.button, marginTop: 0 },
																	onClick: () => void sendToChild(group.parent, child.sessionId),
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
						jsx("div", { style: page.sectionTitle, children: t("capabilities") }),
						capability(jsx, jsxs, true, t("nudge"), t("nudgeDesc")),
						capability(jsx, jsxs, false, t("spawn"), t("spawnDesc")),
						capability(jsx, jsxs, false, t("messaging"), t("messagingDesc")),
						jsx("div", { style: page.sectionTitle, children: t("rules") }),
						jsx("div", {
							style: page.card,
							children: jsx("div", {
								style: page.mono,
								children:
									rules === null
										? t("waiting")
										: rules.length === 0
											? t("noRules")
											: rules.map(describeRule).join("\n"),
							}),
						}),
						jsx("div", { style: page.sectionTitle, children: t("usage") }),
						jsx("div", {
							style: page.card,
							children: jsx("div", {
								style: page.mono,
								children: [t("usageLine1"), t("usageLine2"), t("usageLine3")].join("\n"),
							}),
						}),
						jsx("div", { style: page.footer, children: t("hint") }),
						jsx("div", { style: page.footer, children: t("status") }),
					],
				}),
			});
		}
		//#endregion

		//#region 设置页状态行
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
			let form;
			try {
				form = ctx.configForms.get(ENTRY_ID);
			} catch (_error) {
				form = undefined;
			}
			/** 打开调度台，记住从菜单点进来的父会话。 */
			const openConsole = (sessionId) => {
				pendingTarget = typeof sessionId === "string" ? sessionId : "";
				try {
					ctx.layout.selectPanel(PANEL_ID);
				} catch (_error) {
					/* 面板不可用时保持静默：菜单项不能把整个菜单弄崩 */
				}
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

			// 会话右键菜单
			ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
				const menuFace = () => ({ openConsole });
				yield ctx.slots.register(
					{ name: "sidebar.workspaces.session.menu.item", id: "vibe-create-child", order: 460, locale: NS, inject: menuFace },
					CreateChildMenuItem,
				);
				yield ctx.slots.register(
					{ name: "sidebar.workspaces.session.menu.item", id: "vibe-console", order: 461, locale: NS, inject: menuFace },
					OpenConsoleMenuItem,
				);
			});

			// 创建子会话的弹窗（菜单点进来后出现）
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{ name: "shell.overlay", id: "vibe-bridge-spawn-dialog", locale: NS, inject: () => ({ createChild }) },
					VibeSpawnDialog,
				),
			);

			// 设置页那一行
			ctx.slots.inject("settings.general.item", () =>
				ctx.slots.register(
					{ name: "settings.general.item", id: "vibe-bridge-status", order: 88, locale: NS, inject: face },
					VibeBridgeRow,
				),
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Menu, MoreHorizontal, Plus, ArrowUp, Square, ChevronDown, SquarePen } from "lucide-react";
import { PhonePanel } from "./components/PhonePanel.js";
import { PhoneSidebar } from "./components/PhoneSidebar.js";
import { PhoneTeamStatus } from "./components/PhoneTeamStatus.js";
import { PhoneWelcome } from "./components/PhoneWelcome.js";
import type {
	ArtifactRef,
	Command,
	ModelMetadata,
	SkillSummary,
	ThinkingLevel,
	SessionSnapshot,
	SessionSummary,
	WorkspaceSummary,
	UserContentPart,
} from "@wuming/protocol";
import { PhoneMessage, PhoneMessageContent } from "./components/PhoneMessageContent.js";
import { supportedThinkingLevels } from "./lib/thinking-preference.js";
import { PhoneClient } from "./phone-client.js";
import { detectTrigger, cycleIndex, type Trigger } from "./lib/suggest.js";
import { skillItems } from "./components/ComposerSuggest.js";
import "./phone.css";

async function phoneApi(path: string, input?: unknown) {
	const response = await fetch(`/api/phone/${path}`, {
		method: input === undefined ? "GET" : "POST",
		credentials: "same-origin",
		cache: "no-store",
		signal: AbortSignal.timeout(15_000),
		headers: { "Content-Type": "application/json" },
		...(input === undefined ? {} : { body: JSON.stringify(input) }),
	});
	if (response.status === 404) throw new Error("当前地址不是手机入口，请从电脑「设置 → 手机访问」的二维码打开。");
	const value = await response.json();
	if (!response.ok) throw new Error(value.error ?? "手机连接失败");
	return value;
}
const phaseNames: Record<string, string> = {
	idle: "空闲",
	turn: "执行中",
	awaiting_approval: "等待审批",
	compaction: "整理上下文",
	retry: "重试中",
	error: "发生错误",
};
const modelKey = (m: { provider: string; id: string }) => JSON.stringify([m.provider, m.id]);
function stored<T>(key: string, fallback: T): T {
	try {
		return JSON.parse(sessionStorage.getItem(key) ?? "null") ?? fallback;
	} catch {
		return fallback;
	}
}
export function PhoneApp() {
	const [authenticated, setAuthenticated] = useState(false);
	const [checking, setChecking] = useState(true);
	const [authCheck, setAuthCheck] = useState(0);
	const [pairSecret] = useState(() => new URLSearchParams(location.hash.slice(1)).get("pair") ?? "");
	const [name, setName] = useState("我的手机");
	const [pairing, setPairing] = useState<{ id: string; claim: string }>();
	const [status, setStatus] = useState("正在检查授权");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
	const [workspaceId, setWorkspaceId] = useState("");
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [sessionsLoading, setSessionsLoading] = useState(false);
	const [sessionsError, setSessionsError] = useState("");
	const listGeneration = useRef(0);
	const [skillsLoading, setSkillsLoading] = useState(false);
	const [skillsError, setSkillsError] = useState("");
	const [skillsRetry, setSkillsRetry] = useState(0);
	const [snapshot, setSnapshot] = useState<SessionSnapshot>();
	const [live, setLive] = useState<Record<string, string>>({});
	const [draft, setDraft] = useState("");
	const [showList, setShowList] = useState(false);
	const [panel, setPanel] = useState<"settings" | "model" | null>(null);
	const [skillTrigger, setSkillTrigger] = useState<Trigger>();
	const [skillIndex, setSkillIndex] = useState(0);
	const composerInput = useRef<HTMLTextAreaElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const composer = useRef<HTMLFormElement>(null);
	const [composerCollapsed, setComposerCollapsed] = useState(false);
	useLayoutEffect(() => {
		const el = composerInput.current;
		if (!el || composerCollapsed) return;
		el.style.height = "0px";
		el.style.height = `${Math.min(144, Math.max(48, el.scrollHeight))}px`;
		if (atBottom.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
	}, [draft, composerCollapsed]);
	const [workbench, setWorkbench] = useState(false);
	const [models, setModels] = useState<ModelMetadata[]>([]);
	const [skills, setSkills] = useState<SkillSummary[]>([]);
	const [chosenSkills, setChosenSkills] = useState<string[]>([]);
	const [attachments, setAttachments] = useState<ArtifactRef[]>([]);
	const skillSuggestions = skillItems(skills, skillTrigger?.query ?? "");
	const skillMenuOpen = workbench && Boolean(skillTrigger) && !composerCollapsed && !panel && !showList;
	function updateSkillTrigger(text: string, caret: number) {
		const trigger = detectTrigger(text, caret);
		setSkillTrigger(trigger?.kind === "command" || trigger?.kind === "skill" ? trigger : undefined);
		setSkillIndex(0);
	}
	function saveChosenSkills(values: string[]) {
		setChosenSkills(values);
		sessionStorage.setItem(`phone-skills:${selected.current}`, JSON.stringify(values));
	}
	function chooseSkill(id: string) {
		if (!skillTrigger || busy || (!chosenSkills.includes(id) && chosenSkills.length >= 8)) return;
		if (!chosenSkills.includes(id)) saveChosenSkills([...chosenSkills, id]);
		const text = draft.slice(0, skillTrigger.start) + draft.slice(skillTrigger.end);
		const caret = skillTrigger.start;
		setDraft(text);
		sessionStorage.setItem(`phone-draft:${selected.current}`, text);
		setSkillTrigger(undefined);
		requestAnimationFrame(() => {
			composerInput.current?.focus();
			composerInput.current?.setSelectionRange(caret, caret);
			setSkillTrigger(undefined);
		});
	}
	const [query, setQuery] = useState("");
	const [archived, setArchived] = useState(false);
	const archivedRef = useRef(false);
	const creatingSession = useRef(false);
	const [creating, setCreating] = useState(false);
	const [rename, setRename] = useState("");
	const [theme, setTheme] = useState(() => (localStorage.getItem("phone-theme") === "dark" ? "dark" : "light"));
	const [fontSize, setFontSize] = useState(() => (localStorage.getItem("phone-font") === "large" ? "large" : "normal"));
	const [thinking, setThinking] = useState(() => localStorage.getItem("phone-thinking") !== "false");
	const [tools, setTools] = useState(() => localStorage.getItem("phone-tools") !== "false");
	const transcript = useRef<HTMLDivElement>(null);
	const app = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const resize = () => {
			if (app.current) {
				app.current.style.height = `${viewport.height}px`;
				app.current.style.top = `${viewport.offsetTop}px`;
			}
			if (atBottom.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
		};
		resize();
		viewport.addEventListener("resize", resize);
		viewport.addEventListener("scroll", resize);
		return () => {
			viewport.removeEventListener("resize", resize);
			viewport.removeEventListener("scroll", resize);
		};
	}, []);
	useEffect(() => {
		const el = composer.current;
		if (!el) return;
		const observer = new ResizeObserver(() => {
			app.current?.style.setProperty("--phone-composer-height", `${el.getBoundingClientRect().height}px`);
			if (atBottom.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [snapshot?.session.id]);
	function preserveReading(change: () => void) {
		const el = transcript.current;
		const follow = atBottom.current;
		const top = el?.getBoundingClientRect().top ?? 0;
		const anchor = el ? Array.from(el.children).find((child) => child.getBoundingClientRect().bottom > top) : undefined;
		const offset = anchor?.getBoundingClientRect().top ?? 0;
		change();
		requestAnimationFrame(() => {
			if (!el) return;
			if (follow) el.scrollTop = el.scrollHeight;
			else if (anchor?.isConnected) el.scrollTop += anchor.getBoundingClientRect().top - offset;
		});
	}
	const atBottom = useRef(true);
	const [away, setAway] = useState(false);
	useEffect(() => {
		localStorage.setItem("phone-theme", theme);
		localStorage.setItem("phone-font", fontSize);
		localStorage.setItem("phone-thinking", String(thinking));
		localStorage.setItem("phone-tools", String(tools));
	}, [theme, fontSize, thinking, tools]);
	useEffect(() => {
		if (atBottom.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
	}, [snapshot, live, showList, thinking, tools, fontSize, composerCollapsed]);
	const client = useRef<PhoneClient | undefined>(undefined);
	const requestTeamStatus = useCallback((command: Command) => {
		if (!client.current) return Promise.reject(new Error("尚未连接"));
		return client.current.request(command);
	}, []);
	const selected = useRef("");
	const currentWorkspace = useRef(sessionStorage.getItem("phone-workspace") ?? "");
	const generation = useRef(0);
	const submission = useRef<{ payload: string; sessionId: string; key: string } | undefined>(undefined);
	useEffect(() => {
		history.replaceState(null, "", location.pathname);
		let active = true;
		setChecking(true);
		setError("");
		setStatus("正在检查授权");
		void phoneApi("session")
			.then((v) => {
				if (!active) return;
				setWorkbench(v.workbench === true);
				setAuthenticated(v.authenticated);
				setStatus(v.authenticated ? "连接中" : "此浏览器尚未配对");
			})
			.catch(() => {
				if (!active) return;
				setStatus("暂时无法连接");
				setError("暂时无法检查设备授权，请确认电脑在线、手机入口仍开启，然后重试。无需立即重新配对。");
			})
			.finally(() => {
				if (active) setChecking(false);
			});
		return () => {
			active = false;
		};
	}, [authCheck]);
	useEffect(() => {
		if (!pairing) return;
		let active = true;
		const timer = setInterval(() => {
			void phoneApi("claim", pairing)
				.then((v) => {
					if (active && v.approved) {
						setPairing(undefined);
						setWorkbench(v.workbench === true);
						setAuthenticated(true);
						setError("");
					}
				})
				.catch((e) => {
					if (active) {
						setPairing(undefined);
						setError(e.message);
					}
				});
		}, 2000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [pairing]);
	async function refreshSnapshot(c = client.current) {
		const id = selected.current;
		if (!id || !c) return;
		const result = await c.request({ type: "session.snapshot.get", sessionId: id });
		if (selected.current === id && result.type === "session.snapshot") {
			setSnapshot((old) =>
				!old || old.session.id !== id || result.snapshot.revision >= old.revision ? result.snapshot : old
			);
			setSessions((old) => old.map((s) => (s.id === id ? result.snapshot.session : s)));
			setLive((old) =>
				Object.fromEntries(
					Object.entries(old).filter(([key]) => !result.snapshot.transcript.some((item) => item.id === key))
				)
			);
		}
	}
	async function loadWorkspace(id: string, c = client.current) {
		if (!c) return;
		currentWorkspace.current = id;
		setWorkspaceId(id);
		sessionStorage.setItem("phone-workspace", id);
		const filter = archivedRef.current;
		const request = ++listGeneration.current;
		setSessionsLoading(true);
		setSessionsError("");
		try {
			const result = await c.request({ type: "session.list", workspaceId: id, archived: filter, limit: 200 });
			if (
				request === listGeneration.current &&
				currentWorkspace.current === id &&
				filter === archivedRef.current &&
				result.type === "session.list"
			)
				setSessions(result.sessions);
		} catch (e) {
			if (request === listGeneration.current) setSessionsError(e instanceof Error ? e.message : String(e));
			throw e;
		} finally {
			if (request === listGeneration.current) setSessionsLoading(false);
		}
	}
	useEffect(() => {
		if (!authenticated) return;
		let active = true;
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		let refreshInFlight = false;
		let refreshNeeded = false;
		const scheduleRefresh = () => {
			refreshNeeded = true;
			if (refreshTimer || refreshInFlight) return;
			refreshTimer = setTimeout(() => {
				refreshTimer = undefined;
				refreshNeeded = false;
				refreshInFlight = true;
				void refreshSnapshot(c)
					.catch((e) => {
						if (active) setError(e.message);
					})
					.finally(() => {
						refreshInFlight = false;
						if (active && refreshNeeded) scheduleRefresh();
					});
			}, 1000);
		};
		const c = new PhoneClient(
			(message) => {
				if (!active) return;
				if (
					message.type === "progress" &&
					message.event.type === "assistant.delta" &&
					message.event.kind === "text" &&
					message.event.sessionId === selected.current
				) {
					const event = message.event;
					setLive((old) => ({ ...old, [event.itemId]: (old[event.itemId] ?? "") + event.delta }));
				}
				if (message.type === "event") {
					const event = message.event;
					if (event.type === "session.phase.changed") {
						setSessions((old) => old.map((s) => (s.id === event.sessionId ? { ...s, phase: event.phase } : s)));
					}
					if (
						(event.type === "session.snapshot"
							? event.snapshot.session.id
							: "sessionId" in event
								? event.sessionId
								: undefined) === selected.current
					)
						scheduleRefresh();
				}
			},
			(value) => {
				if (active) setStatus(value);
			},
			() => {
				void (async () => {
					const result = await c.request({ type: "workspace.list" });
					if (!active || result.type !== "workspace.list") return;
					setWorkspaces(result.workspaces);
					const id = result.workspaces.find((w) => w.id === currentWorkspace.current)?.id ?? result.workspaces[0]?.id;
					const catalog = await c.request({ type: "model.list" });
					if (catalog.type === "model.list") {
						setModels(catalog.models.filter((m) => m.authenticated));
					}
					if (id) await loadWorkspace(id, c);
					if (!selected.current && id) {
						const recent = sessionStorage.getItem(`phone-recent:${id}`);
						if (recent) await openSession({ id: recent } as SessionSummary);
					}
					if (selected.current) {
						await c.request({ type: "session.attach", sessionId: selected.current });
						setLive({});
						await refreshSnapshot(c);
					}
				})().catch((e) => {
					if (active) setError(e.message);
				});
			}
		);
		client.current = c;
		c.connect();
		const visible = () => {
			if (document.visibilityState === "visible") void refreshSnapshot(c).catch(() => {});
		};
		document.addEventListener("visibilitychange", visible);
		return () => {
			active = false;
			clearTimeout(refreshTimer);
			c.close();
			document.removeEventListener("visibilitychange", visible);
		};
	}, [authenticated]);
	useEffect(() => {
		setSkills([]);
		setSkillsError("");
		setSkillsLoading(false);
		if (!workbench || !workspaceId || status !== "已连接") return;
		setSkillsLoading(true);
		let active = true;
		void client.current
			?.request({ type: "skill.list", workspaceId })
			.then((r) => {
				if (active && r.type === "skill.list") setSkills(r.skills);
			})
			.catch((e) => {
				if (active) setSkillsError(e.message);
			})
			.finally(() => {
				if (active) setSkillsLoading(false);
			});
		return () => {
			active = false;
		};
	}, [workbench, workspaceId, status, skillsRetry]);
	async function openSession(session: SessionSummary) {
		const c = client.current;
		if (!c) return;
		const n = ++generation.current;
		if (selected.current) {
			sessionStorage.setItem(`phone-draft:${selected.current}`, draft);
			void c.request({ type: "session.detach", sessionId: selected.current }).catch(() => {});
		}
		selected.current = session.id;
		atBottom.current = true;
		setAway(false);
		sessionStorage.setItem(`phone-recent:${currentWorkspace.current}`, session.id);
		setAttachments(stored(`phone-files:${session.id}`, []));
		setChosenSkills(stored(`phone-skills:${session.id}`, []));
		setSkillTrigger(undefined);
		setSnapshot(undefined);
		setLive({});
		setShowList(false);
		setPanel(null);
		setComposerCollapsed(false);
		setError("");
		setDraft(sessionStorage.getItem(`phone-draft:${session.id}`) ?? "");
		try {
			const result = await c.request({ type: "session.attach", sessionId: session.id });
			if (n === generation.current && result.type === "session.attached") {
				setSnapshot(result.snapshot);
				setRename(result.snapshot.session.name ?? "");
				setSessions((old) => old.map((s) => (s.id === session.id ? result.snapshot.session : s)));
				if (sessionStorage.getItem(`phone-submission:${session.id}`))
					setError("上次发送结果可能未知，请先核对历史；相同草稿重发将复用原提交 ID。");
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}
	async function act(command: Command, key?: string) {
		setBusy(true);
		setError("");
		try {
			if (!client.current) throw new Error("尚未连接");
			await client.current.request(command, key);
			// A successful mutation stays successful even if the follow-up read fails.
			try {
				await refreshSnapshot();
				if (["session.rename", "session.archive"].includes(command.type)) await loadWorkspace(currentWorkspace.current);
			} catch (e) {
				setError(`操作已提交，状态同步失败：${e instanceof Error ? e.message : String(e)}`);
			}
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			setBusy(false);
		}
	}
	async function send() {
		const text = draft.trim(),
			sessionId = selected.current;
		if (
			(!text && !attachments.length) ||
			!sessionId ||
			busy ||
			panel ||
			showList ||
			status !== "已连接" ||
			snapshot?.session.phase !== "idle" ||
			snapshot.session.archivedAt
		)
			return;
		const content: UserContentPart[] = [
			...(text ? [{ type: "text" as const, text }] : []),
			...attachments.map((artifact) => ({ type: "artifact" as const, artifact })),
		];
		const payload = JSON.stringify({ content, skills: chosenSkills });
		try {
			submission.current = JSON.parse(sessionStorage.getItem(`phone-submission:${sessionId}`) ?? "null") ?? undefined;
		} catch {
			submission.current = undefined;
		}
		// Preserve the first version's text-only pending ID when upgrading an unknown submission.
		const legacy = submission.current as typeof submission.current & { text?: string };
		if (legacy?.text === text && legacy.sessionId === sessionId && !attachments.length && !chosenSkills.length)
			legacy.payload = payload;
		if (!submission.current || submission.current.payload !== payload || submission.current.sessionId !== sessionId)
			submission.current = { payload, sessionId, key: crypto.randomUUID() };
		sessionStorage.setItem(`phone-submission:${sessionId}`, JSON.stringify(submission.current));
		if (
			await act(
				{ type: "turn.prompt", sessionId, content, ...(chosenSkills.length ? { skills: chosenSkills } : {}) },
				submission.current.key
			)
		) {
			sessionStorage.removeItem(`phone-submission:${sessionId}`);
			sessionStorage.removeItem(`phone-draft:${sessionId}`);
			submission.current = undefined;
			sessionStorage.removeItem(`phone-files:${sessionId}`);
			const remainingSkills = chosenSkills.filter((id) => id !== "team");
			sessionStorage.setItem(`phone-skills:${sessionId}`, JSON.stringify(remainingSkills));
			if (selected.current === sessionId) {
				setChosenSkills(remainingSkills);
				setDraft("");
				setSkillTrigger(undefined);
				setAttachments([]);
			}
		}
	}
	const newSessionModel = models.find((m) => snapshot && modelKey(m.model) === modelKey(snapshot.model)) ?? models[0];
	async function createSession() {
		const model = newSessionModel;
		if (
			!model ||
			busy ||
			creatingSession.current ||
			!workbench ||
			status !== "已连接" ||
			!workspaceId ||
			!client.current
		)
			return;
		creatingSession.current = true;
		setCreating(true);
		setBusy(true);
		setError("");
		const command: Command = {
			type: "session.create",
			workspaceId,
			name: "新对话",
			model: model.model,
			thinkingLevel: "off",
			sandboxMode: "workspace_write",
			approvalPolicy: "on_risk",
		};
		try {
			const payload = JSON.stringify(command);
			const previous = stored<{ payload: string; key: string } | null>("phone-create", null);
			const operation = previous?.payload === payload ? previous : { payload, key: crypto.randomUUID() };
			sessionStorage.setItem("phone-create", JSON.stringify(operation));
			const result = await client.current!.request(command, operation.key);
			if (result.type === "session.created") {
				sessionStorage.removeItem("phone-create");
				setQuery("");
				archivedRef.current = false;
				setArchived(false);
				await loadWorkspace(workspaceId);
				await openSession(result.snapshot.session);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			creatingSession.current = false;
			setCreating(false);
			setBusy(false);
		}
	}
	async function upload(files: FileList | null) {
		if (!files || !snapshot || busy) return;
		const id = snapshot.session.id,
			workspace = snapshot.session.workspaceId;
		setBusy(true);
		setError("");
		const added = [...attachments];
		try {
			if (added.length + files.length > 8) throw new Error("每条消息最多 8 个附件");
			for (const file of Array.from(files)) {
				if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MB`);
				const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace)}/artifacts`, {
					method: "POST",
					credentials: "same-origin",
					headers: {
						"Content-Type": file.type || "application/octet-stream",
						"X-Wuming-File-Name": encodeURIComponent(file.name),
					},
					body: file,
					signal: AbortSignal.timeout(30000),
				});
				const value = await response.json();
				if (!response.ok) throw new Error(value.error ?? "上传失败");
				added.push(value.artifact);
				sessionStorage.setItem(`phone-files:${id}`, JSON.stringify(added));
				if (selected.current === id) setAttachments([...added]);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}
	const activeModel = models.find((m) => snapshot && modelKey(m.model) === modelKey(snapshot.model));
	return (
		<div ref={app} className={`phone-app phone-${theme} phone-font-${fontSize}`}>
			<header className="phone-header">
				{authenticated && (
					<button className="phone-icon" aria-label="打开会话列表" onClick={() => setShowList(true)}>
						<Menu size={21} />
					</button>
				)}
				<div className="phone-title">
					<h1>{authenticated ? snapshot?.session.name || "Pi-Wm" : "Pi-Wm"}</h1>
					<small>
						{authenticated ? workspaces.find((w) => w.id === workspaceId)?.name || "手机工作台" : "你的随身工作台"}
					</small>
				</div>
				<span className={`phone-connection ${status === "已连接" ? "online" : ""}`} role="status" title={status}>
					<span className="phone-status-dot" aria-hidden="true" />
					<span className="phone-status-text">{status}</span>
				</span>
				{authenticated && status !== "已连接" && !status.startsWith("授权已撤销") && (
					<button onClick={() => client.current?.reconnect()}>重新连接</button>
				)}
				{authenticated && (
					<button className="phone-icon" aria-label="会话设置" onClick={() => setPanel("settings")}>
						<MoreHorizontal size={22} />
					</button>
				)}
			</header>
			<PhonePanel error={error} open={panel === "settings"} title="会话设置" onClose={() => setPanel(null)}>
				<p className="phone-panel-note">{snapshot?.session.name || "Pi-Wm 手机工作台"}</p>
				{snapshot && workbench && (
					<div className="phone-setting-grid">
						<label>
							重命名会话
							<input maxLength={500} value={rename} onChange={(e) => setRename(e.target.value)} />
						</label>
						<button
							disabled={busy || status !== "已连接" || !rename.trim()}
							onClick={() => void act({ type: "session.rename", sessionId: snapshot.session.id, name: rename.trim() })}
						>
							保存名称
						</button>
						<button
							disabled={busy || status !== "已连接" || snapshot.session.phase !== "idle"}
							onClick={() =>
								void act({
									type: "session.archive",
									sessionId: snapshot.session.id,
									archived: !snapshot.session.archivedAt,
								})
							}
						>
							{snapshot.session.archivedAt ? "恢复会话" : "归档会话"}
						</button>
					</div>
				)}
				<fieldset className="phone-preferences">
					<legend>显示偏好</legend>
					<label>
						主题
						<select aria-label="主题" value={theme} onChange={(e) => setTheme(e.target.value)}>
							<option value="light">浅色</option>
							<option value="dark">深色</option>
						</select>
					</label>
					<label>
						字号
						<select
							aria-label="字号"
							value={fontSize}
							onChange={(e) => preserveReading(() => setFontSize(e.target.value))}
						>
							<option value="normal">标准</option>
							<option value="large">大字</option>
						</select>
					</label>
					<label className="phone-check">
						<input
							type="checkbox"
							checked={thinking}
							onChange={(e) => preserveReading(() => setThinking(e.target.checked))}
						/>
						显示思考过程
					</label>
					<label className="phone-check">
						<input
							type="checkbox"
							checked={tools}
							onChange={(e) => preserveReading(() => setTools(e.target.checked))}
						/>
						显示工具过程
					</label>
				</fieldset>
				<div className="phone-setting-grid">
					<button onClick={() => void refreshSnapshot().catch((e) => setError(e.message))}>同步状态</button>
					<button
						onClick={() => {
							void phoneApi("logout", {})
								.then(() => {
									setPanel(null);
									setAuthenticated(false);
									setSnapshot(undefined);
									selected.current = "";
									setStatus("已退出，请重新配对");
								})
								.catch((e) => setError(e.message));
						}}
					>
						退出授权
					</button>
				</div>
				<small>沿用电脑会话权限；断线不会自动重发指令。</small>
			</PhonePanel>
			{error && (
				<div className="phone-error" role="alert">
					{error}
				</div>
			)}
			{!authenticated ? (
				<PhoneWelcome
					checking={checking}
					pairing={Boolean(pairing)}
					hasPairLink={Boolean(pairSecret)}
					retry={() => setAuthCheck((n) => n + 1)}
				>
					{pairSecret ? (
						<>
							<label>
								设备名称
								<input maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
							</label>
							<button
								className="phone-primary"
								disabled={Boolean(pairing) || busy}
								onClick={() => {
									setBusy(true);
									setError("");
									void phoneApi("pair", { secret: pairSecret, name })
										.then(setPairing)
										.catch((e) => setError(e.message))
										.finally(() => setBusy(false));
								}}
							>
								{pairing ? "等待电脑确认配对…" : "请求配对这部手机"}
							</button>
						</>
					) : null}
				</PhoneWelcome>
			) : (
				<div className={`phone-workbench ${showList ? "show-list" : "show-chat"}`}>
					<PhonePanel error={error} open={showList} title="项目与会话" drawer onClose={() => setShowList(false)}>
						<PhoneSidebar
							workspaces={workspaces}
							workspaceId={workspaceId}
							sessions={sessions}
							selectedId={snapshot?.session.id}
							busy={busy}
							loading={sessionsLoading}
							loadError={sessionsError}
							connected={status === "已连接"}
							query={query}
							archived={archived}
							onQuery={setQuery}
							onRefresh={() => void loadWorkspace(workspaceId).catch((e) => setError(e.message))}
							onSession={(session) => void openSession(session)}
							onArchive={(value) => {
								archivedRef.current = value;
								setArchived(value);
								setSessions([]);
								void loadWorkspace(workspaceId).catch((e) => setError(e.message));
							}}
							onWorkspace={(id) => {
								if (selected.current) {
									sessionStorage.setItem(`phone-draft:${selected.current}`, draft);
									void client.current?.request({ type: "session.detach", sessionId: selected.current }).catch(() => {});
								}
								++generation.current;
								selected.current = "";
								setSessions([]);
								setQuery("");
								setSnapshot(undefined);
								archivedRef.current = false;
								setArchived(false);
								void loadWorkspace(id).catch((e) => setError(e.message));
							}}
						>
							{!workbench && (
								<p className="phone-notice">
									当前为基础接续授权。新建会话、模型/技能和上传附件需重新配对，并在电脑勾选完整对话能力。
								</p>
							)}
							{workbench && (
								<button
									className="phone-new"
									disabled={busy || status !== "已连接" || !workspaceId || !newSessionModel}
									aria-busy={creating}
									title={
										!newSessionModel
											? "请先在电脑端配置可用模型"
											: `在 ${workspaces.find((w) => w.id === workspaceId)?.name || "当前项目"} 中创建对话`
									}
									onClick={() => void createSession()}
								>
									<SquarePen size={18} aria-hidden="true" />
									<span>{creating ? "正在创建…" : "新对话"}</span>
								</button>
							)}
						</PhoneSidebar>
					</PhonePanel>
					<main className="phone-chat">
						{!snapshot && (
							<div className="phone-empty">
								<span className="phone-mark">✳</span>
								<h2>想法，从这里继续</h2>
								<p>打开电脑上的会话，或在已授权项目中开始新任务。</p>
								<button className="phone-primary" onClick={() => setShowList(true)}>
									选择会话
								</button>
							</div>
						)}
						{snapshot && workbench && (
							<PhonePanel error={error} open={panel === "model"} title="模型与思考" onClose={() => setPanel(null)}>
								<div className="phone-setting-grid">
									<label>
										当前模型
										<select
											disabled={busy || status !== "已连接" || snapshot.session.phase !== "idle"}
											value={modelKey(snapshot.model)}
											onChange={(e) => {
												const model = models.find((m) => modelKey(m.model) === e.target.value);
												if (model)
													void act({ type: "session.model.set", sessionId: snapshot.session.id, model: model.model });
											}}
										>
											{!activeModel && (
												<option value={modelKey(snapshot.model)}>{snapshot.model.id}（当前不可用）</option>
											)}
											{models.map((m) => (
												<option key={modelKey(m.model)} value={modelKey(m.model)}>
													{m.name}
												</option>
											))}
										</select>
									</label>
									<label>
										思考强度
										<select
											disabled={busy || status !== "已连接" || snapshot.session.phase !== "idle" || !activeModel}
											value={snapshot.thinkingLevel}
											onChange={(e) =>
												void act({
													type: "session.thinking.set",
													sessionId: snapshot.session.id,
													thinkingLevel: e.target.value as ThinkingLevel,
												})
											}
										>
											{[...new Set([snapshot.thinkingLevel, ...supportedThinkingLevels(activeModel)])].map((level) => (
												<option
													key={level}
													disabled={!supportedThinkingLevels(activeModel).includes(level)}
													value={level}
												>
													{
														{
															off: "关闭",
															minimal: "最低",
															low: "低",
															medium: "中",
															high: "高",
															xhigh: "更高",
															max: "最高",
														}[level]
													}
												</option>
											))}
										</select>
									</label>
								</div>
							</PhonePanel>
						)}
						<div
							className="phone-transcript"
							ref={transcript}
							onScroll={() => {
								const el = transcript.current!;
								atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
								setAway(!atBottom.current);
							}}
						>
							{snapshot?.transcript.map((item) => (
								<PhoneMessage key={item.id} item={item} thinking={thinking} tools={tools} />
							))}
							{Object.entries(live).map(([id, text]) => (
								<article key={id} className="phone-message assistant">
									<strong>Pi-Wm · 正在回复</strong>
									<PhoneMessageContent parts={[{ type: "text", text }]} thinking={thinking} />
								</article>
							))}
							{snapshot &&
								snapshot.transcript.some(
									(item) =>
										item.type === "tool" && ["team_start", "TeamCreate"].includes(item.toolName) && !item.isError
								) && (
									<PhoneTeamStatus
										key={snapshot.session.id}
										sessionId={snapshot.session.id}
										workspaceId={snapshot.session.workspaceId}
										connected={status === "已连接"}
										request={requestTeamStatus}
									/>
								)}
							{snapshot?.pendingApprovals.map((a) => (
								<section className="phone-approval" key={a.id}>
									<strong>
										需要你确认 · {a.risk === "high" ? "高风险" : a.risk === "medium" ? "中风险" : "低风险"}
									</strong>
									<p>{a.summary}</p>
									<details>
										<summary>查看请求能力</summary>
										<pre>{JSON.stringify(a.capabilities, null, 2)}</pre>
									</details>
									{a.capabilities.some((capability) => capability.type === "computer.use") ? (
										<p role="status">此操作需要在电脑端确认，手机无法批准或拒绝。请在电脑处理后继续。</p>
									) : (
										<div className="phone-actions">
											<button
												disabled={busy || status !== "已连接"}
												onClick={() =>
													void act({
														type: "approval.respond",
														sessionId: a.sessionId,
														approvalId: a.id,
														decision: "approve",
													})
												}
											>
												批准此操作
											</button>
											<button
												disabled={busy || status !== "已连接"}
												onClick={() =>
													void act({
														type: "approval.respond",
														sessionId: a.sessionId,
														approvalId: a.id,
														decision: "deny",
													})
												}
											>
												拒绝
											</button>
										</div>
									)}
								</section>
							))}
						</div>
						{away && (
							<button
								className="phone-jump"
								onClick={() => {
									atBottom.current = true;
									transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: "smooth" });
								}}
							>
								回到底部
							</button>
						)}
						{snapshot && (
							<>
								<form
									ref={composer}
									className="phone-composer"
									onSubmit={(e) => {
										e.preventDefault();
										void send();
									}}
								>
									{skillMenuOpen && (
										<div className="phone-skill-suggest">
											<div className="phone-skill-heading">
												<span>技能 · 电脑已安装</span>
												<button
													type="button"
													className="phone-icon"
													aria-label="关闭技能建议"
													onClick={() => setSkillTrigger(undefined)}
												>
													×
												</button>
											</div>
											<div id="phone-skill-options" role="listbox" aria-label="选择技能">
												{skillSuggestions.map((item, index) => (
													<button
														type="button"
														role="option"
														id={`phone-skill-option-${index}`}
														aria-selected={index === skillIndex}
														key={item.id}
														disabled={busy || (!chosenSkills.includes(item.skillId!) && chosenSkills.length >= 8)}
														onMouseDown={(e) => e.preventDefault()}
														onClick={() => chooseSkill(item.skillId!)}
													>
														<strong>{item.label}</strong>
														<small>{item.detail}</small>
														<small>{chosenSkills.includes(item.skillId!) ? "已选择" : item.badge}</small>
													</button>
												))}
												{!skillSuggestions.length && (
													<p role="status">
														{skillsLoading
															? "正在加载电脑技能…"
															: skillsError
																? `技能加载失败：${skillsError}`
																: status !== "已连接"
																	? "连接恢复后可选择技能"
																	: skills.length
																		? "没有匹配的技能"
																		: "当前项目没有可选择的技能"}
													</p>
												)}
											</div>
											{skillsError && (
												<button
													type="button"
													disabled={status !== "已连接" || skillsLoading}
													onClick={() => setSkillsRetry((n) => n + 1)}
												>
													重试加载技能
												</button>
											)}
											{chosenSkills.length >= 8 && <small>最多选择 8 个技能，请先移除不需要的技能。</small>}
										</div>
									)}
									{workbench && chosenSkills.length > 0 && (
										<div className="phone-selected-skills" aria-label="已选技能">
											{chosenSkills.map((id) => {
												const name = skills.find((s) => s.id === id)?.name ?? id;
												return (
													<button
														key={id}
														type="button"
														disabled={busy}
														aria-label={`移除技能 ${name}`}
														onClick={() => saveChosenSkills(chosenSkills.filter((value) => value !== id))}
													>
														{name} ×
													</button>
												);
											})}
										</div>
									)}
									<div className="phone-attachment-list" hidden={!attachments.length}>
										{attachments.map((a) => (
											<div className="phone-attachment-chip" key={a.id}>
												<span>{a.name}</span>
												<button
													type="button"
													disabled={busy}
													onClick={() => {
														const next = attachments.filter((f) => f.id !== a.id);
														setAttachments(next);
														sessionStorage.setItem(`phone-files:${selected.current}`, JSON.stringify(next));
													}}
												>
													移除附件
												</button>
											</div>
										))}
									</div>
									<div className="phone-composer-tools">
										{workbench && (
											<>
												<button
													type="button"
													className="phone-pill"
													aria-label="选择模型与思考"
													onClick={() => setPanel("model")}
												>
													<span>{activeModel?.name || snapshot.model.id}</span>
													<ChevronDown size={14} />
												</button>
											</>
										)}
										<span className="phone-phase">{phaseNames[snapshot.session.phase]}</span>
										<button
											type="button"
											className="phone-icon phone-collapse"
											aria-label={composerCollapsed ? "展开输入区" : "收起输入区"}
											aria-expanded={!composerCollapsed}
											onClick={() => setComposerCollapsed((v) => !v)}
										>
											<ChevronDown size={18} />
										</button>
									</div>
									<input
										ref={fileInput}
										hidden
										type="file"
										multiple
										aria-label="上传附件（最多 8 个，每个 10 MB）"
										disabled={!workbench || busy || status !== "已连接"}
										onChange={(e) => {
											void upload(e.target.files);
											e.target.value = "";
										}}
									/>
									<div className="phone-input-box" hidden={composerCollapsed}>
										<label className="phone-sr-only" htmlFor="phone-message">
											继续这段对话
										</label>
										<textarea
											id="phone-message"
											ref={composerInput}
											disabled={busy}
											value={draft}
											maxLength={32000}
											onChange={(e) => {
												setDraft(e.target.value);
												updateSkillTrigger(e.target.value, e.target.selectionStart);
												sessionStorage.setItem(`phone-draft:${selected.current}`, e.target.value);
											}}
											onClick={(e) => updateSkillTrigger(e.currentTarget.value, e.currentTarget.selectionStart)}
											aria-controls={skillMenuOpen ? "phone-skill-options" : undefined}
											aria-expanded={skillMenuOpen}
											aria-activedescendant={
												skillMenuOpen && skillSuggestions[skillIndex] ? `phone-skill-option-${skillIndex}` : undefined
											}
											onKeyDown={(e) => {
												if (!skillMenuOpen || e.nativeEvent.isComposing) return;
												if (e.key === "Escape") {
													e.preventDefault();
													setSkillTrigger(undefined);
												}
												if (e.key === "ArrowDown" || e.key === "ArrowUp") {
													e.preventDefault();
													const next = cycleIndex(skillIndex, e.key === "ArrowDown" ? 1 : -1, skillSuggestions.length);
													setSkillIndex(next);
													document.getElementById(`phone-skill-option-${next}`)?.scrollIntoView({ block: "nearest" });
												}
												if (e.key === "Enter" || e.key === "Tab") {
													e.preventDefault();
													const item = skillSuggestions[skillIndex];
													if (item?.skillId) chooseSkill(item.skillId);
												}
											}}
											placeholder={workbench ? "发送消息，输入 / 选择技能…" : "发送消息，继续你的想法…"}
											rows={1}
										/>
										<div className="phone-input-actions">
											{workbench && (
												<button
													type="button"
													className="phone-icon"
													aria-label="添加附件"
													disabled={busy || status !== "已连接"}
													onClick={() => fileInput.current?.click()}
												>
													<Plus size={22} />
												</button>
											)}
											<span className="phone-input-hint">
												{attachments.length ? `${attachments.length} 个附件` : "由电脑执行"}
											</span>
											<button
												aria-label="发送"
												className="phone-primary phone-send"
												disabled={
													busy ||
													status !== "已连接" ||
													(!draft.trim() && !attachments.length) ||
													Boolean(snapshot.session.archivedAt) ||
													snapshot.session.phase !== "idle"
												}
											>
												<ArrowUp size={21} />
											</button>
											<button
												aria-label="停止任务"
												className="phone-icon phone-stop"
												hidden={snapshot.session.phase === "idle"}
												type="button"
												disabled={busy || status !== "已连接" || snapshot.session.phase === "idle"}
												onClick={() => void act({ type: "turn.abort", sessionId: snapshot.session.id })}
											>
												<Square size={18} />
											</button>
										</div>
									</div>
									<small
										className="phone-compose-notice"
										hidden={!busy && !snapshot.session.archivedAt && snapshot.session.phase === "idle"}
									>
										{busy
											? "正在处理，请勿重复提交。"
											: snapshot.session.archivedAt
												? "已归档，请先恢复会话。"
												: "电脑正在执行或等待处理，可先编辑草稿，空闲后再发送。"}
									</small>
								</form>
							</>
						)}
					</main>
				</div>
			)}
		</div>
	);
}

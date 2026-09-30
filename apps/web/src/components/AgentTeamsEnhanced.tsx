/**
 * Agent Teams Enhanced Components
 * 增强版成员卡片和任务卡片组件
 *
 * 使用方法：
 * 1. 导入增强样式: import "./agent-teams-enhanced.css"
 * 2. 使用增强的类名替换原有类名
 * 3. 添加 data-status 属性以支持状态指示灯
 */

import type { CSSProperties } from "react";
import { Check, Clock, GitBranch, Loader2, AlertCircle } from "lucide-react";

// ===== 增强的成员卡片组件 =====
interface EnhancedMemberCardProps {
	id: string;
	name: string;
	role: string;
	avatar: string;
	status: "idle" | "working" | "running" | "completed" | "error";
	isLead?: boolean;
	accent: string;
	tasksCompleted: number;
	tasksTotal: number;
	selected?: boolean;
	onClick: () => void;
}

export function EnhancedMemberCard({
	id,
	name,
	role,
	avatar,
	status,
	isLead = false,
	accent,
	tasksCompleted,
	tasksTotal,
	selected = false,
	onClick,
}: EnhancedMemberCardProps) {
	const progress = tasksTotal > 0 ? (tasksCompleted / tasksTotal) * 100 : 0;

	return (
		<button
			type="button"
			className={`teams-member-enhanced ${isLead ? "is-lead" : ""} ${selected ? "selected" : ""}`}
			style={{ "--member-accent": accent } as CSSProperties}
			data-status={status}
			aria-pressed={selected}
			onClick={onClick}
		>
			<img src={avatar} alt="" />
			<div className="teams-member-copy-enhanced">
				<small>{isLead ? "LEAD" : `AGENT ${id.padStart(2, "0")}`}</small>
				<strong title={name}>{name}</strong>
				<span>
					{status === "idle" && "Idle"}
					{status === "working" && "Working"}
					{status === "running" && "Running"}
					{status === "completed" && "Completed"}
					{status === "error" && "Error"}
				</span>
				<div className="teams-member-stats">
					<span className="teams-member-stat-badge">
						{tasksCompleted}/{tasksTotal} tasks
					</span>
				</div>
			</div>
			<span className="teams-member-progress-enhanced">
				<span style={{ width: `${progress}%` }} />
			</span>
		</button>
	);
}

// ===== 增强的任务卡片组件 =====
interface EnhancedTaskCardProps {
	id: string;
	title: string;
	objective: string;
	status: "waiting" | "running" | "completed" | "attention";
	dependencyCount?: number;
	selected?: boolean;
	style?: CSSProperties;
	onClick: () => void;
}

export function EnhancedTaskCard({
	id,
	title,
	objective,
	status,
	dependencyCount = 0,
	selected = false,
	style,
	onClick,
}: EnhancedTaskCardProps) {
	const statusIcons = {
		waiting: Clock,
		running: Loader2,
		completed: Check,
		attention: AlertCircle,
	};

	const StatusIcon = statusIcons[status];

	return (
		<button
			type="button"
			className={`teams-task-enhanced state-${status} ${selected ? "selected" : ""}`}
			style={style}
			aria-pressed={selected}
			title={`${title}\n${objective}`}
			onClick={onClick}
		>
			<strong>{title}</strong>
			<span className="teams-task-objective-enhanced">{objective}</span>
			<div className="teams-task-footer-enhanced">
				<span className={`teams-status-enhanced state-${status}`}>
					<StatusIcon size={12} />
					<span>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
				</span>
				{dependencyCount > 0 && (
					<span className="teams-dependency-badge">
						<GitBranch size={10} />
						{dependencyCount}
					</span>
				)}
			</div>
		</button>
	);
}

// ===== 增强的指标卡片组件 =====
interface MetricCardProps {
	label: string;
	value: string | number;
	icon?: React.ReactNode;
}

export function MetricCard({ label, value, icon }: MetricCardProps) {
	return (
		<div className="teams-metric-card">
			<dt>
				{icon && <span style={{ marginRight: "4px" }}>{icon}</span>}
				{label}
			</dt>
			<dd>{value}</dd>
		</div>
	);
}

// ===== 使用示例 =====
/*
import { EnhancedMemberCard, EnhancedTaskCard, MetricCard } from "./AgentTeamsEnhanced";
import leadAvatar from "../assets/agent-teams/team-lead.png";
import "./agent-teams-enhanced.css";

function ExampleUsage() {
	return (
		<div>
			<EnhancedMemberCard
				id="1"
				name="Team Lead"
				role="Coordinator"
				avatar={leadAvatar}
				status="working"
				isLead={true}
				accent="var(--green)"
				tasksCompleted={5}
				tasksTotal={8}
				selected={false}
				onClick={() => console.log("Member clicked")}
			/>

			<EnhancedTaskCard
				id="task-1"
				title="Implement authentication"
				objective="Add JWT-based authentication to the API"
				status="running"
				dependencyCount={2}
				selected={false}
				onClick={() => console.log("Task clicked")}
			/>

			<div className="teams-metrics-enhanced">
				<MetricCard label="Total Tokens" value="15,420" />
				<MetricCard label="Cost" value="$0.0234" />
				<MetricCard label="Duration" value="12.5s" />
			</div>
		</div>
	);
}
*/

// ===== 辅助函数 =====

/**
 * 将任务状态映射到视觉状态
 */
export function mapTaskStatus(status: string): "waiting" | "running" | "completed" | "attention" {
	if (status === "completed") return "completed";
	if (["failed", "awaiting_approval", "cancelled", "skipped"].includes(status)) return "attention";
	if (status === "running" || status === "cancelling") return "running";
	return "waiting";
}

/**
 * 生成成员强调色
 */
export function getMemberAccent(index: number, isLead: boolean): string {
	if (isLead) return "var(--green)";
	const accents = ["var(--blue)", "var(--amber)", "var(--green)", "var(--tok-keyword)"];
	return accents[(index - 1) % accents.length] ?? "var(--blue)";
}

/**
 * 格式化时间戳
 */
export function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

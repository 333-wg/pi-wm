import { ArrowUpRight, CircleAlert, LoaderCircle, Users } from "lucide-react";
import type { TranscriptItem } from "@wuming/protocol";
import { useT } from "../lib/locale.js";

export function TeamLaunchNotice({
	transcript,
	onOpen,
}: {
	transcript: TranscriptItem[];
	onOpen: (teamId: string) => void;
}) {
	const t = useT();
	const launch = transcript.findLast((item) => item.type === "tool" && item.toolName === "team_start");
	if (!launch || launch.type !== "tool") return null;
	const failed = launch.isError || launch.status === "error" || launch.status === "aborted";
	let teamId: string | undefined;
	if (!failed && launch.status === "complete") {
		try {
			const part = launch.content.find((value) => value.type === "text");
			const receipt = part?.type === "text" ? JSON.parse(part.text) : undefined;
			if (typeof receipt?.teamId === "string" && receipt.teamId.length > 0 && receipt.teamId.length <= 200)
				teamId = receipt.teamId;
		} catch {
			/* A malformed result must not be presented as a successful launch. */
		}
	}
	const pending = !failed && (launch.status === "running" || launch.status === "pending");
	return (
		<div className={`team-launch-notice${failed || (!pending && !teamId) ? " failed" : ""}`} role="status">
			{pending ? <LoaderCircle size={15} className="spin" /> : teamId ? <Users size={15} /> : <CircleAlert size={15} />}
			<span>{t(pending ? "teamLaunching" : teamId ? "teamCreated" : "teamLaunchFailed")}</span>
			{teamId && (
				<>
					<code title={teamId}>{teamId}</code>
					<button
						className="icon-button"
						type="button"
						title={t("openTeam")}
						aria-label={t("openTeam")}
						onClick={() => onOpen(teamId)}
					>
						<ArrowUpRight size={16} />
					</button>
				</>
			)}
		</div>
	);
}

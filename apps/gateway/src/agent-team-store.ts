import { DatabaseSync } from "node:sqlite";
import { deflateSync, inflateSync } from "node:zlib";
import type { AgentTeam } from "@wuming/protocol";

/** All claims, mailbox writes and replay frames commit in the same transaction. */
export class AgentTeamStore {
	readonly db: DatabaseSync;
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS agent_teams(id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS agent_team_history(team_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(team_id,revision));
			CREATE TABLE IF NOT EXISTS agent_team_actions(team_id TEXT NOT NULL, action_id TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(team_id,action_id));`);
	}
	list(): AgentTeam[] {
		return this.db
			.prepare("SELECT state FROM agent_teams ORDER BY rowid")
			.all()
			.map((row) => JSON.parse(String(row.state)) as AgentTeam);
	}
	get(id: string): AgentTeam | undefined {
		const row = this.db.prepare("SELECT state FROM agent_teams WHERE id=? OR session_id=?").get(id, id);
		return row ? (JSON.parse(String(row.state)) as AgentTeam) : undefined;
	}
	history(id: string, revision: number): AgentTeam | undefined {
		const row = this.db
			.prepare("SELECT state FROM agent_team_history WHERE team_id=? AND revision=?")
			.get(id, revision);
		return row
			? (JSON.parse(
					typeof row.state === "string" ? row.state : inflateSync(row.state as Uint8Array).toString("utf8")
				) as AgentTeam)
			: undefined;
	}
	action<T>(teamId: string, actionId: string): T | undefined {
		const row = this.db
			.prepare("SELECT result FROM agent_team_actions WHERE team_id=? AND action_id=?")
			.get(teamId, actionId);
		return row ? (JSON.parse(String(row.result)) as T) : undefined;
	}
	create(team: AgentTeam): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const json = JSON.stringify(team);
			this.db.prepare("INSERT INTO agent_teams VALUES(?,?,?)").run(team.id, team.sessionId, json);
			this.db.prepare("INSERT INTO agent_team_history VALUES(?,?,?)").run(team.id, team.revision, deflateSync(json));
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	change<T>(id: string, fn: (team: AgentTeam) => T, actionId?: string): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (actionId) {
				const previous = this.action<T>(id, actionId);
				if (previous !== undefined) {
					this.db.exec("COMMIT");
					return previous;
				}
			}
			const team = this.get(id);
			if (!team) throw new Error("Team not found");
			const result = fn(team);
			team.revision += 1;
			team.updatedAt = Date.now();
			const json = JSON.stringify(team);
			this.db.prepare("UPDATE agent_teams SET session_id=?, state=? WHERE id=?").run(team.sessionId, json, team.id);
			this.db.prepare("INSERT INTO agent_team_history VALUES(?,?,?)").run(team.id, team.revision, deflateSync(json));
			if (actionId)
				this.db
					.prepare("INSERT INTO agent_team_actions VALUES(?,?,?)")
					.run(team.id, actionId, JSON.stringify(result ?? null));
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	close(): void {
		this.db.close();
	}
}

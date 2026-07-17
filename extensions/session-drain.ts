import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXTENSION_NAME = "session-drain";
const DEFAULT_SESSION_DIR = "~/.pi/agent/sessions";
const MAX_TRANSCRIPT_ENTRIES = 100;
const MAX_TRANSCRIPT_CHARS = 40_000;
const TOOL_RESULT_LIMIT = 2_000;
const STATUSES = ["processed", "failed"] as const;
type DrainStatus = (typeof STATUSES)[number];

type Config = { sessionDirs?: string[] };
type StatusRecord = {
	session_id: string;
	session_path: string;
	session_dir: string;
	session_hash: string;
	status: DrainStatus;
	status_updated_at: string;
};
type State = { records: StatusRecord[] };
type SessionInfo = {
	session_id: string;
	session_path: string;
	session_dir: string;
	session_hash: string;
	latest_recorded_hash?: string;
	status?: DrainStatus;
	status_updated_at?: string;
	changed: boolean;
	processed: boolean;
};
type DrainStatusSummary = {
	session_dirs: string[];
	missing_session_dirs: string[];
	total: number;
	processed: number;
	failed: number;
	unprocessed: number;
	changed: number;
	retryable: number;
};
type TranscriptEntry = {
	line_number: number;
	timestamp?: string | number;
	role: string;
	content: unknown;
};

export const internals = {
	expandHome,
	stateDir,
	readSessionDirs,
	discoverSessions,
	readState,
	writeState,
	findNextSessions,
	getDrainStatus,
	markSession,
	markSessionByPath,
	buildTranscriptPage,
	transcriptEntriesForLine,
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_drain_next",
		label: "Session Drain Next",
		description: "Return unprocessed or retryable Pi sessions from configured session directories.",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "Maximum sessions to return" })),
		}),
		async execute(_toolCallId, params) {
			const requestedLimit = typeof params.limit === "number" ? params.limit : 1;
			const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.trunc(requestedLimit))) : 1;
			const sessions = await findNextSessions(limit);
			return {
				content: [{ type: "text", text: JSON.stringify({ session_id: sessions[0]?.session_id, session_ids: sessions.map((s) => s.session_id), sessions }, null, 2) }],
				details: { session_id: sessions[0]?.session_id, session_ids: sessions.map((s) => s.session_id), sessions },
			};
		},
	});

	pi.registerTool({
		name: "session_drain_status",
		label: "Session Drain Status",
		description: "Return aggregate session-drain status for configured Pi session directories.",
		parameters: Type.Object({}),
		async execute() {
			const status = await getDrainStatus();
			return {
				content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
				details: status,
			};
		},
	});

	pi.registerTool({
		name: "session_drain_transcript",
		label: "Session Drain Transcript",
		description: "Return a deterministic transcript page for a Pi session by raw JSONL line number.",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session id from session_drain_next" }),
			after_line: Type.Optional(Type.Number({ minimum: 0, description: "Return transcript entries after this raw JSONL line" })),
		}),
		async execute(_toolCallId, params) {
			const requestedAfterLine = typeof params.after_line === "number" ? params.after_line : 0;
			const page = await buildTranscriptPage(params.session_id, Number.isFinite(requestedAfterLine) ? Math.max(0, Math.trunc(requestedAfterLine)) : 0);
			return {
				content: [{ type: "text", text: JSON.stringify(page, null, 2) }],
				details: page,
			};
		},
	});

	pi.registerTool({
		name: "session_drain_mark",
		label: "Session Drain Mark",
		description: "Mark the current hash of a session as processed or failed.",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session id to mark" }),
			status: Type.Union([Type.Literal("processed"), Type.Literal("failed")]),
		}),
		async execute(_toolCallId, params) {
			const record = await markSession(params.session_id, params.status as DrainStatus);
			return {
				content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
				details: record,
			};
		},
	});

	pi.registerCommand("session-drain:status", {
		description: "Show aggregate session-drain status for configured Pi session directories",
		handler: async (_args, ctx) => {
			const status = await getDrainStatus();
			ctx.ui.notify(formatStatus(status), "info");
		},
	});

	pi.registerCommand("session-drain:drain", {
		description: "Mark the current session processed, then drain unprocessed sessions in batches of four using subagents",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy; try /session-drain:drain when idle.", "warning");
				return;
			}
			const sessionManager = (ctx as any).sessionManager;
			const currentSessionId = sessionManager?.getSessionId?.();
			const currentSessionFile = sessionManager?.getSessionFile?.();
			if (!currentSessionId || !currentSessionFile) {
				ctx.ui.notify("Cannot identify the current persisted session; not starting session drain.", "warning");
				return;
			}
			await markSessionByPath(currentSessionId, currentSessionFile, "processed");
			pi.sendUserMessage(`Drain Pi sessions using the session-drain tools.

Process loop:
1. Call session_drain_next with limit 4.
2. If no sessions are returned, summarize current drain status and stop.
3. For each returned session, assign exactly one subagent to drain that session. Pass only that session_id and tell the subagent to fetch transcript pages with session_drain_transcript until complete is true, update durable memory files from durable information in the transcript, then report changed files and outcome.
4. Review each subagent outcome, then call session_drain_mark for that session with processed or failed.
5. Continue with another batch of four until no unprocessed or failed sessions remain or you need user input.`);
		},
	});
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function stateDir(): string {
	return path.join(os.homedir(), "Agents", ".session-drain");
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch (error: any) {
		if (error?.code === "ENOENT") return fallback;
		throw error;
	}
}

async function readSessionDirs(): Promise<string[]> {
	const config = await readJsonFile<Config>(path.join(stateDir(), "config.json"), {});
	const envDirs = (process.env.PI_SESSION_DRAIN_DIRS ?? "").split(path.delimiter).map((s) => s.trim()).filter(Boolean);
	const dirs = [DEFAULT_SESSION_DIR, ...(config.sessionDirs ?? []), ...envDirs].map((dir) => path.resolve(expandHome(dir)));
	return Array.from(new Set(dirs));
}

function formatStatus(status: DrainStatusSummary): string {
	return `Session drain: ${status.unprocessed} unprocessed, ${status.processed} processed, ${status.failed} failed/retryable, ${status.changed} changed, ${status.total} total`;
}

async function readState(): Promise<State> {
	const state = await readJsonFile<State>(path.join(stateDir(), "status.json"), { records: [] });
	return { records: Array.isArray(state.records) ? state.records : [] };
}

async function writeState(state: State): Promise<void> {
	await fs.mkdir(stateDir(), { recursive: true });
	const file = path.join(stateDir(), "status.json");
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	await fs.rename(tmp, file);
}

async function discoverSessions(): Promise<SessionInfo[]> {
	const sessionDirs = await readSessionDirs();
	const state = await readState();
	const sessions: SessionInfo[] = [];
	for (const sessionDir of sessionDirs) {
		let stat;
		try {
			stat = await fs.stat(sessionDir);
		} catch (error: any) {
			if (error?.code === "ENOENT") continue;
			throw error;
		}
		if (!stat.isDirectory()) continue;
		for (const sessionPath of await findJsonlFiles(sessionDir)) {
			const header = await readSessionHeader(sessionPath);
			if (!header?.id) continue;
			const sessionHash = await fileHash(sessionPath);
			const records = state.records.filter((record) => record.session_id === header.id);
			const latest = records.at(-1);
			const current = records.filter((record) => record.session_hash === sessionHash).at(-1);
			const status = current?.status;
			sessions.push({
				session_id: header.id,
				session_path: sessionPath,
				session_dir: sessionDir,
				session_hash: sessionHash,
				latest_recorded_hash: latest?.session_hash,
				status,
				status_updated_at: current?.status_updated_at,
				changed: Boolean(latest && latest.session_hash !== sessionHash),
				processed: status === "processed",
			});
		}
	}
	return sessions.sort((a, b) => a.session_path.localeCompare(b.session_path));
}

async function getDrainStatus(): Promise<DrainStatusSummary> {
	const sessionDirs = await readSessionDirs();
	const missingSessionDirs: string[] = [];
	for (const sessionDir of sessionDirs) {
		try {
			const stat = await fs.stat(sessionDir);
			if (!stat.isDirectory()) missingSessionDirs.push(sessionDir);
		} catch (error: any) {
			if (error?.code === "ENOENT") missingSessionDirs.push(sessionDir);
			else throw error;
		}
	}
	const sessions = await discoverSessions();
	const processed = sessions.filter((session) => session.status === "processed").length;
	const failed = sessions.filter((session) => session.status === "failed").length;
	return {
		session_dirs: sessionDirs,
		missing_session_dirs: missingSessionDirs,
		total: sessions.length,
		processed,
		failed,
		unprocessed: sessions.length - processed - failed,
		changed: sessions.filter((session) => session.changed).length,
		retryable: failed,
	};
}

async function findNextSessions(limit: number): Promise<SessionInfo[]> {
	return (await discoverSessions()).filter((session) => session.status !== "processed").slice(0, limit);
}

async function markSession(sessionId: string, status: DrainStatus): Promise<StatusRecord> {
	if (!STATUSES.includes(status)) throw new Error(`Invalid session drain status: ${status}`);
	const session = (await discoverSessions()).find((candidate) => candidate.session_id === sessionId);
	if (!session) throw new Error(`No configured session found for id ${sessionId}`);
	return writeStatusRecord(session, status);
}

async function markSessionByPath(sessionId: string, sessionPath: string, status: DrainStatus): Promise<StatusRecord> {
	if (!STATUSES.includes(status)) throw new Error(`Invalid session drain status: ${status}`);
	const resolvedSessionPath = path.resolve(expandHome(sessionPath));
	const sessionDirs = await readSessionDirs();
	const sessionDir = sessionDirs.find((dir) => isPathInside(resolvedSessionPath, dir)) ?? path.dirname(resolvedSessionPath);
	const session: SessionInfo = {
		session_id: sessionId,
		session_path: resolvedSessionPath,
		session_dir: sessionDir,
		session_hash: await fileHash(resolvedSessionPath),
		changed: false,
		processed: status === "processed",
	};
	return writeStatusRecord(session, status);
}

async function writeStatusRecord(session: Pick<SessionInfo, "session_id" | "session_path" | "session_dir" | "session_hash">, status: DrainStatus): Promise<StatusRecord> {
	const record: StatusRecord = {
		session_id: session.session_id,
		session_path: session.session_path,
		session_dir: session.session_dir,
		session_hash: session.session_hash,
		status,
		status_updated_at: new Date().toISOString(),
	};
	const state = await readState();
	state.records.push(record);
	await writeState(state);
	return record;
}

async function buildTranscriptPage(sessionId: string, afterLine = 0) {
	const session = (await discoverSessions()).find((candidate) => candidate.session_id === sessionId);
	if (!session) throw new Error(`No configured session found for id ${sessionId}`);
	const lines = (await fs.readFile(session.session_path, "utf8")).split(/\r?\n/);
	const entries: TranscriptEntry[] = [];
	let charCount = 0;
	let nextAfterLine = afterLine;
	let complete = true;

	for (let index = Math.max(0, afterLine); index < lines.length; index++) {
		const line = lines[index];
		const lineNumber = index + 1;
		if (!line.trim()) continue;
		const lineEntries = transcriptEntriesForLine(line, lineNumber);
		for (const entry of lineEntries) {
			const entryChars = JSON.stringify(entry).length;
			if (entries.length >= MAX_TRANSCRIPT_ENTRIES || (entries.length > 0 && charCount + entryChars > MAX_TRANSCRIPT_CHARS)) {
				complete = false;
				return { session_id: sessionId, entries, next_after_line: nextAfterLine, complete };
			}
			if (entryChars > MAX_TRANSCRIPT_CHARS && entries.length === 0) {
				entry.content = truncateDeterministic(JSON.stringify(entry.content), MAX_TRANSCRIPT_CHARS - 500);
			}
			entries.push(entry);
			charCount += JSON.stringify(entry).length;
			nextAfterLine = lineNumber;
		}
	}
	return { session_id: sessionId, entries, next_after_line: nextAfterLine, complete };
}

function transcriptEntriesForLine(line: string, lineNumber: number): TranscriptEntry[] {
	let raw: any;
	try {
		raw = JSON.parse(line);
	} catch {
		return [{ line_number: lineNumber, role: "error", content: "Invalid JSONL line" }];
	}
	if (raw.type !== "message") return [];
	const message = raw.message;
	const timestamp = message?.timestamp ?? raw.timestamp;
	if (message?.role === "user") {
		const text = textFromContent(message.content);
		return text ? [{ line_number: lineNumber, timestamp, role: "user", content: text }] : [];
	}
	if (message?.role === "assistant") {
		const entries: TranscriptEntry[] = [];
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block?.type === "text" && block.text) entries.push({ line_number: lineNumber, timestamp, role: "assistant", content: block.text });
			if (block?.type === "toolCall") entries.push({ line_number: lineNumber, timestamp, role: "assistant_tool_call", content: { tool_call_id: block.id, tool_name: block.name, tool_arguments: block.arguments ?? {} } });
		}
		if (message.stopReason === "error" || message.errorMessage) entries.push({ line_number: lineNumber, timestamp, role: "assistant_diagnostic", content: { stop_reason: message.stopReason, error_message: message.errorMessage } });
		return entries;
	}
	if (message?.role === "toolResult") {
		return [{
			line_number: lineNumber,
			timestamp,
			role: "tool_result",
			content: {
				tool_call_id: message.toolCallId,
				tool_name: message.toolName,
				is_error: Boolean(message.isError),
				content: truncateDeterministic(textFromContent(message.content), TOOL_RESULT_LIMIT),
			},
		}];
	}
	if (message?.role === "bashExecution") {
		return [{ line_number: lineNumber, timestamp, role: "assistant_diagnostic", content: { command: message.command, exit_code: message.exitCode, cancelled: message.cancelled, truncated: message.truncated, output: truncateDeterministic(message.output ?? "", TOOL_RESULT_LIMIT) } }];
	}
	return [];
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

function truncateDeterministic(value: string, limit: number): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, Math.max(0, limit))}\n[truncated ${value.length - limit} chars]`;
}

function isPathInside(candidatePath: string, parentPath: string): boolean {
	const relative = path.relative(parentPath, candidatePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function findJsonlFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	async function visit(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await visit(full);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
		}
	}
	await visit(root);
	return found.sort();
}

async function readSessionHeader(sessionPath: string): Promise<{ id?: string } | undefined> {
	const handle = await fs.open(sessionPath, "r");
	try {
		const buffer = Buffer.alloc(16 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
		if (!firstLine.trim()) return undefined;
		const header = JSON.parse(firstLine);
		return header?.type === "session" ? header : undefined;
	} catch {
		return undefined;
	} finally {
		await handle.close();
	}
}

async function fileHash(file: string): Promise<string> {
	const hash = createHash("sha256");
	hash.update(await fs.readFile(file));
	return `sha256:${hash.digest("hex")}`;
}

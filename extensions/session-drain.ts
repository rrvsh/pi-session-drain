import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXTENSION_NAME = "session-drain";
const DEFAULT_SESSION_DIR = "~/.pi/agent/sessions";
const MAX_TRANSCRIPT_ENTRIES = 100;
const MAX_TRANSCRIPT_CHARS = 40_000;
const TOOL_RESULT_LIMIT = 2_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const RUN_LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RUN_MAX_SESSIONS = 1;
const DEFAULT_RUN_MAX_CHUNKS_PER_SESSION = 80;
const DEFAULT_RUN_SESSION_CONCURRENCY = 1;
const DEFAULT_RUN_CHUNK_CONCURRENCY = 4;
const DEFAULT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MANAGED_AGENT_MARKER = "<!-- managed-by: pi-session-drain -->";
const SESSION_DRAIN_CHUNK_AGENT = `---
name: session-drain-chunk
description: Analyze one bounded Pi session transcript chunk and report durable memory candidates.
tools: read, grep, find, ls, session_drain_transcript
inheritProjectContext: false
inheritSkills: false
defaultContext: fresh
---
${MANAGED_AGENT_MARKER}

Analyze exactly one transcript chunk provided by the parent.

Required input: session_id, session_path, session_dir, chunk_index, after_line, until_line, entry_count, approx_chars.

Call session_drain_transcript with exactly that session_id, after_line, and until_line. Treat it as the authoritative chunk source.

Do not fetch transcript content outside the assigned chunk unless the parent explicitly instructs you to do so.

Use read, grep, find, and ls only for supporting local research when needed. Do not read unrelated large files wholesale.

Do not edit files or update memory. Report candidates only.

Include transcript line references and relevant file paths for every candidate.

Final report shape:
Session: <session_id>
Session path: <session_path>
Session dir: <session_dir>
Chunk: <chunk_index>
After line: <after_line>
Until line: <until_line>
Entries returned: <number>
Next after line: <next_after_line>
Range complete: <true|false>
Session complete: <true|false>
Memory candidates:
- <candidate/source refs or none>
Skipped candidates:
- <candidate/reason or none>
Outcome: <chunk-processed|chunk-failed>
`;
const STATUSES = ["processed", "failed", "deferred"] as const;
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
type RunOptions = {
	max_sessions: number;
	max_chunks_per_session: number;
	session_concurrency: number;
	chunk_concurrency: number;
	timeout_ms: number;
};
type RunManifest = {
	run_id: string;
	started_at: string;
	finished_at?: string;
	status: "running" | "processed" | "failed";
	options: RunOptions;
	sessions: Array<{
		session_id: string;
		session_path: string;
		session_hash: string;
		status: "planned" | "chunks_processed" | "processed" | "failed" | "deferred";
		chunk_count: number;
		chunks: Array<TranscriptChunk & { report_path?: string; status?: "processed" | "failed" }>;
		synthesis_path?: string;
		error?: string;
	}>;
};
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
	is_subagent_child: boolean;
	parent_session_id?: string;
	parent_session_path?: string;
	parent_status?: DrainStatus;
	run_id?: string;
	child_index?: number;
};
type DrainStatusSummary = {
	session_dirs: string[];
	missing_session_dirs: string[];
	include_child_sessions: boolean;
	total: number;
	processed: number;
	failed: number;
	deferred: number;
	unprocessed: number;
	changed: number;
	retryable: number;
	excluded_child_sessions: number;
};
type TranscriptEntry = {
	line_number: number;
	timestamp?: string | number;
	role: string;
	content: unknown;
};
type TranscriptChunk = {
	chunk_index: number;
	after_line: number;
	until_line: number;
	entry_count: number;
	approx_chars: number;
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
	markSessions,
	markSessionByPath,
	buildTranscriptChunks,
	buildTranscriptPage,
	loadTranscriptEntries,
	transcriptEntriesForLine,
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const result = await ensureManagedSubagent();
		if (result === "conflict") {
			ctx.ui.notify("session-drain-chunk subagent file already exists and is not managed by pi-session-drain; leaving it unchanged.", "warning");
		}
	});

	pi.registerTool({
		name: "session_drain_next",
		label: "Session Drain Next",
		description: "Return the next unprocessed or retryable Pi session chunks, using limit as a chunk budget and preserving session boundaries.",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000, description: "Maximum transcript chunks to return; complete sessions only" })),
			session_id: Type.Optional(Type.String({ description: "Plan only this session, used when retrying an oversized session" })),
			include_child_sessions: Type.Optional(Type.Boolean({ description: "Include nested subagent child sessions; defaults to false" })),
		}),
		async execute(_toolCallId, params) {
			const requestedLimit = typeof params.limit === "number" ? params.limit : 1;
			const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(1000, Math.trunc(requestedLimit))) : 1;
			const next = await findNextSessions(limit, typeof params.session_id === "string" ? params.session_id : undefined, params.include_child_sessions === true);
			return {
				content: [{ type: "text", text: JSON.stringify(next, null, 2) }],
				details: next,
			};
		},
	});

	pi.registerTool({
		name: "session_drain_status",
		label: "Session Drain Status",
		description: "Return aggregate session-drain status for configured Pi session directories.",
		parameters: Type.Object({
			include_child_sessions: Type.Optional(Type.Boolean({ description: "Include nested subagent child sessions in status counts; defaults to false" })),
		}),
		async execute(_toolCallId, params) {
			const status = await getDrainStatus(params.include_child_sessions === true);
			return {
				content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
				details: status,
			};
		},
	});

	pi.registerTool({
		name: "session_drain_chunks",
		label: "Session Drain Chunks",
		description: "Return deterministic transcript chunk metadata for a Pi session without transcript content.",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session id from session_drain_next" }),
			include_child_sessions: Type.Optional(Type.Boolean({ description: "Allow chunk planning for nested subagent child sessions; defaults to false" })),
		}),
		async execute(_toolCallId, params) {
			const chunks = await buildTranscriptChunks(params.session_id, params.include_child_sessions === true);
			return {
				content: [{ type: "text", text: JSON.stringify(chunks, null, 2) }],
				details: chunks,
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
			until_line: Type.Optional(Type.Number({ minimum: 1, description: "Stop after this raw JSONL line" })),
			include_child_sessions: Type.Optional(Type.Boolean({ description: "Allow transcript reads for nested subagent child sessions; defaults to false" })),
		}),
		async execute(_toolCallId, params) {
			const requestedAfterLine = typeof params.after_line === "number" ? params.after_line : 0;
			const requestedUntilLine = typeof params.until_line === "number" ? params.until_line : undefined;
			const page = await buildTranscriptPage(
				params.session_id,
				Number.isFinite(requestedAfterLine) ? Math.max(0, Math.trunc(requestedAfterLine)) : 0,
				requestedUntilLine !== undefined && Number.isFinite(requestedUntilLine) ? Math.max(1, Math.trunc(requestedUntilLine)) : undefined,
				params.include_child_sessions === true,
			);
			return {
				content: [{ type: "text", text: JSON.stringify(page, null, 2) }],
				details: page,
			};
		},
	});

	pi.registerTool({
		name: "session_drain_mark_many",
		label: "Session Drain Mark Many",
		description: "Mark current hashes of multiple sessions as processed, failed, or deferred in one transaction.",
		parameters: Type.Object({
			marks: Type.Array(Type.Object({
				session_id: Type.String({ description: "Session id to mark" }),
				status: Type.Union([Type.Literal("processed"), Type.Literal("failed"), Type.Literal("deferred")]),
			}), { minItems: 1, maxItems: 100 }),
		}),
		async execute(_toolCallId, params) {
			const result = await markSessions(params.marks as Array<{ session_id: string; status: DrainStatus }>);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "session_drain_mark",
		label: "Session Drain Mark",
		description: "Mark the current hash of a session as processed, failed, or deferred.",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session id to mark" }),
			status: Type.Union([Type.Literal("processed"), Type.Literal("failed"), Type.Literal("deferred")]),
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
		description: "Drain unprocessed sessions with the deterministic session-drain runner",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy; try /session-drain:drain when idle.", "warning");
				return;
			}
			const result = await runDeterministicDrain();
			ctx.ui.notify(`Session drain run ${result.run_id}: ${result.status}. Artifact: ${result.run_dir}`, result.status === "processed" ? "info" : "warning");
		},
	});

	pi.registerCommand("session-drain:run", {
		description: "Run the deterministic unattended session drain workflow",
		handler: async (_args, ctx) => {
			const result = await runDeterministicDrain();
			ctx.ui.notify(`Session drain run ${result.run_id}: ${result.status}. Artifact: ${result.run_dir}`, result.status === "processed" ? "info" : "warning");
		},
	});

	pi.registerCommand("session-drain:drain-current", {
		description: "Mark the current active persisted session as processed",
		handler: async (_args, ctx) => {
			const sessionManager = (ctx as any).sessionManager;
			const currentSessionId = sessionManager?.getSessionId?.();
			const currentSessionFile = sessionManager?.getSessionFile?.();
			if (!currentSessionId || !currentSessionFile) {
				ctx.ui.notify("Cannot identify the current persisted session.", "warning");
				return;
			}
			await markSessionByPath(currentSessionId, currentSessionFile, "processed");
			ctx.ui.notify(`Marked current session ${currentSessionId} as processed.`, "info");
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
		if (error instanceof SyntaxError) {
			throw new Error(`Failed to parse ${file}. The session-drain status/config JSON may be corrupted; back it up and repair or move it aside. Original parse error: ${error.message}`);
		}
		throw error;
	}
}

async function ensureManagedSubagent(): Promise<"created" | "updated" | "unchanged" | "conflict"> {
	const agentsDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const oldAgentPath = path.join(agentsDir, "session-drain.md");
	try {
		const oldAgent = await fs.readFile(oldAgentPath, "utf8");
		if (oldAgent.includes(MANAGED_AGENT_MARKER)) await fs.rm(oldAgentPath, { force: true });
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}
	const agentPath = path.join(agentsDir, "session-drain-chunk.md");
	let existing: string | undefined;
	try {
		existing = await fs.readFile(agentPath, "utf8");
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (existing !== undefined && !existing.includes(MANAGED_AGENT_MARKER)) return "conflict";
	if (existing === SESSION_DRAIN_CHUNK_AGENT) return "unchanged";
	await fs.mkdir(agentsDir, { recursive: true });
	await fs.writeFile(agentPath, SESSION_DRAIN_CHUNK_AGENT, "utf8");
	return existing === undefined ? "created" : "updated";
}

async function readSessionDirs(): Promise<string[]> {
	const config = await readJsonFile<Config>(path.join(stateDir(), "config.json"), {});
	const envDirs = (process.env.PI_SESSION_DRAIN_DIRS ?? "").split(path.delimiter).map((s) => s.trim()).filter(Boolean);
	const dirs = [DEFAULT_SESSION_DIR, ...(config.sessionDirs ?? []), ...envDirs].map((dir) => path.resolve(expandHome(dir)));
	return Array.from(new Set(dirs));
}

function formatStatus(status: DrainStatusSummary): string {
	return `Session drain: ${status.unprocessed} unprocessed, ${status.processed} processed, ${status.failed} failed/retryable, ${status.deferred} deferred, ${status.changed} changed, ${status.total} total, ${status.excluded_child_sessions} child sessions excluded`;
}

async function readState(): Promise<State> {
	const state = await readJsonFile<State>(path.join(stateDir(), "status.json"), { records: [] });
	return { records: Array.isArray(state.records) ? state.records : [] };
}

async function writeState(state: State): Promise<void> {
	await fs.mkdir(stateDir(), { recursive: true });
	const file = path.join(stateDir(), "status.json");
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	await fs.rename(tmp, file);
}

async function withStateLock<T>(operation: () => Promise<T>): Promise<T> {
	await fs.mkdir(stateDir(), { recursive: true });
	const lockDir = path.join(stateDir(), "status.lock");
	const startedAt = Date.now();
	while (true) {
		try {
			await fs.mkdir(lockDir);
			await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }) + "\n", "utf8");
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
				throw new Error(`Timed out waiting for session-drain state lock at ${lockDir}`);
			}
			try {
				const stat = await fs.stat(lockDir);
				if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
					await fs.rm(lockDir, { recursive: true, force: true });
					continue;
				}
			} catch (statError: any) {
				if (statError?.code === "ENOENT") continue;
				throw statError;
			}
			await sleep(50);
		}
	}
	try {
		return await operation();
	} finally {
		await fs.rm(lockDir, { recursive: true, force: true });
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDeterministicDrain(): Promise<{ run_id: string; run_dir: string; status: "processed" | "failed" }> {
	return withRunLock(async () => {
		const options: RunOptions = {
			max_sessions: Number(process.env.PI_SESSION_DRAIN_MAX_SESSIONS ?? DEFAULT_RUN_MAX_SESSIONS),
			max_chunks_per_session: Number(process.env.PI_SESSION_DRAIN_MAX_CHUNKS_PER_SESSION ?? DEFAULT_RUN_MAX_CHUNKS_PER_SESSION),
			session_concurrency: Number(process.env.PI_SESSION_DRAIN_SESSION_CONCURRENCY ?? DEFAULT_RUN_SESSION_CONCURRENCY),
			chunk_concurrency: Number(process.env.PI_SESSION_DRAIN_CHUNK_CONCURRENCY ?? DEFAULT_RUN_CHUNK_CONCURRENCY),
			timeout_ms: Number(process.env.PI_SESSION_DRAIN_TIMEOUT_MS ?? DEFAULT_RUN_TIMEOUT_MS),
		};
		const started = Date.now();
		const runId = new Date().toISOString().replace(/[:.]/g, "-");
		const runDir = path.join(stateDir(), "runs", runId);
		await fs.mkdir(path.join(runDir, "chunks"), { recursive: true });
		await fs.mkdir(path.join(runDir, "synthesis"), { recursive: true });
		const manifest: RunManifest = { run_id: runId, started_at: new Date(started).toISOString(), status: "running", options, sessions: [] };
		await writeRunManifest(runDir, manifest);
		let manifestWriteQueue = Promise.resolve();
		const writeManifestSerial = async (): Promise<void> => {
			manifestWriteQueue = manifestWriteQueue.then(() => writeRunManifest(runDir, manifest));
			await manifestWriteQueue;
		};
		const appendRunEventSerial = async (event: { timestamp: string; type: string; [key: string]: unknown }): Promise<void> => {
			manifestWriteQueue = manifestWriteQueue.then(() => appendRunEvent(runDir, event));
			await manifestWriteQueue;
		};
		try {
			const plannedSessions = await planSessionsForRun(options.max_sessions);
			for (const next of plannedSessions) {
				const sessionState: RunManifest["sessions"][number] = {
					session_id: next.session_id,
					session_path: next.session_path,
					session_hash: next.session_hash,
					status: "planned",
					chunk_count: next.chunk_count,
					chunks: next.chunks.map((chunk) => ({ ...chunk })),
				};
				manifest.sessions.push(sessionState);
				await appendRunEventSerial({ timestamp: new Date().toISOString(), type: "session_planned", session_id: next.session_id, chunk_count: next.chunk_count });
				await writeManifestSerial();
			}
			let nextSessionIndex = 0;
			async function worker(): Promise<void> {
				while (nextSessionIndex < plannedSessions.length && Date.now() - started < options.timeout_ms) {
					const next = plannedSessions[nextSessionIndex++]!;
					const sessionState = manifest.sessions.find((candidate) => candidate.session_id === next.session_id)!;
					await processPlannedSession(runDir, options, next, sessionState, writeManifestSerial);
				}
			}
			await Promise.all(Array.from({ length: Math.max(1, Math.min(options.session_concurrency, plannedSessions.length)) }, () => worker()));
			manifest.status = manifest.sessions.some((session) => session.status === "failed") ? "failed" : "processed";
			return { run_id: runId, run_dir: runDir, status: manifest.status };
		} catch (error: any) {
			manifest.status = "failed";
			await appendRunEvent(runDir, { timestamp: new Date().toISOString(), type: "run_error", error: error?.message ?? String(error) });
			return { run_id: runId, run_dir: runDir, status: "failed" };
		} finally {
			manifest.finished_at = new Date().toISOString();
			await writeRunManifest(runDir, manifest);
			await fs.writeFile(path.join(runDir, "summary.json"), `${JSON.stringify({ run_id: manifest.run_id, status: manifest.status, started_at: manifest.started_at, finished_at: manifest.finished_at, sessions: manifest.sessions.map((session) => ({ session_id: session.session_id, status: session.status, chunk_count: session.chunk_count, error: session.error })) }, null, 2)}\n`, "utf8");
		}
	});
}

async function withRunLock<T>(operation: () => Promise<T>): Promise<T> {
	await fs.mkdir(stateDir(), { recursive: true });
	const lockDir = path.join(stateDir(), "run.lock");
	try {
		await fs.mkdir(lockDir);
		await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }) + "\n", "utf8");
	} catch (error: any) {
		if (error?.code !== "EEXIST") throw error;
		const stat = await fs.stat(lockDir);
		if (Date.now() - stat.mtimeMs <= RUN_LOCK_STALE_MS) throw new Error(`Session drain run already active at ${lockDir}`);
		await fs.rm(lockDir, { recursive: true, force: true });
		return withRunLock(operation);
	}
	try {
		return await operation();
	} finally {
		await fs.rm(lockDir, { recursive: true, force: true });
	}
}

async function planSessionsForRun(maxSessions: number): Promise<Array<SessionInfo & { chunk_count: number; chunks: TranscriptChunk[] }>> {
	const eligible = (await discoverSessions()).filter((session) => session.status !== "processed" && session.status !== "deferred" && !session.is_subagent_child);
	const planned: Array<SessionInfo & { chunk_count: number; chunks: TranscriptChunk[] }> = [];
	for (const session of eligible) {
		if (planned.length >= maxSessions) break;
		const plan = await buildTranscriptChunks(session.session_id);
		planned.push({ ...session, chunk_count: plan.chunk_count, chunks: plan.chunks });
	}
	return planned;
}

async function processPlannedSession(
	runDir: string,
	options: RunOptions,
	next: SessionInfo & { chunk_count: number; chunks: TranscriptChunk[] },
	sessionState: RunManifest["sessions"][number],
	writeManifest: () => Promise<void>,
): Promise<void> {
	if (next.chunk_count > options.max_chunks_per_session) {
		sessionState.status = "deferred";
		sessionState.error = `Session requires ${next.chunk_count} chunks, above max_chunks_per_session ${options.max_chunks_per_session}`;
		await markSession(next.session_id, "deferred");
		await writeManifest();
		return;
	}
	const chunkReports = await runChunkReports(runDir, next, options.chunk_concurrency);
	for (const report of chunkReports) {
		const chunk = sessionState.chunks.find((candidate) => candidate.chunk_index === report.chunk.chunk_index);
		if (chunk) {
			chunk.report_path = report.path;
			chunk.status = report.ok ? "processed" : "failed";
		}
	}
	const validationError = validateChunkReports(next.chunks, chunkReports);
	if (validationError) {
		sessionState.status = "failed";
		sessionState.error = validationError;
		await markSession(next.session_id, "failed");
		await writeManifest();
		return;
	}
	sessionState.status = "chunks_processed";
	await writeManifest();
	const synthesis = await runSynthesis(runDir, next, chunkReports.map((report) => report.path));
	sessionState.synthesis_path = synthesis.path;
	if (synthesis.ok) {
		sessionState.status = "processed";
		await markSession(next.session_id, "processed");
	} else {
		sessionState.status = "failed";
		sessionState.error = "Synthesis did not report Outcome: processed";
		await markSession(next.session_id, "failed");
	}
	await writeManifest();
}

async function runChunkReports(runDir: string, session: SessionInfo & { chunk_count: number; chunks: TranscriptChunk[] }, concurrency: number): Promise<Array<{ chunk: TranscriptChunk; path: string; ok: boolean }>> {
	const results: Array<{ chunk: TranscriptChunk; path: string; ok: boolean }> = [];
	let nextIndex = 0;
	async function worker(): Promise<void> {
		while (nextIndex < session.chunks.length) {
			const chunk = session.chunks[nextIndex++]!;
			const reportPath = path.join(runDir, "chunks", `${session.session_id}-${String(chunk.chunk_index).padStart(3, "0")}.md`);
			const prompt = chunkPrompt(session, chunk);
			const result = await runPiPrompt(prompt, os.homedir());
			await fs.writeFile(reportPath, result.output, "utf8");
			results.push({ chunk, path: reportPath, ok: result.exitCode === 0 && /Outcome:\s*chunk-processed/i.test(result.output) });
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, session.chunks.length)) }, () => worker()));
	return results.sort((a, b) => a.chunk.chunk_index - b.chunk.chunk_index);
}

function validateChunkReports(chunks: TranscriptChunk[], reports: Array<{ chunk: TranscriptChunk; ok: boolean }>): string | undefined {
	if (reports.length !== chunks.length) return `Expected ${chunks.length} chunk reports, got ${reports.length}`;
	for (const chunk of chunks) {
		const report = reports.find((candidate) => candidate.chunk.chunk_index === chunk.chunk_index);
		if (!report) return `Missing chunk report ${chunk.chunk_index}`;
		if (!report.ok) return `Chunk ${chunk.chunk_index} failed`;
	}
	return undefined;
}

async function runSynthesis(runDir: string, session: SessionInfo & { chunk_count: number; chunks: TranscriptChunk[] }, reportPaths: string[]): Promise<{ path: string; ok: boolean }> {
	const synthesisPath = path.join(runDir, "synthesis", `${session.session_id}.md`);
	const prompt = `Synthesize durable agent memory updates for Pi session ${session.session_id}.

Chunk report files:
${reportPaths.map((file) => `- ${file}`).join("\n")}

Read the chunk reports and existing /home/rafiq/Agents/MEMORY.md plus relevant /home/rafiq/Agents/memory/**/*.md files. Add or update only durable memory: stable preferences, corrections, environment/tool quirks, project state, and completed session summaries worth keeping. Discard transient task progress, raw transcripts, logs, secrets, credentials, and duplicates.

Edit memory files directly if there are durable updates. Keep entries compact. If there are no durable updates, make no edits.

Final lines must include:
Memory files changed: <list or none>
Outcome: processed`;
	const result = await runPiPrompt(prompt, path.join(os.homedir(), "Agents"));
	await fs.writeFile(synthesisPath, result.output, "utf8");
	return { path: synthesisPath, ok: result.exitCode === 0 && /Outcome:\s*processed/i.test(result.output) };
}

function chunkPrompt(session: SessionInfo, chunk: TranscriptChunk): string {
	return `Analyze exactly this Pi session transcript chunk for durable memory candidates.

session_id: ${session.session_id}
session_path: ${session.session_path}
session_dir: ${session.session_dir}
chunk_index: ${chunk.chunk_index}
after_line: ${chunk.after_line}
until_line: ${chunk.until_line}
entry_count: ${chunk.entry_count}
approx_chars: ${chunk.approx_chars}

Call session_drain_transcript with exactly this session_id, after_line, and until_line. Do not inspect other transcript ranges. Do not edit files. Report durable memory candidates only, with source line references. Discard transient progress, raw logs, secrets, and duplicates.

Final report must include exactly these fields:
Session: ${session.session_id}
Chunk: ${chunk.chunk_index}
After line: ${chunk.after_line}
Until line: ${chunk.until_line}
Entries returned: <number>
Next after line: <number>
Range complete: <true|false>
Session complete: <true|false>
Memory candidates:
- <candidate/source refs or none>
Skipped candidates:
- <candidate/reason or none>
Outcome: chunk-processed`;
}

function piPromptArgs(prompt: string): string[] {
	const args = ["--no-session"];
	const model = process.env.PI_SESSION_DRAIN_MODEL?.trim();
	if (model) args.push("--model", model);
	args.push("-p", prompt);
	return args;
}

async function runPiPrompt(prompt: string, cwd: string): Promise<{ exitCode: number; output: string }> {
	return new Promise((resolve) => {
		const child = spawn("pi", piPromptArgs(prompt), { cwd, env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk.toString(); });
		child.stderr.on("data", (chunk) => { output += chunk.toString(); });
		child.on("error", (error) => resolve({ exitCode: 1, output: String(error) }));
		child.on("close", (code) => resolve({ exitCode: code ?? 1, output }));
	});
}

async function writeRunManifest(runDir: string, manifest: RunManifest): Promise<void> {
	await fs.writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function appendRunEvent(runDir: string, event: { timestamp: string; type: string; [key: string]: unknown }): Promise<void> {
	await fs.appendFile(path.join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
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
			const childInfo = subagentChildInfo(sessionPath);
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
				is_subagent_child: Boolean(childInfo),
				...childInfo,
			});
		}
	}
	const byPath = new Map(sessions.map((session) => [session.session_path, session]));
	for (const session of sessions) {
		if (session.parent_session_path) {
			const parent = byPath.get(session.parent_session_path);
			if (parent) {
				session.parent_session_id = parent.session_id;
				session.parent_status = parent.status;
			}
		}
	}
	return sessions.sort((a, b) => a.session_path.localeCompare(b.session_path));
}

async function getDrainStatus(includeChildSessions = false): Promise<DrainStatusSummary> {
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
	const discoveredSessions = await discoverSessions();
	const excludedChildSessions = includeChildSessions ? 0 : discoveredSessions.filter((session) => session.is_subagent_child).length;
	const sessions = discoveredSessions.filter((session) => includeChildSessions || !session.is_subagent_child);
	const processed = sessions.filter((session) => session.status === "processed").length;
	const failed = sessions.filter((session) => session.status === "failed").length;
	const deferred = sessions.filter((session) => session.status === "deferred").length;
	return {
		session_dirs: sessionDirs,
		missing_session_dirs: missingSessionDirs,
		include_child_sessions: includeChildSessions,
		total: sessions.length,
		processed,
		failed,
		deferred,
		unprocessed: sessions.length - processed - failed - deferred,
		changed: sessions.filter((session) => session.changed).length,
		retryable: failed,
		excluded_child_sessions: excludedChildSessions,
	};
}

async function findNextSessions(limit: number, sessionId?: string, includeChildSessions = false) {
	const eligibleSessions = (await discoverSessions()).filter((session) => session.status !== "processed" && session.status !== "deferred" && (includeChildSessions || !session.is_subagent_child) && (!sessionId || session.session_id === sessionId));
	const sessions: Array<SessionInfo & { chunk_count: number; chunks: TranscriptChunk[] }> = [];
	let chunkCount = 0;
	let oversizedSessionId: string | undefined;
	let oversizedChunkCount: number | undefined;

	for (const session of eligibleSessions) {
		const plan = await buildTranscriptChunks(session.session_id, includeChildSessions);
		const sessionChunkCount = plan.chunk_count;
		if (!sessionId && sessions.length === 0 && sessionChunkCount > limit) {
			oversizedSessionId = session.session_id;
			oversizedChunkCount = sessionChunkCount;
			break;
		}
		if (!sessionId && sessions.length > 0 && chunkCount + sessionChunkCount > limit) break;
		if (!sessionId && sessions.length === 0 && chunkCount + sessionChunkCount > limit) break;
		sessions.push({ ...session, chunk_count: sessionChunkCount, chunks: plan.chunks });
		chunkCount += sessionChunkCount;
		if (sessionId) break;
	}

	const result: Record<string, unknown> = {
		limit,
		chunk_limit: limit,
		include_child_sessions: includeChildSessions,
		chunk_count: chunkCount,
		session_count: sessions.length,
		session_id: sessions[0]?.session_id,
		session_ids: sessions.map((session) => session.session_id),
		sessions,
	};
	if (oversizedSessionId && oversizedChunkCount !== undefined) {
		result.oversized_session_id = oversizedSessionId;
		result.oversized_chunk_count = oversizedChunkCount;
		result.required_limit = oversizedChunkCount;
		result.message = `Next session ${oversizedSessionId} requires ${oversizedChunkCount} chunks; call session_drain_next with session_id ${oversizedSessionId} and limit ${oversizedChunkCount}.`;
	}
	return result;
}

async function markSession(sessionId: string, status: DrainStatus): Promise<StatusRecord> {
	const result = await markSessions([{ session_id: sessionId, status }]);
	return result.records[0]!;
}

async function markSessions(marks: Array<{ session_id: string; status: DrainStatus }>): Promise<{ records: StatusRecord[]; processed: number; failed: number }> {
	if (marks.length === 0) throw new Error("At least one session mark is required");
	for (const mark of marks) {
		if (!STATUSES.includes(mark.status)) throw new Error(`Invalid session drain status: ${mark.status}`);
	}
	const sessions = await discoverSessions();
	const recordsToWrite = marks.map((mark) => {
		const session = sessions.find((candidate) => candidate.session_id === mark.session_id);
		if (!session) throw new Error(`No configured session found for id ${mark.session_id}`);
		return { session, status: mark.status };
	});
	return writeStatusRecords(recordsToWrite);
}

async function markSessionByPath(sessionId: string, sessionPath: string, status: DrainStatus): Promise<StatusRecord> {
	if (!STATUSES.includes(status)) throw new Error(`Invalid session drain status: ${status}`);
	const resolvedSessionPath = path.resolve(expandHome(sessionPath));
	const sessionDirs = await readSessionDirs();
	const sessionDir = sessionDirs.find((dir) => isPathInside(resolvedSessionPath, dir)) ?? path.dirname(resolvedSessionPath);
	const childInfo = subagentChildInfo(resolvedSessionPath);
	const session: SessionInfo = {
		session_id: sessionId,
		session_path: resolvedSessionPath,
		session_dir: sessionDir,
		session_hash: await fileHash(resolvedSessionPath),
		changed: false,
		processed: status === "processed",
		is_subagent_child: Boolean(childInfo),
		...childInfo,
	};
	return writeStatusRecord(session, status);
}

async function writeStatusRecord(session: Pick<SessionInfo, "session_id" | "session_path" | "session_dir" | "session_hash">, status: DrainStatus): Promise<StatusRecord> {
	return (await writeStatusRecords([{ session, status }])).records[0]!;
}

async function writeStatusRecords(items: Array<{ session: Pick<SessionInfo, "session_id" | "session_path" | "session_dir" | "session_hash">; status: DrainStatus }>): Promise<{ records: StatusRecord[]; processed: number; failed: number }> {
	return withStateLock(async () => {
		const now = new Date().toISOString();
		const records = items.map(({ session, status }) => ({
			session_id: session.session_id,
			session_path: session.session_path,
			session_dir: session.session_dir,
			session_hash: session.session_hash,
			status,
			status_updated_at: now,
		}));
		const state = await readState();
		state.records.push(...records);
		await writeState(state);
		return {
			records,
			processed: records.filter((record) => record.status === "processed").length,
			failed: records.filter((record) => record.status === "failed").length,
		};
	});
}

async function buildTranscriptChunks(sessionId: string, includeChildSessions = false) {
	const session = (await discoverSessions()).find((candidate) => candidate.session_id === sessionId && (includeChildSessions || !candidate.is_subagent_child));
	if (!session) throw new Error(`No configured non-child session found for id ${sessionId}`);
	const entries = await loadTranscriptEntries(session.session_path);
	const chunks: TranscriptChunk[] = [];
	let currentEntries = 0;
	let currentChars = 0;
	let afterLine = 0;
	let untilLine = 0;

	for (const entry of entries) {
		const entryChars = JSON.stringify(entry).length;
		if (currentEntries > 0 && (currentEntries >= MAX_TRANSCRIPT_ENTRIES || currentChars + entryChars > MAX_TRANSCRIPT_CHARS)) {
			chunks.push({ chunk_index: chunks.length, after_line: afterLine, until_line: untilLine, entry_count: currentEntries, approx_chars: currentChars });
			afterLine = untilLine;
			currentEntries = 0;
			currentChars = 0;
		}
		currentEntries += 1;
		currentChars += entryChars;
		untilLine = entry.line_number;
	}
	if (currentEntries > 0) {
		chunks.push({ chunk_index: chunks.length, after_line: afterLine, until_line: untilLine, entry_count: currentEntries, approx_chars: currentChars });
	}
	return { session_id: sessionId, session_path: session.session_path, session_dir: session.session_dir, session_hash: session.session_hash, chunk_count: chunks.length, chunks };
}

async function buildTranscriptPage(sessionId: string, afterLine = 0, untilLine?: number, includeChildSessions = false) {
	const session = (await discoverSessions()).find((candidate) => candidate.session_id === sessionId && (includeChildSessions || !candidate.is_subagent_child));
	if (!session) throw new Error(`No configured non-child session found for id ${sessionId}`);
	const transcriptEntries = await loadTranscriptEntries(session.session_path);
	const rangeEntries = transcriptEntries.filter((entry) => entry.line_number > afterLine && (untilLine === undefined || entry.line_number <= untilLine));
	const entries: TranscriptEntry[] = [];
	let charCount = 0;
	let nextAfterLine = afterLine;
	let hitLimit = false;

	for (const entry of rangeEntries) {
		const entryChars = JSON.stringify(entry).length;
		if (entries.length >= MAX_TRANSCRIPT_ENTRIES || (entries.length > 0 && charCount + entryChars > MAX_TRANSCRIPT_CHARS)) {
			hitLimit = true;
			break;
		}
		if (entryChars > MAX_TRANSCRIPT_CHARS && entries.length === 0) {
			entry.content = truncateDeterministic(JSON.stringify(entry.content), MAX_TRANSCRIPT_CHARS - 500);
		}
		entries.push(entry);
		charCount += JSON.stringify(entry).length;
		nextAfterLine = entry.line_number;
	}

	const rangeComplete = !hitLimit && !rangeEntries.some((entry) => entry.line_number > nextAfterLine);
	const sessionComplete = !transcriptEntries.some((entry) => entry.line_number > nextAfterLine);
	return {
		session_id: sessionId,
		entries,
		next_after_line: nextAfterLine,
		complete: untilLine === undefined ? sessionComplete : rangeComplete,
		range_complete: rangeComplete,
		session_complete: sessionComplete,
	};
}

async function loadTranscriptEntries(sessionPath: string): Promise<TranscriptEntry[]> {
	const lines = (await fs.readFile(sessionPath, "utf8")).split(/\r?\n/);
	const entries: TranscriptEntry[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line.trim()) continue;
		entries.push(...transcriptEntriesForLine(line, index + 1));
	}
	return entries;
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

function subagentChildInfo(sessionPath: string): Pick<SessionInfo, "parent_session_id" | "parent_session_path" | "run_id" | "child_index"> | undefined {
	const normalized = path.resolve(sessionPath);
	const match = normalized.match(/^(.*\/([^/]+)_([0-9a-fA-F-]{36}))\/([0-9a-fA-F]{8})\/run-(\d+)\/session\.jsonl$/);
	if (!match) return undefined;
	return {
		parent_session_id: match[3],
		parent_session_path: `${match[1]}.jsonl`,
		run_id: match[4],
		child_index: Number.parseInt(match[5]!, 10),
	};
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

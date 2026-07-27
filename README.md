# pi-session-drain

A Pi package that exposes session-drain state for historical Pi JSONL sessions.

## What it provides

- Tools:
  - `session_drain_status` — summarize configured session directories by status.
  - `session_drain_next` — find unprocessed/retryable work using `limit` as a chunk budget, returning complete sessions with embedded chunks.
  - `session_drain_chunks` — plan bounded transcript chunks for one session without returning transcript content.
  - `session_drain_transcript` — page a deterministic transcript by raw JSONL line number, optionally bounded by `until_line`.
  - `session_drain_mark` — mark the current session hash as `processed`, `failed`, or `deferred`.
  - `session_drain_mark_many` — mark multiple current session hashes in one transaction.
- Commands:
  - `/session-drain:status` — show aggregate status for configured session directories.
  - `/session-drain:drain` — run the deterministic unattended drain workflow.
  - `/session-drain:run` — alias for the deterministic unattended drain workflow.
  - `/session-drain:drain-current` — mark the current active session as `processed`.
- Managed subagent:
  - `session-drain-chunk` — installed at `~/.pi/agent/agents/session-drain-chunk.md`, allowed to call `read`, `grep`, `find`, `ls`, and `session_drain_transcript`, and limited to one assigned transcript chunk.

The deterministic runner owns session selection, oversized-session handling, chunk fanout, chunk validation, run artifacts, and status marking. Chunk LLM workers report durable memory candidates only. A synthesis LLM step reviews chunk reports, performs any memory edits serially, and must report `Outcome: processed` before the runner marks a session processed.

Nested subagent child sessions are excluded by default from status, next-batch planning, chunk planning, and transcript reads. Pass `include_child_sessions: true` only for explicit inspection/debugging.

State is stored in `~/Agents/.session-drain/status.json`. Per-run observability artifacts are stored under `~/Agents/.session-drain/runs/<run-id>/` (`manifest.json`, `events.jsonl`, chunk reports, synthesis report, and `summary.json`).

## Session directories

Default session directory: `~/.pi/agent/sessions/`.

Additional/configured directories can be supplied either with:

- `PI_SESSION_DRAIN_DIRS=/path/a:/path/b`
- `~/Agents/.session-drain/config.json`:

```json
{
  "sessionDirs": ["/path/to/sessions"]
}
```

## Install in Pi

```bash
pi install git:github.com:rrvsh/pi-session-drain
```

For local testing:

```bash
git clone https://github.com/rrvsh/pi-session-drain.git
cd pi-session-drain
pi -e .
```

## Nix

Build the packaged Pi extension directory:

```bash
nix build
```

The result contains `package.json` and `extensions/session-drain.ts` and can be used as a local Pi package.

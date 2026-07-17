# Specification

## Extension

Create a Pi extension that exposes session-drain state.

Store extension state under `~/Agents/.session-drain/`.

Use `~/.pi/agent/sessions/` as the default session directory.

Support configured session directories.

Discover Pi session JSONL files from configured session directories.

Store:

- `session_id` from the session JSONL header `id`
- `session_path` from the discovered JSONL file path
- `session_dir` from the configured session directory containing the file
- `session_hash` from the session file byte hash
- `status` from `session_drain_mark(session_id, status)`
- `status_updated_at` from the time status is recorded

Store `status` against `session_id` and `session_hash`.

Use these status values:

- `drained`
- `skipped`
- `deferred`
- `failed`

Treat a session as processed when its current `session_hash` has status `drained`, `skipped`, or `deferred`.

Treat a session as undrained when its current `session_hash` has no status.

Treat a session as changed when its current `session_hash` differs from the latest recorded hash for its `session_id`.

Treat changed sessions as undrained.

Treat `failed` sessions as retryable.

## Tools

Expose `session_drain_next`.

Accept:

- `limit`

Return:

- `session_id`

Expose `session_drain_transcript`.

Accept:

- `session_id`
- `after_line`

Return:

- `session_id`
- `entries`
- `next_after_line`
- `complete`

Expose `session_drain_mark`.

Accept:

- `session_id`
- `status`

## Commands

Expose `/session-drain:status`.

## Transcript

Build transcripts deterministically from the session JSONL file.

Return transcript entries in raw file line order.

For each transcript entry, include:

- `line_number`
- `timestamp`
- `role`
- `content`

Include user text content.

Include assistant text content.

Include assistant diagnostics and errors.

Include assistant tool calls with:

- tool call id
- tool name
- tool arguments

Include tool results with:

- tool call id
- tool name
- error status
- truncated result content

Use deterministic truncation for tool result content.

Omit:

- assistant thinking
- full tool result content
- compaction summaries
- branch summaries
- model changes
- thinking-level changes
- custom entries
- labels
- session info
- image data
- usage and cost metadata

Paginate transcripts by raw JSONL line number.

Return entries whose raw JSONL line number is greater than `after_line`.

Return at most 100 transcript entries per call.

Return at most 40,000 transcript characters per call.

Return `next_after_line` as the raw JSONL line number of the last returned entry.

Return `complete` when no more transcript entries remain.

## Drain command prompt

Request undrained sessions with `session_drain_next`.

Process sessions in batches of four.

Assign each session to one subagent.

Pass the `session_id` to the subagent.

Have each subagent report its outcome.

Mark each session after reviewing the subagent outcome.

## Subagent prompt

Drain one session.

Fetch transcript pages with `session_drain_transcript` until `complete` is true.

Update memory files from durable information in the transcript.

Report changed files and outcome to the parent agent.

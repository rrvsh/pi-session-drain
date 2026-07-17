# pi-session-drain

A Pi package that exposes session-drain state for historical Pi JSONL sessions.

## What it provides

- Tools:
  - `session_drain_status` — summarize configured session directories by status.
  - `session_drain_next` — find unprocessed/retryable sessions.
  - `session_drain_transcript` — page a deterministic transcript by raw JSONL line number.
  - `session_drain_mark` — mark the current session hash as `processed` or `failed`.
- Commands:
  - `/session-drain:status` — show aggregate status for configured session directories.
  - `/session-drain:drain` — mark the current session as `processed`, then queue the batch/subagent drain workflow.

State is stored in `~/Agents/.session-drain/status.json`.

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

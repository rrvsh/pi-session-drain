# pi-session-drain

A Pi package that exposes session-drain state for historical Pi JSONL sessions.

## What it provides

- Tools:
  - `session_drain_next` — find undrained/retryable sessions.
  - `session_drain_transcript` — page a deterministic transcript by raw JSONL line number.
  - `session_drain_mark` — mark the current session hash as `drained`, `skipped`, `deferred`, or `failed`.
- Command:
  - `/session-drain:status` — queue a prompt that asks the agent to drain sessions in batches of four using subagents.

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
pi install git:github.com:rafiqism/pi-session-drain
```

For local testing:

```bash
pi -e /home/rafiq/Git/pi-session-drain
```

## Nix

Build the packaged Pi extension directory:

```bash
nix build
```

The result contains `package.json` and `extensions/session-drain.ts` and can be used as a local Pi package.

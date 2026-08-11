---
title: flue run
description: Reference for running one agent module locally from the command line.
lastReviewedAt: 2026-07-21
---

## Synopsis

```bash
flue run <path> --message <text> [--name <agent>] [--id <id>] [--data <json>] [--uid <uid> | --new] [--vite] [--env <path>] [--json]
```

## Description

`flue run` executes one agent module locally: it submits one message, streams the agent's activity to stderr, prints the final assistant reply to stdout, and exits. It is transport-free by default on every target: no server is created and only the agent module (and whatever it imports) is loaded, never `app.ts`. A module that imports platform APIs such as `cloudflare:*` fails in this mode.

Pass `--vite` to run through the single [`FlueRunEnvironment`](/docs/reference/configuration/#fluerunenvironment) registered by the project's Vite configuration. The host owns platform setup, route injection, persistence, and cleanup; the CLI owns agent selection, server startup, protocol driving, and terminal output. Cloudflare provides an environment out of the box, so `--vite` runs the selected agent through workerd with the generated Durable Object and project bindings, including the `cloudflare/...` Workers AI provider.

Every Vite-hosted run uses a random temporary route and shuts the server down afterward. The agent module must have a top-level `'use agent'` directive and match the configured agent scan. Host integrations may deliberately bypass authored HTTP mounts and middleware, as Cloudflare does for its localhost-only route; each integration documents its own behavior.

Conversations persist between invocations, so `--id` continues a conversation an earlier run started. Node storage comes from the project's [db entry](/docs/guide/database/) when one exists, or a project-local cache file (`node_modules/.cache/flue/run.db`) without one. Vite hosts own their persistence; Cloudflare uses the Vite plugin's persistent local binding state (by default `.wrangler/state`), including Durable Object SQLite. `flue.config.*` is discovered from the current working directory, and the project `.env` is loaded automatically (values already set in the shell win); Cloudflare's standard local binding-variable loading remains owned by the Cloudflare Vite plugin.

## Options

| Option                 | Description                                                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<path>`               | The agent module to run, as a file path resolved from the current working directory.                                                                                                                                                    |
| `-m, --message <text>` | The user message submitted to the agent. Required.                                                                                                                                                                                      |
| `--name <agent>`       | Which agent to run when the module defines several. Matches the agent's name — its `agentName` static when set, otherwise the exported function name. Required when the module exports more than one agent; there is no silent default. |
| `--id <id>`            | Conversation id to create or continue. Defaults to a fresh generated ULID, printed on stderr.                                                                                                                                           |
| `--data <json>`        | Instance-creation data, read inside the agent with [`useInitialData()`](/docs/guide/agent-hooks/). Consulted only when this run creates the conversation; silently ignored on continues. Cannot be combined with `--uid`.               |
| `--uid <uid>`          | Continue only the conversation instance with this uid. Cannot be combined with `--new` or `--data`.                                                                                                                                     |
| `--new`                | Create only: the run is rejected when the conversation id already exists.                                                                                                                                                               |
| `--json`               | Print a JSON result envelope to stdout instead of the reply text.                                                                                                                                                                       |
| `--vite`               | Run through the single [`FlueRunEnvironment`](/docs/reference/configuration/#fluerunenvironment) registered by the project's Vite configuration.                                                                                        |
| `--env <path>`         | Load one alternate `.env`-format file before the run instead of the default `.env`.                                                                                                                                                     |

## Output

The final assistant reply prints to stdout; everything else — streamed text, tool activity, status rows — goes to stderr, so stdout stays pipeable. With `--json`, stdout is one JSON envelope instead:

```json
{
  "id": "support-4821",
  "agent": "hello",
  "submissionId": "…",
  "outcome": "completed",
  "message": "The final assistant reply.",
  "uid": "inst_…"
}
```

`--json` always prints exactly one envelope, discriminated by `outcome`, for every terminal result:

- `"outcome": "completed"` carries `message` (the assistant reply).
- `"outcome": "failed"` and `"outcome": "aborted"` carry an `error` object instead of a reply — `{ message, type?, details?, dev? }`, the typed fields present when the underlying error is a Flue error.
- A setup or admission failure before the run starts (module resolution, config, creation-data validation) prints `{ "outcome": "error", "error": { … } }`.

The envelope supplements the exit code rather than replacing it: `0` for completed, `1` for failed and setup errors, `130` for aborts.

## Examples

```bash
# Run an agent once and print its reply
flue run src/agents/hello.ts -m "Hi there"

# Continue the same conversation across invocations
flue run src/agents/support.ts -m "It fails on startup." --id support-4821
flue run src/agents/support.ts -m "Node 22, macOS."      --id support-4821

# Pick one agent from a multi-agent module
flue run src/agents/team.ts --name second-shift -m "Take over."

# CI: create exactly once, seed creation data, capture the envelope
flue run src/agents/triage.ts -m "Triage this." --id "issue-$N" --data '{"issue": 17307}' --new --json

# Extract just the reply text from the envelope
flue run src/agents/hello.ts -m "Run the demo." --json | jq -r .message

# Run through a third-party Vite host integration
flue run src/agents/hello.ts -m "Hi" --vite

# Load staging credentials for one run
flue run src/agents/hello.ts -m "Hi" --env .env.staging
```

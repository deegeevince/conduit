# Using a ChatGPT subscription (Codex brain)

`BRAIN=claude-cli` is the default way to run Conduit. `BRAIN=codex-cli` runs the same app on the Codex CLI with a ChatGPT login instead. There is no API key anywhere: the child process is started with the same credential-free environment as the Claude one, and `forced_login_method="chatgpt"` stops Codex falling back to an API login. Your own Codex config, hooks, rules and MCP servers are not read by the app's turns.

## Setup

1. Install Codex CLI 0.169 or newer (`--ignore-user-config` is needed).
2. `codex login`, choose ChatGPT, then check `codex login status`.
3. Pick a model your account offers (`codex debug models` lists them) and start the server:

```sh
pnpm install --frozen-lockfile
pnpm build
BRAIN=codex-cli CODEX_MODEL=<a model from your list> \
  HOST=127.0.0.1 PORT=4300 DATA_DIR=/path/to/data LIBRARY=seed DATASETS=none pnpm start
```

Settings: `CODEX_MODEL` (required), `CODEX_BIN` (default `codex`), `CODEX_TIMEOUT_MS` (a whole turn, default 180000), `CODEX_WEB` (`on`/`off`, default `on`), `BRAIN_EFFORT` (`low`, `medium`, `high`; default `low`), `PROMPT_VARIANT`, `CANVAS_TOOLS=off`. They are in `docs/runbook.md` and `.env.example`.

## What works

- The same Series prompt, parser and stage as with Claude, with the whole stage and conversation sent each turn.
- Your photos and a picture of the stage, passed as private temporary image files.
- Look and fix, and amendments (the brain sees a picture of its draft and fixes it).
- Codex's own web search (read only), shown in the activity strip, and Conduit's canvas tools (`canvas_stage`, `canvas_fits` and the others). Quiet and review passes have both switched off.
- Pictures for mock-ups (`PICTURES=openverse`), image generation settings, voice notes, documents and their pages: these do not depend on the brain.
- Token use when Codex reports it, cancelling a turn, the whole-turn timeout, and the stop-all that ends every child.

Each turn is a fresh process with a read-only sandbox in a private temporary folder. Codex emits whole messages, so Series arrives a message at a time rather than word by word, and a first line takes longer than it does with Claude.

## What stays with Claude

These are switched off or hidden when the brain is `codex-cli`, so nothing offers a control that cannot work:

| Feature | With Codex |
| --- | --- |
| Model and effort picker | Not offered; model and effort are server settings |
| Skills (`/skills`, `/skill`, the Skills view) | They are Claude Code skills. The view says so and lists none; a held skill is not read into a turn |
| Agent mode, `AGENT_SERVICES`, permission prompts | Off. There is no way to hand Codex's tool approvals to Conduit's per-action rules yet, so no shell, file or account actions are exposed. The conversation is in plain mode |
| Steward mode | Not offered |
| The critic and "keep making it better" | Off |
| Writing the parts of a document ahead (`AHEAD`) | Off |
| Reading handwriting in a lesson | Refused with a message; type the answer |
| PDF attachments | Not read natively; the turn says so. Use page images or the text |

This is not full parity with Claude. Porting any of these is future work.

## Checking it

Use the browser gate against your own server on its own port, never the one people use:

```sh
pnpm smoke --url http://127.0.0.1:5101 --timeout 180
```

It drives a real headless Chrome with real keys and taps and reports console errors, overlap, clipping, visible answers and the composer.

## Validation on this version

Tested with Codex CLI 0.169.0, a ChatGPT login and `gpt-6.1-sol` at low effort, on a build merged with the current Conduit:

- `pnpm typecheck`, `pnpm build` and `pnpm -s prompt count` (98% of the budget, unchanged): pass.
- `pnpm smoke` against a Codex server, both screens, seven turns: pass. The same build on `claude-cli` also passes.
- The seven welcome starters, sent from the prompt box on a fresh page, all answered at 390x844 and 1280x720. From sending to rest, in seconds:

| Starter | 390x844 | 1280x720 |
| --- | --- | --- |
| Teach my 7-year-old division | 46 | 38 |
| Explain how a heat pump works | 54 | 52 |
| Mock up an Apple fiscal 2025 dashboard (it searched the web) | 40 | 34 |
| Mock up an app screen | 20 | 23 |
| A real webpage for a small coffee roaster | 81 | 65 |
| A little piano | 54 | 36 |
| Compound interest explorable | 17 | 38 |

  The division lesson, the dashboard, the app screen and the webpage read well. The heat pump diagram is correct but its flow arrows do not join up. The piano is cramped on a phone. Once, on the phone, the explorable showed an unevaluated `${...}` in a line of text; the desktop run was right.
- The model picker, tools list and agent mode are absent for Codex (`/brain` reports `configurable: false`, `/tools` is empty); `/api/skills` returns the Claude-only note instead of a list.
- The offline catalogue (`pnpm catalogue`, recorded answers) gives the same 51 of 90 green as before, with no case changing verdict. It does not call a model, so it checks that nothing else moved, not Codex's drawing.

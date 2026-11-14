# Codex / ChatGPT subscription brain

The Claude brain remains available as `BRAIN=claude-cli`. Select `BRAIN=codex-cli`
to use the locally installed Codex CLI and its ChatGPT login. This integration
requires Codex CLI 0.169 or newer (`--ignore-user-config` is required).

Run `codex login` and choose ChatGPT, then `codex login status`. Set CODEX_MODEL to
a model available to that account. No API key is needed or passed to the child;
`forced_login_method="chatgpt"` prevents an API-login fallback. Personal Codex
configuration, hooks and MCP servers are not inherited by the app's turns.

From the isolated Codex worktree:

```sh
pnpm install --frozen-lockfile
pnpm build
BRAIN=codex-cli CODEX_MODEL=gpt-6.1-sol \
  HOST=127.0.0.1 PORT=5100 DATA_DIR="$HOME/conduit-codex-data" \
  LIBRARY=seed DATASETS=none pnpm start
```

Open http://127.0.0.1:5100. Model names depend on the account; the example above was
available on the development account. Optional settings: CODEX_BIN (default
`codex`), CODEX_TIMEOUT_MS (whole turn, default 180000), CODEX_WEB (on/off, default
on), BRAIN_EFFORT (low/medium/high), PROMPT_VARIANT, and CANVAS_TOOLS=off.

## Capabilities

- Shared Series prompt/parser, full stage and conversation context each turn.
- User images and stage snapshots passed as private temporary image files.
- Look-and-fix and amendments, including the previous answer and review context.
- Native Codex web search and Conduit's six canvas MCP tools. Web-search activity is
  displayed in the existing activity strip; canvas calls use the existing internal
  attention tracking, as with Claude. Raw results and credentials are not copied
  into the activity strip. Quiet and review passes have web and canvas tools disabled.
- Token usage when reported by Codex, cancellation, whole-turn timeout and the
  existing tracked-process stop-all mechanism.

Each turn uses a fresh ephemeral process. Codex exec emits completed messages, so
Series arrives a message at a time rather than token by token. Model and effort
are server settings for now; the Claude-specific model picker is not offered.
Claude's critic, fill-ahead verifier and external agent integrations remain
Claude-only. Arbitrary MCP connections and shell/file/account actions are not
exposed: those require a Codex approval bridge before they can satisfy Conduit's
per-action permission rules. Native PDF attachments are not supported by this
adapter; use images or extracted text. This is not full Claude tool parity.

The CLI runs in a private temporary directory with a read-only sandbox. Its Series
instructions replace the coding instructions. Temporary images/instructions are
removed and the canvas token is revoked when the turn ends. No credentials are
written into the repository.

## Browser gate

```sh
pnpm smoke --url http://127.0.0.1:5100 --screens 1280x900,390x844 \
  --turns 1,2 --timeout 180 --no-chat --out /tmp/conduit-codex-smoke
```

The existing runner starts its own headless Chrome profile and drives actual keys
and clicks. It saves screenshots and reports console/request errors, overlap,
clipping, visible answers and composer behavior. Do not run its default URL
against the live app. No unit tests are needed for this workflow.

Codex settings reference: https://developers.openai.com/codex/config-reference/

## Validation of this branch

Tested with Codex CLI 0.169.0 and the development account's `gpt-6.1-sol` login:

- `pnpm typecheck`, `pnpm build`, and `git diff --check`: passed.
- Real Chrome lighthouse and follow-up flowchart: all checks passed at 1280x900
  and 390x844 after tightening Codex's diagram instructions.
- Desktop chat (send, reply, trace, canvas, composer): passed.
- Phone chat: one run failed the saved-snapshot visibility check despite a visible
  caption in the browser screenshot. A separate phone-chat retry passed every
  check. Treat the snapshot discrepancy as intermittent, not conclusively fixed.
- Dedicated web-search and canvas-tool browser runs passed. Actual web-search
  events and `canvas_stage` / `canvas_fits` server calls were verified, rather than
  relying on the model saying it had used a tool. The final canvas run recorded
  two calls and passed every browser check.

Review artifacts on the development machine: `/tmp/conduit-codex-final`,
`/tmp/conduit-codex-tools`, `/tmp/conduit-codex-canvas-final`, and
`/tmp/conduit-codex-chat-final`. Session evidence is under
`~/conduit-codex-data` (including `tools-debug`). No unit tests were added.
The full seven-turn deployment gate has not been run; the principal session must
still run its merge gate. Nothing was deployed or pushed.

# Runbook: local development

This document answers one question: **how do I run it and poke at it?**

> **v2.** The quality and expression round is built and integrated (`PLAN-v2.md` records what it measured). Everything below is how it runs now; rows marked (v2) are new in this round. To run a second copy beside another (the round was built on 4600 and 4601): `PORT=4600 VITE_PORT=4601 VITE_API=http://127.0.0.1:4600 BRAIN=claude-cli CLAUDE_MODEL=sonnet pnpm dev`.

## Once

```sh
nvm use            # Node 22.14.0, from .nvmrc (any 22.x from 22.14 will do)
corepack enable    # so pnpm 10.28.2 from package.json is used
pnpm install
cp .env.example .env
```

Then set `BRAIN` in `.env` (see below). The server refuses to start without it and says exactly what is missing.

## Ports

| What | Where |
| --- | --- |
| server (API, and the built web app in production) | http://127.0.0.1:4300 |
| web dev server (Vite; proxies `/api` to 4300) | http://127.0.0.1:4301 |

Both ports are strict: if one is taken the process fails instead of picking another. To run a second copy, set `PORT=` for the server and `VITE_PORT=` and `VITE_API=http://127.0.0.1:<that port>` for Vite.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | server and web dev server together, both reloading on change. Open http://127.0.0.1:4301 |
| `pnpm dev:server` / `pnpm dev:web` | one of them |
| `pnpm typecheck` | type-checks every package. |
| `pnpm check [--url <server>] [--out <dir>] [--screens 1280x720,390x844] [--allow-plain]` | the free browser check, and the one CI runs: with no `--url` it starts its own server from the build (`BRAIN=replay`, a throwaway `DATA_DIR`, a free port) and stops it; plays the welcome (also under reduced motion) and every offered demo in headless Chrome, taps a starter, works the explorable's controls, and runs smoke's checks on each screen. Run `pnpm build` first. Prints the renderer it got (a fall back from WebGL fails it unless `--allow-plain`). No model, no account. |
| `pnpm smoke [--url <server>]` | one scripted conversation with a live brain, in headless Chrome at desk and phone sizes (the deploy gate). Needs a server with a real brain. |
| `pnpm catalogue` | the real-browser cases in `catalogue/`, replayed at desk and phone sizes. |
| `pnpm build` | builds the web app into `web/dist` |
| `pnpm start` | production mode: the server serves the API and `web/dist` on 4300. Run `pnpm build` first. |
| `pnpm timeline <name or path>` | prints when every line of a script would play. `pnpm timeline overture`. With no argument it checks every worked example in the prompt. |
| `pnpm prompt` | prints the brain's system prompt for a painter that does everything. `pnpm prompt relay` adds the relay appendix, `pnpm prompt v3` is for a painter with no structures, charts or controls (today's), `pnpm prompt flat` for one that only sets type, `pnpm prompt model` with an image model as well, `pnpm prompt count` prints what each costs and fails above `PROMPT_BUDGET`. |
| (v2) `pnpm library [list \| match "<message>" \| check \| lint [file…] \| usage]` | the technique library: what it holds, which techniques a message would be handed and what they add to the brief, every battery prompt against it (with the time choosing takes), whether technique files may be written, and how often each technique was handed over and how its answers judged. |
| (v2) `pnpm improve [--dry-run \| --budget <usd> --experiments <n> --yes]` (nothing runs without `--yes`), `improve status \| approve <id> \| refuse <id> --why "…" \| vault --file <path>` | the improvement loop (see "The improvement loop" below). `--dry-run` prints what a run would do and what guards it. |
| (v2) `pnpm taste` | how far the judge agrees with the owner's own scores in `explore/taste/` (written by the taste page, `/taste.html`). |
| `pnpm sessions [file]` | reads session logs back (see "The session log") |
| `pnpm explore [flags]` | runs the exploration battery (see "The exploration battery") |
| `pnpm docs:language` | regenerates the reference section of `docs/language.md` from the code |
| `pnpm --filter @conduit/web fonts` | rebuilds the processed font files in `web/src/fonts` (needs Node 22.6 or later) |

`pnpm check` takes two more flags. `--only <groups>` runs just those groups (comma-separated, each a name or the start of one: `--only art-maker,memory`, `--only demo`, `--only demo-toolkit`; `choice` picks the welcome) plus only the servers they need, and `--list` prints the names. `--jobs <n>` runs that many groups side by side, each in its own Chrome (default min(8, cpus/2); `--sequential` means 1), and the report keeps its usual shape and order. `CHECK_PORTS=a-b` is honoured by every server and Chrome debugging port it starts (three servers and up to `--jobs` Chromes at once, so give it 8 or more: each server takes one, and a few shared Chromes the rest). Builders run `--only` for their area; the steward runs the full suite before a deploy.

The browser tools (`pnpm check`, `smoke`, `catalogue`, `explore`) find Chrome in the usual places on macOS and Linux, or at `CHROME_BIN`. They use the GPU on a Mac and SwiftShader (software WebGL) on Linux; `CHROME_GL=swiftshader` forces that anywhere.

One brain at a time (`claude-cli`, `codex-cli` for a ChatGPT login, `relay`, `replay`; `docs/codex.md` says what `codex-cli` does and does not do). To switch brains, stop the server and start it with another `BRAIN`; for a single run you can set it inline: `BRAIN=replay pnpm dev`.

## Environment

Only the selected brain's settings are read.

| Name | Needed | Default | Meaning |
| --- | --- | --- | --- |
| `BRAIN` | always | none | `relay`, `claude-cli` or `replay`: who answers prompts |
| `HOST` | no | `127.0.0.1` | address to bind. Leave it alone. |
| `PORT` | no | `4300` | |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` |
| `DATA_DIR` | no | `~/Library/Application Support/Conduit` | where the owner's data lives, outside the repository (see "Operating it") |
| `LOG_DIR` | no | `<DATA_DIR>/logs` | where session logs go; `off` writes none |
| `OWNER_LOGINS` | no | unset | comma list of Tailscale logins allowed through `tailscale serve`; unset: nobody is refused on identity (never commit it) |
| `USAGE_HOURLY_CAP` | no | off | dollars (cost-equivalent) per rolling hour; the critic and `pnpm lessons` stand down from 80% of it; your own turns are only warned |
| `AHEAD` | no | `on` with `claude-cli` | v3: write the parts of a document that are only named (a worksheet's questions, a syllabus's chapters), in the background, a few at a time, and check each before it is offered; `AHEAD_PARALLEL` (3, at most one fewer than `CLAUDE_MAX_WARM`), `AHEAD_VERIFY_MODEL` (`sonnet`), `AHEAD_VERIFY_EFFORT` (`low`), `AHEAD_BATCH` (3 parts a check), `AHEAD_LIMIT` (60 parts a conversation). Calls are on the meter as `ahead` and `verify`; fill ahead stands down at 60% of `USAGE_HOURLY_CAP`, before the critic |
| `MIGRATE_FROM` | no | none | comma list of other checkouts whose `logs/` are copied into `DATA_DIR` on the first start |
| `SIGHT` | no | `snapshot` | what a brain is told about how its last answer landed: `report` (the structured report) or `snapshot` (the report and a picture of the resting stage). With `report` the browser takes and sends no picture. |
| `CLAUDE_MODEL` | when `BRAIN=claude-cli` | none | passed to `claude --model`, for example `sonnet` |
| `BRAIN_EFFORT` | no | `low` | passed to `claude --effort` on every spawn and written over `CLAUDE_EFFORT` in the child, so a shell that exports `CLAUDE_EFFORT` never changes the brain's latency or cost. `low`, `medium`, `high`. The exploration battery's plain baseline uses the same value. |
| `BRAIN_THINKING` | no | `on` | `off` starts every claude process with `--thinking disabled`: no hidden deliberation before the first line and none between tool calls. Measured with opus at medium effort (docs/technology.md, "Streaming"): with it on, the model deliberated for 12 to 15 s and then drafted its answer inside `canvas_fits` calls, and the answer reached the stage in one burst 42 to 116 s in; off, the first line came at 5 s and the lines spread over the 8 s the model took to write them. What it costs in the quality of the answers (and of the look-and-fix pass, which runs on the same process) was not measured. |
| `PROMPT_VARIANT` | no | `column` | which teaching of the prompt. One exists; a second, `hero`, was measured, scored level and was removed. The battery's `--variant` is how two are compared. |
| (v2) `REVIEW` | no | `on` | look and fix: the brain is shown its draft and fixes it within the turn. The conductor runs the pass; the viewer's switch in the bar sends `x-conduit-review: off` to turn it off for them. |
| (v2) `REVIEW_PASSES`, `REVIEW_DRAFT_WAIT_MS`, `REVIEW_FIRST_LINE_MS`, `REVIEW_PASS_MS` | no | `1`, `1500`, `12000`, `30000` | fix passes after the draft (0 to 2), and the three waits |
| (v2) `LIBRARY` | no | `seed` | where techniques come from: `seed` (the repository's `techniques/seed`) or `none`. Any other value is ignored with one warning at start-up and the seed is used. |
| (v2) `LIBRARY_OVERLAY` | no | none | a folder of technique files laid over the library (the improvement loop's candidates) |
| (v2) `EXPLORE_WEB_PORT` | no | `4661` | the web dev server the battery starts for its pictures (or pass `--web <url>` to use one that is running) |
| `CLAUDE_BIN` | no | `claude` | the Claude Code executable |
| `CODEX_MODEL` | when `BRAIN=codex-cli` | none | a model your ChatGPT account offers; `docs/codex.md` |
| `CODEX_BIN` | no | `codex` | the Codex CLI executable (0.169 or newer) |
| `CODEX_TIMEOUT_MS` | no | `180000` | the whole turn, tools included |
| `CODEX_WEB` | no | `on` | Codex's own read-only web search (`on`, `off`) |
| `CLAUDE_WARM` | no | `on` | `off` starts one process per turn instead of keeping one per conversation (an interrupted turn's process is killed at once) |
| `CLAUDE_MAX_WARM` | no | `4` | conversations that may hold a process at once |
| `CLAUDE_WARM_IDLE_MS` | no | `600000` | a process nobody has asked anything for this long is stopped |
| `CLAUDE_RECYCLE_TOKENS` | no | `150000` | a conversation whose input has grown past this gets a fresh process (and a full brief, which attaches its documents again). A 15-page PDF is about 47,000 tokens, so the default leaves room for a paper or two beside the talk. |
| `READ_LINKS` | no | `on` | `off` stops the server fetching the links in a prompt; the brain is told it could not read them. Any brain. |
| `BRAIN_TOOLS` | no | `WebSearch,WebFetch` | the only tools the brain may hold, read-only web; anything else refuses to boot; empty is none |
| `CLAUDE_FIRST_TOKEN_TIMEOUT_MS` | no | `120000` (`60000` with no tools) | give up if the model has written nothing by then |
| `CLAUDE_IDLE_TIMEOUT_MS` | no | `30000` | give up if the model goes quiet for this long mid-answer |
| `RELAY_IDLE_TIMEOUT_MS` | no | `180000` | a claimed turn that receives no lines for this long fails |
| `REPLAY_SCRIPT` | no | none | with `BRAIN=replay`, the script every prompt plays. Unset: a prompt that is a demo's name plays that demo, anything else plays `overture`. |
| `NODE_ENV` | no | | `production` makes the server serve `web/dist` (`pnpm start` sets it) |

## Pages

| Page | What it is |
| --- | --- |
| `/` | the stage and the prompt. With no prompt yet, it performs `overture`: a short welcome and seven starters to tap. |
| `/gallery.html` | one script, `styles`, as eight stills (one per look) and one live stage in the look you choose |
| `/explore.html` | the exploration page: one card per prompt of a battery run (see below) |
| (v2) `/taste.html` | the taste page: twenty answers from a run, one at a time, a thumb and a word each, saved to `explore/taste/`; the judge's score is hidden until you have scored. On a phone it is the page to use. |
| (v2) `/bench-chart.html` | every kind of chart in every look, with the frame time of 10,000 points; for working on `web/src/render/chart/` |
| `/bench-painter.html` | the painter on the plain renderer with no server: for working on layout and motion |
| `/bench-renderer.html` | the WebGL renderer with no painter: for working on a look or an effect |

Query parameters on `/`:

| Parameter | Effect |
| --- | --- |
| `debug=1` | shows the HUD: playhead, pen, lead, clock state, recent lines, last sight and back-channel events |
| `demo=<name>` | the script performed on load: `overture`, `sketchbook`, `plainly`, `titles`, `styles`, (v2) `diagrams`, `explorable`, `charts`. `demo=none` performs nothing. |
| `look=<name>` | locks the stage to one of the nine looks |
| `renderer=plain` | forces the DOM renderer. `renderer=three` forces WebGL. |
| `motion=reduced` | behaves as if the OS asked for reduced motion. `motion=full` ignores the OS setting. |
| `lens=1` | (PLAN-canvas step 1, experimental) a lens on the stage: two fingers pinch and pan, one finger on empty stage pans, Ctrl or Cmd with the wheel zooms, `0` fits, `1` goes to 100%, `+` and `-` zoom, the arrows move. A Pencil drags to draw without Draw switched on, and a short Pencil tap presses. The layout is untouched; off, nothing changes. `pnpm check` has a lens group for it. Ignored with `wall=1`. |

The bar under the stage has Show all (also the `.` key while the stage has focus: the stage is a focusable region, so the key never swallows a character typed elsewhere), Save (film of the latest answer, the whole conversation as one WebM, a picture as PNG or SVG, MIDI, copy script, play a script) and Transcript.

## (v2) The technique library, taste and the improvement loop

- **The library.** `pnpm library` says what it holds (the seed in `techniques/seed/`, and an overlay if `LIBRARY_OVERLAY` names one). Turns are served from an index in memory, read once at boot; the start-up log says `library.loaded` with the count. To add a technique, put a file in `techniques/seed/`, run `pnpm library lint` and `pnpm library check`. Settings from earlier versions (`LIBRARY_ROOT`, `LIBRARY_REFRESH_MS`, `LIBRARY_TIMEOUT_MS`, `DATASETS*`) are no longer read; a server that still has one set warns once and starts.
- **Taste.** `pnpm explore` writes a run; open `/taste.html`, score twenty answers (on a phone, by Tailscale, if you like), and `pnpm taste` prints how far the judge agrees with you (`TASTE_FLOOR`: 75% and kappa 0.4).
- **The loop.** `pnpm improve --dry-run` first. **Do not make a real run yet**: the keep rule decides on noise, the builder is not confined, the candidate is measured by its own harness, a technique is measured without its technique, and the cleanup can delete the base branch (`PLAN-v2.1.md`, package I). The loop has only ever run with stand-ins. A run (`pnpm improve --budget 3 --experiments 1 --yes`; without `--yes` it prints its plan and does nothing) measures the tune set, asks the critic for a proposal, builds it in a worktree, refuses a diff that touches a protected path, measures baseline and candidate interleaved on the held-out set, asks a reviewer, and stops at `awaiting-steward`. With no taste sheet it runs **uncalibrated**: the records say so and nothing is approved without you. `pnpm improve status` lists what waits; `approve <id>` merges into the branch you are on (never `main`); `refuse <id> --why "…"`. Every experiment is in `loop/ledger.jsonl` and `loop/CHANGELOG.md`.

## The three brains

### replay: no model at all

```sh
BRAIN=replay pnpm dev
```

Every prompt plays a fixture from `language/demos/`. Type `sketchbook` to play that one. Deterministic; use it for anything visual.

### claude-cli: a real model, no API key

```sh
BRAIN=claude-cli CLAUDE_MODEL=sonnet pnpm dev
```

Needs Claude Code installed and logged in. One headless `claude` process with no tools is kept per conversation, opened on its first prompt or tap (a page that only looks, such as the gallery, starts none), so a second turn costs a short brief and reads the system prompt from cache. The system prompt is fixed for the conversation; the screen, the look and the stage ride in each turn's brief, so resizing the window or changing the look never starts a new process. To check the brain without the server or a browser:

```sh
pnpm --filter @conduit/server exec tsx src/brains/claude-cli/probe.ts "pixel art of a fox" "now make it blue"
```

### relay: you are the brain

```sh
BRAIN=relay pnpm dev
```

Now a prompt typed in the browser waits until something claims it over HTTP. Open `/?demo=none` to start from an empty stage (otherwise the page performs `overture` first and that run is turn `t1`); read the turn id from the claim rather than assuming it. From another shell:

```sh
# 1. Read the language, once.
curl -s localhost:4300/api/relay/guide

# 2. Claim a prompt (a POST: it changes state). Waits up to 25 s; prints nothing and exits on 204.
curl -s -X POST 'localhost:4300/api/relay/next?wait=25'
# -> {"turn":"t1","session":"c1","input":{"kind":"prompt","text":"…"},"context":{…},"brief":"…","links":{…}}

# 3. Write a scene. Lines can be sent in as many calls as you like.
curl -s -X POST localhost:4300/api/relay/turns/t1/lines -H 'content-type: text/plain' --data-binary @- <<'EOF'
scene figure lines=2
circle c1 50,45 25 stroke=accent thick=1.5
say lab label near=c1:below | a circle
EOF
# -> {"accepted":4,"rejected":[],"warnings":[],"clock":{"pen":3.15,"playhead":null,…},"events":[],"cursor":2,"ended":false}
#    (playhead is null until the painter has reported this turn; the pen is exact)

# 4. Listen at the break: what has the audience seen? Did they tap or interrupt?
curl -s 'localhost:4300/api/relay/turns/t1/events?wait=5'

# 5. Write more, then end the turn (or put ?end=1 on the last lines).
curl -s -X POST 'localhost:4300/api/relay/turns/t1/lines?end=1' -H 'content-type: text/plain' --data-binary 'say a2 aside | Round all the way.'

# 6. The next prompt's claim carries a brief that says how this answer landed.
```

If the viewer interrupts, the events carry a `report` with `"outcome":"interrupted"` and what was shown, and the next claim's `brief` says "The user interrupted at 3.4s … Everything you wrote after that never happened." A rejected line never fails the whole request: the answer says which lines were dropped and why. `curl -s localhost:4300/api/relay/status` shows what is waiting and what is claimed.

## (v2.1) The brain is an agent

There is one brain, and it is always the agent: every conversation starts with the tools the owner offered switched on (the two web tools by default, and any connected service or the browser once it is listed). Reading is free and instant; anything else is asked for on the stage, each time. There is no "plain" to choose, no mode in the picker, and `/brain` is not in `/help`. The only other mode is the developer's `steward` (`STEWARD=on`, then `/brain steward`).

| Setting | Default | Meaning |
| --- | --- | --- |
| `AGENT` | `on` (with `BRAIN=claude-cli`) | `off` gives a server with no agent: the brain keeps only the read-only web tools in `BRAIN_TOOLS` |
| `AGENT_TOOLS` | `WebSearch,WebFetch` | the CLI's own tools offered (`Read`, `Glob`, `Grep`, `Write`, `Edit` too); a file tool exists only when `AGENT_DIR` is set |
| `AGENT_SERVICES` | none | connected services, `name=/path/outside/the/repo.json,...` (an MCP configuration file; it may hold a credential, so never inside the repository), and the word `chrome` for the owner's browser (below). Calls to a service always ask, unless the service's own annotation says a tool only reads |
| `AGENT_DIR` | none | the one folder file tools may touch; the process is started in it with `--restricted` |
| `AGENT_ANSWER_MS` | `120000` | how long the owner has to answer a confirm control; no answer is a no |

`/tools` lists what is offered and switches one thing off or on for this conversation (`/tools chrome off`). The rules are code (`server/src/domain/agent.ts`, `browser.ts`, `server/src/brains/claude-cli/`), not prompt:

- The process is started with `--tools <exactly the offered ones>`, `--permission-mode manual`, `--permission-prompts host`, `--permission-prompt-tool stdio` and `--restricted`, and each service's `--mcp-config` with `--strict-mcp-config`. Never `--dangerously-skip-permissions`, `bypassPermissions`, `acceptEdits` or `--bare`. The CLI asks this process before every call that is not already allowed; `gateCall` answers: a tool not switched on is denied, a `read` runs, anything else is put to the owner as a `permission` event (`write`, `run`, `send`, `buy`, `delete`, `publish`, `signin`) and held until a `permit` arrives or the deadline passes. There is no "always allow". The confirm control shows the whole call (`detail`, scrollable, redacted), waits about half a second before its buttons work, and ties each click to its own request.
- When nothing but the two web tools is on, the CLI is told to allow them itself (`--allowedTools`): a prompt is answered as fast as without an agent (measured: first line 1.7 to 2.1 s, either way; with the web tools asked about instead, the brain searched before drawing in about one turn in four). With a folder, a service or the browser on, a fetch with a query string, or to any host but a search or reference site, is asked for and shown in full, so that a fetch cannot carry out what the other tools read.
- A look at the draft and the fix that follows use no tools: a call in one asks nothing and the pass is stopped.
- A tool's input and result stay in the CLI's own conversation. The activity strip, the log and the session record get a few words (`summaryOf`, through `redactSecrets`); only the confirm control gets the whole call.
- Something that needs the owner's own hands (a sign-in, a code, a payment) is a `signin` or `buy`: it is asked for and then left to the owner.
- `pnpm agent-check` checks all of this with no model: the policy tables, a scripted stand-in for `claude`, and the real road of an answer over HTTP (it starts the server on port 4785, answers a confirm control with the CLI's 36-character request id and checks the write happened). `pnpm agent-check -- --real` adds one tiny live turn.

### The browser (`chrome`)

The brain can use the owner's own Chrome through Claude in Chrome, in tabs of its own. To turn it on:

1. Chrome is open on this Mac with the Claude in Chrome extension installed and signed in to the same Claude account as the `claude` CLI.
2. In `.env`: `AGENT_SERVICES=chrome` (alongside any others: `AGENT_SERVICES=chrome,notes=/path/mcp.json`). Restart the server.
3. `/tools` now lists `chrome` as on; `/tools chrome off` switches it off for a conversation. If the extension is not connected, the first browser call fails and the brain says so; nothing else changes.

Private destinations are refused in every permit level, `auto` included: loopback and `localhost`, private ranges (10/8, 172.16/12, 192.168/16, fc00::/7), link-local, shared 100.64/10, `.local` `.internal` `.lan` names, single-word hosts, and any public name that resolves to one of those (`domain/destinations.ts`). The owner may allow particular hosts, one per line, in `<DATA_DIR>/private-hosts.allow`; the file does not exist by default.

What it does there, by what it is (`riskOf`/`gateCall`, `domain/browser.ts`):

| Call | Risk | Answer |
| --- | --- | --- |
| tab list, screenshot, zoom, scroll, hover, wait, page text, page tree, find, console | `read` | runs |
| navigate to a plain public http(s) address (no query, no fragment, a short path) | `read` | runs |
| navigate to an address with a query or fragment, or a long path | `send` | asked, full address shown |
| navigate to a private address, `back`/`forward` | `run` | asked |
| click, key, form input, type | `run` | asked, each time |
| open the session's tab (`tabs_context_mcp` with `createIfEmpty`), `tabs_create_mcp`, `tabs_close_mcp` | `write` | asked |
| anything at all on a page whose address looks like a sign-in | `signin` | asked, at the highest risk |
| anything at all on a payment or checkout page, navigating to one | `buy` | asked, at the highest risk |

Always refused, with or without a permit, and the brain is told so and told to leave it to the owner:

- typing a password, a card number, a one-time code or anything shaped like a secret (`type`, `form_input`, or keys that spell it);
- typing anything on a sign-in, payment or checkout page, or on a page a read showed a password or card field on;
- any call on a tab the brain did not open itself (the tab list of an earlier group, the owner's tabs); a `navigate` with no tab named;
- `browser_batch` (several calls in one: the gate would see one), `javascript_tool`, `file_upload`, `upload_image`, `gif_creator` (a download), `resize_window`, `read_network_requests`, and choosing or switching the owner's browser. These are removed from the process (`--disallowedTools`) and refused again if one is called.

The owner signs in to any site themselves, in their own Chrome, and tells the brain to go on. The brain gets an image from the owner's ChatGPT by opening chatgpt.com in its tab, typing the prompt (asked), waiting, and taking a screenshot. **The picture cannot yet be put on the stage**: this build has no upload store and `pic from=` has no route (the package for pictures in is S4), so the brain says the image is made and waiting in their tab and leaves the tab open. What S4 needs from here: the screenshot arrives in the stream as an inline `image` block (and, with `save_to_disk`, as a file under `$TMPDIR/claude-chrome-screenshots-*`); store it in the upload store and tell the brain its id.

### Steward mode

`STEWARD=on`, then `/brain steward` in a conversation. Its turns, and its looks at drafts, wait in the relay for a Claude Code session to claim them. From that session (run `listen` in the background so it is told when a turn arrives):

```sh
PORT=<the server's port> pnpm --filter @conduit/server exec tsx src/tools/relay.ts listen      # one JSON line per claimed turn: brief, links, the snapshot's file
printf 'scene layout=solo\nsay a1 | Hello.\n' | PORT=<port> pnpm --filter @conduit/server exec tsx src/tools/relay.ts say t3 --end
PORT=<port> pnpm --filter @conduit/server exec tsx src/tools/relay.ts end t3 | status
```

(`pnpm relay …` once the root `package.json` has the script.) There is no default port, so the tool can never claim a turn from a server that is not yours. A turn claimed a second time is the look at its draft: the brief says so and names the file the picture is in; answer with fix lines or `ok`.

## Operating it (v2.1 ops)

Conduit runs on the owner's Mac, on 4600, published to the tailnet by `tailscale serve`. This is how it is kept safe and kept up.

**Identity.** `tailscale serve` connects from 127.0.0.1 and says who the caller is in headers (measured on this Mac): `Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-User-Profile-Pic`, `Tailscale-Headers-Info`, plus `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`. `serve` overwrites any `Tailscale-User-*` header the client sends, so a header that came through it can be believed. `server/src/identity.ts` is the one place it is decided: a request from loopback with none of those marks is the owner at the keyboard (`local`); one that came through `serve` must carry a login in `OWNER_LOGINS`, else 403; a request not from loopback is always refused. The login is logged on every turn (`turn.opened`, the session log's `turn` record) and in the audit. `GET /api/whoami` says what the server takes you to be; open it through the tailnet address to read your own login for `OWNER_LOGINS`.

**Reports from the page.** "Report a problem" in the `+` menu opens a sheet with one optional note. Send saves, in `DATA_DIR/reports/<UTC time>-<session>/`, `report.json` (the note, the context: session and turn, look, viewport and DPR, user agent, work mode, build commit; and the last ~90 seconds of events: taps and what they hit, pointer down and up with kind pen, touch or mouse, what the ink layer did with each (drawn, ignored and why, stroke kept or abandoned), key names, scroll and viewport changes, console errors, failed requests) and `screen.png` (the stage with the ink over it), `stage.png`, `ink.png`. The picture and events are taken when the menu item is pressed, not when Send is. No model is called; the route (`POST /api/reports`, 12 MB cap) is behind the same owner identity check as the rest of `/api`. Nothing leaves the data folder. `pnpm reports` lists them newest first (time, session, turn, the note's first line, event count); `pnpm reports show <id>` prints one in full with its picture paths (an id may be the start of a folder name); `--data <dir>` reads another folder.

**The data folder.** `DATA_DIR` holds `logs/` (session logs and pictures), `uploads/`, `audit.jsonl`, `usage.jsonl`, `cache/`, `loop/queue/` (critic findings, lessons usage) and `state/` (the kill switch). The first start copies the old places (the repository's `logs/`, `loop/queue/`, and any checkout in `MIGRATE_FROM`) into it, once (`state/migrated.json`); it never moves, deletes or overwrites. `pnpm sessions`, `capture`, `lessons` and `critic-usage` read it; each takes `--data <dir>` for another (`--from` is the older spelling).

**The audit trail.** `audit.jsonl`: every tool call, permission asked and answered (including a `permit` that matched nothing), setting change, connector or service use (Chrome is `chrome`), refused request, kill and start, each with time, session, turn, login, tool, target (secrets and address queries removed), the decision and who decided (`policy`, `owner`, `timeout`, `turn`, `kill`, `system`). `GET /api/audit?limit=&kind=&session=&login=&since=`; `pnpm audit-log` (or `pnpm run audit`; a bare `pnpm audit` is pnpm's own vulnerability check and never reaches this).

**The kill switch.** `/stop-all` in the app, or `curl -X POST http://127.0.0.1:4600/api/kill`. In under a second or two, whatever any child is doing: every turn ends `interrupted`, every question waiting for you is refused, every brain and critic process is SIGKILLed with everything below it (it does not wait for one to agree), and agent tools are off, and stay off across a restart, until `/stop-all resume` (`DELETE /api/kill`). The answer says what it did and which pids, if any, would not die. Tabs the brain opened in Chrome belong to the extension's tab group and cannot be closed once the brain is gone: the answer counts them and you close the group by hand.

**Usage.** `usage.jsonl` meters every model call the server makes (turn, review pass, critic look, comparison) and `pnpm lessons`: tokens, cost-equivalent, ms, model. `GET /api/usage?hours=48&days=14`; `/usage` in the app. With `USAGE_HOURLY_CAP` set, fill ahead (the parts a document has only named, written in the background) backs off first, at 60% of the cap, the critic and lessons at 80%, and the second check of what was written ahead at 100%; the owner's turns are never refused, and the answer to one carries a `warning` when the hour is near or over.

**As a service.** `ops/install.sh` builds the committed code into `~/.conduit/app` and loads `~/Library/LaunchAgents/com.conduit.server.plist` (RunAtLoad, KeepAlive; logs to `<DATA_DIR>/service.log`); `ops/uninstall.sh` reverses it and leaves the data. Port 4600 must be free first (stop the nohup server). `--dry-run` shows the plist without loading anything.

```sh
OWNER_LOGINS='<your tailscale login>' ops/install.sh --keep-awake
```

**Sleep.** A sleeping Mac serves nothing. `--keep-awake` runs the server under `caffeinate -is`: no idle sleep, and no system sleep on AC power, for as long as it runs. A closed lid on battery still sleeps, and so does a Mac in Low Power Mode; keep it on power with the lid open, or set System Settings, Battery/Energy, "Prevent automatic sleeping on power adapter".

**A crash does not stop it.** An unhandled rejection or exception is logged, audited and survived; ten in a minute exit so launchd restarts it. A turn's `finish` never throws. Shutdown exits within 6 s whatever a child is doing.

## Links and long text

A prompt with an `http(s)` link (two at most) has it fetched by the server, not by the brain, which has no tools. Public addresses only: loopback, private, link-local, CGNAT (100.64/10, which includes the tailnet) and multicast are refused, by name or by number, on every redirect (three at most). Fifteen seconds in all, 20 MB after decompression. A PDF goes to the model whole as a `document` content block; a web page becomes its headings and paragraphs, text and markdown go as they are, each cut at 40,000 characters with a note in the brief when it was cut. A prompt of 1,500 characters or more is treated as a document too (up to 20,000 characters), and its links are left alone. The material is marked in the brief as material, not instructions, and stays with the conversation: a later turn still has it, and a recycled process is given it again.

To see what happened to a link, `pnpm sessions <file>` prints a `fetch` line per link (URL, final URL, status, type, bytes, ms, outcome). To try it without the browser, post a turn whose text holds a link and read the stream: a `reading` event (`start`, then `done` or `failed` with the reason) comes first.

## The session log

Every conversation writes one file to `logs/` (one `.jsonl` per session; `logs/` is not tracked). It holds what the user typed or tapped, the brief given to the brain for each turn, every brain line with its time, each rejected line and why, the report of how the turn landed, and the turn's usage (output and thinking tokens, cache reads, cost when the brain reports it). When `SIGHT=snapshot`, the picture of the resting stage is saved beside it as `<stamp>-<session>-<turn>.jpg`. Uploads (sketches, snapshots) are limited to 1 MB each.

```sh
pnpm sessions                     # the files, newest first, with turns and total cost
pnpm sessions <file or session>   # every turn: what was asked, what was shown (struck text marked, drawn things in brackets), rejects, first-line time, tokens, cost
pnpm sessions <file> --lines      # the same with every brain line
pnpm sessions <file> --csv        # one row per turn
```

## The exploration battery

`explore/battery.json` holds fifty-eight prompts and ten scripted conversations: v1's thirty-five and five, and (v2) twenty-three prompts and five conversations for structures, charts, explorables and drawings that need a look. `explore/sealed/heldout.json` is a second set of twenty-eight prompts and three conversations that decides whether the improvement loop keeps an experiment; do not tune against it (its README says why). The runner plays either file (`--pool tune|heldout`, `--battery <file>`), teaches the brain exactly what the page's painter can do, and works controls and charts through the page. Three limits of it are known and are being fixed in v2.1 (`PLAN-v2.1.md`, package H): it drives a pick with a value the painter refuses and pictures a toggle before it has eased, so what it says of explorables is not yet to be believed; it counts overlapping text only between free texts; and the held-out file is not out of sample (seed techniques name its subjects, and the prompt was edited after a run of it), so nothing measured on it may be called held out.

Of v1's thirty-five prompts, thirteen are held out in the older sense: no worked example in the brain's prompt mirrors them. Each prompt has the use it tests, what it expects (`plain`, `drawn`, `pixels`, `scene`, `type`, `motion`, `any`), whether it is an information prompt (the two prompt variants are compared on those), whether a stated duration is to be honoured, and whether to compare it with a plain-English answer. The conversations are two to four turns on one brain session: a look change mid-conversation, an interruption, tapping a choice, and "look at what you drew; fix it" on a diagram and on a chart (the second turn receives the sight report and the picture).

```sh
pnpm explore --dry-run                 # print the plan, the call count and the projected dollars; run nothing
pnpm explore --brain replay            # no model, judge or conversations: each prompt plays the demo named by its id, else one chosen by what it expects
pnpm explore --brain claude-cli --model sonnet --samples 2 --max-usd 6 --yes
pnpm explore --only sky-blue,story     # a few prompts or conversations
pnpm explore --held-out                # only what no example mirrors
pnpm explore --pool heldout            # (v2) the sealed set, explore/sealed/heldout.json; --pool tune is the default. --battery <file> plays any battery file (the vault)
pnpm explore --no-review               # (v2) leave look and fix off: the draft is the answer. On by default with claude-cli, through the same reviewTurn the server uses
pnpm explore --samples 5               # samples per prompt (default 3); every check gets a pass rate
pnpm explore --no-cases                # single-turn prompts only
pnpm explore --no-judge                # skip the model that looks at the final still
pnpm explore --judge-model sonnet --judge-effort medium --judge-frames 3
pnpm explore --no-baseline             # skip the plain-English comparison
pnpm explore --timeout 120             # seconds a turn may take (default 180)
pnpm explore --web http://127.0.0.1:4661   # use this running web dev server for the judge's pictures
```

A run projected over `--max-usd` (default 5) refuses to start without `--yes`; the projection over-estimates the judge. The judge's pictures are made by the painter's own engine in a headless Chrome (`CHROME_BIN` names it when it is not in a usual place) behind a Vite dev server the tool starts on port 4661 (`EXPLORE_WEB_PORT`) unless `--web` names one; both are stopped when the run ends. The judge is `claude -p` shown the final still and the prompt, and returns whether it shows what was asked, whether any text is unreadable or overlaps, whether a label points at the wrong thing, whether it is correct, and a coherence score from 1 to 5. `--variant` runs more than one teaching of the prompt on the information prompts when more than one exists (one does). Compare variants by judge score and tokens, not dollars (cache warmth confounds cost).

Each sample is a fresh conversation, so every one pays a cold start; it is not the warm latency the server gives. A run is written to `explore/runs/<id>/` (an `index.json`, one `<prompt>_<variant>_s<n>.json` per sample and one `<case>_<variant>_s<n>.json` per conversation; not tracked) and a table is printed: first visible line, first and last word, the viewer's wait at reading speed, output tokens, cost per sample, the checks and the judge's score, with pass rates and like-for-like baseline sums in the footer. One Ctrl-C finishes the current unit and writes the run; a second abandons it. The baseline runs at the same effort as the brain.

Read a run on `/explore.html` (the server must be running): one card per prompt with a strip of stills, the numbers, the checks, the words, the script and a Play button; pick a second run to set it beside the first, card by card; variants appear side by side, and each card shows the judge's verdicts and the picture it saw. The engine the judge's pictures come from is `/explore.html#harness`.

## Inspecting a stage

`window.__stage` in the browser console (and `window.__stages.<look>` in the gallery). None of it waits for a frame, so it works in a background tab.

```js
await __stage.ready
__stage.state()        // playhead, pen, lead, clock, hidden, look, scene (with the fitted canvas), renderer, quality, fps, fault (a drawing error the painter caught and survived; also in the `?debug=1` HUD)
__stage.elements()     // what is on stage, with on-screen boxes, colours and contrast ratios
__stage.lines()        // the turn's lines with their scheduled times
__stage.events()       // back-channel events sent so far
__stage.sight()        // how the last turn landed, as reported
__stage.seek(12.4)     // pause at 12.4 s and draw exactly that frame; works on the open turn and on the last finished one (play() replays it)
__stage.step(0.1)      // advance a tenth of a second and draw
__stage.play()
__stage.showAll()
__stage.script()       // the canonical lines of the last turn: what "Copy script" copies
__stage.playScript(text)
__stage.demo('sketchbook')
__stage.prompt('hello')
__stage.tap('h2')
__stage.interrupt()
__stage.capture(768)   // a data URL of the stage now
__stage.export({ kind: 'video', format: 'webm', width: 1280, height: 720, fps: 30, scope: 'conversation' })   // scope: 'turn' | 'answer' (default) | 'conversation'
__stage.controls()     // (v2) the controls on stage: id, kind, label, value, box, whether bound or sending
__stage.control('height', 40)   // (v2) works one as the hand would; the same events, the same frame
__stage.charts()       // (v2) the charts on stage
await __stage.chart('x2', { hover: 3 })   // (v2) or { zoom: 2 }, { pan: 1 }, { reset: true }; resolves with the engine's probe: crosshair, range, ticks, frame time
```

## When something is wrong

| Symptom | Cause and fix |
| --- | --- |
| `cannot start: BRAIN is required…` | `.env` is missing or empty. `cp .env.example .env` and set `BRAIN`. |
| `EADDRINUSE` on 4300 or 4301 | something else holds the port. `lsof -nP -iTCP:4300 -sTCP:LISTEN` |
| the stage does not move and `__stage.state().clock` is `hidden` | the tab is in the background; browsers stop the frame loop there. Bring it forward, or use `seek`/`step`. |
| `clock` is `holding` | the playhead caught up with the pen and the brain has not written more. With `relay`, that brain is you. |
| `clock` is `waiting` for a long time with `BRAIN=relay` | nobody has claimed the prompt. `curl -s -X POST 'localhost:4300/api/relay/next'` |
| `brain_failed … CLAUDE_BIN` | Claude Code is not installed or not on the PATH. |
| the brain is slow to start writing | `pnpm sessions <file>` shows thinking tokens per turn; they should be zero. Check `BRAIN_EFFORT`, and `BRAIN_THINKING=off`. |
| the whole answer arrives at once, after a long wait | the model made a tool call (`canvas_fits`, a search) before its first line: the text a model writes after a tool result reaches us in one piece. `pnpm stream-probe "<prompt>"` shows it (one model call); `BRAIN_THINKING=off` or `BRAIN_EFFORT=low` make a tool-first answer much rarer. See docs/technology.md, "Streaming". |
| a painting never arrives | there is no image model: a `paint` line leaves its sketch, by design. |
| `__stage.state().fault` is not null | a frame or an element threw and the painter dropped it and kept running; the text says what. A script that names a colour or style like a built-in word is the usual cause. |
| the stage is plain text without paper or grain | WebGL2 was unavailable and the plain renderer took over; `__stage.state().renderer` says which is running. |

# Runbook: local development

This document answers one question: **how do I run it and poke at it?**

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
| `pnpm typecheck` | type-checks every package. The only automated gate. |
| `pnpm build` | builds the web app into `web/dist` |
| `pnpm start` | production mode: the server serves the API and `web/dist` on 4300. Run `pnpm build` first. |
| `pnpm timeline <name or path>` | prints when every line of a script would play. `pnpm timeline overture`. With no argument it checks every worked example in the prompt. |
| `pnpm prompt` | prints the brain's system prompt. `pnpm prompt relay` adds the relay appendix, `pnpm prompt flat` is the variant for a painter that only sets type, `pnpm prompt count` prints what each costs and fails above `PROMPT_BUDGET`. |
| `pnpm sessions [file]` | reads session logs back (see "The session log") |
| `pnpm explore [flags]` | runs the exploration battery (see "The exploration battery") |
| `pnpm docs:language` | regenerates the reference section of `docs/language.md` from the code |
| `pnpm --filter @conduit/web fonts` | rebuilds the processed font files in `web/src/fonts` (needs Node 22.6 or later) |
| `pnpm --filter @conduit/server exec tsx src/tools/image-stand-in.ts [--port 4390] [--delay SECONDS] [--fail] [--refuse]` | a local stand-in for the OpenAI Images API, so paintings can be tried with no key and no spend |

One brain at a time. To switch brains, stop the server and start it with another `BRAIN`; for a single run you can set it inline: `BRAIN=replay pnpm dev`.

## Environment

Only the selected brain's settings are read.

| Name | Needed | Default | Meaning |
| --- | --- | --- | --- |
| `BRAIN` | always | none | `relay`, `claude-cli` or `replay`: who answers prompts |
| `HOST` | no | `127.0.0.1` | address to bind. Leave it alone. |
| `PORT` | no | `4300` | |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_DIR` | no | `logs` | where session logs go; `off` writes none |
| `SIGHT` | no | `snapshot` | what a brain is told about how its last answer landed: `report` (the structured report) or `snapshot` (the report and a picture of the resting stage). With `report` the browser takes and sends no picture. |
| `CLAUDE_MODEL` | when `BRAIN=claude-cli` | none | passed to `claude --model`, for example `sonnet` |
| `BRAIN_EFFORT` | no | `low` | passed to `claude --effort` on every spawn and written over `CLAUDE_EFFORT` in the child, so a shell that exports `CLAUDE_EFFORT` never changes the brain's latency or cost. `low`, `medium`, `high`. The exploration battery's plain baseline uses the same value. |
| `PROMPT_VARIANT` | no | `column` | how the brain's prompt teaches a diagram: `column` (the drawing beside the explanation) or `hero` (the drawing carries the answer, in steps). Any brain; the exploration battery sets it per run with `--variant`. |
| `CLAUDE_BIN` | no | `claude` | the Claude Code executable |
| `CLAUDE_WARM` | no | `on` | `off` starts one process per turn instead of keeping one per conversation (an interrupted turn's process is killed at once) |
| `CLAUDE_MAX_WARM` | no | `4` | conversations that may hold a process at once |
| `CLAUDE_WARM_IDLE_MS` | no | `600000` | a process nobody has asked anything for this long is stopped |
| `CLAUDE_RECYCLE_TOKENS` | no | `150000` | a conversation whose input has grown past this gets a fresh process (and a full brief, which attaches its documents again). A 15-page PDF is about 47,000 tokens, so the default leaves room for a paper or two beside the talk. |
| `READ_LINKS` | no | `on` | `off` stops the server fetching the links in a prompt; the brain is told it could not read them. Any brain. |
| `CLAUDE_FIRST_TOKEN_TIMEOUT_MS` | no | `60000` | give up if the model has written nothing by then |
| `CLAUDE_IDLE_TIMEOUT_MS` | no | `30000` | give up if the model goes quiet for this long mid-answer |
| `RELAY_IDLE_TIMEOUT_MS` | no | `180000` | a claimed turn that receives no lines for this long fails |
| `REPLAY_SCRIPT` | no | none | with `BRAIN=replay`, the script every prompt plays. Unset: a prompt that is a demo's name plays that demo, anything else plays `overture`. |
| `IMAGE_MODEL` | no | `none` | `none`, or `openai` for paintings. A `paint` line without one leaves its sketch and nothing else. |
| `OPENAI_API_KEY` | with `IMAGE_MODEL=openai` | none | costs money per picture |
| `OPENAI_BASE_URL` | no | `https://api.openai.com` | point at the stand-in: `http://127.0.0.1:4390` |
| `OPENAI_IMAGE_MODEL`, `IMAGE_QUALITY`, `IMAGE_TIMEOUT_MS`, `IMAGE_MAX_PER_SESSION` | no | `gpt-image-1`, `low`, `90000`, `12` | |
| `NODE_ENV` | no | | `production` makes the server serve `web/dist` (`pnpm start` sets it) |

The OpenAI adapter has never been run against the real service (the owner has not approved spend). Use the stand-in:

```sh
pnpm --filter @conduit/server exec tsx src/tools/image-stand-in.ts &
IMAGE_MODEL=openai OPENAI_API_KEY=stand-in OPENAI_BASE_URL=http://127.0.0.1:4390 BRAIN=replay pnpm dev
```

then ask the replay brain for `overture` (the first load plays it): the sketch under the painting is uploaded and the picture grows over it.

## Pages

| Page | What it is |
| --- | --- |
| `/` | the stage and the prompt. With no prompt yet, it performs `overture`. |
| `/gallery.html` | one script, `styles`, as eight stills (one per look) and one live stage in the look you choose |
| `/explore.html` | the exploration page: one card per prompt of a battery run (see below) |
| `/bench-painter.html` | the painter on the plain renderer with no server: for working on layout and motion |
| `/bench-renderer.html` | the WebGL renderer with no painter: for working on a look or an effect |

Query parameters on `/`:

| Parameter | Effect |
| --- | --- |
| `debug=1` | shows the HUD: playhead, pen, lead, clock state, recent lines, last sight and back-channel events |
| `demo=<name>` | the script performed on load: `overture`, `sketchbook`, `plainly`, `titles`, `styles`. `demo=none` performs nothing. |
| `look=<name>` | locks the stage to one of the eight looks |
| `renderer=plain` | forces the DOM renderer. `renderer=three` forces WebGL. |
| `motion=reduced` | behaves as if the OS asked for reduced motion. `motion=full` ignores the OS setting. |

The bar under the stage has Show all (also the `.` key while the stage has focus: the stage is a focusable region, so the key never swallows a character typed elsewhere), Take away (video, frames, a picture as PNG or SVG, copy script, play a script) and Transcript.

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

`explore/battery.json` holds thirty-five prompts (the original twenty-two and thirteen held out: no worked example in the brain's prompt mirrors them) and five scripted conversations. Each prompt has the use it tests, what it expects (`plain`, `drawn`, `pixels`, `scene`, `type`, `motion`, `any`), whether it is an information prompt (the two prompt variants are compared on those), whether a stated duration is to be honoured, and whether to compare it with a plain-English answer. The conversations are two to four turns on one brain session: a look change mid-conversation, an interruption, tapping a choice, and "look at what you drew; fix it" on a diagram and on a chart (the second turn receives the sight report and the picture).

```sh
pnpm explore --dry-run                 # print the plan, the call count and the projected dollars; run nothing
pnpm explore --brain replay            # no model, judge or conversations: each prompt plays the demo named by its id, else one chosen by what it expects
pnpm explore --brain claude-cli --model sonnet --samples 2 --variant column,hero --max-usd 6 --yes
pnpm explore --only sky-blue,story     # a few prompts or conversations
pnpm explore --held-out                # only what no example mirrors
pnpm explore --samples 5               # samples per prompt (default 3); every check gets a pass rate
pnpm explore --no-cases                # single-turn prompts only
pnpm explore --no-judge                # skip the model that looks at the final still
pnpm explore --judge-model sonnet --judge-effort medium --judge-frames 3
pnpm explore --no-baseline             # skip the plain-English comparison
pnpm explore --timeout 120             # seconds a turn may take (default 180)
pnpm explore --web http://127.0.0.1:4461   # use this running web dev server for the judge's pictures
```

A run projected over `--max-usd` (default 5) refuses to start without `--yes`; the projection over-estimates the judge. The judge's pictures are made by the painter's own engine in a headless Chrome (`CHROME_BIN` names it when it is not in a usual place) behind a Vite dev server the tool starts on port 4461 unless `--web` names one; both are stopped when the run ends. The judge is `claude -p` shown the final still and the prompt, and returns whether it shows what was asked, whether any text is unreadable or overlaps, whether a label points at the wrong thing, whether it is correct, and a coherence score from 1 to 5. `--variant column,hero` runs both teachings of a diagram on the information prompts; the runner builds one brain per variant and warns if `PROMPT_VARIANT` did not reach it. Compare variants by judge score and tokens, not dollars (cache warmth confounds cost).

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
__stage.export({ kind: 'frames', width: 1280, height: 720, fps: 30 })
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
| the brain is slow to start writing | `pnpm sessions <file>` shows thinking tokens per turn; they should be zero. Check `BRAIN_EFFORT`. |
| a painting never arrives | `paint` is off without `IMAGE_MODEL`; the sketch stays by design. With the stand-in, check it is running on the port `OPENAI_BASE_URL` names. |
| `__stage.state().fault` is not null | a frame or an element threw and the painter dropped it and kept running; the text says what. A script that names a colour or style like a built-in word is the usual cause. |
| the stage is plain text without paper or grain | WebGL2 was unavailable and the plain renderer took over; `__stage.state().renderer` says which is running. |

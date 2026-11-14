# Technology: why it is built this way

This document answers one question: **why does the code have this shape?** What the product is and what was decided about it is in [product.md](product.md). The language is specified in [language.md](language.md). How to run it is in [runbook.md](runbook.md).

> **v2.** The quality and expression round is built and integrated. Sections marked (v2) are what it added; `PLAN-v2.md` records what it measured against the bar. Everything marked here as built is built: no stub remains.

## The shape

A pnpm workspace with three packages. Imports point inward: `server` and `web` depend on `language`; `language` depends on nothing.

```
language/   Series itself: vocabulary, line types, parser, normaliser, serialiser, geometry,
            styles, timing, the schedule, the stage carried between turns, sight, the wire
            types, the brain's prompt. Pure TypeScript. No Node, no DOM. Used by both sides.
server/     Sessions, turns, the two streams, the brains, the image model, the session log.
web/        The painter, its renderers, the exporter, and a small amount of chrome. Browser.
explore/    The exploration battery (a JSON file) and, untracked, the runs it produces.
            (v2) sealed/ the held-out set; taste/ the owner's own scores.
techniques/ (v2) seed/ the techniques in the repository: the library's fallback and its first contents. .cache/ is untracked.
loop/       (v2) The improvement loop's changelog and ledger.
```

Domain types are plain interfaces in the middle. Edges translate. Every outside system sits behind an interface the domain owns:

| Interface | Owned by | Adapters |
| --- | --- | --- |
| `Brain` (`server/src/domain/brain.ts`) | server domain | relay, claude-cli, replay |
| `ImageModel` (`server/src/domain/images.ts`) | server domain | none (the default), OpenAI |
| `SessionLog` (`server/src/domain/session-log.ts`) | server domain | JSONL files, none |
| `Renderer` (`web/src/contracts/renderer.ts`) | painter | three.js, plain DOM |
| `StageLink` (`web/src/contracts/link.ts`) | web app | HTTP (SSE down, POST up) |
| `Exporter` (`web/src/contracts/export.ts`) | web app | WebCodecs and a zip writer |
| (v2) `StructureEngine`, `CalloutEngine` (`web/src/contracts/blocks.ts`) | painter | `web/src/painter/blocks/` |
| (v2) `ControlEngine`, `ControlStore` (`web/src/contracts/controls.ts`) | painter | `web/src/painter/controls/` |
| (v2) `ChartEngine` (`web/src/contracts/chart.ts`) | painter | `lightweight-charts` |
| (v2) `TechniqueLibrary`, `TechniqueWriter` (`server/src/domain/techniques.ts`) | server domain | memory over seed, file cache and Remote; none |
| (v2) `DatasetLibrary` (`server/src/domain/datasets.ts`) | server domain | Remote; none |
| (v2) `Brain.review` (`server/src/domain/brain.ts`) | server domain | claude-cli |

Each vendor is imported in exactly one place, so replacing one is a change to one place:

| Vendor | The only place that imports it |
| --- | --- |
| `three` | files under `web/src/render/three/` |
| `troika-three-text` | `web/src/render/three/text.ts` |
| WebCodecs and the muxer packages | `web/src/export/video.ts` |
| `node:child_process` (the `claude` process) | `server/src/brains/claude-cli/process.ts` |
| the OpenAI Images API (over `fetch`) | `server/src/images/openai/openai-images.ts` |
| `node:fs` for session logs | `server/src/logs/jsonl-session-log.ts` |
| `node:dns`, `node:net`, `node:http(s)`, `node:zlib` (reading links) | `server/src/reading/safe-fetch.ts` |
| `hono`, `@hono/node-server` | files under `server/src/http/`, and `server/src/main.ts` for `serve` |
| (v2) `lightweight-charts` | `web/src/render/chart/lightweight.ts` |
| (v2) the `remote` command: its arguments, its output, the tree's write rules | `server/src/library/remote/remote-cli.ts` |
| (v2) `node:fs` for the technique seed, overlay and cache | `server/src/library/files.ts` |
| (v2) `git` (worktrees, branches, diffs) | `server/src/loop/git.ts` |
| (v2) `claude -p` as an agent with tools (the critic, the builder, the reviewer, the edit and reader passes) | `server/src/loop/agents.ts` |
| `process.env` | `server/src/env.ts` reads it through `loadEnv`; handed over only by `main.ts` and the tools under `server/src/tools/` and `brains/claude-cli/probe.ts` |
| the console | `server/src/log.ts` (and one line in `main.ts` for a failed boot) |

## Six ideas the rest depends on

### 1. The schedule is a pure function of the score

`buildSchedule(entries, base)` in `language/src/schedule.ts` takes the lines of a turn and the stage they started from, and returns absolute times for everything. It is recomputed from scratch on every line. A turn is at most a few hundred lines and the function is linear; recomputing makes `revise` and `cancel` an edit to a list followed by a rebuild, and makes a schedule reproducible: the same score always gives the same times.

Durations depend only on text, geometry and words of the language, never on pixels or fonts. That is why timing lives in `language/` and not in the painter: the server runs the same code to know where the pen is.

### 2. Geometry lives with timing

How long a line takes to draw itself depends on how long it is. So what a shape is (its outline as polylines, its length, its box, a point part-way along it) is defined once, in `language/src/geometry.ts`, and used by the schedule for durations and by the painter for drawing, morphing and travel. SVG path data is parsed there, when the line is parsed, into four absolute commands. The painter never interprets a path string and the renderer never sees one.

### 3. The timeline is a pure function of time

The painter joins the schedule with space (layout, colour, motion) into a `Timeline`, and `timeline.frameAt(t)` returns a complete `Frame`. Nothing is advanced, mutated or remembered between frames. This is why there is no tweening library: those advance state frame by frame, and state that is advanced cannot be asked "what do you look like at 12.4 seconds?".

v1 leans on this three more ways. **Weather**: a field's particles are placed in the vertex shader from a seed, an index and the ambient time, so rain can be seeked. **Export**: a film is `frameAt(n / fps)` for every n. **Sight**: the snapshot of a resting stage is one more frame, drawn off screen.

The one piece of carried state is in the renderer (afterglow reads the previous picture), and `Renderer.reset()` clears it.

### 4. The playhead is a real clock that holds

`PlayClock` advances only by time that actually elapsed between two frames, capped per frame. It never estimates. It reports `holding` when the playhead reaches the pen and the brain is still writing (or the renderer cannot yet draw what the frame holds), `paused`, and `hidden`. Ambient motion runs on a second clock that keeps going during a hold.

"Show all" is a mode of this clock, not of the schedule: the horizon is taken at once and, while the turn is open, on every line.

### 5. The painter is the authority; the server keeps an estimate

Only the painter knows where the playhead is, what was shown, and how it landed. It reports; the server believes it. Memory and sight are built from the report.

### 6. Some things are not on the clock

A painting takes ten seconds or never comes. If it were on the turn clock the schedule would depend on an image model. So it is not: `paint` creates a picture element instantly, and the painting's arrival is an input to `frameAt` alongside time (which paintings can be drawn, and since when on the ambient clock). The schedule, the pen, memory and exported timing are identical with and without it. An export uses the paintings that had arrived when it was started.

### 7. (v2) Layout is the painter's, and it is pure

A flow, a tree, a table: where its parts go is decided by an engine in the painter (`web/src/painter/blocks/`) that is a pure function. It is handed the parts, the room, and a function that measures text exactly as the painter sets it; it returns boxes, outlines and text. It touches no DOM and reads no clock, so the same parts give the same layout on screen, in an exported film and under `tsx` with no browser, which is how the battery counts collisions without a model's opinion.

The engines return the things the painter already turns into frames. **No renderer learns anything about structures or controls**: a node is a shape and some text by the time it is drawn, so the three.js renderer, the plain renderer, picking, the snapshot and the SVG export work unchanged.

Timing stays in `language/`. A link's duration is a fixed length, not one worked out from its route, because the route is a decision made with font metrics and the schedule may not depend on those. That is the one place a drawn thing's time does not come from its geometry, and it is what keeps idea 1 true.

A structure is laid out from every line that has arrived, not from what the playhead has reached. Live, a late part moves what is on stage once, eased; in a film, where every line is known at time zero, nothing moves.

### 8. (v2) What the user does is an input, like time

A frame was a pure function of time and of which paintings had arrived. v2 adds two more inputs of the same kind: **what every control holds** (`ControlStore`) and **which DATA has arrived**. A bound change is an ordinary change (`set`, `move`, a morph) whose progress is read from a control instead of from the clock; what that means is one function in `language/src/bind.ts`. So a dragged slider is a new frame, not a new schedule: nothing is rebuilt, nothing is sent, and the same turn exported with the slider elsewhere is a different, equally exact film.

Charts are the exception to "everything is a frame". The charting engine is stateful and draws in a surface of its own. The port makes it behave: `ChartHandle.apply(state)` takes a value and shows exactly that, any state can follow any other, and `still()` gives a picture of it. So a chart can be seeked, replayed and exported like the rest, and only its live crosshair and zoom, which are the user's, live inside the engine.

### 9. (v2) A turn can have a second pass

Look and fix is a second call to the same warm process inside one turn (`Brain.review`). The painter makes it cheap in the only way that matters: when the server says the draft is written (`pass … drafted`), the painter settles a copy of the schedule to its end, computes sight and rasterises that frame off screen (idea 3: a frame is a function of time, so the frame at the end exists before the playhead gets there), and sends both. The look therefore runs while the draft plays. Whether to look at all is two pure functions in `language/src/review.ts`, called by the conductor and by the battery alike.

### 10. (v2) Craft is data, and it is never on the turn's path

The system prompt is the language. Everything about how to answer a kind of question well is a technique: a block in Remote, mirrored to a file cache, with a seed in the repository. The server keeps an index in memory and chooses for each message with a few dozen string comparisons. Remote is read by a background refresh that nothing awaits. The same shape will hold anything else that must be both remote and instant.

## The two streams

Server to painter is Server-Sent Events; painter to server is small POSTs. Not a WebSocket: the two directions are independent and deliberately one-way, SSE is plain HTTP that the Vite proxy and `curl` both handle, and it reconnects by itself. The relay is plain HTTP for the same reason.

The server reads each line with a `LineReader`, makes it explicit with a `LineNormalizer` (ids, which sprite a row belongs to), re-serialises it, and forwards the canonical text. So the language itself is what is on the wire, every line on it stands alone, and the painter needs neither.

Pictures travel beside the streams as ordinary requests: a painting down (`GET`), a sketch and a snapshot up (`POST` with an image body). They are best effort. Nothing waits for an upload.

## Rendering

**Stage units.** One unit is one CSS pixel on the reading plane with the camera at rest; origin at the centre; y down. `web/src/contracts/space.ts` defines the camera and the depth of the four planes. **Canvas units** are the brain's: `web/src/painter/canvas.ts` fits the scene's canvas into the room its layout leaves and converts between the two. The same canvas point lands on the same screen point on every layer with the camera at rest.

**Text.** troika-three-text draws signed-distance-field text. Each *run* (a word) is its own mesh, typeset once; everything that changes per frame is a transform or a uniform. A typed entrance moves a clip rectangle across the run. `RunFrame.reveal` is a share of the run's *width*, which the painter computes from the face's advances, so the renderer needs no metrics.

**Type is measured in one place.** `web/src/fonts/measure.ts` sums advances from a table generated from each font file. The painter lays out with it; the renderer never measures. For that sum to equal what troika draws, **every shipped font file has its `GPOS`, `GSUB` and `GDEF` tables removed** (`web/scripts/strip-font-tables.mjs`): troika applies every kerning and ligature lookup a font offers and has no switch for it. v0 needed this to keep fixed-pitch grids intact; v1 needs it to keep proportional measurement exact. The cost is no kerning, which shows at display sizes; putting it back means a kern-pair table read by both the measurer and the renderer, and is recorded as open in product.md.

**No glyph may be missing.** troika answers a missing glyph by downloading a fallback font from a public CDN. `foldText` in `web/src/fonts/index.ts` brings all text into the set of characters every face has before it reaches a renderer, and every face added in v1 must cover `GLYPHS`.

**Figures.** A shape reaches the renderer as flat polylines with a `geometryKey`. The renderer triangulates the fill and builds a ribbon for the stroke only when that key changes; each stroke vertex carries its distance along the outline as a share of the whole, so a line drawing itself is one uniform and no vertex moves. A sprite is a small nearest-filtered texture. A painting is a texture revealed through a noise threshold. Weather is one instanced draw per field. Text and figures on a layer are drawn together in creation order.

**The surface is one pipeline.** v0 had three hand-built skins; they are gone. v1 has one pipeline that applies the effects a look lists, in a fixed order (`web/src/render/three/fx/`): the passes of the v0 skins are moved into effect modules, and a retro preset is then only its list and amounts. No `EffectComposer` and no post-processing library: full-screen passes over render targets the pipeline owns.

**Capture.** `Renderer.rasterise(frame, options)` draws any frame, of any viewport, into a target of its own and returns it encoded. It never touches the visible canvas. The snapshot for sight, the sketch for a painting and every frame of an exported still or strip come through it. A picture never omits its words: `rasterise` loads the faces of the frame, waits up to two seconds for its text to be drawable, draws, and calls `RasteriseOptions.onIncomplete` if it still could not (the gallery marks such a still). troika's font loads are shared per font file, so a second request for a face joins the first instead of drawing blank glyphs. A lost WebGL context is rebuilt on a fresh canvas after two seconds; `Renderer.onContext` reports `lost`, `restored`, `rebuilt` or `failed`, and the app says so and, on `failed`, points at `?renderer=plain`.

**Start-up.** `Renderer.mount(host, viewport, look, { looks })` resolves only when the starting look's face is typeset for the whole `GLYPHS` set and a real frame of its ground has been presented, and clears the canvas to the look's ground at once, so nothing looks unstyled and the first line is drawn, not just reported. Warm-up draws into an off-screen target, never into the visible canvas and never resizing it. A locked stage (a gallery cell) passes `looks: [its look]` and never compiles or warms another; otherwise the other looks' fonts and programs are warmed in idle time afterwards, one per task, 400 ms apart, on parked 160x100 kits, so a later `look` line neither stalls nor compiles anything. `web/index.html` preloads the VT323 file so it downloads beside the script, and mount rejects after 15 s if fonts never load (the app then falls back to the plain renderer). An element is atomic in the renderer: its marks (bar, box, underline, strike) are drawn only once all its runs are typeset. Measured on an Apple M4 Max through Chrome's Metal backend (production build, cold profile): type is on the canvas, in pixels, about 0.8 to 1.0 s after navigation; through the whole `overture` script at 1440x900, device pixel ratio 2, in each of the eight looks, 1,980 page frames are 16.7 ms at the median and 95th percentile and none is over 20 ms except one 33 ms frame in `phosphor`; the stage stays at `full` quality at 60 fps. Drawing begins about 0.6 s after navigation.

**Performance.** The painter measures the time spent inside `render`, not the interval between frames, so a display capped at 30 Hz is not mistaken for a slow renderer. Two seconds with mean render time above 20 ms and the renderer drops to `lite` (the look without its expensive passes) for the rest of the session. If WebGL2 is unavailable or the WebGL renderer fails to mount, the plain DOM renderer is used: same painter, same words, no screen simulation.

**(v2) Charts.** The decision was between writing a charting engine and using one. Written here because it is the largest dependency the project has taken.

| | Our own, on the stage's renderer | `lightweight-charts` behind a port |
| --- | --- | --- |
| Quality the owner asked for (a trading terminal's) | months away: time scales, tick formatting, crosshair, pan and zoom with inertia and pinch, candles, panes, 60 fps with dense data | there today; it is what TradingView ships |
| In the look's surface, under the camera | yes | no: it draws with canvas 2D in a DOM surface over the stage |
| Snapshot, film, the brain's look at its draft | free | through its `takeScreenshot`, drawn into the frame by the renderer |
| Vector export | yes | no: an SVG carries the chart as a picture |
| Cost | a second product to maintain | one dependency (Apache-2.0, and one small MIT dependency of its own), its mark on each chart, and one adapter file |

**Chosen: the library, behind `ChartEngine`.** The owner's bar is the library's own standard, the brain's part (rows in, a model out) is the same either way, and the port means the choice can be undone in one file. Checked against its documentation (version 5.3): line, area, baseline, bar, candlestick and histogram series, `addSeries(definition, options, paneIndex)` and `addPane` for a volume pane, `createSeriesMarkers` and price lines for marks, `subscribeCrosshairMove` and `setCrosshairPosition`, `takeScreenshot()` returning a canvas, `createChartEx` and `createOptionsChart` for a bottom axis that is not trading time. Its licence asks for its notice and a link to TradingView on the page; the `attributionLogo` option puts the link on the chart, and it is left on.

Three things the adapter must do that the library does not do by itself, and they are the adapter's acceptance: (1) **to scale**: the library spaces points evenly, as trading charts do; for anything but candles the adapter uses a numeric bottom axis so that 1800, 1900, 1950, 2000 are not four equal steps. (2) **names along the bottom** (a distribution's bins): one slot a row, labelled by a tick formatter. (3) **the reveal**: the library draws data the moment it is set; the adapter drives arrival from `ChartState.reveal` with the price range pinned to its final value. It has no horizontal bars; a ranking is a `table bars`, drawn by the painter.

**The plain renderer** is the proof that the painter does not depend on three.js. In v1 it draws shapes and sprites as inline SVG, no weather and no surface, and advertises exactly that; the brain's prompt follows.

## The brains

One interface: `respond(request, signal)` returns an async iterable of events and must stop promptly when the signal aborts. v1 adds `open(session)` and `release(session)` so a brain can get ready for a conversation, and two events beside lines: `brief` (what the brain was told, for the log) and `usage` (what the turn cost).

**relay.** A `RelayHub` holds turns waiting for a mind. An outside agent claims one, appends lines in as many calls as it likes, reads the back channel between calls, and ends it. The claim carries the same brief an LLM brain is given and, when there is one, a link to the snapshot.

**replay.** Streams a fixture file, or the lines of a `script` input, in chunks at about a model's speed, deterministically. `#! stall N` pauses the stream.

**claude-cli.** One long-lived `claude` process per conversation (`brains/claude-cli/warm.ts`):

```
claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose \
  --model <CLAUDE_MODEL> --effort <BRAIN_EFFORT> --system-prompt <prompt> \
  --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence
```

Each turn is one JSON line on stdin; the process keeps the conversation. Everything below was confirmed on this machine with Claude Code 2.1.322:

```
stdin   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
        an image is one more content block:
        {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"…"}}
stdout  {"type":"system","subtype":"init","tools":[],"mcp_servers":[],"model":"…"}        after each user message
stdout  {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}
stdout  {"type":"result","subtype":"success","usage":{…},"total_cost_usd":…,"ttft_ms":…}    ends every turn

stdin   {"type":"control_request","request_id":"r1","request":{"subtype":"interrupt"}}
stdout  {"type":"control_response","response":{"subtype":"success","request_id":"r1",…}}    within about 10 ms
stdout  {"type":"result","subtype":"error_during_execution","is_error":true,…}              the interrupted turn ends; the process stays usable
```

Only `text_delta` carries the answer; deltas do not respect line boundaries, which is what `LineAssembler` is for. The whole-message `assistant` event is ignored, or every line would arrive twice.

**Where v0's ten seconds went, and what was measured.** One v0 turn on sonnet: first text after 8.5 s, of which about 1.4 s was the request and the rest was 822 tokens of hidden reasoning. The process start-up was half a second. So the cure is mostly not the warm process:

| Setting (sonnet, a 7.5k-token prompt) | Hidden tokens | First text |
| --- | --- | --- |
| v0: fresh process, default effort | 400 to 800 | 5.6 to 8.5 s |
| `--effort low` alone | 200 to 600 | 3.7 to 6.9 s |
| `MAX_THINKING_TOKENS=0`, `CLAUDE_CODE_DISABLE_THINKING=1`, `alwaysThinkingEnabled: false`, or the `set_max_thinking_tokens` control request | 200 to 700 | 3.2 to 8.5 s (none of them switches it off) |
| `--effort low` and a prompt section that says "start at once" | **0** | **1.4 to 2.0 s** |

With the last row, and the v1 prompt, three sonnet answers took 133 to 670 output tokens (v0's comparable answer: 1136) and three haiku answers 153 to 273, with first text at 1.7 to 2.3 s. All six parsed with no rejected line and no warning.

**Caching.** The system prompt is written to the provider's cache on the first turn of the first conversation and read from it afterwards, across processes: a second turn reported 7,535 tokens read from cache, 821 written, 4 at full price. The input cost of a turn after the first is almost all cache reads.

**Memory in a warm process.** The process remembers what the model wrote. Each turn's brief (`buildTurnBrief(…, 'since')`) tells it what the stage did with that: where it was interrupted, what was rejected, what was clipped. A process is replaced (and its successor given the whole conversation as shown, `'full'`) when it dies, when it has been idle for `CLAUDE_WARM_IDLE_MS`, when its conversation passes `CLAUDE_RECYCLE_TOKENS`, or when more than `CLAUDE_MAX_WARM` conversations want one. The system prompt is fixed for a conversation: it is built once from what the painter can do and what the server offers, never from the screen or the look. The screen, the look and the stage ride in every turn's brief, and a real change of capabilities is told there as a note (`THE PAINTER CHANGED`), never by a new prompt. The process opens on the conversation's first prompt or tap, not when the page loads: the gallery, the explore page and the first-load demo never start one.

The process gets a first-token timeout and an idle timeout. When the user interrupts, the turn is drained to the process's `result` without yielding text, so the process survives and the next brief is `since`; one that goes quiet is killed. With `CLAUDE_WARM=off` a process serves one turn and is killed when it ends or is interrupted. Nothing is orphaned.

**(v2) What is in the prompt, and what left it.** The budget did not move: 8,850 tokens. With everything on, the prompt is 8,814 (`pnpm prompt count`). Room for structures, charts, controls and paint (about 1,450 tokens) was made by moving out what is not language: the advice for documents now rides in the brief of a turn that has a document (282 tokens); three of five worked examples became techniques (about 650); the arithmetic of a stated length became a technique (55); glosses a word does not need were cut (about 300). The second teaching of a diagram, `hero`, is deleted. A painter that does not advertise structures still gets the v1 examples, so today's stage is taught what it was. An image model would add 63 tokens and take the prompt over; none is configured, and whoever configures one finds the room first.

**The prompt.** Generated from the vocabulary, filtered by what the painter and the server can do. `pnpm prompt count` prints its size in characters and estimated tokens; `PROMPT_BUDGET` is 8,850 tokens (raised from 8,500 in v1 for the Documents section, which has since moved to the brief) and it fails above it. v0's prompt taught thirteen verbs; v1's twenty-eight; with everything on, v2's teaches forty-four. `PROMPT_VARIANT` names a teaching of the prompt so that two can be measured side by side; one exists (`column`).

## Reading links

The brain has no tools (`--tools ""`), so a link is read by the server and handed over as part of the message. `server/src/reading/safe-fetch.ts` is the only code that connects to an address a user typed. The check is in the resolver hook of the connection itself, so what is checked is exactly what is connected to (a name cannot pass the check and then resolve elsewhere), and every address a name resolves to must be public. Literal addresses (including `http://2130706433/`, which the URL parser turns into 127.0.0.1) are checked before connecting; IPv4-mapped, NAT64 and 6to4 forms are checked by the address they carry; IPv6 outside 2000::/3 is refused. A redirect goes round the same loop, three at most. One 15 s deadline covers everything; the 20 MB cap counts bytes after decompression, so a small compressed bomb stops at the cap.

A PDF is not converted. Stream-json input accepts it as one more content block beside the image block (`{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"…"}}`): checked on this machine with haiku, first on one page (it gave the title), then on the whole Transformer paper (2.2 MB, 15 pages, about 47,000 input tokens; the answers carried the paper's own numbers: 28.4 BLEU, 12 hours on 8 P100s, Adam with 4000 warmup steps). No new dependency, and `pdftotext` is not used. The API's own limits on PDFs (page count, size) apply; if the model refuses one, the turn fails and the document is dropped from the conversation so it is not sent again.

The conversation holds up to four documents (30 MB of PDF). A warm process is given each once (the entry remembers which it has heard); a recycled or replaced process gets all of them in its `full` brief. `CLAUDE_RECYCLE_TOKENS` is 150,000 for this reason: a paper alone is 47,000, and at the old 60,000 the second turn would have recycled and paid for the paper again.

## Paintings

`ImageModel.generate(request)` takes words, a medium, the look's palette, an aspect, and the painter's rendering of the sketch when it arrived in time. The conductor starts it when a `paint` line is accepted and the conversation has allowance left, waits at most a second and a half for the sketch (the painter renders and sends it as soon as the `paint` line reaches it, from the schedule and not from what the playhead has drawn, because a brain's pen runs seconds ahead of the playhead), and announces the result with an `asset` event. The bytes are held in memory, bounded per session, and served from the same origin, so the browser still talks to nothing but its own server and holds no key.

The OpenAI adapter uses the edits endpoint when there is a sketch and the generations endpoint when there is not. **It has not been run against the real service**: no key has been approved. It is written against a stand-in and marked untested in its file.

## (v2) The technique library

`server/src/domain/techniques.ts` holds the port and the two pure functions: reading a technique's body (a fixed layout: what it is for, use it when, not when, an example fenced as `series`, what failed, score) and choosing techniques for a message.

**Choosing.** Each technique is indexed once on its title, its summary and its link reason, which are written to say when it applies; not on its body, whose prose is full of ordinary words. A message's words are stemmed and matched; a word counts for more the fewer techniques use it. A technique is handed over only if it clears a floor, matches on two words or on one word of its own title, and scores at least 60% of the best. At most three, at most 1,650 characters in all. Measured on the 86 prompts of the two batteries against the 19 seed techniques: about 50 microseconds a prompt, and no plain question is handed a recipe.

**Sources**, later ones winning by title: the seed (`techniques/seed/*.md`, read at boot), the file cache of the last good read of Remote, Remote itself, and an overlay folder (`LIBRARY_OVERLAY`) that an experiment of the improvement loop lays over the rest.

**Reading Remote.** One call lists every technique: `remote get memory <root> --links 1` returns the root's links, each with the linked block's id, title, summary, reason and fingerprint (checked on this machine: about one second). A technique's body is fetched (`--content 1`) only when its fingerprint differs from the cache's. The refresh runs at boot and every ten minutes and is awaited by nothing.

**Writing** is not on the server's path at all: it is `pnpm library push`, used by a person, a review or the loop's steward. It refuses what `lintTechnique` refuses (no example, an example that does not parse, a date, a change number, history, a possible secret, a reason that does not begin "only if"), reads the block again, sends that read's fingerprint, re-applies on a conflict, and sets `REMOTE_SESSION_ID` and `REMOTE_AGENT`. An edit pass and a reader pass by cold `claude -p` sessions come before the write.

**Datasets** (`DatasetLibrary`) are the same idea with one difference that is stated rather than hidden: finding whether a prompt names a stored series is instant and from memory, but reading its rows is a network call on the turn's path. It is treated exactly as reading a link is: a `reading` event, one short deadline, and a brief that says it could not be read when it could not.

## (v2) The improvement loop

`pnpm improve` (`server/src/tools/improve.ts`, `server/src/loop/`). The steps and who does each are in product.md. What is built as code rather than asked of a model, in `server/src/loop/guard.ts`:

- `PROTECTED_PATHS` and `touchesProtected`: the batteries, the judge, the runner, the guard itself, the look-and-fix policy, the changelog, `package.json`.
- `SEALED_PATHS`: what a builder's worktree is made without.
- `leaksBattery`: battery text in source.
- `decide(proposal, before, after)`: the rule for keeping an experiment, with every reason in words for the changelog.

A builder is a `claude -p` process with tools, confined to its worktree by the CLI's own permission flags; the critic and the reviewer have no tools that write. All of them are on the owner's login. The budget is counted in the dollars the CLI reports for each call: on a subscription that is a measure of use, not a bill, and it is the one number every call returns.

## (v2) Taste

`language/src/taste.ts` holds the types and `agreementOf`: the share of answers on which the judge and the owner agree, at the cut of the judge's score that agrees best, with Cohen's kappa. The page writes a sheet to `explore/taste/`; `pnpm taste` and the battery's footer print the line. Each judgement carries a hash of the judge's instructions and model, so agreement is always about the judge that is in use.

## The session log

`SessionLog.write` appends one JSON object per line to `logs/<stamp>-<session>.jsonl`: the session's facts, each turn's input, the brief the brain was given (and the system prompt, once per process), every line with its scheduled start, every reject, the end, the usage, the moment the painter first showed something, the report, and what became of any painting. Snapshots are saved beside it. Writes are queued and never awaited by a turn. The server never reads the files; `pnpm sessions` does.

## Export

A `Recording` is a turn as data: the stage it started from and its lines. `createFilm(recording, options)` lays it out for any viewport and answers `frameAt`, with no clock, renderer or server. The exporter mounts a renderer of its own off screen at the export size and walks the film: stills and frame strips through `rasterise`, video by handing the renderer's canvas to a `VideoEncoder` with exact timestamps and muxing the result. It is constant frame rate by construction and does not depend on how fast the machine draws. A frame strip is a zip written without compression by forty lines of code, not a library. SVG is a serialisation of a `Frame`: shapes bleed as on screen, fonts come from `Renderer.fontFile` (the export module imports none), and weather is left out and named in the drawing's `desc`. One renderer job runs at a time: a second film, strip or raster still is refused with "Another export is still running" and the first keeps going; the script and the SVG still touch no renderer and run beside it. Cancelling is checked between every await and the preload has a ten-second limit; strip limits are checked before the work begins.

## The exploration harness

`pnpm explore` hands each prompt of `explore/battery.json` (thirty-five prompts, thirteen of them held out from the prompt's worked examples, and five scripted conversations) to a brain exactly as the conductor would, `--samples` times each and, on the information prompts, once per prompt variant, and writes the lines with their arrival times, the usage, and checks computed from the schedule to `explore/runs/<run>/`, with a pass rate per check. The painter's own layout engine, run in a headless Chrome the tool starts (and stops) behind a Vite dev server, makes the final still of every answer and carries a conversation's stage, report and picture to its next turn; a vision judge (`claude -p`, sonnet) is shown the still and scores whether it is what was asked, whether any text is unreadable, whether a label points at the wrong thing, whether it is correct, and its coherence from 1 to 5. For prompts that ask for it, the same question goes to a plain-English model for comparison. Everything the tool starts goes through `spawnTracked`, so nothing outlives it. `/explore.html` reads a run and replays every answer locally as a film: a strip of stills per card through one shared off-screen renderer, a live stage for the card being played. The page calls no brain, so a run can be reviewed any number of times, and re-running the battery after a change gives a second run to set beside the first.

## The server

- **Hono** on `@hono/node-server`: small, typed, and its `streamSSE` is first-class streaming.
- **Environment** is read once by `loadEnv`, which collects every problem and refuses to boot with all of them listed. Only the selected brain's settings are required or read. The rest of the code receives an `Env`; the few places that must pass the environment on (the probe, the sessions tool, the exploration tool) ask `env.ts` for it (`processEnvironment`, `childEnvironment`).
- **Logs** are one JSON object per line from one module.
- **Errors** that reach HTTP are `AppError`s and serialise as `{ code, message, statusCode }`; anything else is logged and answered as a 500 `internal`.
- **Local only.** The server binds to `127.0.0.1`. Because a web page in the user's own browser can still reach loopback, `/api` also rejects requests whose `Host` is not a loopback name (DNS rebinding), whose `Origin` is present and not loopback (including `Origin: null`, which a sandboxed frame or a `file:` page sends), or whose `Sec-Fetch-Site` is `cross-site`. Claiming a relay turn changes state, so it is a `POST` (`GET` answers 405), and every route requires its Content-Type (`application/json`, or `text/plain` for `lines`) so a cross-site form cannot post without a preflight. Request bodies are capped at 64 KB (1 MiB for painter reports).
- **No build step.** The server runs TypeScript directly with `tsx` in development and in production. This is a single-user program bound to localhost; a compile step would add a build artefact and a class of "works in dev" bugs for no benefit. If it is ever deployed, compile it then.
- **No database.** Sessions are in memory and bounded; a restart forgets them. The session log is a record for people, not a store.

## TypeScript

One `tsconfig.base.json` with `strict` written out, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `verbatimModuleSyntax`. Nothing emits: every tsconfig is `noEmit`. The DOM library is only in `web/tsconfig.json`; `language` is checked with neither DOM nor Node types, which is what keeps it portable. Every `.ts` file belongs to a tsconfig that `pnpm typecheck` runs:

| tsconfig | Covers |
| --- | --- |
| `language/tsconfig.json` | `language/src` |
| `language/tsconfig.scripts.json` | `language/scripts` (Node) |
| `server/tsconfig.json` | `server/src`, tools included (Node) |
| `web/tsconfig.json` | `web/src` (DOM) |
| `web/tsconfig.node.json` | `web/vite.config.ts` (Node) |

`@conduit/language` exports its TypeScript source directly; Vite and `tsx` both consume it as is.

With no tests, typecheck is the only automated gate. Four tools help without being tests: `pnpm timeline <script>` prints the schedule a script adds up to (and, with no argument, checks every worked example in the prompt), `pnpm prompt` prints what the brain is told and `pnpm prompt count` what it costs, `pnpm sessions` reads a conversation back, and `pnpm explore` runs the battery.

## Checked on this machine

Verified on the integrated product (Node 22.14.0, pnpm 10.28.2, TypeScript 7.0.2, Claude Code 2.1.322, Apple M4 Max, Chrome on Metal):

- `pnpm typecheck` and `pnpm build` are clean, and no stub remains.
- `pnpm timeline` runs the five demo scripts and the prompt's worked examples with no rejected line and no warning.
- A `claude` process with `--input-format stream-json` stays alive across turns, keeps the conversation, accepts a `document` (PDF) content block (see Reading links), accepts an image content block (asked the colour of a red square, it said red), honours an interrupt control request within about 10 ms and stays usable, and reports cache reads on the second turn.
- The latency table above.
- With the v1 prompt and no drawing-specific coaching beyond it: "pixel art of a fox" produced a `pix` sprite; "why is the sky blue" a labelled diagram in `layout=figure`; "tell me a story as a scene" a night scene in layers with weather and a camera move; "what is the boiling point of water at the top of Everest" three plain paragraphs in `layout=page` for 133 output tokens.

- Ten turns of one conversation through the server (sonnet, `--effort low`) across a window resize before turn four and several look changes (paper, blueprint, pixel): turns 2 to 11 all `since` and warm, no process replaced, 85 to 95 percent of input tokens read from cache, first text 1.6 to 2.1 s (the cold first turn 2.5 s), $0.078 in all. The first drawing appears 0.58 s after navigation in headless Chrome on Metal (three runs, 576 to 585 ms). Across two full 22-answer runs, all nine looks and 1440x900 and 375x667, no two pieces of text overlap in the painter's final frame (792 film runs; one label wider than its canvas in teletext remains).
- Warm turns through the server with sonnet at `--effort low` (nine turns of one conversation): first line 1.6 to 2.2 s (median 1.9 s), zero thinking tokens, 87 to 94 percent of input tokens read from cache after the first turn, and a question about the colour of a circle drawn one turn earlier answered correctly from the snapshot.
- A tap changes the stage in one frame (16 ms from pointer-down to the pressed state, others receded, waiting dots), five taps open one turn; Stop settles in 34 ms with no half-drawn thing left; "Show all" settles in under 20 ms.
- Export of `overture` at 1920x1080 and 30 fps: 664 frames for a 22.14 s film (`round(22.14 x 30) = 664`), 22.1 s long, made in 3 s; frame 31 of a strip that starts at 9 s is byte-identical to the still at 10 s; the visible stage held 60 fps (95th percentile 16.7 ms) with one 200 ms hitch when the exporter's renderer was created; an SVG still embeds its font and requests nothing.
- A stroked or filled shape's box matches `canvasToStage` projected through the camera to 0.00 px in `blueprint` with reduced motion; with the hand look's wobble and the camera's sway it is within 3 px.
- Resting text keeps 4.5:1 or better in all eight looks (worst measured 4.52:1, `riso`), and no text of ten battery answers leaves the 16 px safe frame at any sampled instant, in full and reduced motion.

**(v2) Checked on the integrated product** (the same machine; headless Chrome with `--use-angle=metal`, the three renderer unless said, a replay brain for the demos and sonnet at `--effort low` for the rest):

- `pnpm typecheck` and `pnpm build` are clean; `pnpm prompt count` is 8,848 of 8,850 with everything on; `pnpm timeline` and `pnpm library lint` are clean on every demo, example and seed; `pnpm library check` hands a seed technique to 41 of 42 tune prompts that have one and none to the three plain ones, choosing in a median of 53 microseconds (p99 80).
- The three demos (`diagrams`, `explorable`, `charts`) play to the end with no fault at 60 fps in all nine looks at 1440x900, on the plain renderer, and (explorable) at 375x667 with touch emulation. A tree, a cycle, a table with bars, a flow, a line chart, an indexed two-series chart, columns and candles drew correctly in every look; the machine looks colour the chart and keep its crosshair.
- Controls: the slider moves by pointer drag, by touch drag and by arrow keys (each step sends its `control` event, 0.5 s to the sun's new place); the toggle by Space, the pick by arrow keys; a button opens an `act` turn. Each has an invisible form control over it with a name, role and value.
- Charts: hover and zoom through the hook change the readout and the range and open no turn; their picture reaches a PNG, an SVG, a WebM film and a zip of frames (`chartStill` is wired into the exporter, and a draft's chart is drawn off screen).
- Paint: `paint over=<group> as=<medium>` on the three renderer reaches the renderer (the painter now sets `medium`, `sketch` and `develop` on the picture); watercolor, gouache, pastel and pixel read as their medium, oil and woodcut were tuned to read as one, ink is three flat tones.
- Look and fix inside the battery runs through the same `reviewTurn` the server uses: the draft is pictured by the page, the brain is shown it, a fix is parsed and played, and the judge scores both.
- Seams found only by putting the parts together, and fixed: a card did not reserve its room in the flow (the say line and button drew over it); a structure carried to rest showed no rows (the resting picture of a table, and so the brain's snapshot of it, was blank); a renderer-made painting never reached the renderer; a chain of twenty steps ran off the right edge (it now folds into rows); the chart engine drew before its fonts were loaded; the battery's pictures had no charts in them.

Not verified: the OpenAI adapter against the real service (no spend approved); QuickTime and VLC playback of an exported film; memory during a 60 s export; weather thinning over text and the 12 field kinds by eye; background-tab rendering.

Carried over from v0 and still true: three and troika render together under Vite; the processed font files are exactly fixed pitch; with text limited to `GLYPHS` the page makes no request to another origin.

## Deliberately absent

Tests, CI, linters, pre-commit hooks (the owner's choice). (v2) Paid services of any kind: an image model, a market data feed, an embedding service, an API key. (v2) A model on the turn's path other than the brain: techniques are chosen by string matching, not by a second model. A database. Authentication (it is a local program). A tweening library. A post-processing library. API-key model adapters for the brain. Sound. Kerning.

# Conduit

A language model that answers on a canvas instead of in a text box.

The brain writes a compact line language called Series. A painter in the browser performs each line the moment it arrives. An answer can be words, a drawing that draws itself, pixel art, a staged scene with depth and a camera, a painting grown over its sketch, or plain prose when that is what the question needs. The brain chooses the form; the painter decides every pixel and keeps everything readable.

```
look night
scene caption calm slow
rect full layer=far fill=#0b1026>#16324f
ambient stars light
circle moon 118,22 9 layer=far fill=#f6f1d5
cam push slow
say | Nothing is asked of you tonight.
wait 2
say | The tide does the counting.
```

Paste a link to a PDF or a web page, or a long passage, and it reads it and answers about it on the stage. The server fetches public addresses only.

**v2, the quality and expression round, is planned and not yet built**: diagrams the brain names and the painter lays out, charts drawn by a charting engine, controls that drive a drawing with no round trip, the brain looking at its own draft and fixing it, a library of techniques, and a loop that improves all of it. The decisions are in [docs/product.md](docs/product.md); the build is in [PLAN-v2.md](PLAN-v2.md).

It is not a chat replacement. A fact is plain prose at reading speed; a drawing is used where a drawing shows more than words.

Every answer can be taken away: a video, a strip of stills, an SVG, or the script itself.

## Run it

Needs Node 22.14 or any later 22.x, and pnpm 10.28 (`corepack enable`).

```sh
pnpm install
cp .env.example .env        # set BRAIN=replay, claude-cli or relay
pnpm dev                    # open http://127.0.0.1:4301
```

- `BRAIN=replay` performs fixture scripts. No model, no key.
- `BRAIN=claude-cli` with `CLAUDE_MODEL=sonnet` uses Claude Code as a real streaming brain. No API key.
- `BRAIN=relay` holds each prompt until an outside agent claims it over HTTP and writes the answer.

Production mode: `pnpm build && pnpm start`, then http://127.0.0.1:4300.

Paintings from an image model cost money and are off; nothing uses one. Everything else, including how to be the brain with `curl`, read a session log, run the exploration battery (`pnpm explore --dry-run` shows what a run would cost; `--samples`, `--only`, `--held-out`, `--max-usd`) and inspect a frame, is in [docs/runbook.md](docs/runbook.md).

## Layout

```
language/   Series: vocabulary, parser, timing, geometry, the schedule, wire types, the brain's prompt, the demo scripts
server/     sessions, turns, the back channel, the brains (relay, claude-cli, replay), the image model port, the session log, the tools
web/        the painter, its renderers (three.js and plain DOM), looks and fonts, the stage page, export, the exploration page
explore/    the exploration battery (battery.json), the held-out set (sealed/), the owner's scores (taste/); runs are written to explore/runs/ and are not tracked
techniques/ the seed of the technique library; the library itself lives in Remote
loop/       the improvement loop's changelog
docs/       see below
```

## Documents

| Document | The question it answers |
| --- | --- |
| [docs/product.md](docs/product.md) | What is this, what was decided, and what is still open? |
| [docs/language.md](docs/language.md) | What exactly is Series? The specification. |
| [DESIGN.md](DESIGN.md) | What must the looks, drawings, pixels, weather and paintings be, and never be? |
| [docs/technology.md](docs/technology.md) | Why is it built this way, and what was measured? |
| [docs/runbook.md](docs/runbook.md) | How do I run it and poke at it? |

MIT licensed. The fonts in `web/src/fonts` carry their own licences beside them.

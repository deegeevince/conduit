# Conduit

**A different way to interact with the AI you already use.**

Most AI chats are a column of text: you ask, it answers, you scroll. Conduit turns the answer into a canvas.

Conduit works with the AI you already pay for: Claude (through Claude Code) or ChatGPT (through Codex). When it replies, the reply streams as a small drawing language that the browser performs live: what to draw, how to arrange it, what to animate, what you can tap. The canvas keeps its own state, so the next answer builds on what is already there instead of starting over. You can tap a choice, drag a slider, write with a pen, or just keep talking.

The result is a shared, evolving, interactive canvas rather than a linear prompt and response. It is an experiment in a different way to interact with AI itself.

## What you can do with it

Some things to try. The welcome screen offers several of them to tap:

| Try asking | What you get |
| --- | --- |
| *show me a division question for my 7-year-old who doesn't know division yet* | A hands-on problem a child can work through, with a bar model, room to write with the pen, a hint behind a tap and a celebration when they get it. It asks before it tells. |
| *explain how a heat pump works, step by step* | A labelled diagram that builds itself, with a "1 of 4" stepper that lights up each part as you tap through. |
| *mock up a dashboard of Apple's fiscal 2025 results* | Headline numbers, charts and tables, looked up on the web where it can and marked approximate where it can't. |
| *mock up an app screen* | A clickable, phone-shaped app mock-up with real labels and copy. |
| *render me a real webpage for a small coffee roaster* | A real, working web page in a sandbox on the stage, with its own type and layout. |
| *make a little piano I can play* | A tiny app with sound that you can play right away. |
| *let me explore how compound interest grows with the rate* | A drawing with a slider bound to it: move the rate and watch the curve change, with no round trip to the model. |
| *show me how to fold a paper plane, step by step* | The paper drawn on the canvas with a "1 of 5" stepper beside it: tap through the folds one at a time. |

You can also:

- **Bring your own material.** Paste a link to a PDF or a web page, or attach a photo (a page of instructions, a chart, a child's worksheet), and it answers about it on the stage.
- **Keep going.** Say "make the mobile version", "go more technical" or "zoom into the last 14 days", and the answer changes what is already drawn.
- **Use your skills.** With Claude, pick one of your Claude skills from **+ Skills**, or type `/skill name`, and the next answer uses it.
- **Take it with you.** Every answer can be saved as a video, a strip of stills, an SVG or the script itself.

It is not a chat replacement. A plain question of fact gets plain prose; a drawing is used where a drawing shows more than words.

## How it works

```
 you: type, tap, drag, write with the pen
   │
   ▼
 server ──── your message + what is on the stage now ────▶ your AI (Claude Code or Codex CLI)
   ▲                                                          │
   │                      Series, streamed line by line       │
   └──────────────────────────────────────────────────────────┘
   │
   ▼
 browser painter (three.js and the DOM) performs each line as it arrives
```

- **The brain** is the AI you already use, run through its own command-line tool on your own subscription: Claude through [Claude Code](https://claude.com/claude-code), or ChatGPT through [Codex](https://developers.openai.com/codex). No API key is needed, and none is ever passed on.
- **Series** is the line language it writes: one short line per thing to draw, arrange, animate or make tappable. The brain says what it means, and the painter decides every pixel and keeps it readable.
- **The painter** in the browser performs each line the moment it arrives, so you watch the answer draw itself.
- **The stage keeps state.** The next turn is told what is on the canvas, so the brain edits it rather than redrawing from scratch.
- **It checks its own work.** After drawing, Conduit takes a look at the picture and fixes what is wrong, such as a label on the wrong part or text on top of a diagram.

A taste of Series:

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

## Quick start

You need:

- macOS (Linux should work too; the optional service installer is macOS only)
- [Node](https://nodejs.org) 22.14 or any later 22.x (see `.nvmrc`)
- pnpm 10 (run `corepack enable`)
- one AI command-line tool, installed and signed in with your subscription:
  - **Claude:** the [Claude Code](https://claude.com/claude-code) CLI (`claude` on your `PATH`), or
  - **ChatGPT:** the [Codex](https://developers.openai.com/codex) CLI 0.169 or newer (`codex login`, choosing ChatGPT)

Then clone this repository and, from its folder:

```sh
pnpm install
pnpm build

# with Claude
BRAIN=claude-cli CLAUDE_MODEL=sonnet LIBRARY=seed pnpm start

# or with ChatGPT (`codex debug models` lists the models your plan offers)
BRAIN=codex-cli CODEX_MODEL=<model> LIBRARY=seed pnpm start
```

Open **http://127.0.0.1:4300**. The welcome screen offers a few things to try; tap one, or type your own.

Some variations:

- **No account, no model:** `BRAIN=replay pnpm start` plays the bundled demo scripts, so you can see the painter at work.
- **A stronger model:** with Claude, `CLAUDE_MODEL=opus BRAIN_EFFORT=low` (slower to start, richer drawings).
- **ChatGPT details:** what the Codex brain does and doesn't do yet is in [docs/codex.md](docs/codex.md). Claude currently has the most complete feature set.
- **Settings in a file:** `cp .env.example .env` and fill in what you need. Every setting is described in [docs/runbook.md](docs/runbook.md).
- **Developing:** `pnpm dev`, then open http://127.0.0.1:4301 (the server and the web app both reload as you edit).

Your conversations, logs and caches live outside the repository, in `~/Library/Application Support/Conduit` on a Mac or `$XDG_DATA_HOME/conduit` elsewhere. Set `DATA_DIR` to put them somewhere else.

### On your phone or tablet (optional)

Conduit works well on a phone or an iPad, and the pen works with a finger or an Apple Pencil. The simplest way to reach it is [Tailscale](https://tailscale.com):

1. Run `tailscale serve` to publish the server to your tailnet.
2. Set `TRUSTED_HOSTS` to your machine's tailnet name.
3. Set `OWNER_LOGINS` to your Tailscale login, so nobody else on the tailnet can use it.

`ops/install.sh` sets this up as a macOS service that survives restarts. The details are in [docs/runbook.md](docs/runbook.md).

## Safety and privacy

- **It runs on your machine.** The model runs through your own Claude Code or Codex sign-in, and no keys live in this repository.
- **Reading is free; everything else asks.** By default the brain may search and read the web. Anything that writes, sends, signs in or spends is shown to you on the stage and waits for your yes, every time. Sign-ins, codes and payments are always left to your own hands.
- **Public addresses only.** Links are fetched from the public internet only; private and local addresses are refused.
- **Apps are sandboxed.** A page or app it builds runs in a locked sandbox on the stage.
- **More tools are opt-in.** With Claude, your own browser (through Claude in Chrome), a folder and other services can be connected; each is off unless you list it in `AGENT_SERVICES` or `AGENT_DIR`.
- **Only you over the network.** Served over Tailscale, only the logins in `OWNER_LOGINS` get in; any other request that is not from your own machine is refused.

## Project layout

```
language/   Series: the vocabulary, parser, timing and layout, the brain's prompt, the demo scripts
server/     sessions and turns, the brains (claude-cli, codex-cli, replay, relay), reading links and photos, the session log, tools
web/        the painter and its renderers (three.js and DOM), looks and fonts, the stage page, export
catalogue/  real-browser test cases: each is a past failure, replayed at desk and phone sizes
explore/    the exploration battery used to measure answers
techniques/ the seed library of drawing techniques handed to the brain
docs/       the specification, the product notes, the runbook
```

## Read more

| Document | The question it answers |
| --- | --- |
| [docs/product.md](docs/product.md) | What is this, what was decided, and what is still open? |
| [docs/language.md](docs/language.md) | What exactly is Series? The specification. |
| [DESIGN.md](DESIGN.md) | What must the looks, drawings and pictures be, and never be? |
| [docs/technology.md](docs/technology.md) | Why is it built this way, and what was measured? |
| [docs/runbook.md](docs/runbook.md) | How do I run it, configure it and poke at it? |
| [CHANGELOG.md](CHANGELOG.md) | What's new? |

The `PLAN-*.md`, `STATUS.md` and `BACKLOG.md` files are the working notes the project was built with, left in for anyone curious about how it got here.

## License

[MIT](LICENSE). The fonts in `web/src/fonts` carry their own licences beside them.

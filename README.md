# Conduit

**A different way to interact with the AI you already use.**

Most AI chats are a column of text: you ask, it answers, you scroll. Conduit turns the answer into a canvas. It runs on your own computer, on the Claude or ChatGPT subscription you already have: no API keys, no accounts to create.

## Quick start

You need [Git](https://git-scm.com), [Node](https://nodejs.org) 22.14 or any later 22.x (see `.nvmrc`), and a browser. Works on macOS and Linux.

**1. Get it.**

```sh
git clone https://github.com/deegeevince/conduit.git conduit
cd conduit
corepack enable     # makes the right pnpm (10.28.2) available
pnpm install
pnpm build
```

**2. Sign in to the AI you already pay for.** You do this once, in its own command-line tool. Conduit never sees a password or an API key.

- **Claude:** install [Claude Code](https://claude.com/claude-code), then run `claude auth login` and follow the prompts (the default is your Claude subscription). `claude auth status` tells you it worked.
- **ChatGPT:** install the [Codex CLI](https://developers.openai.com/codex) (0.169 or newer), then run `codex login` and choose **Sign in with ChatGPT**. `codex login status` tells you it worked.

**3. Run it.**

```sh
# with Claude
BRAIN=claude-cli CLAUDE_MODEL=sonnet pnpm start

# or with ChatGPT (`codex debug models` lists the models your plan offers)
BRAIN=codex-cli CODEX_MODEL=<a model from that list> pnpm start

# or with no account at all: plays the bundled demos so you can see it work
BRAIN=replay pnpm start
```

**4. Open <http://127.0.0.1:4300>.** The welcome screen offers seven things to try; tap one, or type your own question.

If something does not start:

- *"BRAIN is required"*: you left out the `BRAIN=` part. The message lists the choices.
- *cannot start "claude": no such program* (or `codex`): the tool is not on your `PATH`. Install it, or point `CLAUDE_BIN` / `CODEX_BIN` at it.
- *The server will not start because port 4300 is taken:* something else is using it. Add `PORT=4310` and open that port instead (Conduit never picks another port for you).

## Things to try

The welcome screen offers starters like these. Each answer arrives as a drawing you can tap, drag and write on, and the next answer builds on what is already there.

| Try asking | What you get |
| --- | --- |
| *Teach my 7-year-old division* | A hands-on problem a child can work through, with a bar model, room to write with the pen, a hint behind a tap and a celebration when they get it. It asks before it tells. |
| *Explain how a heat pump works* | A labelled diagram that builds itself, with a "1 of 4" stepper that lights up each part as you tap through. |
| *Mock up a sales dashboard for a small shop* | Headline numbers, charts and tables, laid out as a dashboard. |
| *Mock up an app screen* | A clickable, phone-shaped app mock-up with real labels and copy. |
| *Render me a real webpage for a small coffee roaster* | A real, working web page in a sandbox on the stage, with its own type and layout. |
| *Make a little piano I can play* | A tiny app with sound that you can play right away. |
| *Let me explore how compound interest grows with the rate* | A drawing with a slider bound to it: move the rate and watch the curve change, with no round trip to the model. |
| *Show me how to fold a paper plane, step by step* | The paper drawn on the canvas with a "1 of 5" stepper beside it: tap through the folds one at a time. |

You can also:

- **Bring your own material.** Paste a link to a PDF or a web page, or attach a photo (a page of instructions, a chart, a child's worksheet), and it answers about it on the stage.
- **Keep going.** Say "make the mobile version", "go more technical" or "zoom into the last 14 days", and the answer changes what is already drawn.
- **Use your skills.** With Claude, pick one of your Claude skills from **+ Skills**, or type `/skill name`, and the next answer uses it.
- **Take it with you.** Every answer can be saved as a video, a strip of stills, an SVG or the script itself.

It is not a chat replacement. A plain question of fact gets plain prose; a drawing is used where a drawing shows more than words.

## How it works

```
 you: type, tap, drag, write with the pen
   |
   v
 server ---- your message + what is on the stage now ---->  your AI (Claude Code or Codex CLI)
   ^                                                          |
   |                      Series, streamed line by line       |
   +----------------------------------------------------------+
   |
   v
 browser painter (three.js and the DOM) performs each line as it arrives
```

- **The brain** is the AI you already use, run through its own command-line tool on your own subscription. No API key is needed, and none is ever passed on.
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

## More ways to run it

- **A stronger model:** with Claude, `CLAUDE_MODEL=opus BRAIN_EFFORT=low` (slower to start, richer drawings).
- **ChatGPT details:** what the Codex brain does and doesn't do yet is in [docs/codex.md](docs/codex.md). Claude currently has the most complete feature set.
- **Settings in a file:** `cp .env.example .env` and fill in what you need; `pnpm start` reads it. Every setting is described in [docs/runbook.md](docs/runbook.md).
- **Developing:** `pnpm dev` with the same `BRAIN=...` settings (instead of `pnpm start`, and with no `pnpm build`), then open <http://127.0.0.1:4301>. The server and the web app both reload as you edit.
- Voice notes use Apple's on-device speech recognition, so they work on a Mac.

Your conversations stay on your machine; set `DATA_DIR` to choose where.

### On your phone or tablet

It works on a phone or iPad, and the pen works with a finger or an Apple Pencil.
To reach it from another device, see [docs/runbook.md](docs/runbook.md).

## Safety and privacy

- **It runs on your machine.** The model runs through your own Claude Code or Codex sign-in, and no keys live in this repository.
- **Reading is free; everything else asks.** By default the brain may search and read the web. Anything that writes, sends, signs in or spends is shown to you on the stage and waits for your yes, every time. Sign-ins, codes and payments are always left to your own hands.
- **Public addresses only.** Links are fetched from the public internet only; private and local addresses are refused.
- **Apps are sandboxed.** A page or app it builds runs in a locked sandbox on the stage.
- **More tools are opt-in.** With Claude, your own browser (through Claude in Chrome), a folder and other services can be connected; each is off unless you list it in `AGENT_SERVICES` or `AGENT_DIR`.
- **Only you over the network.** Served over Tailscale, only the logins in `OWNER_LOGINS` get in; any other request that is not from your own machine is refused.

## Tests

`pnpm typecheck` type-checks every package. `pnpm check` is the free browser check: it starts its own server on the replay brain, plays the welcome and every demo in headless Chrome at desk and phone sizes, and needs no model or account (`pnpm check --only welcome` runs just the welcome). CI runs it on every push.
`pnpm smoke --url <server>` drives a real conversation against a server with a live brain, and `pnpm catalogue` replays the real-browser cases in `catalogue/`; both are run by hand.

## Project layout

```
language/   Series: the vocabulary, parser, timing and layout, the brain's prompt, the demo scripts
server/     sessions and turns, the brains (claude-cli, codex-cli, replay, relay), reading links and photos, the session log, tools
web/        the painter and its renderers (three.js and DOM), looks and fonts, the stage page, export
catalogue/  real-browser test cases: each is a past failure, replayed at desk and phone sizes
explore/    the exploration battery used to measure answers
techniques/ the seed library of drawing techniques handed to the brain
art/        the seed library of pictures (original drawings, MIT)
docs/       the specification, the technology notes, the runbook
```

## Read more

| Document | The question it answers |
| --- | --- |
| [docs/language.md](docs/language.md) | What exactly is Series? The specification. |
| [DESIGN.md](DESIGN.md) | What must the looks, drawings and pictures be, and never be? |
| [docs/technology.md](docs/technology.md) | Why is it built this way, and what was measured? |
| [docs/runbook.md](docs/runbook.md) | How do I run it, configure it and poke at it? |
| [CHANGELOG.md](CHANGELOG.md) | What's new? |

## License

[MIT](LICENSE). The fonts in `web/src/fonts` and the other third-party files carry their own licences beside them.

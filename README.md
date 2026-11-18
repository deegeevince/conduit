# Conduit

**A different way to use the AI you already pay for.**

Most AI chats give you a column of text: you ask, it writes, you scroll. Conduit gives you a canvas instead. As the AI answers, your browser draws what it describes, and you can tap, drag and write on the result.

It runs on your own computer and uses the Claude or ChatGPT plan you already have. You don't need an API key or a new account.

The idea behind it is in the essay [What does the user interface of the future look like?](https://lattris.com/by/b/memories/what-does-the-user-interface-of-the-future-look-like-8aff)

## Quick start

You need [Git](https://git-scm.com), [Node](https://nodejs.org) 22.14 or a later 22.x version (see `.nvmrc`), and a web browser. It works on macOS and Linux.

**1. Download it and build it.**

```sh
git clone https://github.com/deegeevince/conduit.git conduit
cd conduit
corepack enable     # sets up the right version of pnpm (10.28.2)
pnpm install
pnpm build
```

**2. Sign in to your AI.** You do this once, in the AI's own command-line tool. Conduit never sees your password or any key.

- **Claude:** install [Claude Code](https://claude.com/claude-code), run `claude auth login` and follow the steps. Run `claude auth status` to check it worked.
- **ChatGPT:** install the [Codex CLI](https://developers.openai.com/codex) (version 0.169 or newer), run `codex login` and choose **Sign in with ChatGPT**. Run `codex login status` to check it worked.

**3. Start it.** Pick one:

```sh
# using Claude
BRAIN=claude-cli CLAUDE_MODEL=sonnet pnpm start

# using ChatGPT (run `codex debug models` to see which models your plan has)
BRAIN=codex-cli CODEX_MODEL=<a model from that list> pnpm start

# with no AI at all: plays back the built-in examples so you can see how it looks
BRAIN=replay pnpm start
```

**4. Open <http://127.0.0.1:4300> in your browser.** The first screen suggests seven things to try. Tap one, or type your own question.

If it doesn't start:

- **"BRAIN is required":** you left out the `BRAIN=` part. The message lists what you can use.
- **cannot start "claude": no such program** (or "codex"): your computer can't find the tool. Install it, or set `CLAUDE_BIN` or `CODEX_BIN` to where it is.
- **port 4300 is taken:** another program is using that port. Add `PORT=4310` to the start command and open that address instead.

## Things to try

The first screen suggests questions like these. Each answer is drawn on the canvas, and you can tap it, drag it and write on it. When you ask a follow-up, the AI changes what is already there instead of starting again.

| Try asking | What you get |
| --- | --- |
| *Teach my 7-year-old division* | A problem a child can work through: a picture of the sum, space to write the answer with a pen, a hint if they tap for one, and a little celebration when they get it. It asks questions before it gives answers. |
| *Explain how a heat pump works* | A labelled diagram that draws itself, with "1 of 4" buttons that light up each part in turn. |
| *Mock up a sales dashboard for a small shop* | A dashboard with headline numbers, charts and tables. |
| *Mock up an app screen* | A phone-shaped app design you can tap through, with real labels and text. |
| *Render me a real webpage for a small coffee roaster* | A real web page that works, running safely inside the canvas. |
| *Make a little piano I can play* | A small piano with sound that you can play straight away. |
| *Let me explore how compound interest grows with the rate* | A chart with a slider. Move the slider and the curve changes instantly, without asking the AI again. |
| *Show me how to fold a paper plane, step by step* | A drawing of the paper with "1 of 5" buttons to go through the folds one at a time. |

You can also:

- **Ask about your own things.** Paste a link to a web page or PDF, or add a photo (instructions, a chart, a child's worksheet), and the answer is drawn about it.
- **Keep going.** Say things like "make the mobile version" or "go more technical", and it changes what is already drawn.
- **Use your Claude skills.** Pick one from **+ Skills**, or type `/skill name`, and the next answer uses it.
- **Save any answer** as a video, a set of still images, an SVG picture, or the text instructions that drew it.

Conduit doesn't draw everything. If you ask a simple factual question, you get a plain written answer. It draws only when a picture explains something better than words.

## How it works

```
 you: type, tap, drag, write with a pen
   |
   v
 Conduit ---- your message + what is on the canvas now ---->  your AI (Claude Code or Codex)
   ^                                                            |
   |                 short instructions, one per line            |
   +------------------------------------------------------------+
   |
   v
 your browser draws each instruction the moment it arrives
```

1. **The AI writes instructions, not text for you to read.** Conduit asks the AI to answer in a small language called Series. Each line is one instruction: draw this, label that, move this, add a button.
2. **Your browser carries them out as they arrive.** You watch the answer build itself, line by line. The AI says what it wants; your browser works out the exact layout and keeps it readable on any screen.
3. **The canvas remembers.** Each time you ask something new, the AI is told what is already on the canvas, so it can change one part instead of drawing everything again.
4. **It works in both directions.** Your taps, slider moves, pen marks and photos go back to the AI along with what you touched. Some things, like moving a slider, happen in your browser straight away without asking the AI.
5. **It checks its own drawing.** After drawing, Conduit looks at a picture of the result and fixes problems, such as a label on the wrong part or text covering a diagram.
6. **The AI is the one you already use,** run through its own command-line tool on your own plan. No API key is needed, and none is passed on.

Here is what a few lines of Series look like:

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

- **A more capable model:** with Claude, use `CLAUDE_MODEL=opus BRAIN_EFFORT=low`. It is slower to start and draws richer pictures.
- **ChatGPT:** what works with Codex, and what doesn't yet, is listed in [docs/codex.md](docs/codex.md). Claude currently supports the most.
- **Keep your settings in a file:** run `cp .env.example .env` and fill it in; `pnpm start` reads it. Every setting is explained in [docs/runbook.md](docs/runbook.md).
- **Change the code:** run `pnpm dev` with the same `BRAIN=...` setting (no `pnpm build` needed), then open <http://127.0.0.1:4301>. It reloads as you edit.
- **Voice notes** use Apple's speech recognition on your computer, so they work on a Mac.

Your conversations are saved on your own computer. Set `DATA_DIR` to choose the folder.

### On your phone or tablet

It works on a phone or iPad, and you can write with a finger or an Apple Pencil. To open it from another device, see [docs/runbook.md](docs/runbook.md).

## Safety and privacy

- **It runs on your computer.** The AI runs through your own Claude Code or Codex sign-in. No keys are stored in this project.
- **It asks before it acts.** The AI can search and read the web. Anything that writes, sends, signs in or spends money is shown to you first and waits for your yes. Logins, codes and payments are always left to you.
- **Only public websites.** It only opens links on the public internet. It refuses private and local addresses.
- **Apps are kept separate.** Any page or app it builds runs in a locked box inside the canvas.
- **Extra tools are off by default.** With Claude, you can connect your own browser (through Claude in Chrome), a folder or other services. Each stays off unless you turn it on with `AGENT_SERVICES` or `AGENT_DIR`.
- **Only you, if you open it to your network.** If you reach it from other devices through Tailscale, only the accounts listed in `OWNER_LOGINS` can use it.

## Tests

- `pnpm typecheck` checks the code for type errors.
- `pnpm check` runs a free browser test. It starts its own copy of Conduit with the built-in examples, plays the first screen and every example in a hidden browser at desktop and phone sizes, and needs no AI or account. `pnpm check --only welcome` runs just the first screen. These run automatically on every push.
- `pnpm smoke --url <server>` runs a real conversation against a copy of Conduit with an AI connected. `pnpm catalogue` replays recorded test cases from `catalogue/` in a real browser. You run both by hand.

## What's in the project

```
language/   Series: its words, how lines are read and timed and laid out, the instructions given to the AI, the built-in examples
server/     conversations, the connections to each AI, reading links and photos, the saved history, tools
web/        what draws in your browser: shapes, text, looks and fonts, the main page, saving videos and images
catalogue/  recorded test cases, each one a past bug, replayed at desktop and phone sizes
explore/    tests used to measure how good the answers are
techniques/ drawing techniques given to the AI as examples
art/        a starter set of pictures (original drawings, MIT licence)
docs/       the Series specification, why it is built this way, and how to run it
```

## Read more

| Document | What it covers |
| --- | --- |
| [docs/language.md](docs/language.md) | Series, the instruction language, in full. |
| [DESIGN.md](DESIGN.md) | The rules for how drawings, looks and pictures must and mustn't look. |
| [docs/technology.md](docs/technology.md) | Why it is built this way, and what was measured. |
| [docs/runbook.md](docs/runbook.md) | How to run it, set it up and test it. |
| [CHANGELOG.md](CHANGELOG.md) | What has changed. |

## Licence

[MIT](LICENSE). The fonts in `web/src/fonts` and other third-party files have their own licences next to them.

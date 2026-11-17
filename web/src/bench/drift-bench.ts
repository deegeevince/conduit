// The page's own run of a turn, with no browser and no model: the real painter on a renderer that draws nothing, a clock turned by hand, and lines
// written the way a brain writes them. It prints what the painter said on the back channel (`ready`, `draft`, `report`, with the `facts` each
// carries) as one JSON document, for `server/src/tools/drift-check.ts` to measure the server's way and hold against.
//
//   tsx --import ./src/bench/node-register.mjs src/bench/drift-bench.ts        (run from web/; `pnpm drift-check` does it)
//
// Each case is a pattern the owner's drifted sessions had, at a screen they ran on: a revision that comes after its words have played, an ask a
// hand has answered, a choice under a mouse, a control the hand moved, words that wrap in CJK, a live app, a second turn on the first's stage.
// Nothing here is a copy of a private log: the lines are made up.

import { TurnScore, parseLine, EMPTY_STAGE } from '@conduit/language';
import type { BackEvent, Line, StageBase, TurnInput } from '@conduit/language';
import { askOf, check as askCheck, runOf as askRun } from '../painter/controls/ask-state';

interface Scene {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly pointer: 'fine' | 'coarse';
}

/** The screens the owner's drifted sessions ran on, and a mouse on the iPad's size. */
export const SCREENS: readonly Scene[] = [
  { name: 'ipad-upright', width: 820, height: 971, dpr: 2, pointer: 'coarse' },
  { name: 'ipad-short', width: 820, height: 775, dpr: 2, pointer: 'coarse' },
  { name: 'phone-wide', width: 719, height: 356, dpr: 3, pointer: 'coarse' },
  { name: 'phone-tall', width: 353, height: 595, dpr: 3, pointer: 'coarse' },
  { name: 'desktop', width: 1920, height: 856, dpr: 2, pointer: 'fine' },
  { name: 'desktop-dpr1', width: 1920, height: 757, dpr: 1, pointer: 'fine' },
  { name: 'phone-390', width: 390, height: 776, dpr: 2, pointer: 'coarse' },
  { name: 'ipad-mouse', width: 820, height: 971, dpr: 2, pointer: 'fine' },
];

interface Step {
  /** lines of the turn, and the seconds of the turn clock each arrives after the one before it */
  readonly lines: readonly (readonly [string, number])[];
  readonly input?: TurnInput;
  /** what a hand does on the page when the turn has rested, before the next one opens */
  readonly hand?: 'answer-asks' | 'move-slider';
}

interface Pattern {
  readonly name: string;
  readonly turns: readonly Step[];
}

const ASK = ['scene layout=caption', 'say a1 | Work it out.', 'ask q1 is=12 stage=1 | What is 5 + 7?', 'hint in=q1 stage=yes | Count on from five.', 'ask q2 is=20 stage=2:q1 | And 12 + 8?'];

export const PATTERNS: readonly Pattern[] = [
  { name: 'words', turns: [{ lines: [['scene layout=caption', 0], ['say a | Hello there', 0.4], ['say b | A second line of words for the reader to take in', 0.4]] }] },
  {
    name: 'revise-late',
    turns: [{ lines: [['scene layout=caption', 0], ['say x1 | The first thing said', 0.3], ['say x2 | The second thing said', 0.3], ['say x3 | And a third, which keeps the turn going a while', 0.3], ['revise x1 | The first thing, said better', 6], ['revise x3 | A third thing, said better', 0.2]] }],
  },
  { name: 'revise-early', turns: [{ lines: [['scene layout=caption', 0], ['say x1 | The first thing said', 0], ['say x2 | The second thing said', 0], ['revise x2 | The second thing, said better', 0]] }] },
  { name: 'ask-answered', turns: [{ lines: ASK.map((text) => [text, 0.3] as const), hand: 'answer-asks' }, { lines: [['say z | Well done. Now the next.', 0.3]] }] },
  { name: 'choices', turns: [{ lines: [['scene layout=caption', 0], ['say a | Pick one', 0.3], ['say c1 choice | Cats', 0.3], ['say c2 choice | Dogs', 0.3], ['say c3 choice | Birds', 0.3]] }] },
  {
    name: 'controls',
    turns: [
      { lines: [['scene layout=figure lines=3', 0], ['card tools | Try it', 0.2], ['slider height 10 80 20 unit=deg in=tools | Height of the sun', 0.2], ['toggle shade on in=tools | Show the shadow', 0.2], ['pick view tabs in=tools | Day | Dusk | Night', 0.2], ['say s | With the sun up, the shadow is short.', 0.2]], hand: 'move-slider' },
      { lines: [['scene layout=caption', 0], ['say n | A new question, with its own words and a slider of the same name', 0.3], ['slider height 0 100 50 | Another height', 0.3]] },
    ],
  },
  { name: 'cjk', turns: [{ lines: [['scene layout=caption', 0], ['say a | 你好，今天我们来看一个很长的句子，它需要在窄的屏幕上换行显示出来。', 0.4], ['say b | これは日本語の文章で、画面の幅に合わせて折り返されます。', 0.4], ['say c | 한국어 문장도 같은 방식으로 줄을 바꿉니다.', 0.4]] }] },
  { name: 'scripts', turns: [{ lines: [['scene layout=caption', 0], ['say a | Καλημέρα κόσμε, this line has Greek in it', 0.4], ['say b | Привет, мир: и немного кириллицы', 0.4], ['say c | مرحبا بالعالم', 0.4]] }] },
  { name: 'flow-choices', turns: [{ lines: [['look paper', 0.1], ['scene layout=caption', 0.1], ['flow x5 right | How a bill becomes a law', 0.1], ['node intro in=x5 | Introduced in House or Senate', 0.1], ['node comm from=intro in=x5 | Committee studies and amends it', 0.1], ['node floor1 from=comm in=x5 | First chamber debates and votes', 0.1], ['node floor2 from=floor1:passes in=x5 | Second chamber votes', 0.1], ['node conf from=floor2:different text in=x5 | Both agree on one text', 0.1], ['node pres ask from=conf in=x5 | President signs?', 0.1], ['node law end from=pres:yes in=x5 fill=accent | Law', 0.1], ['node veto from=pres:veto in=x5 | Veto: Congress can override with 2/3', 0.1], ['link veto law id=x6 dashed | override', 0.1], ['say x7 | A bill can die at any step.', 0.1], ['say x9 choice | What happens in committee?', 0.1], ['say x11 choice | How often are vetoes overridden?', 0.1]] }] },
  { name: 'flow', turns: [{ lines: [['scene layout=caption', 0], ['flow x1 down | How it goes', 0.3], ['node a in=x1 | Start here', 0.2], ['node b from=a in=x1 | Then this', 0.2], ['node c from=b in=x1 | Finally that', 0.2], ['say s | Words under the flow', 0.3]] }] },
  { name: 'carry', turns: [{ lines: [['scene layout=caption', 0], ['say a | The first turn says this', 0.3], ['say b | And this, which the next turn will stand on', 0.3]] }, { lines: [['say c | The second turn adds its own line below', 0.3], ['revise a | The first turn said this, but better', 5]] }] },
  { name: 'math', turns: [{ lines: [['scene layout=stack', 0], ['say a | Six lots of 12.', 0.3], ['math m1 column | 12+12+12+12+12+12', 0.3], ['set m1.ans-ones mark=box', 0.2], ['say b | Take 278 from 503.', 0.3], ['math m2 column | 503 - 278', 0.3], ['math m3 times | 47 × 6', 0.3], ['math m4 bond | 10 = 4 + ?', 0.3]] }] },
  { name: 'math-pictures', turns: [{ lines: [['scene layout=stack', 0], ['say a | Three quarters.', 0.3], ['math m1 bar | 3/4', 0.3], ['scene layout=stack', 0.5], ['math m2 groups | 12 ÷ 3', 0.3], ['scene layout=stack', 0.5], ['math m3 line steps | 7 + 5', 0.3]] }] },
  // fb-059 and fb-060: a free scene whose title has no place of its own, over words set at points, and asks that wait: the page and the server place and measure them alike
  { name: 'free-title', turns: [{ lines: [['scene layout=free canvas=square', 0], ['say t1 title | Adding big numbers', 0.3], ['say d1 at=60,28 align=right face=mono | 4768', 0.2], ['say d2 at=60,42 align=right face=mono | 2557', 0.2], ['say d3 at=60,58 align=right face=mono | 7325', 0.2], ['ask q1 is=6281 stage=1 | 3486 + 2795 = __', 0.3], ['ask q2 is=7043 stage=2:q1 | 5079 + 1964 = __', 0.3], ['ask q3 is=10000 stage=3:q2 | 6358 + 3642 = __', 0.3]] }] },
  { name: 'app', turns: [{ lines: [['scene layout=caption', 0], ['app tally height=320 | Tally', 0.3], ['| <div id="n">0</div>', 0], ['say s | A counter.', 0.3]] }] },
];

/** What the page said of one turn. */
export interface TurnCapture {
  readonly id: string;
  readonly opened: string;
  readonly base: StageBase | null;
  readonly lines: readonly { readonly seq: number; readonly text: string }[];
  readonly events: readonly BackEvent[];
}

export interface CaseCapture {
  readonly pattern: string;
  readonly screen: Scene;
  readonly ready: BackEvent | null;
  readonly turns: readonly TurnCapture[];
}

/** One pattern at one screen, played by the real painter. */
async function play(pattern: Pattern, scene: Scene): Promise<CaseCapture> {
  const g = globalThis as unknown as Record<string, unknown>;
  let frame: ((now: number) => void) | null = null;
  g.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  g.requestAnimationFrame = (callback: (now: number) => void) => {
    frame = callback;
    return 1;
  };
  g.cancelAnimationFrame = () => {
    frame = null;
  };
  const { createPainter } = await import('../painter');
  const quiet = (): undefined => undefined;
  const renderer = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'isDrawable'
          ? () => true
          : key === 'capabilities'
            ? { depth: true, post: false, looks: [], kinds: ['text', 'shape', 'sprite', 'group', 'copy', 'picture', 'field'], fx: [], ambient: [], capture: false, media: [], textures: [], brushes: [], clip: true }
            : key === 'preload'
              ? () => Promise.resolve()
              : key === 'pick'
                ? () => null
                : key === 'rasterise'
                  ? () => Promise.resolve(null)
                  : quiet,
    },
  );
  const painter = createPainter({ renderer: renderer as never, viewport: { width: scene.width, height: scene.height, dpr: scene.dpr }, lockLook: null, pointer: scene.pointer, reducedMotion: false });
  const events: BackEvent[] = [];
  let ready: BackEvent | null = null;
  painter.on('back', (event) => {
    events.push(event);
    if (event.type === 'ready') ready = event;
  });
  let now = 1000;
  const tick = async (frames: number): Promise<void> => {
    for (let i = 0; i < frames; i += 1) {
      now += 100;
      (frame as ((now: number) => void) | null)?.(now);
      await Promise.resolve();
    }
  };
  const turns: TurnCapture[] = [];
  let stage: StageBase | null = null;
  let seq = 0;
  for (const [at, step] of pattern.turns.entries()) {
    const id = `t${at + 1}`;
    const input: TurnInput = step.input ?? { kind: 'prompt', text: 'go' };
    events.length = 0;
    painter.openTurn(id, input);
    const lines: { seq: number; text: string }[] = [];
    // `| …` lines are the body of the block above them: they are read with it
    for (const [text, after] of step.lines) {
      await tick(Math.round(after * 10));
      const parsed = parseLine(text);
      if (parsed.kind !== 'line') continue;
      seq += 1;
      lines.push({ seq, text });
      painter.ingest(id, seq, parsed.line as Line);
      await tick(1);
    }
    painter.notePass(id, 1, 'drafted');
    await tick(2);
    painter.closeTurn(id, 'done');
    for (let i = 0; i < 3000 && !events.some((event) => event.type === 'report'); i += 1) await tick(1);
    await tick(2);
    const report = events.find((event) => event.type === 'report');
    turns.push({ id, opened: input.kind, base: stage, lines, events: [...events] });
    if (report?.type === 'report') stage = report.report.stage;
    if (step.hand === 'answer-asks') {
      // The hand answers every ask on the stage right, as a finger on its field would; the page keeps that, and tells the server only by its facts.
      const score = new TurnScore(turns[at]?.base ?? EMPTY_STAGE, input.kind);
      for (const entry of lines) {
        const parsed = parseLine(entry.text);
        if (parsed.kind === 'line') score.push(parsed.line as Line, entry.seq, 0);
      }
      for (const element of score.schedule.elements) {
        const ask = askOf(element);
        if (ask === null) continue;
        const run = askRun(element);
        run.hints = Math.min(1, ask.hints.length);
        askCheck(element, ask.accepted[0] ?? 'x');
      }
    }
    if (step.hand === 'move-slider') {
      painter.setControl('height', 70, true);
      await tick(2);
    }
  }
  painter.dispose?.();
  return { pattern: pattern.name, screen: scene, ready, turns };
}

async function main(): Promise<void> {
  const out: CaseCapture[] = [];
  for (const scene of SCREENS) {
    for (const pattern of PATTERNS) {
      const played = await play(pattern, scene);
      out.push(played);
    }
  }
  console.log(JSON.stringify(out));
}

void main();

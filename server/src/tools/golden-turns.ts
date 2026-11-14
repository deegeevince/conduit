// The golden turns: the owner's own answers, fixed, that `pnpm golden` replays in a real browser before and after a refactor.
//
// Each one names a fixture log under `server/golden/logs/` (copies of the owner's session logs, whole, so a turn's base is what the
// turns before it left) and a turn in it. `covers` says what the turn is there to catch; a refactor that changes any of them changes
// bytes. To add a turn: copy its log into `server/golden/logs/`, add a line here, and take a new baseline.

export interface GoldenTurn {
  /** the name its artefacts carry in the manifest */
  readonly id: string;
  /** the log's file name under server/golden/logs/ (the owner's: `logs/` of v2-quality or v2.1) */
  readonly log: string;
  readonly turn: string;
  /** what the owner asked, as logged */
  readonly asked: string;
  /** what it exercises */
  readonly covers: string;
}

export const GOLDEN_TURNS: readonly GoldenTurn[] = [
  { id: 'flow-bill', log: '20261114-131022-c1.jsonl', turn: 't2', asked: 'explain how a bill becomes a law in the US', covers: 'a flow: nodes, links, a highlight hit' },
  { id: 'cycle-water', log: '20261114-131120-c3.jsonl', turn: 't3', asked: 'explain the water cycle', covers: 'a cycle structure' },
  { id: 'chart-apple', log: '20261114-131120-c5.jsonl', turn: 't5', asked: "show me how Apple's stock price moved over 2024", covers: 'a chart from rows' },
  { id: 'explorable-compound', log: '20261114-131120-c4.jsonl', turn: 't4', asked: 'let me explore how compound interest grows with the rate', covers: 'an explorable: a slider bound to a drawing' },
  { id: 'scene-steam', log: '20261114-135830-c2.jsonl', turn: 't6', asked: 'how about a steam engine', covers: 'a scene picture: shapes, paths, look' },
  { id: 'table-nvidia', log: '20261114-145623-c2.jsonl', turn: 't5', asked: 'search the latest nvidia financial results and show it', covers: 'a chart and a table together, on a phone-shaped first look' },
  { id: 'followup-nvidia', log: '20261114-145623-c2.jsonl', turn: 't6', asked: 'thats it?', covers: 'a follow-up: carried stage, chart and table' },
  { id: 'tap-vlookup', log: '20261114-145623-c2.jsonl', turn: 't11', asked: 'Teach me VLOOKUP this way (a tapped choice)', covers: 'a tapped choice: a table, a pick, binds, the choices retired' },
  { id: 'controls-calculator', log: '20261114-145623-c2.jsonl', turn: 't16', asked: 'ability to add tooling to the user for interaction', covers: 'controls: card, slider, pick, toggle, input, button' },
  { id: 'cycle-rocket', log: '20261114-140410-c3.jsonl', turn: 't16', asked: 'okay go more technical', covers: 'a cycle as a follow-up to a scene' },
  { id: 'followup-crew', log: '20261114-140410-c3.jsonl', turn: 't15', asked: "whats inside the crew space", covers: 'a follow-up scene that reuses sprites (`use`) over a carried stage' },
  { id: 'wireframe-journey', log: '20261114-151538-c3.jsonl', turn: 't7', asked: 'Turn the quote journey into wireframe screens (a tapped choice)', covers: 'a wireframe: 71 lines of boxes and lines, a tap' },
  { id: 'home-page', log: '20261114-151538-c3.jsonl', turn: 't9', asked: 'okay now do the actual home page for me including hero image', covers: 'a long follow-up over two earlier wireframe turns' },
];

/** The windows every turn is captured at: the desk, the phone, the wide desk. */
export const GOLDEN_SCREENS: readonly string[] = ['1280x720', '390x844', '1920x825'];

/** `pnpm prompt <variant>`; the empty name is the default (full). `count` is the budget check and may exit non-zero. */
export const GOLDEN_PROMPTS: readonly string[] = ['', 'relay', 'model', 'shipped', 'v3', 'flat', 'count'];

/** The replay battery: a logged run of the explore battery (copied to server/golden/run/), laid out in every look at this window. No model is called. */
export const GOLDEN_REPLAY = { screen: '390x844', looks: 'all' } as const;

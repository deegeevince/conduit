// pnpm scenarios: the general scenarios gate. Four conversations that are NOT homework, driven in real headless Chrome with real input beside the worksheet case, so that anything
// that only works for homework shows up red (PRINCIPLES pass 4: a toolkit, not an app; REVIEW-generality section 3).
//
//   pnpm scenarios [--url http://127.0.0.1:<port>] [--live | --record] [--only explainer,mockup,recipe,document,worksheet] [--screens 1280x720,390x844] [--out <dir>]
//                  [--timeout <s>] [--quiet] [--port 4965] [--photo <worksheet photo>] [--private <dir>]
//
//   explainer   "explain how a heat pump works, step by step"; step through every stop by tapping; "what happens in winter?"
//   mockup      "mock up a checkout page for a bakery"; ring the pay button with the pen (+ menu, Draw), say "make this bigger and clearer"; the change must land on the circled thing
//   recipe      "walk me through making pancakes, with a timer for each step"; step through; start a timer; ask "how many eggs again?" mid-way
//   document    a short public-domain text attached as a screenshot; "highlight the three main claims and comment on the weakest"; select words on stage and ask "what does this mean?"
//   worksheet   (the flagship) a worksheet photo, from a path you give (never committed): photo, the map, a question, a wrong try, help, a right try, reload resumes
//
// Modes. Default: REPLAY. The brain's lines for each case were recorded once (`--record`, from a live run) and are played back with no model: the tool starts its own server on
// --port with BRAIN=replay and REPLAY_CASE=<the case's file>, so the run is deterministic and costs nothing. `--live` drives the server at --url with its real brain.
// `--record` is `--live` that also writes each case's brain lines: public cases beside this file (scenarios/<case>.json), the worksheet case (a private photo) under the data dir.
//
// After every turn: the existing checks (answer-on-stage, chrome-readable, no-overlap, nothing-cut-off, no-console-errors, no-failed-requests) plus `legible` (the ink on stage
// reads) and the case's own expectations (steps, marks-land, change-lands, timer, mid-answer, highlights, selection, document-view ...). At the end of a case: `kept-after-reload`.
// A contact sheet per case and screen, like smoke's. A table of case x screen x check, and which general pieces each case exercised and what was missing.
// Lint S0: the lines of shared code that name a scenario (worksheet, homework, young child, learner, "for the parent") may only go down from scenarios/s0-baseline.json.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Conversation, Tab } from './smoke';
import type { Answer, CheckResult, LiveElement, Options, TurnRecord, Verdict } from './smoke';
import { repoRoot, sleep, waitFor } from './explore-browser';

// ---------------------------------------------------------------------------------------------------------------------------------
// Arguments

const CASES = ['explainer', 'mockup', 'recipe', 'document', 'worksheet'] as const;
type CaseId = (typeof CASES)[number];

interface Args {
  readonly url: string;
  readonly mode: 'replay' | 'live' | 'record';
  readonly only: readonly CaseId[];
  readonly screens: readonly { readonly name: string; readonly width: number; readonly height: number }[];
  readonly out: string;
  readonly timeoutMs: number;
  readonly quiet: boolean;
  readonly port: number;
  readonly photo: string | null;
  readonly privateDir: string;
}

function usage(message: string): never {
  process.stderr.write(`scenarios: ${message}\nusage: pnpm scenarios [--url <server>] [--live | --record] [--only ${CASES.join(',')}] [--screens 1280x720,390x844] [--out <dir>] [--timeout <s>] [--quiet] [--port 4965] [--photo <file>] [--private <dir>]\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) usage(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (['live', 'record', 'quiet'].includes(name)) flags.set(name, 'true');
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usage(`--${name} needs a value`);
      flags.set(name, value);
      i += 1;
    }
  }
  const screens = (flags.get('screens') ?? '1280x720,390x844').split(',').map((text) => {
    const match = /^(\d{3,4})x(\d{3,4})$/.exec(text.trim());
    if (match === null) usage(`bad screen ${text}: say 1280x720`);
    return { name: text.trim(), width: Number(match[1]), height: Number(match[2]) };
  });
  const only = (flags.get('only') ?? CASES.join(',')).split(',').map((id) => {
    if (!(CASES as readonly string[]).includes(id.trim())) usage(`no case ${id}`);
    return id.trim() as CaseId;
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const data = process.env['DATA_DIR'] ?? join(homedir(), '.conduit-scenarios');
  return {
    url: (flags.get('url') ?? 'http://127.0.0.1:4964').replace(/\/+$/, ''),
    mode: flags.has('record') ? 'record' : flags.has('live') ? 'live' : 'replay',
    only,
    screens,
    out: resolve(flags.get('out') ?? join(process.env['TMPDIR'] ?? '/tmp', 'conduit-scenarios', stamp)),
    timeoutMs: Number(flags.get('timeout') ?? 300) * 1000,
    quiet: flags.has('quiet'),
    port: Number(flags.get('port') ?? 4965),
    photo: flags.get('photo') ?? process.env['SCENARIOS_WORKSHEET_PHOTO'] ?? null,
    privateDir: resolve(flags.get('private') ?? join(data, 'scenarios')),
  };
}

const publicDir = join(import.meta.dirname, 'scenarios');

// ---------------------------------------------------------------------------------------------------------------------------------
// The browser, beyond smoke's: frames (a live app runs in a sandboxed iframe), real drags, a page of public-domain text as a picture

interface Btn {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly disabled: boolean;
  readonly where: 'page' | 'app';
}

class Frames {
  /** the sandboxed iframes of live apps are their own processes: each is attached as a target of its own, in the order they came */
  private readonly sessions: string[] = [];
  constructor(private readonly tab: Tab) {
    tab.browser.onEvent((event) => {
      if (event.sessionId !== tab.session) return;
      const p = event.params as { sessionId?: string; targetInfo?: { type?: string } };
      if (event.method === 'Target.attachedToTarget' && p.sessionId !== undefined && p.targetInfo?.type === 'iframe') this.sessions.push(p.sessionId);
      else if (event.method === 'Target.detachedFromTarget' && p.sessionId !== undefined) {
        const at = this.sessions.indexOf(p.sessionId);
        if (at >= 0) this.sessions.splice(at, 1);
      }
    });
  }

  async start(): Promise<void> {
    await this.tab.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }

  /** the document of each live app, in page order, with where its iframe is */
  async frames(): Promise<readonly { readonly session: string; readonly x: number; readonly y: number }[]> {
    const rects = await this.tab.eval<{ x: number; y: number }[]>(`[...document.querySelectorAll('iframe')].map((f) => { const r = f.getBoundingClientRect(); return { x: r.left, y: r.top }; })`);
    const out: { session: string; x: number; y: number }[] = [];
    this.sessions.forEach((session, index) => {
      const rect = rects[index];
      if (rect !== undefined) out.push({ session, x: rect.x, y: rect.y });
    });
    return out;
  }

  async inFrame<T>(session: string, expression: string): Promise<T | null> {
    const call = this.tab.browser.send<{ result: { value?: T }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
    call.catch(() => undefined);
    const out = await Promise.race([call, sleep(8000).then(() => null)]).catch(() => null);
    return out === null || out.exceptionDetails !== undefined ? null : (out.result.value ?? null);
  }

  /** every button a finger could press that is not the app's own chrome: on the page, and inside each live app */
  async buttons(): Promise<readonly Btn[]> {
    const collect = String.raw`(() => [...document.querySelectorAll('button,[role=button],a[href],summary,[data-tap]')].filter((e) => !e.closest('.composer,.prompt,.bar,.transcript__panel,.ink-bar,.action,.voice,.composer__menu')).map((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { text: ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).trim().replace(/\s+/g, ' ').slice(0, 60), x: r.left, y: r.top, w: r.width, h: r.height, disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true', vis: r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.top < innerHeight }; }).filter((b) => b.vis))()`;
    const out: Btn[] = [];
    for (const b of await this.tab.eval<Omit<Btn, 'where'>[]>(collect)) out.push({ ...b, where: 'page' });
    for (const frame of await this.frames()) {
      const found = await this.inFrame<Omit<Btn, 'where'>[]>(frame.session, collect);
      for (const b of found ?? []) out.push({ ...b, x: b.x + frame.x, y: b.y + frame.y, where: 'app' });
    }
    return out;
  }

  /** everything readable: the page's words and each app's */
  async text(): Promise<string> {
    const parts = [await this.tab.eval<string>(`document.body.innerText`)];
    for (const frame of await this.frames()) parts.push((await this.inFrame<string>(frame.session, `document.body.innerText`)) ?? '');
    return parts.join('\n');
  }

  async appCount(): Promise<number> {
    return (await this.frames()).length;
  }
}

class Hands {
  constructor(private readonly tab: Tab) {}

  /** a real stroke: the pointer goes down, along the points, up. A finger on a phone, a mouse on a desk. */
  async drag(points: readonly { readonly x: number; readonly y: number }[]): Promise<void> {
    const first = points[0];
    const last = points[points.length - 1];
    if (first === undefined || last === undefined) return;
    const { tab } = this;
    if (tab.mobile) {
      await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
      for (const point of points.slice(1)) {
        await tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
        await sleep(12);
      }
      await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, pointerType: 'mouse' });
      await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
      for (const point of points.slice(1)) {
        await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'left', buttons: 1, pointerType: 'mouse' });
        await sleep(12);
      }
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    }
    await sleep(120);
  }

  async arrow(name: 'ArrowRight' | 'ArrowLeft'): Promise<void> {
    const code = name === 'ArrowRight' ? 39 : 37;
    await this.tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await this.tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  }

  async attach(file: string): Promise<boolean> {
    const { tab } = this;
    const found = await tab.send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: `document.querySelector('input[type=file]')` });
    const objectId = found.result.objectId;
    if (objectId === undefined) return false;
    await tab.send('DOM.setFileInputFiles', { objectId, files: [file] });
    return true;
  }
}

/** A few paragraphs of public-domain prose (Thomas Paine, Common Sense, 1776) as a plain screenshot, and where each sentence is on it, as fractions of the picture. */
const PAINE = [
  'Some writers have so confounded society with government, as to leave little or no distinction between them; whereas they are not only different, but have different origins. Society is produced by our wants, and government by our wickedness; the former promotes our happiness positively by uniting our affections, the latter negatively by restraining our vices.',
  'Society in every state is a blessing, but government, even in its best state, is but a necessary evil; in its worst state an intolerable one: for when we suffer, or are exposed to the same miseries by a government, which we might expect in a country without government, our calamity is heightened by reflecting that we furnish the means by which we suffer.',
  'Government, like dress, is the badge of lost innocence; the palaces of kings are built on the ruins of the bowers of paradise. For were the impulses of conscience clear, uniform, and irresistibly obeyed, man would need no other lawgiver.',
];

async function renderDocument(tab: Tab, file: string): Promise<readonly { readonly x: number; readonly y: number; readonly w: number; readonly h: number }[]> {
  const html = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#fff"><div id=p style="width:760px;padding:36px 40px;font:21px/1.55 Georgia,serif;color:#111">${PAINE.map((text) => `<p style="margin:0 0 20px">${text.replace(/([^.;:]+[.;:]?)/g, '<span>$1</span>')}</p>`).join('')}</div>`;
  const { targetId } = await tab.browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await tab.browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => tab.browser.send<T>(method, params, sessionId);
  await call('Emulation.setDeviceMetricsOverride', { width: 840, height: 700, deviceScaleFactor: 1, mobile: false });
  await call('Page.enable');
  await call('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
  await sleep(800);
  const boxes = await call<{ result: { value: { x: number; y: number; w: number; h: number; W: number; H: number }[] } }>('Runtime.evaluate', {
    expression: `(() => { const p = document.getElementById('p').getBoundingClientRect(); return [...document.querySelectorAll('span')].flatMap((s) => [...s.getClientRects()].map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height, W: p.width + 0, H: p.bottom + 36 }))); })()`,
    returnByValue: true,
  });
  const height = Math.ceil(boxes.result.value.reduce((m, b) => Math.max(m, b.y + b.h), 0) + 36);
  const shot = await call<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 840, height, scale: 1 } });
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  await tab.browser.send('Target.closeTarget', { targetId }).catch(() => undefined);
  return boxes.result.value.map((b) => ({ x: b.x / 840, y: b.y / height, w: b.w / 840, h: b.h / height }));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Cases

interface Ctx {
  readonly args: Args;
  readonly c: Conversation;
  readonly tab: Tab;
  readonly frames: Frames;
  readonly hands: Hands;
  readonly screen: Args['screens'][number];
  readonly dir: string;
  readonly caseId: CaseId;
  /** brain lines per turn, for recording */
  readonly recorded: { match: string; script: string }[];
  /** the pieces this case really met, by the scripts and the page */
  readonly pieces: Set<string>;
  readonly notes: string[];
  readonly scripts: string[];
  lines: readonly { x: number; y: number; w: number; h: number }[];
  /** the turns the page has posted that the brain has not yet been waited for */
  n: number;
}

interface TurnDef {
  readonly name: string;
  readonly say?: string;
  /** a turn of its own: works the page, adds its checks, and says whether it started a brain turn */
  readonly run?: (ctx: Ctx, results: CheckResult[]) => Promise<{ readonly said: string; readonly brain: boolean; readonly note?: string }>;
  readonly expects: 'drawing' | 'structure' | 'chart' | 'screen' | 'interact' | 'any';
  /** pre-conditions (the typed words are not what is judged) */
  readonly checkPrompt?: boolean;
}

const sigOf = async (ctx: Ctx): Promise<string> => (await ctx.frames.text()).replace(/\b\d{1,2}:\d\d\b/g, '').replace(/\s+/g, ' ').trim();
const clockOf = async (ctx: Ctx): Promise<string | null> => /\b\d{1,2}:\d\d\b/.exec(await ctx.frames.text())?.[0] ?? null;

function add(ctx: Ctx, results: CheckResult[], check: string, verdict: Verdict, detail: string): void {
  results.push({ turn: ctx.c.current, check, verdict, detail });
}

const tapButton = async (ctx: Ctx, b: Btn): Promise<void> => ctx.tab.tap(b.x + b.w / 2, b.y + b.h / 2);

/** after a tap in a page or an app, a turn may have been opened by it (`conduit.send`, a choice): wait for it like any turn */
async function settle(ctx: Ctx, mark: number): Promise<boolean> {
  await sleep(900);
  if (ctx.tab.posted.length > mark) {
    await ctx.c.rest(true, true);
    return true;
  }
  return false;
}

const NEXT = /(^|\s)(next|continue|forward|go on|got it|›|»|→)(\s|$)/i;
const BACK = /(^|\s)(back|previous|prev|‹|«|←)(\s|$)/i;

async function findButton(ctx: Ctx, pattern: RegExp): Promise<Btn | null> {
  const all = await ctx.frames.buttons();
  return all.find((b) => !b.disabled && pattern.test(b.text.replace(/^\s*(next|back|previous)\s+(step)?/i, (m) => m).trim())) ?? null;
}

/** walks every stop there is by tapping Next (or a deck's arrow key); each stop is saved as a picture. Returns what was found. */
async function stepThrough(ctx: Ctx, name: string, max: number): Promise<{ readonly stops: number; readonly how: string; readonly buttons: string[]; readonly brainTurns: number }> {
  const seen = new Set<string>([await sigOf(ctx)]);
  let how = 'nothing to tap';
  const buttons: string[] = [];
  let brainTurns = 0;
  const deck = ctx.scripts.some((script) => /^deck\b/m.test(script));
  for (let i = 0; i < max; i += 1) {
    const mark = ctx.tab.posted.length;
    const next = await findButton(ctx, NEXT);
    if (next !== null) {
      how = `tapped "${next.text.slice(0, 20)}"${next.where === 'app' ? ' (in the live app)' : ''}`;
      buttons.push(next.text.slice(0, 20));
      await tapButton(ctx, next);
    } else if (deck) {
      how = 'arrow key on a deck';
      await ctx.hands.arrow('ArrowRight');
    } else break;
    if (await settle(ctx, mark)) brainTurns += 1;
    const sig = await sigOf(ctx);
    if (seen.has(sig)) break;
    seen.add(sig);
    await writeFile(join(ctx.dir, `${name}-stop${seen.size}.png`), Buffer.from((await ctx.tab.shot()).split(',')[1] ?? '', 'base64'));
  }
  return { stops: seen.size, how, buttons, brainTurns };
}

/** a document view (a lesson, a sheet's map) is laid over the stage: a visible, non-empty `.stage__document` */
const documentViewShown = (ctx: Ctx): Promise<boolean> => ctx.tab.eval<boolean>(`(() => { const d = document.querySelector('.stage__document'); if (!d) return false; const r = d.getBoundingClientRect(); const cs = getComputedStyle(d); return r.width > 40 && r.height > 40 && cs.visibility !== 'hidden' && cs.display !== 'none' && d.hidden !== true && (d.innerText || '').trim().length > 0; })()`);

/** a lesson/document takes the stage: the words of a document in the brain's lines and a view for them (the stage's own, or a player in a sandbox) */
const lessonShown = async (ctx: Ctx): Promise<boolean> => ctx.scripts.some((script) => /^(part|step|ask)\b/m.test(script)) && ((await documentViewShown(ctx)) || (await ctx.frames.appCount()) > 0);

/** a place to answer in: a field or a pen area, on the page or inside a player in a sandbox */
async function findField(ctx: Ctx): Promise<{ x: number; y: number; w: number; h: number; pen: boolean } | null> {
  const find = String.raw`(() => { const e = [...document.querySelectorAll('input:not([type=hidden]):not([type=file]),textarea,canvas')].filter((v) => { const r = v.getBoundingClientRect(); return r.width > 20 && r.height > 20 && !v.closest('.composer,.prompt,.ink-bar,.ink-stage,.voice,.transcript__panel'); }); const f = e.find((v) => v.tagName !== 'CANVAS') || e[0]; if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, pen: f.tagName === 'CANVAS' }; })()`;
  const here = await ctx.tab.eval<{ x: number; y: number; w: number; h: number; pen: boolean } | null>(find);
  if (here !== null) return here;
  for (const frame of await ctx.frames.frames()) {
    const found = await ctx.frames.inFrame<{ x: number; y: number; w: number; h: number; pen: boolean }>(frame.session, find);
    if (found !== null) return { ...found, x: found.x + frame.x, y: found.y + frame.y };
  }
  return null;
}

const stageWords = (answer: Answer): string => answer.live.filter((element) => element.kind === 'text' && element.phase !== 'struck' && element.phase !== 'leaving').map((element) => element.text).join(' ');

// ---- 1. explainer

const explainer: readonly TurnDef[] = [
  { name: 'heat-pump', say: 'explain how a heat pump works, step by step', expects: 'any', checkPrompt: true },
  {
    name: 'step-through',
    expects: 'any',
    run: async (ctx, results) => {
      const found = await stepThrough(ctx, 'explainer', 12);
      add(ctx, results, 'steps', found.stops >= 3 ? 'PASS' : 'FAIL', found.stops >= 3 ? `${found.stops} stops reached by tapping (${found.how})` : `asked for step by step, but only ${found.stops} stop reachable by tapping (${found.how}): the steps play on their own or sit on one frame, with nothing to tap through`);
      if (found.stops < 3) ctx.notes.push('explainer: no stops to tap through (steps are lines in one painted scene)');
      return { said: 'tap through every stop', brain: false };
    },
  },
  { name: 'winter', say: 'what happens in winter?', expects: 'any' },
];

// ---- 2. mock-up review with marks

interface Part {
  readonly id: string;
  readonly text: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

async function payButton(ctx: Ctx): Promise<Part | null> {
  const answer = await ctx.tab.call<Answer>('answer');
  for (const mock of answer.mockups) {
    const presses = mock.hits.filter((hit) => hit.action === 'press' && /^button/.test(hit.part));
    const named = presses.map((hit) => ({ hit, words: mock.words.filter((word) => word.owner === hit.id).map((word) => word.text).join(' ') }));
    const pick = named.find((entry) => /pay|order|checkout|buy|purchase|place|complete/i.test(entry.words)) ?? named[0];
    if (pick !== undefined) return { id: pick.hit.id, text: pick.words, box: pick.hit.box };
  }
  return null;
}

const mockup: readonly TurnDef[] = [
  { name: 'checkout', say: 'mock up a checkout page for a bakery', expects: 'screen', checkPrompt: true },
  {
    name: 'ring-and-ask',
    expects: 'any',
    run: async (ctx, results) => {
      const { tab, hands } = ctx;
      const target = await payButton(ctx);
      if (target === null) {
        add(ctx, results, 'marks-land', 'FAIL', 'no pay button on the mock-up to circle');
        return { said: 'ring the pay button', brain: false };
      }
      const before = target.box;
      // + menu, then Draw: real taps
      const plus = await tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', '.composer__plus');
      if (plus === null) throw new Error('no [+] on the page');
      await tab.tap(plus.x + plus.w / 2, plus.y + plus.h / 2);
      await sleep(300);
      const draw = await tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', '.composer__item[data-item="draw"]');
      if (draw === null) throw new Error('the [+] menu has no Draw');
      await tab.tap(draw.x + draw.w / 2, draw.y + draw.h / 2);
      await sleep(700);
      const open = await tab.eval<boolean>(`!!document.querySelector('.ink-stage') && !document.querySelector('.ink-stage').hidden`);
      add(ctx, results, 'pen-opens', open ? 'PASS' : 'FAIL', open ? 'Draw from the + menu opened the pen over the stage' : 'Draw did not open an ink area');
      if (!open) return { said: 'ring the pay button', brain: false };
      // a ring around the button, a little wider than it, once round
      const ringAround = (box: Part['box'], from: number): { x: number; y: number }[] => {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const rx = box.width / 2 + 16;
        const ry = box.height / 2 + 14;
        return Array.from({ length: 41 }, (_, i) => {
          const a = ((i + from) / 36) * Math.PI * 2 - Math.PI / 2;
          return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
        });
      };
      const inked = (): Promise<boolean> => tab.eval<boolean>(`[...document.querySelectorAll('.ink-bar button')].some((b) => b.getAttribute('aria-label') === 'Clear everything' && !b.disabled)`);
      await hands.drag(ringAround(before, 0));
      if (await inked()) add(ctx, results, 'pen-over-parts', 'PASS', 'a ring drawn round the button left a stroke on the pen');
      else {
        // the stage took the stroke: a pen that comes down on a live part of the mock-up presses the part instead of drawing
        const now = await tab.call<Answer>('answer');
        add(ctx, results, 'pen-over-parts', 'FAIL', `a ring started over a live part of the mock-up drew nothing: the stage took the pointer (${now.mockups[0]?.screen === undefined ? '' : `the mock-up is now on ${now.mockups[0].screen}`}); pen strokes over a mock-up's buttons and fields press them`);
        ctx.notes.push('mockup: the pen cannot draw starting on a live part of a mock-up (the stage takes the pointer)');
        const boxes = now.mockups.flatMap((mock) => mock.hits.map((hit) => hit.box));
        const again = await payButton(ctx);
        if (again === null) {
          add(ctx, results, 'marks-land', 'FAIL', 'the failed stroke changed the mock-up and the pay button is gone');
          return { said: 'ring the pay button', brain: false };
        }
        const free = [...Array(36).keys()].find((from) => {
          const start = ringAround(again.box, from)[0] as { x: number; y: number };
          return !boxes.some((box) => start.x >= box.x && start.x <= box.x + box.width && start.y >= box.y && start.y <= box.y + box.height);
        });
        await hands.drag(ringAround(again.box, free ?? 0));
      }
      const strokes = (await inked()) ? 1 : 0;
      const words = 'make this bigger and clearer';
      const field = await tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', '.ink-bar__words');
      if (field !== null) {
        await tab.tap(field.x + field.w / 2, field.y + field.h / 2);
        await tab.type(words);
      } else ctx.notes.push('mockup: the pen has no words field; the words go in the prompt box');
      const mark = tab.posted.length;
      const send = await tab.call<{ x: number; y: number; w: number; h: number; hidden: boolean } | null>('rect', '.ink-btn--send');
      if (send === null || send.hidden) {
        add(ctx, results, 'marks-land', 'FAIL', `no Send on the pen (strokes on the pen: ${strokes})`);
        return { said: words, brain: false };
      }
      let posted: (typeof tab.posted)[number] | undefined;
      for (let attempt = 0; attempt < 2 && posted === undefined; attempt += 1) {
        const at = (await tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', '.ink-btn--send')) ?? send;
        await tab.tap(at.x + at.w / 2, at.y + at.h / 2);
        for (let waited = 0; waited < 8000 && posted === undefined; waited += 250) {
          posted = tab.posted.slice(mark).find((turn) => turn.kind === 'prompt');
          if (posted === undefined) await sleep(250);
        }
      }
      if (posted === undefined) {
        add(ctx, results, 'marks-land', 'FAIL', `Send on the pen opened no turn (${await tab.eval<string>(`JSON.stringify({ send: (document.querySelector('.ink-btn--send') || {}).disabled, status: (document.querySelector('.ink-bar__status') || {}).textContent, words: (document.querySelector('.ink-bar__words') || {}).value })`)})`);
        return { said: words, brain: false };
      }
      let marks: { regions?: { id?: string; label?: string; strokes?: unknown[] }[]; strokes?: unknown[]; on?: unknown; outside?: string[] } = {};
      try {
        marks = (JSON.parse(posted.body) as { input?: { marks?: typeof marks } }).input?.marks ?? {};
      } catch {
        // an unreadable body is reported below
      }
      const regions = marks.regions ?? [];
      const hit = regions.filter((region) => JSON.stringify(region).includes(target.id) || (target.text !== '' && JSON.stringify(region).toLowerCase().includes(target.text.toLowerCase().slice(0, 12))));
      const detail = `${(marks.strokes ?? []).length} stroke(s), regions ${regions.length === 0 ? 'none' : regions.map((region) => region.id ?? region.label ?? '?').join(', ')}${marks.on === undefined ? ', no anchor' : ''}`;
      if (hit.length > 0) {
        add(ctx, results, 'marks-land', 'PASS', `the ring resolved to the pay button (${target.id} "${target.text.slice(0, 20)}"): ${detail}`);
        ctx.pieces.add('marks resolved to a part');
      } else add(ctx, results, 'marks-land', 'FAIL', `the ring around the pay button (${target.id} "${target.text.slice(0, 20)}") reached the brain as ${detail}: it does not say which thing was circled`);
      await ctx.c.rest(true, true);
      // the change must have landed on the circled thing
      const after = await payButton(ctx);
      if (after === null) add(ctx, results, 'change-lands', 'FAIL', 'after the change there is no pay button on the mock-up any more');
      else {
        const grew = (after.box.width * after.box.height) / Math.max(1, before.width * before.height);
        const same = after.id === target.id || after.text === target.text;
        add(ctx, results, 'change-lands', same && grew > 1.08 ? 'PASS' : 'FAIL', `${same ? 'the same button' : `a different part now (${after.id} "${after.text.slice(0, 16)}" for ${target.id})`}: ${Math.round(before.width)}x${Math.round(before.height)} -> ${Math.round(after.box.width)}x${Math.round(after.box.height)} (${grew.toFixed(2)}x)`);
      }
      return { said: words, brain: true };
    },
  },
];

// ---- 3. recipe

const recipe: readonly TurnDef[] = [
  { name: 'pancakes', say: 'walk me through making pancakes, with a timer for each step', expects: 'any', checkPrompt: true },
  {
    name: 'step-through',
    expects: 'any',
    run: async (ctx, results) => {
      const found = await stepThrough(ctx, 'recipe', 12);
      add(ctx, results, 'steps', found.stops >= 3 ? 'PASS' : 'FAIL', found.stops >= 3 ? `${found.stops} stops reached by tapping (${found.how})` : `only ${found.stops} stop reachable by tapping (${found.how})`);
      const text = await ctx.frames.text();
      const lesson = await lessonShown(ctx);
      add(ctx, results, 'not-taken-over', lesson ? 'FAIL' : 'PASS', lesson ? 'the lesson/document view is on screen for a recipe' : `the recipe is its own thing (${(await ctx.frames.appCount()) > 0 ? 'a live app' : 'painted'}), no lesson view${/\bask\b|hint/i.test(text) ? '' : ''}`);
      return { said: 'step through the recipe', brain: false };
    },
  },
  {
    name: 'timer-and-eggs',
    expects: 'any',
    run: async (ctx, results) => {
      // go back to about the middle, where a step with a timer is
      for (let i = 0; i < 3; i += 1) {
        const back = await findButton(ctx, BACK);
        if (back === null) break;
        const mark = ctx.tab.posted.length;
        await tapButton(ctx, back);
        await settle(ctx, mark);
      }
      const start = await findButton(ctx, /start|begin|timer|play|resume/i);
      if (start === null) add(ctx, results, 'timer', 'FAIL', `no button to start a timer (buttons: ${(await ctx.frames.buttons()).map((b) => b.text.slice(0, 14)).join(' | ')})`);
      else {
        const mark = ctx.tab.posted.length;
        await tapButton(ctx, start);
        await settle(ctx, mark);
        const first = await clockOf(ctx);
        await sleep(3600);
        const second = await clockOf(ctx);
        const counts = first !== null && second !== null && first !== second;
        add(ctx, results, 'timer', counts ? 'PASS' : 'FAIL', counts ? `the clock moved ${first} -> ${second} in about 3.6 s` : `no clock moved after "${start.text.slice(0, 20)}" (read ${first ?? 'none'} then ${second ?? 'none'})`);
        if (counts) ctx.pieces.add('timer');
      }
      // mid-way: ask by words while it runs
      const appsBefore = await ctx.frames.appCount();
      const reply: CheckResult[] = [];
      const sent = await ctx.c.say('how many eggs again?', reply);
      for (const r of reply) results.push(r);
      const note = sent ? await ctx.c.rest(true, true) : 'the turn never started';
      if (note !== '') add(ctx, results, 'rest-after-question', 'FAIL', note);
      const answer = await ctx.tab.call<Answer>('answer');
      const words = `${stageWords(answer)} ${await ctx.frames.text()}`;
      add(ctx, results, 'mid-answer', /\begg/i.test(words) ? 'PASS' : 'FAIL', /\begg/i.test(words) ? 'the answer about eggs is on stage' : 'nothing about eggs on stage after the question');
      const appsAfter = await ctx.frames.appCount();
      add(ctx, results, 'recipe-survives', appsAfter >= appsBefore && (appsBefore > 0 || appsAfter === 0) ? 'PASS' : 'FAIL', appsBefore > 0 ? (appsAfter >= appsBefore ? 'the live recipe is still on stage after the question' : 'the question replaced the recipe') : 'no live app to keep (painted recipe)');
      return { said: 'how many eggs again?', brain: true };
    },
  },
];

// ---- 4. document review

const documentCase: readonly TurnDef[] = [
  {
    name: 'attach',
    expects: 'any',
    checkPrompt: true,
    run: async (ctx, results) => {
      const file = join(ctx.dir, 'public-domain-text.png');
      ctx.lines = await renderDocument(ctx.tab, file);
      const ok = await ctx.hands.attach(file);
      await sleep(2500);
      add(ctx, results, 'attached', ok ? 'PASS' : 'FAIL', ok ? 'a screenshot of three paragraphs (Paine, Common Sense, public domain) went into the prompt bar' : 'no file input on the page');
      const reply: CheckResult[] = [];
      const said = 'highlight the three main claims and comment on the weakest';
      const sent = await ctx.c.say(said, reply);
      for (const r of reply) results.push(r);
      const turn = ctx.tab.posted[ctx.tab.posted.length - 1];
      let images = 0;
      try {
        images = ((JSON.parse(turn?.body ?? '{}') as { input?: { images?: string[] } }).input?.images ?? []).length;
      } catch {
        images = 0;
      }
      add(ctx, results, 'photo-sent', images > 0 ? 'PASS' : 'FAIL', images > 0 ? `${images} photo(s) went with the words` : 'the turn carried no photo');
      const note = sent ? await ctx.c.rest(true, true) : 'the turn never started';
      if (note !== '') add(ctx, results, 'rest-after-photo', 'FAIL', note);
      const answer = await ctx.tab.call<Answer>('answer');
      const pictures = answer.live.filter((element) => element.kind === 'picture' && element.phase !== 'struck' && element.phase !== 'leaving' && element.box.width > 80);
      const picture = pictures.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
      const view = await documentViewShown(ctx);
      add(ctx, results, 'document-view', picture !== undefined ? 'PASS' : 'FAIL', picture !== undefined ? `the document is on stage as a picture ${Math.round(picture.box.width)}x${Math.round(picture.box.height)}${view ? ' (and a document view)' : ''}; there is no text document kind, so highlights can only be shapes over a picture` : 'the photo of the document is not on stage');
      if (picture !== undefined) {
        // highlights: shapes laid over the picture's words
        const shapes = answer.live.filter((element) => element.kind === 'shape' && element.phase !== 'struck' && element.phase !== 'leaving');
        const over = shapes.filter((shape) => {
          const a = Math.max(0, Math.min(shape.box.x + shape.box.width, picture.box.x + picture.box.width) - Math.max(shape.box.x, picture.box.x)) * Math.max(0, Math.min(shape.box.y + shape.box.height, picture.box.y + picture.box.height) - Math.max(shape.box.y, picture.box.y));
          return a > 0.6 * shape.box.width * shape.box.height && shape.box.width * shape.box.height < 0.5 * picture.box.width * picture.box.height;
        });
        const onWords = over.filter((shape) => {
          const x0 = (shape.box.x - picture.box.x) / picture.box.width;
          const y0 = (shape.box.y - picture.box.y) / picture.box.height;
          const x1 = x0 + shape.box.width / picture.box.width;
          const y1 = y0 + shape.box.height / picture.box.height;
          let hit = 0;
          for (const line of ctx.lines) hit += Math.max(0, Math.min(x1, line.x + line.w) - Math.max(x0, line.x)) * Math.max(0, Math.min(y1, line.y + line.h) - Math.max(y0, line.y));
          return hit > 0.5 * (x1 - x0) * (y1 - y0);
        });
        add(ctx, results, 'highlights', over.length >= 3 && onWords.length >= 3 ? 'PASS' : 'FAIL', `${over.length} highlight shape(s) over the picture, ${onWords.length} of them on the document's words (three claims wanted)`);
        if (over.length > 0) ctx.pieces.add('highlights as shapes over a picture');
        const comment = answer.live.filter((element) => element.kind === 'text' && element.phase === 'on' && /weak|least|flaw|assum|claim|argu/i.test(element.text));
        add(ctx, results, 'comment', comment.length > 0 ? 'PASS' : 'FAIL', comment.length > 0 ? `a comment on the weakest is on stage ("${comment[0]?.text.slice(0, 50)}")` : 'no words on stage comment on a weakest claim');
      }
      else add(ctx, results, 'highlights', 'FAIL', 'no highlights: the document is not on stage, so nothing can be marked on its words (the brain wrote its own page about it)');
      return { said, brain: true };
    },
  },
  {
    name: 'select-and-ask',
    expects: 'any',
    run: async (ctx, results) => {
      const { tab } = ctx;
      const answer = await tab.call<Answer>('answer');
      const words = answer.live.filter((element) => element.kind === 'text' && element.phase === 'on' && element.text.split(' ').length >= 5 && element.box.width > 120).sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
      if (words === undefined) {
        add(ctx, results, 'selection', 'FAIL', 'no line of words on stage to select');
        return { said: 'select words', brain: false };
      }
      const y = words.box.y + Math.min(words.box.height / 2, 20);
      const a = { x: words.box.x + 6, y };
      const b = { x: words.box.x + Math.min(words.box.width - 6, 220), y };
      if (tab.mobile) {
        // a phone selects by a long press on a word (the selection handles then widen it)
        await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x + 30, y }] });
        await sleep(900);
        await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else await ctx.hands.drag([a, ...Array.from({ length: 10 }, (_, i) => ({ x: a.x + ((b.x - a.x) * (i + 1)) / 10, y }))]);
      await sleep(300);
      const picked = await tab.eval<string>(`String(window.getSelection())`);
      add(ctx, results, 'selection', picked.trim().length > 2 ? 'PASS' : 'FAIL', picked.trim().length > 2 ? `a drag over the words on stage selected "${picked.trim().slice(0, 40)}"` : 'dragging across words on stage selected nothing');
      const heldBy = await tab.eval<string>(`JSON.stringify((window.__stage && window.__stage.events ? window.__stage.events() : []).slice(-3))`).catch(() => '');
      const reply: CheckResult[] = [];
      const sent = await ctx.c.say('what does this mean?', reply);
      for (const r of reply) results.push(r);
      const turn = ctx.tab.posted[ctx.tab.posted.length - 1];
      const quote = picked.trim().slice(0, 12);
      const carried = picked.trim().length > 2 && turn !== undefined && (turn.body.includes(quote) || /selection|anchor|quote/i.test(turn.body));
      add(ctx, results, 'selection-carried', carried ? 'PASS' : 'FAIL', carried ? 'the turn carries the selected words' : `the turn "what does this mean?" went up with no sign of the selected words (body ${Math.round((turn?.body.length ?? 0) / 10) * 10} chars${heldBy === '' ? '' : ''}): the brain cannot know what "this" is`);
      const note = sent ? await ctx.c.rest(true, true) : 'the turn never started';
      if (note !== '') add(ctx, results, 'rest-after-select', 'FAIL', note);
      return { said: 'what does this mean?', brain: true };
    },
  },
];

// ---- 5. the worksheet (the flagship), from a photo the owner provides

const worksheet: readonly TurnDef[] = [
  {
    name: 'photo-and-map',
    expects: 'any',
    checkPrompt: true,
    run: async (ctx, results) => {
      if (ctx.args.photo === null || !existsSync(ctx.args.photo)) {
        add(ctx, results, 'photo', 'SKIP', 'no worksheet photo given (--photo <file> or SCENARIOS_WORKSHEET_PHOTO); it is never committed');
        return { said: '(no photo)', brain: false };
      }
      const ok = await ctx.hands.attach(ctx.args.photo);
      await sleep(3000);
      add(ctx, results, 'photo', ok ? 'PASS' : 'FAIL', ok ? 'the worksheet photo went into the prompt bar' : 'no file input');
      const reply: CheckResult[] = [];
      const said = 'help me with this';
      const sent = await ctx.c.say(said, reply);
      for (const r of reply) results.push(r);
      const note = sent ? await ctx.c.rest(true, true) : 'the turn never started';
      if (note !== '') add(ctx, results, 'rest-after-photo', 'FAIL', note);
      // the map: the document view over the stage
      const buttons = await ctx.frames.buttons();
      const view = await ctx.tab.eval<{ doc: boolean; inputs: number; text: string }>(`({ doc: (document.querySelectorAll('iframe').length > 0) || (() => { const d = document.querySelector('.stage__document'); if (!d) return false; const r = d.getBoundingClientRect(); return r.width > 40 && r.height > 40 && (d.innerText || '').trim().length > 0 && getComputedStyle(d).display !== 'none'; })(), inputs: document.querySelectorAll('.stage__document input, .stage__document textarea, [class*="lesson"] input, [class*="lesson"] textarea').length, text: (document.querySelector('.stage__document') || document.body).innerText.slice(0, 160) })`);
      add(ctx, results, 'map', view.doc ? 'PASS' : 'FAIL', view.doc ? `a document view is on screen (${buttons.length} things to tap): "${view.text.replace(/\s+/g, ' ').slice(0, 80)}"` : 'no document view (map of the sheet) appeared');
      if (view.doc) ctx.pieces.add('document view and map');
      return { said, brain: true };
    },
  },
  {
    name: 'question',
    expects: 'any',
    run: async (ctx, results) => {
      const buttons = await ctx.frames.buttons();
      const open = buttons.find((b) => /question|\b1\b|start|open|begin|first/i.test(b.text) && !b.disabled);
      if (open === undefined) {
        add(ctx, results, 'question', 'FAIL', `nothing to open a question with (buttons: ${buttons.map((b) => b.text.slice(0, 14)).join(' | ').slice(0, 120)})`);
        return { said: 'open the first question', brain: false };
      }
      const mark = ctx.tab.posted.length;
      await tapButton(ctx, open);
      const brain = await settle(ctx, mark);
      await sleep(800);
      const inputs = (await findField(ctx)) === null ? 0 : 1;
      add(ctx, results, 'question', inputs > 0 ? 'PASS' : 'FAIL', inputs > 0 ? `a question is open with ${inputs} place(s) to answer` : `tapped "${open.text.slice(0, 20)}" but found no place to answer`);
      return { said: `open: ${open.text.slice(0, 20)}`, brain };
    },
  },
  {
    name: 'wrong-try-and-help',
    expects: 'any',
    run: async (ctx, results) => {
      const tab = ctx.tab;
      const field = await findField(ctx);
      if (field === null) {
        add(ctx, results, 'wrong-try', 'FAIL', 'no field or pen area to try in');
        return { said: 'a wrong try', brain: false };
      }
      const mark = tab.posted.length;
      if (field.pen) {
        // a wrong numeral written with the pen: a plain 7
        const x = field.x + field.w * 0.35;
        const y = field.y + field.h * 0.3;
        await ctx.hands.drag([{ x, y }, { x: x + 40, y }, { x: x + 15, y: y + 70 }]);
        ctx.pieces.add('pen on a question');
      } else {
        await tab.tap(field.x + field.w / 2, field.y + field.h / 2);
        await tab.type('7');
        ctx.pieces.add('typed try');
      }
      const check = (await ctx.frames.buttons()).find((b) => /check|done|try|send|submit/i.test(b.text) && !b.disabled);
      if (check !== undefined) await tapButton(ctx, check);
      const before = await sigOf(ctx);
      const brain = await settle(ctx, mark);
      for (let waited = 0; waited < 25_000 && (await sigOf(ctx)) === before; waited += 1000) await sleep(1000);
      const text = (await ctx.frames.text()).replace(/\s+/g, ' ');
      await writeFile(join(ctx.dir, 'after-try.txt'), text);
      add(ctx, results, 'wrong-try', check !== undefined ? 'PASS' : 'FAIL', check !== undefined ? `tried ${field.pen ? 'with the pen' : 'by typing'} and pressed "${check.text.slice(0, 16)}"` : 'no way to check a try');
      const helped = (await sigOf(ctx)) !== before && /hint|not quite|try again|close|wrong|help|look at|think/i.test(text);
      add(ctx, results, 'help', helped ? 'PASS' : 'FAIL', helped ? 'the page answered the wrong try with a hint or a nudge' : 'no help appeared after a wrong try');
      return { said: 'a wrong try', brain };
    },
  },
];

const DEFS: Record<CaseId, { readonly turns: readonly TurnDef[]; readonly title: string }> = {
  explainer: { turns: explainer, title: 'Explainer with steps' },
  mockup: { turns: mockup, title: 'Mock-up review with marks' },
  recipe: { turns: recipe, title: 'Recipe / how-to' },
  document: { turns: documentCase, title: 'Document review' },
  worksheet: { turns: worksheet, title: 'Worksheet (flagship)' },
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Running one case on one screen

interface RunResult {
  readonly caseId: CaseId;
  readonly screen: string;
  readonly records: readonly TurnRecord[];
  readonly aborted: string | null;
  readonly sheet: string | null;
  readonly seconds: number;
  readonly pieces: readonly string[];
  readonly notes: readonly string[];
  readonly recorded: readonly { match: string; script: string }[];
}

/** the `legible` row: the ink of every word on stage against what is behind it */
function legible(ctx: Ctx, answer: Answer, results: CheckResult[]): void {
  const words = answer.live.filter((element: LiveElement) => element.kind === 'text' && element.phase === 'on' && element.opacity > 0.5 && element.box.width * element.box.height > 0);
  const faint = words.filter((element) => element.contrast > 0 && element.contrast < 4.5);
  const small = words.filter((element) => element.fontPx > 0 && element.fontPx < (ctx.screen.width < 600 ? 9 : 11.75));
  const problems: string[] = [];
  if (faint.length > 0) problems.push(`${faint.length} line(s) under 4.5:1 ("${faint[0]?.text.slice(0, 24)}" ${faint[0]?.contrast.toFixed(1)}:1)`);
  if (small.length > 0) problems.push(`${small.length} line(s) too small ("${small[0]?.text.slice(0, 24)}" ${small[0]?.fontPx.toFixed(1)} px)`);
  add(ctx, results, 'legible', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? `${words.length} lines of words, all at 4.5:1 or better and not tiny` : problems.join('; '));
}

async function runCase(args: Args, caseId: CaseId, screen: Args['screens'][number], url: string): Promise<RunResult> {
  const dir = join(args.out, caseId, screen.name);
  await mkdir(dir, { recursive: true });
  const started = Date.now();
  const tab = await Tab.open(screen.width, screen.height);
  const frames = new Frames(tab);
  const options: Options = { url, screens: [screen], out: args.out, turns: new Set(), timeoutMs: args.timeoutMs, parallel: false, demo: false, quiet: args.quiet, page: '', say: null, chat: 'off' };
  const c = new Conversation(tab, options, screen, dir);
  const ctx: Ctx = { args, c, tab, frames, hands: new Hands(tab), screen, dir, caseId, recorded: [], pieces: new Set(), notes: [], scripts: [], lines: [], n: 0 };
  let aborted: string | null = null;
  try {
    await tab.send('DOM.enable');
    await frames.start();
    await c.start();
    let n = 0;
    for (const def of DEFS[caseId].turns) {
      n += 1;
      c.current = n;
      const results: CheckResult[] = [];
      const began = Date.now();
      tab.drain();
      c.at(`turn ${n}: ${def.name}`);
      const step = { n, say: def.say ?? null, name: def.name, expects: def.expects } as const;
      c.note(`turn ${n} ${def.name}${def.say === undefined ? '' : `: ${def.say}`}`);
      let said = def.say ?? '';
      let restNote = '';
      let brain = true;
      const before = tab.posted.length;
      if (def.say !== undefined) {
        const sent = await c.say(def.say, results);
        restNote = sent ? await c.rest(true) : 'the turn never started';
      } else if (def.run !== undefined) {
        const out = await def.run(ctx, results);
        said = out.said;
        brain = out.brain;
        restNote = await c.rest(brain ? true : false, false);
      }
      c.add(results, 'rest', restNote === '' ? 'PASS' : 'FAIL', restNote === '' ? `at rest ${((Date.now() - began) / 1000).toFixed(0)} s after asking` : restNote);
      // the picture at rest, and the checks smoke already has
      const picture = await tab.shot();
      const file = `t${n}-${def.name}.png`;
      await writeFile(join(dir, file), Buffer.from(picture.split(',')[1] ?? '', 'base64'));
      const answer = await tab.call<Answer>('answer');
      await writeFile(join(dir, file.replace(/\.png$/, '.answer.json')), JSON.stringify({ ...answer, live: undefined }, null, 1));
      ctx.scripts.push(answer.script);
      for (const [pattern, piece] of [[/^deck\b/m, 'deck'], [/^app\b/m, 'live app'], [/^screen\b/m, 'screen kit'], [/^(part|step|ask)\b/m, 'document words (part/step/ask)'], [/^chart\b/m, 'chart'], [/^flow\b/m, 'flow'], [/layout=figure/, 'figure'], [/^pick\b.*steps/m, 'pick steps'], [/^hit\b/m, 'hit (pulse a part)'], [/^pic\b/m, 'pic (a photo on stage)'], [/^say\b[^|]*\bnear=/m, 'labels near parts']] as const) {
        if (pattern.test(answer.script)) ctx.pieces.add(piece);
      }
      if ((await frames.appCount()) > 0) ctx.pieces.add('live app in a sandbox');
      if (brain && answer.script !== '') ctx.recorded.push({ match: def.say ?? (tab.posted.slice(before).find((t) => t.kind === 'prompt')?.text ?? ''), script: answer.script });
      await c.checkAnswer(step, answer, picture, results);
      legible(ctx, answer, results);
      if (def.checkPrompt === true) await c.checkPrompt(results);
      await c.checkChrome(picture, results);
      c.checkOverlap(step, answer, results);
      await c.checkCutOff(answer, results);
      const logged = tab.drain();
      c.add(results, 'no-console-errors', logged.consoleErrors.length === 0 ? 'PASS' : 'FAIL', logged.consoleErrors.length === 0 ? 'nothing logged as an error' : `${logged.consoleErrors.length}: ${[...new Set(logged.consoleErrors.map((entry) => entry.text))].slice(0, 3).join(' | ')}`);
      c.add(results, 'no-failed-requests', logged.failedRequests.length === 0 ? 'PASS' : 'FAIL', logged.failedRequests.length === 0 ? 'every request answered' : `${logged.failedRequests.length}: ${[...new Set(logged.failedRequests.map((entry) => entry.text))].slice(0, 3).join(' | ')}`);
      c.records.push({ step, said, picture: file, seconds: (Date.now() - began) / 1000, results });
      for (const result of results) if (result.verdict === 'FAIL') c.note(`  FAIL ${result.check}: ${result.detail.slice(0, 220)}`);
    }
    // kept after reload
    {
      n += 1;
      c.current = n;
      const results: CheckResult[] = [];
      const before = stageWords(await tab.call<Answer>('answer'));
      const beforeDoc = await tab.eval<number>(`document.body.innerText.length`);
      const apps = await frames.appCount();
      c.note(`turn ${n} reload`);
      await tab.send('Page.reload');
      await waitFor('the page to be ready again', 60_000, async () => {
        const probe = await tab.call<{ ready: boolean }>('probe').catch(() => null);
        return probe !== null && probe.ready ? probe : null;
      });
      await tab.eval('window.__stage.ready');
      const note = await c.rest(null, false);
      for (let waited = 0; waited < 12_000; waited += 500) {
        if (stageWords(await tab.call<Answer>('answer')) !== '' || (await frames.appCount()) > 0 || (await documentViewShown(ctx))) break;
        await sleep(500);
      }
      const answer = await tab.call<Answer>('answer');
      const after = stageWords(answer);
      const words = before.split(/\s+/).filter((word) => word.length > 3);
      const kept = words.length === 0 ? 1 : words.filter((word) => after.includes(word)).length / words.length;
      const appsAfter = await frames.appCount();
      const docAfter = await tab.eval<number>(`document.body.innerText.length`);
      const ok = kept >= 0.6 || (apps > 0 && appsAfter >= apps) || (await documentViewShown(ctx)) || docAfter >= beforeDoc * 1.1;
      add(ctx, results, 'kept-after-reload', ok ? 'PASS' : 'FAIL', ok ? `after a reload the conversation is back (${Math.round(kept * 100)}% of the words on stage, ${appsAfter} live app(s))` : `after a reload the page came back without the conversation (${Math.round(kept * 100)}% of the words on stage, ${appsAfter} live app(s)${note === '' ? '' : `; ${note}`})`);
      const picture = await tab.shot();
      const file = `t${n}-reload.png`;
      await writeFile(join(dir, file), Buffer.from(picture.split(',')[1] ?? '', 'base64'));
      const logged = tab.drain();
      add(ctx, results, 'no-console-errors', logged.consoleErrors.length === 0 ? 'PASS' : 'FAIL', logged.consoleErrors.length === 0 ? 'nothing logged as an error' : `${logged.consoleErrors.length}: ${[...new Set(logged.consoleErrors.map((entry) => entry.text))].slice(0, 3).join(' | ')}`);
      c.records.push({ step: { n, say: null, name: 'reload', expects: 'any' }, said: 'reload the page', picture: file, seconds: 0, results });
      for (const result of results) if (result.verdict === 'FAIL') c.note(`  FAIL ${result.check}: ${result.detail.slice(0, 220)}`);
    }
  } catch (error) {
    aborted = `turn ${c.current}: ${error instanceof Error ? error.message : String(error)}`;
    process.stdout.write(`[${caseId} ${screen.name}] ABORTED ${aborted}\n`);
  }
  const sheet = await c.contactSheet().catch(() => null);
  await tab.close();
  return { caseId, screen: screen.name, records: c.records, aborted, sheet, seconds: (Date.now() - started) / 1000, pieces: [...ctx.pieces], notes: ctx.notes, recorded: ctx.recorded };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A server of our own for replays

async function startReplayServer(args: Args, caseFile: string): Promise<{ readonly url: string; readonly stop: () => Promise<void> }> {
  const data = join(args.out, 'replay-data', `${Date.now()}`);
  await mkdir(data, { recursive: true });
  const child: ChildProcess = spawn('pnpm', ['--filter', '@conduit/server', 'start'], {
    cwd: repoRoot(),
    env: { ...process.env, PORT: String(args.port), DATA_DIR: data, BRAIN: 'replay', REPLAY_CASE: caseFile, IMAGE_MODEL: 'none', PICTURES: 'openverse', AGENT_PERMITS: 'auto', NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${args.port}`;
  await waitFor('the replay server', 60_000, async () => ((await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) ? true : null));
  return {
    url,
    stop: async () => {
      child.kill('SIGTERM');
      await sleep(500);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Lint S0: scenario nouns in shared code may only go down

const S0_PATTERN = /worksheet|homework|young child|learner|for the parent/i;

async function countS0(): Promise<{ readonly lines: number; readonly files: number }> {
  let lines = 0;
  let files = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(ts|tsx|css|html|md)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        const found = (await readFile(path, 'utf8')).split('\n').filter((line) => S0_PATTERN.test(line)).length;
        if (found > 0) {
          lines += found;
          files += 1;
        }
      }
    }
  };
  for (const sub of ['language/src', 'server/src', 'web/src']) await walk(join(repoRoot(), sub));
  return { lines, files };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The report

const CHECK_ORDER = ['prompt-registers', 'rest', 'answer-on-stage', 'legible', 'prompt-readable', 'chrome-readable', 'no-overlap', 'nothing-cut-off', 'no-console-errors', 'no-failed-requests'];

function matrix(runs: readonly RunResult[]): string {
  const lines: string[] = ['| case | screen | turn | check | verdict | detail |', '| --- | --- | --- | --- | --- | --- |'];
  for (const run of runs) {
    for (const record of run.records) {
      const ordered = [...record.results].sort((a, b) => (CHECK_ORDER.indexOf(a.check) < 0 ? 99 : CHECK_ORDER.indexOf(a.check)) - (CHECK_ORDER.indexOf(b.check) < 0 ? 99 : CHECK_ORDER.indexOf(b.check)));
      for (const result of ordered) lines.push(`| ${run.caseId} | ${run.screen} | ${record.step.n} ${record.step.name} | ${result.check} | ${result.verdict} | ${result.detail.replace(/\|/g, '/').slice(0, 200)} |`);
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const runs: RunResult[] = [];
  let failures = 0;
  const live = args.mode !== 'replay';
  if (live) {
    const ok = await fetch(`${args.url}/api/health`).then((r) => r.ok, () => false);
    if (!ok) usage(`nothing answers at ${args.url}/api/health`);
  }
  process.stdout.write(`scenarios: ${args.mode}${live ? ` against ${args.url}` : ''}, cases ${args.only.join(', ')}, screens ${args.screens.map((s) => s.name).join(', ')}, pictures in ${args.out}\n`);
  for (const caseId of args.only) {
    const caseFile = join(caseId === 'worksheet' ? args.privateDir : publicDir, `${caseId}.json`);
    let server: Awaited<ReturnType<typeof startReplayServer>> | null = null;
    let url = args.url;
    if (!live) {
      if (!existsSync(caseFile)) {
        process.stdout.write(`[${caseId}] no recorded case at ${caseFile}: run it live with --record first\n`);
        failures += 1;
        continue;
      }
      server = await startReplayServer(args, caseFile);
      url = server.url;
    }
    try {
      let first = true;
      for (const screen of args.screens) {
        const run = await runCase(args, caseId, screen, url);
        runs.push(run);
        if (args.mode === 'record' && first && run.recorded.length > 0) {
          const target = caseId === 'worksheet' ? args.privateDir : publicDir;
          await mkdir(target, { recursive: true });
          await writeFile(join(target, `${caseId}.json`), JSON.stringify({ case: caseId, recordedAt: new Date().toISOString(), screen: screen.name, turns: run.recorded }, null, 1));
          process.stdout.write(`[${caseId}] recorded ${run.recorded.length} brain turn(s) to ${join(target, `${caseId}.json`)}\n`);
        }
        first = false;
      }
    } finally {
      if (server !== null) await server.stop();
    }
  }
  // lint S0
  const s0 = await countS0();
  const baselineFile = join(publicDir, 's0-baseline.json');
  let baseline: number | null = null;
  try {
    baseline = (JSON.parse(await readFile(baselineFile, 'utf8')) as { lines: number }).lines;
  } catch {
    baseline = null;
  }
  const s0Ok = baseline === null || s0.lines <= baseline;
  if (!s0Ok) failures += 1;
  process.stdout.write(`\nS0 (scenario nouns in shared code): ${s0.lines} lines in ${s0.files} files${baseline === null ? ' (no baseline recorded)' : `, baseline ${baseline}: ${s0Ok ? 'PASS' : 'FAIL, it went up'}`}\n`);
  for (const run of runs) {
    for (const record of run.records) for (const result of record.results) if (result.verdict === 'FAIL') failures += 1;
    if (run.aborted !== null) failures += 1;
  }
  const table = matrix(runs);
  await writeFile(join(args.out, 'scenarios.md'), `# Scenarios (${args.mode})\n\n${table}\n`);
  // compact table: case x screen x check (worst verdict across turns)
  process.stdout.write('\n');
  const checks = [...new Set(runs.flatMap((run) => run.records.flatMap((record) => record.results.map((result) => result.check))))];
  const order = [...CHECK_ORDER.filter((check) => checks.includes(check)), ...checks.filter((check) => !CHECK_ORDER.includes(check))];
  for (const run of runs) {
    const cells = order.map((check) => {
      const verdicts = run.records.flatMap((record) => record.results.filter((result) => result.check === check).map((result) => result.verdict));
      return verdicts.length === 0 ? '-' : verdicts.includes('FAIL') ? `FAIL${verdicts.filter((v) => v === 'FAIL').length > 1 ? `x${verdicts.filter((v) => v === 'FAIL').length}` : ''}` : verdicts.every((v) => v === 'SKIP') ? 'SKIP' : 'PASS';
    });
    process.stdout.write(`${run.caseId.padEnd(10)} ${run.screen.padEnd(9)} ${run.aborted === null ? '' : 'ABORTED '}${order.map((check, i) => `${check}=${cells[i]}`).filter((cell) => !cell.endsWith('=-')).join(' ')}\n`);
    process.stdout.write(`${''.padEnd(20)}pieces: ${run.pieces.join(', ') || 'none'}; ${run.seconds.toFixed(0)} s; sheet ${run.sheet ?? 'none'}\n`);
  }
  await writeFile(join(args.out, 'scenarios.json'), JSON.stringify({ mode: args.mode, at: new Date().toISOString(), failures, s0: { ...s0, baseline }, runs: runs.map((run) => ({ case: run.caseId, screen: run.screen, aborted: run.aborted, sheet: run.sheet, pieces: run.pieces, notes: run.notes, turns: run.records.map((record) => ({ turn: record.step.n, name: record.step.name, said: record.said, picture: record.picture, results: record.results })) })) }, null, 2));
  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL: ${failures} check${failures === 1 ? '' : 's'} red`}. Table in ${join(args.out, 'scenarios.md')}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void copyFile;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    process.stderr.write(`scenarios: stopped by ${signal}\n`);
    process.exit(2);
  });
}
main().catch((error: unknown) => {
  process.stderr.write(`scenarios: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(2);
});

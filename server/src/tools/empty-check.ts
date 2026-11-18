// pnpm check's fb-075 / fb-008 group: a turn that drew nothing is told so and asked once more (docs/feedback.md).
//
//   fb-075  the brain's first turn called the canvas tools four times and wrote "ok": 0 lines, an empty stage, after 38 s
//   fb-008  the brain described a slider in prose, drew nothing, and its markdown bullets were all refused
//
// The real server runs with its brain's CLI replaced by `empty-stand-in.mjs` (no model, no network), so the turn goes through the real conductor and the real claude-cli brain
// (the same warm process is spoken to twice). Each case is a session of its own on one server; the events are read from the stream the page reads:
//
//   retry     the first pass writes "ok" after four tool calls, the second writes real lines: the lines arrive, "Trying again…" came first, the brain was spoken to exactly twice
//             and told what happened
//   no-loop   the second pass writes nothing either: the turn ends done, with an honest message, with no third message to the brain
//   bullets   the first pass is prose and markdown bullets (the shape of the owner's turn): every bullet is said as text, none refused, emphasis gone; the turn was asked again
//             because nothing in it was drawn
//   plain     a turn that wrote a real line is never asked again, whatever else it wrote ("ok" too)
//
// Run by `pnpm check` (group `fb-075`, also `fb-008`) and standalone: `tsx empty-check.ts`; `tsx empty-check.ts --live "<prompt>"` is one real turn (costs money, see `emptyLive`).

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API, FULL_CAPABILITIES, LOOK_IDS, REFERENCE_SCREEN } from '@conduit/language';
import type { StageEvent } from '@conduit/language';
import { EMPTY_AGAIN } from '../domain/empty-turn';
import { sleep } from './explore-browser';
import { MEMORY_SCREEN, withTab } from './memory-check';
import type { LensScreen } from './lens-check';
import { startMathsServer } from './math-check';
import type { CheckResult } from './smoke';

interface Reply {
  readonly tools?: readonly string[];
  readonly text: string;
  /** the stand-in thinks this long before it writes */
  readonly delayMs?: number;
}

const CAR = ['scene layout=solo', 'say a1 | A car has an engine, four wheels, a body and a steering wheel.', 'say a2 | The engine turns the wheels, and the wheel steers them.'].join('\n');
const PLAN: Readonly<Record<string, readonly Reply[]>> = {
  // the owner's turn: four tool calls (canvas_fits three times, canvas_look once), then only "ok"
  retry: [{ tools: ['canvas_fits', 'canvas_fits', 'canvas_fits', 'canvas_look'], text: 'ok\n' }, { text: `${CAR}\n` }],
  // the second try writes nothing either (and the third reply is the one that must never be asked for)
  'no-loop': [{ tools: ['canvas_fits'], text: 'ok\n' }, { tools: ['canvas_look'], text: 'ok\n' }, { text: 'scene layout=solo\nsay z1 | asked a third time\n' }],
  // the owner's turn: prose that claims a slider, then a list in markdown; then the real lines
  bullets: [
    {
      text: [
        "I've added a time slider that runs from 0 to 2 years. Moving it puts each planet where it really is at that point in time.",
        'As you drag across the 2 years, you should see:',
        '- **Mercury** go round 8 times (about 88 days per orbit)',
        '- **Venus** go round about 3 times',
        '* _Earth_ goes round exactly twice',
        '1. **Uranus and Neptune** barely move',
        '',
      ].join('\n'),
    },
    { text: `${CAR}\n` },
  ],
  // a real line, and a refused one beside it: drawn, so never asked again
  plain: [{ text: `${CAR}\nok\n` }, { text: 'scene layout=solo\nsay z1 | asked again\n' }],
  // in a real page: the second try thinks for a while, and the status line says so over an empty stage
  page: [{ tools: ['canvas_fits', 'canvas_look'], text: 'ok\n' }, { delayMs: 2500, text: `${CAR}\n` }],
  // in a real page: the second try is empty too, and the person is told so
  'page-empty': [{ text: 'ok\n' }, { delayMs: 2000, text: 'ok\n' }],
};
const PHONE_SCREEN: LensScreen = { name: '390x844', width: 390, height: 844, dpr: 3 };
/** the cases a real page plays (the others are read from the stream) */
const IN_A_PAGE: readonly string[] = ['page', 'page-empty'];

interface Played {
  readonly events: readonly StageEvent[];
  /** what the brain was sent for this session, in order */
  readonly messages: readonly string[];
  readonly over: boolean;
}

/** A turn of a new session on the server, with the stream a page reads open: every event as it came (and when, in ms after the turn was asked), until the turn ends (or `waitMs`). */
async function ask(base: string, text: string, waitMs: number, settleMs = 700): Promise<{ readonly events: readonly StageEvent[]; readonly times: readonly number[]; readonly over: boolean; readonly session: string }> {
  const created = (await (await fetch(`${base}${API.sessions}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screen: REFERENCE_SCREEN, capabilities: FULL_CAPABILITIES, look: LOOK_IDS[0] }) })).json()) as { session: string };
  const stream = await fetch(`${base}${API.stream(created.session)}`);
  const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
  const events: StageEvent[] = [];
  const times: number[] = [];
  let asked = 0;
  let over = false;
  const reading = (async (): Promise<void> => {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const kind = /^event: (.*)$/m.exec(frame)?.[1] ?? '?';
        if (kind === 'heartbeat') continue;
        try {
          const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? '{}') as StageEvent;
          events.push(data);
          times.push(asked === 0 ? 0 : Date.now() - asked);
          if (data.type === 'end') over = true;
        } catch {
          // a frame that is not JSON is not one of ours
        }
      }
    }
  })();
  await sleep(300);
  asked = Date.now();
  // look and fix is off for the turn: only the second pass of a turn that drew nothing is under test, and a look would be a message more
  await fetch(`${base}${API.turns(created.session)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-conduit-review': 'off' }, body: JSON.stringify({ input: { kind: 'prompt', text } }) });
  for (let waited = 0; !over && waited < waitMs; waited += 100) await sleep(100);
  // anything the turn does after it has ended (a second end, a late line) is seen too
  await sleep(settleMs);
  await reader.cancel().catch(() => undefined);
  await reading.catch(() => undefined);
  return { events, times, over, session: created.session };
}

/** One turn of one session on the stand-in's server: the events the page would read, and what the brain was sent. */
async function play(base: string, name: string, dir: string, waitMs: number): Promise<Played> {
  const { events, over } = await ask(base, `show me the main parts of a car (case:${name})`, waitMs);
  const heard = readFileSync(join(dir, 'messages.jsonl'), 'utf8')
    .split('\n')
    .filter((row) => row !== '')
    .map((row) => JSON.parse(row) as { case: string; text: string })
    .filter((row) => row.case === name)
    .map((row) => row.text);
  return { events, messages: heard, over };
}

const linesOf = (played: Played): Extract<StageEvent, { type: 'line' }>[] => played.events.filter((event): event is Extract<StageEvent, { type: 'line' }> => event.type === 'line');
const spoken = (event: Extract<StageEvent, { type: 'line' }>): string => /\|\s*(.*)$/.exec(event.text)?.[1] ?? event.text;
const retryingAt = (played: Played): number => played.events.findIndex((event) => event.type === 'pass' && event.state === 'retrying');
const endOf = (played: Played): Extract<StageEvent, { type: 'end' }> | undefined => played.events.find((event): event is Extract<StageEvent, { type: 'end' }> => event.type === 'end');
const after = (played: Played): string[] => played.events.filter((event) => event.type === 'pass' && event.state === 'retrying').map(() => 'retrying');

/** Judges what the four cases came to; one result a case, each `FAIL` saying what was seen. */
export function judge(played: Readonly<Record<string, Played>>): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (check: string, problems: readonly string[], saw: string): void => {
    results.push({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? saw : problems.join('; ') });
  };
  const get = (name: string): Played => played[name] as Played;

  {
    const run = get('retry');
    const problems: string[] = [];
    const at = retryingAt(run);
    const lines = linesOf(run);
    const end = endOf(run);
    if (!run.over) problems.push('the turn never ended');
    if (!run.events.some((event) => event.type === 'reject' && event.raw.trim() === 'ok')) problems.push('the first try\'s "ok" was not refused as a line (the case is not the owner\'s)');
    if (at < 0) problems.push('the person was shown no "retrying" pass: the empty stage stood with no word of what was happening');
    if (!lines.some((line) => spoken(line).startsWith('A car has an engine'))) problems.push(`the second try's lines never reached the stage (${lines.length} lines)`);
    if (at >= 0 && run.events.slice(0, at).some((event) => event.type === 'line')) problems.push('a line came before the retry was said');
    if (run.messages.length !== 2) problems.push(`the brain was spoken to ${run.messages.length} times, not twice (one try and one retry)`);
    else if (!/Nothing was drawn/.test(run.messages[1] as string) || !/"ok"/.test(run.messages[1] as string)) problems.push(`the brain was not told plainly what happened: ${JSON.stringify((run.messages[1] as string).slice(0, 160))}`);
    if (end?.reason !== 'done' || end.message !== null) problems.push(`the turn did not end done and plain (${end?.reason}, ${JSON.stringify(end?.message)})`);
    add('fb-075-retry', problems, `the first try wrote "ok" after four tool calls: the person was told "retrying", the brain was told what happened, asked once, and its ${lines.length} lines reached the stage`);
  }

  {
    const run = get('no-loop');
    const problems: string[] = [];
    const end = endOf(run);
    if (!run.over) problems.push('the turn never ended');
    if (run.messages.length !== 2) problems.push(`the brain was spoken to ${run.messages.length} times, not twice: it must be asked once, never again`);
    if (linesOf(run).length > 0) problems.push(`lines arrived from a turn that wrote none (${linesOf(run).map(spoken).join(' / ')})`);
    if (after(run).length !== 1) problems.push(`"retrying" was said ${after(run).length} times, not once`);
    if (end?.reason !== 'done') problems.push(`the turn did not end done (${end?.reason}: ${end?.message})`);
    else if (end.message !== EMPTY_AGAIN) problems.push(`the end did not say honestly that nothing was drawn, even when asked again (${JSON.stringify(end.message)})`);
    if (run.events.filter((event) => event.type === 'end').length !== 1) problems.push('the turn ended more than once');
    add('fb-075-no-loop', problems, 'the second try wrote nothing either: the brain was asked once and not again, and the turn ended done with the message "nothing was drawn, even when asked again"');
  }

  {
    const run = get('bullets');
    const problems: string[] = [];
    const lines = linesOf(run);
    const said = lines.map(spoken);
    const refused = run.events.filter((event) => event.type === 'reject');
    for (const want of ['Mercury go round 8 times (about 88 days per orbit)', 'Venus go round about 3 times', 'Earth goes round exactly twice', 'Uranus and Neptune barely move']) {
      if (!said.includes(want)) problems.push(`the bullet "${want}" was not said as text (said: ${JSON.stringify(said.slice(0, 8))})`);
    }
    if (refused.length > 0) problems.push(`${refused.length} lines were refused (${refused.map((event) => (event.type === 'reject' ? event.raw.slice(0, 40) : '')).join(' | ')}): a bullet must be said, not refused`);
    if (said.some((words) => /\*\*|^[-*] |^\d\. |_Earth_/.test(words))) problems.push(`a marker or an emphasis mark was left in the words (${JSON.stringify(said.filter((words) => /\*\*|^[-*] |^\d\. |_Earth_/.test(words)))})`);
    const bullet = lines.find((line) => spoken(line).startsWith('Mercury'));
    if (bullet !== undefined && !bullet.issues.some((issue) => issue.code === 'said-as-text' && issue.severity === 'warn')) problems.push('the bullet carries no warning, so nothing says it was only said as text');
    // nothing of it was drawn, so the brain is asked again, once
    if (retryingAt(run) < 0) problems.push('a turn that only said prose and bullets was not asked again');
    if (run.messages.length !== 2) problems.push(`the brain was spoken to ${run.messages.length} times, not twice`);
    else if (!/only said as plain text/.test(run.messages[1] as string)) problems.push(`the brain was not told its lines were only said as text: ${JSON.stringify((run.messages[1] as string).slice(0, 200))}`);
    if (!said.includes('A car has an engine, four wheels, a body and a steering wheel.')) problems.push('the retry\'s lines never arrived');
    add('fb-008-bullets', problems, `${said.filter((words) => /^(Mercury|Venus|Earth|Uranus)/.test(words)).length} bullets were said as text (marker and emphasis off, none refused), then, since nothing was drawn, the brain was asked once more and its lines arrived`);
  }

  {
    const run = get('plain');
    const problems: string[] = [];
    if (!run.over) problems.push('the turn never ended');
    if (run.messages.length !== 1) problems.push(`a turn that drew something was spoken to ${run.messages.length} times`);
    if (retryingAt(run) >= 0) problems.push('"retrying" was said for a turn that drew');
    if (!run.events.some((event) => event.type === 'reject' && event.raw.trim() === 'ok')) problems.push('the stray "ok" was not refused (the case is not what it says)');
    add('fb-075-plain-not-retried', problems, 'a turn that wrote real lines (and one refused "ok") was not asked again');
  }
  return results;
}

/** What the real page showed of a turn: every text its status line and notice held (a new one when it changed), and how many elements stood on stage when it said "Trying again…" */
interface Seen {
  readonly texts: readonly string[];
  readonly onStageWhenRetrying: number | null;
  readonly ids: readonly string[];
}

/** One turn in a real page (headless Chrome at 1280x800) on the stand-in's server: the status line and the stage are read every 100 ms until the turn is over. */
async function inAPage(base: string, name: string, screen: LensScreen, dir: string, timeoutMs: number, over: (texts: readonly string[], ids: readonly string[]) => boolean): Promise<Seen> {
  const picture = async (tab: { shot(): Promise<string> }, when: string): Promise<void> => writeFileSync(join(dir, `fb-075-${name}-${screen.name}-${when}.png`), Buffer.from((await tab.shot()).replace(/^data:image\/png;base64,/, ''), 'base64'));
  return withTab(base, screen, dir, timeoutMs, async (tab, live) => {
    const texts: string[] = [];
    let onStageWhenRetrying: number | null = null;
    await tab.eval<string>(`window.__stage.prompt(${JSON.stringify(`show me the main parts of a car (case:${name})`)})`);
    for (let waited = 0; waited < 30_000; waited += 100) {
      // the message box's own words (a short routine status is shown there, where the person looks), then the pill and the notice above it
      const text = await tab.eval<string>(`[document.querySelector('.prompt__input')?.placeholder ?? '', ...[...document.querySelectorAll('.prompt__status, .prompt__notice')].map((n) => n.textContent.trim())].filter((t) => t !== '' && t !== 'Ask anything').join(' | ')`);
      if (text !== '' && texts[texts.length - 1] !== text) texts.push(text);
      if (onStageWhenRetrying === null && /Trying again…/.test(text)) {
        onStageWhenRetrying = (await live()).length;
        await picture(tab, 'retrying');
      }
      const ids = (await live()).map((element) => element.id);
      if (over(texts, ids)) {
        await sleep(400);
        await picture(tab, 'end');
        return { texts, onStageWhenRetrying, ids: (await live()).map((element) => element.id) };
      }
      await sleep(100);
    }
    return { texts, onStageWhenRetrying, ids: (await live()).map((element) => element.id) };
  });
}

/** What the person saw: "Trying again…" over an empty stage and then the lines; and, when the second try is empty too, the honest words */
export function judgePage(pages: Readonly<Record<string, Seen>>): CheckResult[] {
  const results: CheckResult[] = [];
  for (const [name, retry] of Object.entries(pages).filter(([name]) => name.startsWith('page@'))) {
    const problems: string[] = [];
    if (!retry.texts.some((text) => /Trying again…/.test(text))) problems.push(`the status line never said "Trying again…" (it said ${JSON.stringify(retry.texts)})`);
    else if (retry.onStageWhenRetrying !== 0) problems.push(`the stage held ${retry.onStageWhenRetrying} elements when "Trying again…" was said: the first try drew nothing`);
    if (!retry.ids.includes('a2')) problems.push(`the second try's lines never reached the stage (${JSON.stringify(retry.ids)})`);
    if (/Trying again…/.test(retry.texts[retry.texts.length - 1] ?? '')) problems.push('"Trying again…" was still the status line after the second try\'s lines had come');
    results.push({ turn: 0, check: `fb-075-page-trying-again ${name.slice(5)}`, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? 'in a real page the status line said "Trying again…" over the empty stage, and the lines came after it' : problems.join('; ') });
  }

  const empty = pages['page-empty'] as Seen;
  const bad: string[] = [];
  if (!empty.texts.some((text) => /Trying again…/.test(text))) bad.push(`the status line never said "Trying again…" (it said ${JSON.stringify(empty.texts)})`);
  if (!empty.texts.some((text) => text.includes(EMPTY_AGAIN))) bad.push(`the person was not told, in the status line, that nothing was drawn even when asked again (it said ${JSON.stringify(empty.texts)})`);
  if (empty.ids.length > 0) bad.push(`something stood on a stage that nothing was drawn on (${JSON.stringify(empty.ids)})`);
  results.push({ turn: 0, check: 'fb-075-page-honest', verdict: bad.length === 0 ? 'PASS' : 'FAIL', detail: bad.length === 0 ? 'in a real page a second try that was empty too left the status line saying "Nothing was drawn, even when asked again"' : bad.join('; ') });
  return results;
}

/** Runs the cases on one server whose brain's CLI is the stand-in, and judges them: the stream's, then (needs Chrome) a real page's. */
export async function emptyGroup(note: (text: string) => void = () => undefined, out: string = join(tmpdir(), 'conduit-empty-out'), timeoutMs = 90_000): Promise<CheckResult[]> {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-empty-check-'));
  const wrapper = join(dir, 'claude');
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(PLAN));
  writeFileSync(join(dir, 'messages.jsonl'), '');
  writeFileSync(wrapper, `#!/bin/sh\nSTAND_IN_DIR='${dir}' STAND_IN_PLAN='${join(dir, 'plan.json')}' exec '${process.execPath}' '${join(import.meta.dirname, 'empty-stand-in.mjs')}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  note('fb-075: starting a server whose brain is a stand-in CLI');
  // everything else that would speak to a model (the critic, the art studio, writing ahead, agent tools, look and fix) is off: only the turn's own brain is under test
  const server = await startMathsServer({ BRAIN: 'claude-cli', CLAUDE_BIN: wrapper, CLAUDE_MODEL: 'stand-in', CRITIC: 'off', ART_MAKER: 'off', AHEAD: 'off', AGENT: 'off', REVIEW: 'off', IMAGE_MODEL: 'none', VOICE: 'off' });
  try {
    const names = Object.keys(PLAN).filter((name) => !IN_A_PAGE.includes(name));
    const runs = await Promise.all(names.map(async (name) => [name, await play(server.url, name, dir, 40_000)] as const));
    // EMPTY_CHECK_DUMP=1: what each case saw, to be read
    if (process.env['EMPTY_CHECK_DUMP'] !== undefined) for (const [name, run] of runs) note(`--- ${name}\n${run.events.map((event) => JSON.stringify(event).slice(0, 230)).join('\n')}\nmessages: ${JSON.stringify(run.messages.map((message) => message.slice(-330)))}`);
    const results = judge(Object.fromEntries(runs));
    // a real page, one case after the other (each takes a Chrome of its own)
    note('fb-075: a real page');
    mkdirSync(out, { recursive: true });
    const pages: Record<string, Seen> = {};
    for (const screen of [MEMORY_SCREEN, PHONE_SCREEN]) pages[`page@${screen.name}`] = await inAPage(server.url, 'page', screen, out, timeoutMs, (_texts, ids) => ids.includes('a2'));
    pages['page-empty'] = await inAPage(server.url, 'page-empty', MEMORY_SCREEN, out, timeoutMs, (texts) => texts.some((text) => text.includes(EMPTY_AGAIN)));
    return [...results, ...judgePage(pages)];
  } catch (error) {
    return [{ turn: 0, check: 'fb-075-retry', verdict: 'FAIL', detail: `stopped: ${error instanceof Error ? error.message : String(error)}` }];
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `--live "<prompt>"`: ONE real turn (and a second, if the guard fires) on the owner's login: the real server and the real claude, BRAIN_THINKING=off, the canvas tools on,
 * `CLAUDE_MODEL`/`BRAIN_EFFORT` as given (opus, medium). Look and fix, the critic, the art studio and writing ahead are off, so the guard is the only thing that can add a call. Prints
 * what the page was sent, with times, and the turn's own log of what the brain was told and what it cost. Costs money: only when asked.
 */
async function emptyLive(prompt: string, logs: string): Promise<void> {
  const server = await startMathsServer({ BRAIN: 'claude-cli', CLAUDE_MODEL: process.env['CLAUDE_MODEL'] ?? 'opus', BRAIN_EFFORT: process.env['BRAIN_EFFORT'] ?? 'medium', BRAIN_THINKING: process.env['BRAIN_THINKING'] ?? 'off', CANVAS_TOOLS: 'on', CRITIC: 'off', ART_MAKER: 'off', AHEAD: 'off', AGENT: 'off', IMAGE_MODEL: 'none', VOICE: 'off', LOG_DIR: logs });
  try {
    const run = await ask(server.url, prompt, 300_000, 2_000);
    process.stdout.write(`\n${run.over ? 'the turn ended' : 'THE TURN DID NOT END IN TIME'}; what the page was sent (seconds after the question):\n`);
    run.events.forEach((event, at) => {
      if (event.type === 'typing' || event.type === 'doc' || event.type === 'hello') return;
      const detail = event.type === 'line' ? ` ${event.text.slice(0, 110)}${event.issues.length > 0 ? `   [${event.issues.map((issue) => `${issue.severity} ${issue.code}`).join(', ')}]` : ''}` : event.type === 'reject' ? ` ${JSON.stringify(event.raw.slice(0, 90))}` : event.type === 'pass' ? ` pass ${event.pass} ${event.state}${event.reason === null ? '' : `: ${event.reason}`}` : event.type === 'end' ? ` ${event.reason}${event.message === null ? '' : `: ${event.message}`}` : '';
      process.stdout.write(`${((run.times[at] ?? 0) / 1000).toFixed(1).padStart(7)} s  ${event.type}${detail}\n`);
    });
    // what the server's own log says of the brain: the messages it was sent, the tools it used, what each cost
    const file = join(logs, readdirSync(logs).filter((name) => name.endsWith('.jsonl')).sort().pop() ?? '');
    const rows = readFileSync(file, 'utf8').split('\n').filter((row) => row !== '').map((row) => JSON.parse(row) as Record<string, unknown>);
    process.stdout.write('\nthe turn\'s log:\n');
    for (const row of rows) {
      if (row['type'] === 'brief') process.stdout.write(`  brief (pass ${String(row['pass'])}, ${String(row['form'])}): ${JSON.stringify(String(row['text']).slice(-260))}\n`);
      else if (row['type'] === 'usage') process.stdout.write(`  usage (pass ${String(row['pass'])}): ${JSON.stringify(row['usage'])}\n`);
      else if (row['type'] === 'attention') process.stdout.write(`  canvas tools: ${String(row['calls'] ?? 0)} calls, ${String(row['toolMs'] ?? 0)} ms\n`);
      else if (row['type'] === 'pass' || row['type'] === 'end') process.stdout.write(`  ${row['type']} ${JSON.stringify({ ...row, type: undefined, at: undefined })}\n`);
    }
  } finally {
    await server.stop();
  }
}

if (process.argv[1] !== undefined && /empty-check\.ts$/.test(process.argv[1]) && process.argv.includes('--live')) {
  const prompt = process.argv.slice(2).filter((arg) => arg !== '--live').join(' ') || 'Show me the main parts of a car';
  const logs = mkdtempSync(join(tmpdir(), 'conduit-empty-live-'));
  void emptyLive(prompt, logs).then(() => process.exit(0), (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
} else if (process.argv[1] !== undefined && /empty-check\.ts$/.test(process.argv[1])) {
  void emptyGroup((text) => process.stdout.write(`${text}\n`)).then((results) => {
    for (const result of results) process.stdout.write(`${result.verdict} ${result.check}: ${result.detail}\n`);
    process.exit(results.every((result) => result.verdict === 'PASS') ? 0 : 1);
  });
}

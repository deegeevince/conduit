import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summaryOf } from '../src/explore';
const dir = process.argv[2] as string;
const answers = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.json') || f === 'index.json' || f === 'summary.json') continue;
  const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  answers.push(d.results ? d.results[0] : d);
}
const s = summaryOf({ run: 'x', pool: 'tune', battery: '', rubric: '', brain: 'x', model: 'x', samples: 1, spentUsd: 0 } as never, answers as never);
console.log(JSON.stringify(s.families, (k, v) => (k === 'bar' ? undefined : v), 1));
const diag = answers.filter((a: any) => ['structure'].includes(a.prompt.expects) || a.prompt.family === 'diagram');
const j = (xs: any[]) => xs.filter((a) => a.judge && a.judge.failure === null);
const fam = (name: string) => answers.filter((a: any) => (a.prompt.family ?? (a.prompt.expects === 'drawn' ? (a.prompt.information ? 'diagram' : 'mechanism') : a.prompt.expects)) === name);
for (const name of ['diagram', 'mechanism', 'chart', 'explorable', 'plain', 'type', 'motion', 'scene', 'pixels']) {
  const a = j(fam(name));
  if (a.length === 0) continue;
  const mean = a.reduce((t: number, x: any) => t + x.judge.coherence, 0) / a.length;
  console.log(name, 'n', a.length, 'coh', mean.toFixed(2), 'ge4', Math.round((100 * a.filter((x: any) => x.judge.coherence >= 4).length) / a.length) + '%', 'readable', Math.round((100 * a.filter((x: any) => !x.judge.textProblem).length) / a.length) + '%', 'labelsOK', Math.round((100 * a.filter((x: any) => !x.judge.wrongLabel).length) / a.length) + '%', 'correct', Math.round((100 * a.filter((x: any) => x.judge.correct).length) / a.length) + '%');
}
const rv = answers.filter((a: any) => a.review);
console.log('review', rv.length, 'fixed', rv.filter((a: any) => a.review.result === 'fixed').length, 'kept', rv.filter((a: any) => a.review.result === 'kept').length);
const gains = rv.filter((a: any) => a.review.before != null && a.review.after != null).map((a: any) => a.review.after - a.review.before);
console.log('gain mean', gains.length ? (gains.reduce((a: number, b: number) => a + b, 0) / gains.length).toFixed(2) : null, 'n', gains.length, 'worse', gains.filter((g: number) => g < 0).length);
const fl = rv.map((a: any) => a.review.firstLineMs).filter((x: any) => x != null).sort((a: number, b: number) => a - b);
const aw = rv.map((a: any) => a.review.addedWaitMs).sort((a: number, b: number) => a - b);
console.log('fix first line ms median', fl[Math.floor(fl.length / 2)], 'added wait median', aw[Math.floor(aw.length / 2)], 'p90', aw[Math.floor(aw.length * 0.9)]);
const vis = answers.map((a: any) => a.firstVisibleMs).filter((x: any) => x != null).sort((a: number, b: number) => a - b);
console.log('first visible median', vis[Math.floor(vis.length / 2)], 'worst', vis[vis.length - 1]);

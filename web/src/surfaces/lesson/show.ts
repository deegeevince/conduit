// STUB (WS3, `VISUAL` table): reads what a `show=` says into a picture to draw. The words are the plan's (section 3):
//
//   numberline 0..70 [tick=10] [mark=64] [hops=-10,-10,-10]
//   groups n=5 of=12 [parts=6,2,4] [start=1] [noun=vase] [thing=flower]
//   blocks tens=6 ones=4
//   bar parts=6,2,4          or          bar of=12 n=5
//   coins 50,20,5            (cents)
//   clock 3:30
//
// A `show` it cannot read draws nothing and the step's words still stand (never see nothing: the words are there).

import type { VisualSpec } from './types';

function numbers(text: string | undefined): number[] {
  return (text ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
}

export function parseShow(text: string | null): VisualSpec | null {
  if (text === null) return null;
  const words = text.trim().split(/\s+/);
  const kind = words.shift();
  const keyed = new Map<string, string>();
  const bare: string[] = [];
  for (const word of words) {
    const eq = word.indexOf('=');
    if (eq > 0) keyed.set(word.slice(0, eq), word.slice(eq + 1));
    else bare.push(word);
  }
  const num = (key: string, fallback: number): number => {
    const n = Number(keyed.get(key));
    return keyed.has(key) && Number.isFinite(n) ? n : fallback;
  };
  switch (kind) {
    case 'numberline': {
      const range = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/.exec(bare[0] ?? '');
      if (range === null) return null;
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!(to > from)) return null;
      const span = to - from;
      const tick = num('tick', span <= 30 ? 1 : span <= 120 ? 10 : Math.pow(10, Math.floor(Math.log10(span)) - 1));
      return { kind: 'numberline', from, to, tick: tick > 0 ? tick : 1, mark: keyed.has('mark') ? num('mark', from) : null, hops: numbers(keyed.get('hops')) };
    }
    case 'groups':
      return { kind: 'groups', groups: Math.max(1, num('n', 1)), of: Math.max(1, num('of', 1)), parts: numbers(keyed.get('parts')), start: Math.max(1, num('start', 1)), noun: keyed.get('noun') ?? 'group', thing: keyed.get('thing') ?? 'counter' };
    case 'blocks':
      return { kind: 'blocks', tens: Math.max(0, num('tens', 0)), ones: Math.max(0, num('ones', 0)) };
    case 'bar':
      return { kind: 'bar', of: Math.max(1, num('of', 1)), n: Math.max(1, num('n', 1)), parts: numbers(keyed.get('parts')) };
    case 'coins': {
      const coins = numbers(bare[0] ?? keyed.get('coins'));
      return coins.length === 0 ? null : { kind: 'coins', coins };
    }
    case 'clock': {
      const time = /^(\d{1,2}):(\d{2})$/.exec(bare[0] ?? '');
      return { kind: 'clock', minutes: time === null ? 0 : ((Number(time[1]) % 12) * 60 + Number(time[2])) % 720 };
    }
    default:
      return null;
  }
}

// A step's `show=` (WS3's `ShowSpec`: a visual, its span, its parameters as text) read into what a widget is given. A picture it cannot make
// (a numberline with no span) draws nothing and the step's words still stand.

import { numbersOf } from '@conduit/language';
import type { ShowSpec } from '@conduit/language';
import type { VisualSpec } from './types';

function num(args: Readonly<Record<string, string>>, key: string): number | null {
  const raw = Object.hasOwn(args, key) ? args[key] : undefined;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}
function list(args: Readonly<Record<string, string>>, key: string): readonly (number | null)[] {
  return numbersOf(Object.hasOwn(args, key) ? args[key] : undefined).map((n) => (n === null || Number.isFinite(n) ? n : null));
}
function known(values: readonly (number | null)[]): number[] {
  return values.filter((n): n is number => n !== null);
}

export function visualOf(show: ShowSpec | null): VisualSpec | null {
  if (show === null) return null;
  const a = show.args;
  switch (show.visual) {
    case 'numberline': {
      if (show.range === null) return null;
      const [from, to] = show.range;
      const span = to - from;
      const tick = num(a, 'step') ?? (span <= 30 ? 1 : span <= 120 ? 10 : 10 ** (Math.floor(Math.log10(span)) - 1));
      return { kind: 'numberline', from, to, tick: tick > 0 ? tick : 1, mark: num(a, 'mark'), hops: known(list(a, 'hops')) };
    }
    case 'groups': {
      const parts = known(list(a, 'parts'));
      const sum = parts.reduce((x, y) => x + y, 0);
      const each = num(a, 'each') ?? (sum > 0 ? sum : 1);
      return { kind: 'groups', count: Math.max(1, Math.min(12, num(a, 'count') ?? 1)), each: Math.max(1, Math.min(60, each)), parts: sum === each ? parts : [], label: Object.hasOwn(a, 'label') ? (a['label'] ?? '').replace(/_/g, ' ') : 'counters' };
    }
    case 'blocks':
      return { kind: 'blocks', tens: Math.max(0, Math.min(12, num(a, 'tens') ?? 0)), ones: Math.max(0, Math.min(19, num(a, 'ones') ?? 0)) };
    case 'bar':
      return { kind: 'bar', parts: list(a, 'parts'), total: num(a, 'total') };
    case 'coins': {
      const coins = known(list(a, 'coins'));
      return coins.length === 0 ? null : { kind: 'coins', coins, target: num(a, 'target') };
    }
    case 'ruler': {
      const mm = known(list(a, 'mm')).filter((n) => n >= 5 && n <= 300).slice(0, 6);
      return mm.length === 0 ? null : { kind: 'ruler', mm };
    }
    case 'grid': {
      const rows = (Object.hasOwn(a, 'cells') ? (a['cells'] ?? '') : '').split('/').filter((row) => row !== '');
      return rows.length === 0 ? null : { kind: 'grid', rows };
    }
    case 'clock': {
      const time = /^(\d{1,2}):(\d{2})$/.exec(Object.hasOwn(a, 'time') ? (a['time'] ?? '') : '');
      return { kind: 'clock', minutes: time === null ? 0 : ((Number(time[1]) % 12) * 60 + Number(time[2])) % 720 };
    }
  }
}

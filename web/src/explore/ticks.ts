// "Every tick label equals its tick" (quality bar, row 9), as far as the labels themselves can say it: a tick that reads NaN, two that read the
// same, numbers out of order or unevenly spaced, a different number of decimals on one axis. Pure; the engine's own ticks come from its probe.

const SUFFIX: Readonly<Record<string, number>> = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9, t: 1e12, tn: 1e12 };
const BAD = /nan|undefined|infinity|null|\[object/i;
const NUMBER = /^[-−+]?[$€£¥]?\s*(\d[\d,  ]*)(?:\.(\d+))?\s*(%|k|m|b|bn|t|tn)?$/i;

interface Reading {
  readonly value: number;
  readonly decimals: number;
}

/** The number a tick label says, with how many decimals it was written with; null when it is not a plain number. */
function readingOf(label: string): Reading | null {
  const found = NUMBER.exec(label.trim());
  if (found === null) return null;
  const whole = (found[1] ?? '').replace(/[,  ]/g, '');
  const fraction = found[2] ?? '';
  const unit = (found[3] ?? '').toLowerCase();
  const scale = unit === '' || unit === '%' ? 1 : (SUFFIX[unit] ?? 1);
  const magnitude = Number(`${whole}${fraction === '' ? '' : `.${fraction}`}`) * scale;
  if (!Number.isFinite(magnitude)) return null;
  const negative = /^[-−]/.test(label.trim());
  return { value: negative ? -magnitude : magnitude, decimals: fraction.length };
}

function sideProblems(side: string, labels: readonly string[]): string[] {
  const out: string[] = [];
  for (const label of labels) if (label.trim() === '' || BAD.test(label)) out.push(`${side}: a tick reads "${label.trim() === '' ? '(empty)' : label}"`);
  const repeated = labels.find((label, at) => labels.indexOf(label) !== at);
  if (repeated !== undefined) out.push(`${side}: "${repeated}" appears twice`);
  const readings = labels.map(readingOf);
  if (labels.length >= 2 && readings.every((reading): reading is Reading => reading !== null)) {
    const values = readings.map((reading) => reading.value);
    const direction = Math.sign((values[1] ?? 0) - (values[0] ?? 0));
    if (direction === 0 || values.some((value, at) => at > 0 && Math.sign(value - (values[at - 1] ?? 0)) !== direction)) out.push(`${side}: the ticks are not in order`);
    else if (values.length >= 3) {
      const steps = values.slice(1).map((value, at) => value - (values[at] ?? 0));
      const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
      if (steps.some((step) => Math.abs(step - mean) > Math.abs(mean) * 0.08)) out.push(`${side}: the ticks are not evenly spaced`);
    }
    if (new Set(readings.map((reading) => reading.decimals)).size > 1) out.push(`${side}: the ticks are written with different numbers of decimals`);
  }
  return out;
}

/** What is wrong with a chart's ticks as written, bottom axis then side; an empty list is a clean pair of axes. */
export function tickProblemsOf(ticks: { readonly x: readonly string[]; readonly y: readonly string[] }): string[] {
  return [...sideProblems('x', ticks.x), ...sideProblems('y', ticks.y)];
}

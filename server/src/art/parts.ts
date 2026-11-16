// Labels on the parts of a drawing (PLAN-art.md, step 7). The brain cannot know a sheet's part names, so it writes `near=fox1-tail` or
// `near=rocket1-fin`, and the server settles which part is meant: the one whose name matches best, else the figure itself.

/** Words that stand for each other in part names. */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  body: ['torso', 'trunk', 'belly', 'chest', 'hull'],
  torso: ['body', 'trunk', 'chest'],
  face: ['head', 'muzzle', 'snout'],
  head: ['face', 'skull'],
  nose: ['snout', 'muzzle'],
  tail: ['brush'],
  leg: ['foot', 'paw'],
  foot: ['paw', 'leg', 'shoe'],
  arm: ['hand'],
  hand: ['arm', 'paw'],
  wing: ['fin'],
  fin: ['wing'],
  window: ['porthole'],
  porthole: ['window'],
  door: ['entrance'],
  roof: ['top'],
  trunk: ['body', 'stem'],
  leaf: ['crown', 'foliage', 'canopy'],
  crown: ['leaf', 'canopy', 'foliage'],
  flame: ['fire', 'exhaust'],
  nosecone: ['cone', 'tip', 'nose'],
};

const wordsOf = (name: string): string[] => name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== '');
const stem = (word: string): string => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word);

/** How well a part's name (without the figure's id) suits a word: higher is better, 0 is no match. */
export function scorePart(part: string, word: string): number {
  const wanted = stem(word.toLowerCase());
  if (wanted === '') return 0;
  const have = wordsOf(part).map(stem);
  if (have.join('-') === wanted) return 100;
  if (have.includes(wanted)) return 80;
  if (wanted.length >= 3 && have.some((h) => h.length >= 3 && (h.includes(wanted) || wanted.includes(h)))) return 60;
  const alike = (SYNONYMS[wanted] ?? []).map(stem);
  if (alike.length > 0 && have.some((h) => alike.includes(h))) return 40;
  if (alike.length > 0 && have.some((h) => h.length >= 3 && alike.some((a) => a.length >= 3 && (h.includes(a) || a.includes(h))))) return 30;
  return 0;
}

/** The best part (a full id) of a figure for the word, or null when none suits. */
export function bestPart(group: string, parts: readonly string[], word: string): string | null {
  let best: string | null = null;
  let top = 0;
  for (const part of parts) {
    const name = part.startsWith(`${group}-`) ? part.slice(group.length + 1) : part;
    const score = scorePart(name, word);
    if (score > top) {
      top = score;
      best = part;
    }
  }
  return best;
}

/**
 * What `near=<id>` should point at. An id that is already on stage stays as it is (null). Otherwise `<figure>-<word>` is read against the figure's
 * parts; with no part to suit it is the figure itself; a placeholder still standing leaves the label as it is, to follow its part when the drawing arrives. Null also means: not about a drawn figure, so the line's
 * own rules apply.
 */
export function resolveNear(id: string, live: ReadonlySet<string>, figures: ReadonlyMap<string, readonly string[]>): string | null {
  if (live.has(id)) return null;
  for (let at = id.lastIndexOf('-'); at > 0; at = id.lastIndexOf('-', at - 1)) {
    const group = id.slice(0, at);
    const parts = figures.get(group);
    if (parts === undefined || !live.has(group)) continue;
    // a placeholder has no parts yet: a label that names one is left to follow it when the drawing arrives
    if (parts.length === 0) return null;
    return bestPart(group, parts.filter((part) => live.has(part)), id.slice(group.length + 1)) ?? group;
  }
  return null;
}

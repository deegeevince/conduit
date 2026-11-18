// How a journey's `tap | Brakes` finds a label by what its words say (fb-055). Pure: words in, a closeness out. The label is what the brain wrote against a part
// (`say callout near=x | brake disc`, a figure part's `label=`), and the person writing the journey does not know what the brain will call it: "Brakes" must find
// "brake disc", "brakes" and "Brake".

/** the lower-cased words of some text, without the marks between them */
export const norm = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'in', 'on', 'for', 'my', 'your', 'is']);

/** a plural as its singular: brakes to brake, boxes to box, bodies to body */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:s|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

const wordsOf = (text: string): string[] =>
  norm(text)
    .split(' ')
    .filter((word) => word !== '' && !STOP.has(word))
    .map(stem);

/**
 * How close a label is to what was asked for: 0 for the same words; otherwise 1 and a little more for each word the label has besides the asked ones, when every asked
 * word is in the label (a word is in it when they are the same, or one begins the other and is at least five letters long); -1 when a word is missing.
 */
export function likeness(label: string, wanted: string): number {
  if (norm(label) === norm(wanted)) return 0;
  const want = wordsOf(wanted);
  const have = wordsOf(label);
  if (want.length === 0 || have.length === 0) return -1;
  const found = (word: string): boolean => have.some((other) => other === word || (Math.min(other.length, word.length) >= 5 && (other.startsWith(word) || word.startsWith(other))));
  return want.every(found) ? 1 + (have.length - want.length) * 0.1 : -1;
}

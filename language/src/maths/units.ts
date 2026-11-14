// Units of measure, as exact ratios. A quantity is held in the base unit of its kind (metre, gram, litre, second, month, dollar, pound, euro) and
// shown in the unit it was written in. Two kinds never mix: 25 cm + 3 kg is a mistake and is said to be one. A month is not a fixed number of
// days, so months and days never convert; weeks, fortnights and days do.

import { q } from './rational';
import type { Q } from './rational';

export type Dim = 'length' | 'mass' | 'volume' | 'time' | 'month' | 'dollar' | 'pound' | 'euro';

export interface Unit {
  /** the unit as it is written after a number: `cm`, `kg`, `min`, `day` */
  readonly name: string;
  readonly dim: Dim;
  /** how many of the base unit one of these is */
  readonly factor: Q;
  /** money: the symbol that goes before the number (`$`), and for its small coin (`c`) the one that goes after */
  readonly symbol?: string;
  /** a word that takes an `s` when there is more than one */
  readonly plural?: boolean;
}

const KIND_NAMES: Readonly<Record<Dim, string>> = {
  length: 'a length',
  mass: 'a weight',
  volume: 'a volume',
  time: 'a time',
  month: 'a number of months',
  dollar: 'dollars',
  pound: 'pounds',
  euro: 'euros',
};

export function kindName(dim: Dim): string {
  return KIND_NAMES[dim];
}

const TABLE: Record<string, Unit> = {};

function add(words: readonly string[], unit: Unit): void {
  for (const word of words) TABLE[word] = unit;
}

const u = (name: string, dim: Dim, n: number, d = 1, rest: Partial<Unit> = {}): Unit => ({ name, dim, factor: q(n, d), ...rest });

add(['mm', 'millimetre', 'millimetres', 'millimeter', 'millimeters'], u('mm', 'length', 1, 1000));
add(['cm', 'centimetre', 'centimetres', 'centimeter', 'centimeters'], u('cm', 'length', 1, 100));
add(['m', 'metre', 'metres', 'meter', 'meters'], u('m', 'length', 1));
add(['km', 'kilometre', 'kilometres', 'kilometer', 'kilometers'], u('km', 'length', 1000));

add(['g', 'gram', 'grams', 'gramme', 'grammes'], u('g', 'mass', 1));
add(['kg', 'kilo', 'kilos', 'kilogram', 'kilograms', 'kilogramme', 'kilogrammes'], u('kg', 'mass', 1000));

add(['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters'], u('ml', 'volume', 1, 1000));
add(['cl', 'centilitre', 'centilitres', 'centiliter', 'centiliters'], u('cl', 'volume', 1, 100));
add(['l', 'litre', 'litres', 'liter', 'liters'], u('l', 'volume', 1));

add(['s', 'sec', 'secs', 'second', 'seconds'], u('s', 'time', 1));
add(['min', 'mins', 'minute', 'minutes'], u('min', 'time', 60));
add(['h', 'hr', 'hrs', 'hour', 'hours'], u('h', 'time', 3600));
add(['day', 'days'], u('day', 'time', 86400, 1, { plural: true }));
add(['week', 'weeks', 'wk', 'wks'], u('week', 'time', 604800, 1, { plural: true }));
add(['fortnight', 'fortnights'], u('fortnight', 'time', 1209600, 1, { plural: true }));

add(['month', 'months'], u('month', 'month', 1, 1, { plural: true }));
add(['year', 'years', 'yr', 'yrs'], u('year', 'month', 12, 1, { plural: true }));

add(['$', 'dollar', 'dollars'], u('$', 'dollar', 1, 1, { symbol: '$' }));
add(['c', '¢', 'cent', 'cents'], u('c', 'dollar', 1, 100, { symbol: '$' }));
add(['£', 'pound', 'pounds', 'quid'], u('£', 'pound', 1, 1, { symbol: '£' }));
add(['p', 'pence', 'penny', 'pennies'], u('p', 'pound', 1, 100, { symbol: '£' }));
add(['€', 'euro', 'euros'], u('€', 'euro', 1, 1, { symbol: '€' }));

/** The unit a word names, or null. Only whole words: `m` is a metre, `more` is not. */
export function unitOf(word: string): Unit | null {
  const key = word.toLowerCase().replace(/\.$/, '');
  return Object.hasOwn(TABLE, key) ? (TABLE[key] ?? null) : null;
}

/** Units too short to be words: they only count straight after a number (`5 m`), never on their own. */
export function isShortUnit(word: string): boolean {
  return word.length === 1 && /[a-z]/i.test(word);
}

/** Money units: a symbol before the number, and the small coin after it (`50c`, `75p`). */
export const isMoney = (unit: Unit): boolean => unit.dim === 'dollar' || unit.dim === 'pound' || unit.dim === 'euro';

export function majorUnit(dim: Dim): Unit | null {
  switch (dim) {
    case 'dollar':
      return TABLE['$'] ?? null;
    case 'pound':
      return TABLE['£'] ?? null;
    case 'euro':
      return TABLE['€'] ?? null;
    default:
      return null;
  }
}

/** Every unit that can be named, for the lexer to look words up and for tests to walk. */
export const UNIT_WORDS: readonly string[] = Object.keys(TABLE);

/** `1 day`, `3 days`, `1 min`, `2 min`: the unit as it reads after a number. */
export function unitLabel(unit: Unit, one: boolean): string {
  if (unit.plural === true) return one ? unit.name : `${unit.name}s`;
  return unit.name;
}

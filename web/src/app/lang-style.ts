// How a line of Series is coloured, for the pane on the page and for the pane in a film: one tokeniser and one palette, so the two read alike.
//
// Calm on purpose: the verb in the look's accent, the id in its ink, `key=` quiet and its value a step between, the `|` quiet and the words
// after it in ink. Every colour is held to 4.5:1 against the pane's own ground, whatever look is on stage.

import type { Colour } from '../contracts/frame';
import { FONTS } from '../fonts';
import { contrastRatio, mix } from '../looks/colour-math';

export type TokenRole = 'verb' | 'id' | 'key' | 'value' | 'bar' | 'words' | 'plain';

export interface Token {
  readonly role: TokenRole;
  readonly text: string;
}

/** `say c1 card size=l | the words`: the verb, then ids and `key=value` pairs, then (after ` | `) the words. Spaces are kept so a line can be set again exactly. */
export function tokenize(text: string): readonly Token[] {
  const bar = text.indexOf(' | ');
  const head = bar < 0 ? text : text.slice(0, bar);
  const tokens: Token[] = [];
  let seenVerb = false;
  for (const part of head.split(/( +)/)) {
    if (part === '') continue;
    if (/^ +$/.test(part)) tokens.push({ role: 'plain', text: part });
    else if (!seenVerb) {
      seenVerb = true;
      tokens.push({ role: 'verb', text: part });
    } else {
      const eq = part.indexOf('=');
      if (eq > 0) {
        tokens.push({ role: 'key', text: part.slice(0, eq + 1) });
        tokens.push({ role: 'value', text: part.slice(eq + 1) });
      } else tokens.push({ role: 'id', text: part });
    }
  }
  if (bar >= 0) {
    tokens.push({ role: 'bar', text: ' | ' });
    tokens.push({ role: 'words', text: text.slice(bar + 3) });
  }
  return tokens;
}

export interface Roles {
  readonly ground: Colour;
  readonly ink: Colour;
  readonly dim: Colour;
  readonly accent: Colour;
}

export interface PanePalette {
  readonly ground: Colour;
  readonly edge: Colour;
  readonly text: Record<TokenRole, Colour>;
  /** the line that is being drawn, and the line that is pointed at */
  readonly now: Colour;
  readonly pointed: Colour;
  /** "dropped: …" and "repaired: …" */
  readonly note: Colour;
}

/** The colour nearest `colour` on the way to `toward` that reads at `floor` against every one of `against`; if the way to `toward` never gets there (a look whose own ink is faint on its ground), the way to black or white, whichever reads best. */
function reading(colour: Colour, toward: Colour, against: readonly Colour[], floor: number): Colour {
  const worst = (candidate: Colour): number => Math.min(...against.map((ground) => contrastRatio(candidate, ground)));
  const ends = [toward, worst('#000000') >= worst('#ffffff') ? '#000000' : '#ffffff'];
  for (const end of ends) {
    for (let step = 0; step <= 20; step += 1) {
      const candidate = mix(colour, end, step / 20);
      if (worst(candidate) >= floor) return candidate;
    }
  }
  return ends[1] ?? toward;
}

export const PANE_CONTRAST = 4.5;

/** A palette that reads on the pane's ground, and on the two washes laid over it for the line being drawn and the line pointed at. A ground in the middle of the scale (a grey look) leaves little room: the washes are then laid lighter until the words read. */
export function paletteOf(roles: Roles): PanePalette {
  const ground = mix(roles.ground, roles.ink, 0.045);
  let palette: PanePalette | null = null;
  for (const strength of [1, 0.6, 0.35, 0.15, 0]) {
    const now = mix(ground, roles.accent, 0.16 * strength);
    const pointed = mix(ground, roles.accent, 0.28 * strength);
    const washes = [ground, now, pointed];
    const make = (colour: Colour): Colour => reading(colour, roles.ink, washes, PANE_CONTRAST);
    const ink = make(roles.ink);
    const dim = make(roles.dim);
    palette = {
      ground,
      edge: mix(ground, roles.ink, 0.16),
      text: { verb: make(roles.accent), id: ink, key: dim, value: make(mix(roles.accent, roles.ink, 0.55)), bar: dim, words: ink, plain: ink },
      now,
      pointed,
      note: dim,
    };
    if (Object.values(palette.text).every((colour) => washes.every((wash) => contrastRatio(colour, wash) >= PANE_CONTRAST))) return palette;
  }
  if (palette === null) throw new Error('no palette');
  return palette;
}

/** The pane's face: the app's own fixed-pitch one, so a character is a column on the page and in a film alike. */
export const MONO = { regular: FONTS['jetbrains-mono-400']?.family ?? 'monospace', bold: FONTS['jetbrains-mono-700']?.family ?? 'monospace' } as const;

let monoReady: Promise<void> | null = null;
/** Makes sure the pane's two faces are in the page's font set before anything is set in them. Never rejects: a face that will not load leaves the system's monospace. */
export function ensureMono(): Promise<void> {
  monoReady ??= Promise.all(
    ['jetbrains-mono-400', 'jetbrains-mono-700'].map(async (key) => {
      const face = FONTS[key];
      if (face === undefined) return;
      try {
        // `check` is true for a family nobody has registered (there is nothing to wait for), so ask the set whether the face is in it at all
        const known = [...document.fonts].some((candidate) => candidate.family.replace(/["']/g, '') === face.family);
        if (known) await document.fonts.load(`12px "${face.family}"`);
        else document.fonts.add(await new FontFace(face.family, `url(${face.url}) format("${face.format}")`).load());
      } catch {
        // the system's monospace stands in
      }
    }),
  ).then(() => undefined);
  return monoReady;
}

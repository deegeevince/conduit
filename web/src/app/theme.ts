import type { Colour } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';

interface Roles {
  readonly ground: Colour;
  readonly ink: Colour;
  readonly dim: Colour;
  readonly accent: Colour;
}

function luminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (match?.[1] === undefined) return 0;
  const value = parseInt(match[1], 16);
  const channel = (shift: number): number => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * A role the chrome writes in, held to a floor of contrast against the ground. A look is free to pick roles for what it draws
 * (an interface look's "ink" is the ink on its white screen, not on the dark room around it), but the bar is the owner's
 * controls and must read in every look: if the role is too close to the ground, it is pushed to the nearest end of the scale
 * that is readable (light on a dark ground, dark on a light one), keeping the look's own colour whenever it already reads.
 */
function readable(colour: string, ground: string, floor: number, quiet = false): string {
  if (contrast(colour, ground) >= floor) return colour;
  const light = luminance(ground) <= 0.18;
  const candidates = light ? (quiet ? ['#a8abb5', '#f2f0ea'] : ['#f2f0ea', '#ffffff']) : quiet ? ['#5d5a53', '#1c1a17'] : ['#1c1a17', '#000000'];
  return candidates.find((c) => contrast(c, ground) >= floor) ?? candidates[candidates.length - 1] ?? colour;
}

function rootFor(host: HTMLElement): HTMLElement {
  return host.closest<HTMLElement>('[data-theme-root]') ?? document.documentElement;
}

/** The chrome wears the colours of the look on stage, preset or invented. */
export function applyRoles(host: HTMLElement, roles: Roles): void {
  const target = rootFor(host);
  target.style.setProperty('--stage-ground', roles.ground);
  const ink = readable(roles.ink, roles.ground, 4.5);
  target.style.setProperty('--stage-ink', ink);
  // the quiet text is the status line and the control labels at small size: 4.5 against the ground, in a quieter colour than the ink
  target.style.setProperty('--stage-dim', readable(roles.dim, roles.ground, 4.5, true));
  target.style.setProperty('--stage-accent', readable(roles.accent, roles.ground, 3));
  target.style.colorScheme = luminance(roles.ground) > 0.4 ? 'light' : 'dark';
  if (target === document.documentElement) {
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', roles.ground);
  }
}

export function applyLook(host: HTMLElement, spec: LookSpec): void {
  applyRoles(host, spec.roles);
}

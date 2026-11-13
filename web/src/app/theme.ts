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

function rootFor(host: HTMLElement): HTMLElement {
  return host.closest<HTMLElement>('[data-theme-root]') ?? document.documentElement;
}

/** The chrome wears the colours of the look on stage, preset or invented. */
export function applyRoles(host: HTMLElement, roles: Roles): void {
  const target = rootFor(host);
  target.style.setProperty('--stage-ground', roles.ground);
  target.style.setProperty('--stage-ink', roles.ink);
  target.style.setProperty('--stage-dim', roles.dim);
  target.style.setProperty('--stage-accent', roles.accent);
  target.style.colorScheme = luminance(roles.ground) > 0.4 ? 'light' : 'dark';
  if (target === document.documentElement) {
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', roles.ground);
  }
}

export function applyLook(host: HTMLElement, spec: LookSpec): void {
  applyRoles(host, spec.roles);
}

// A colour with an alpha, as a canvas writes one. Pure.

import { parse } from '../../looks/colour-math';

export function rgba(colour: string, alpha: number): string {
  const [r, g, b] = parse(colour);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

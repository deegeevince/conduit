// The seven widgets, and the one function that draws a visual by its kind. Shared pieces (the context, `press`, `readout`) are in common.ts.

import { bar } from './bar';
import { blocks } from './blocks';
import { clock } from './clock';
import { coins } from './coins';
import type { WidgetCtx, Widgets } from './common';
import { groups } from './groups';
import { numberline } from './numberline';
import { ruler } from './ruler';
import type { VisualSpec } from '../types';

export const WIDGETS: Widgets = { numberline, groups, blocks, bar, coins, clock, ruler };

export function drawVisual(spec: VisualSpec, ctx: WidgetCtx): HTMLElement {
  switch (spec.kind) {
    case 'numberline':
      return numberline.draw(spec, ctx);
    case 'groups':
      return groups.draw(spec, ctx);
    case 'blocks':
      return blocks.draw(spec, ctx);
    case 'bar':
      return bar.draw(spec, ctx);
    case 'coins':
      return coins.draw(spec, ctx);
    case 'clock':
      return clock.draw(spec, ctx);
    case 'ruler':
      return ruler.draw(spec, ctx);
  }
}


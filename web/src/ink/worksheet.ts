// Worksheet mode: a picture (an uploaded photo, by its id and address) or a card, with ink over it, boxes to answer in and a scratch area.
//
// The view defines the boxes in the picture's own pixels (`regions`), and is told which box each stroke landed in (`onStroke`) and, at any time,
// `regionReport()`. The ink is kept in the picture's pixels, so it replays at any size. Sending is `ink.send` from `send.ts`; the toolbar here calls it.

import type { InkOn, InkRegionDef, InkSpace } from '@conduit/language';
import { createInk } from './layer';
import type { Ink, InkBackground, InkOptions } from './layer';
import { mountInkBar } from './toolbar';
import type { InkBar, InkBarOptions } from './toolbar';
import { sendInk } from './send';
import type { InkPort } from './send';

export interface WorksheetOptions extends Omit<InkOptions, 'background' | 'space' | 'placement' | 'regions'> {
  /** the picture or the card, and its own size: the units the boxes and the ink are in */
  readonly background: InkBackground;
  readonly space: InkSpace;
  /** answer boxes and a scratch area, in the picture's pixels */
  readonly regions?: readonly InkRegionDef[];
  readonly on?: InkOn;
  /** the toolbar; false for a view that has its own */
  readonly bar?: false | (Omit<InkBarOptions, 'onSend'> & { readonly onSend?: InkBarOptions['onSend'] });
  /** how a picture and a turn go up; with it the toolbar's Send works on its own */
  readonly port?: InkPort;
}

export interface Worksheet {
  readonly ink: Ink;
  readonly bar: InkBar | null;
  /** the element holding the picture and the ink (in the page's flow) */
  readonly element: HTMLElement;
  /** sends what is on the sheet as it is, with these words (`Check my working`) */
  send(words: string): Promise<void>;
  dispose(): void;
}

export function mountWorksheet(host: HTMLElement, options: WorksheetOptions): Worksheet {
  const wrap = host.ownerDocument.createElement('div');
  wrap.className = 'ink-sheet';
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  host.append(wrap);
  // the tools stay at the top of the screen while the sheet scrolls under them
  const tools = host.ownerDocument.createElement('div');
  tools.style.cssText = 'position:sticky;top:0;z-index:5';
  wrap.append(tools);
  const sheet = host.ownerDocument.createElement('div');
  sheet.style.cssText = 'position:relative;width:100%';
  wrap.append(sheet);
  const ink = createInk(sheet, { ...options, placement: 'flow' });
  const send = async (words: string): Promise<void> => {
    if (options.port === undefined) throw new Error('This sheet has nowhere to send to.');
    await sendInk(ink, options.port, { words });
  };
  let bar: InkBar | null = null;
  if (options.bar !== false) {
    const given = options.bar ?? {};
    bar = mountInkBar(tools, ink, { sendLabel: 'Check my working', words: true, ...given, onSend: given.onSend ?? send });
  }
  return {
    ink,
    bar,
    element: sheet,
    send,
    dispose() {
      bar?.dispose();
      ink.dispose();
      wrap.remove();
    },
  };
}

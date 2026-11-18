// A selection on the stage's text layer, as the exact pieces of the stage it covers. Small and apart on purpose: the
// anchor type is being designed elsewhere, and this is the one place that turns a DOM selection into it. `start` and `end` are character offsets
// into the element's whole text (its wrapped lines joined as `TextSpanView.text` joins them); `prefix` and `suffix` are up to 24 characters either side.

export interface TextAnchor {
  /** the element's id on stage */
  readonly element: string;
  /** the part of a structure it is (`cell:1:2`, `label`, `title`); absent for a whole element or a node */
  readonly part?: string;
  /** the structure a part or node belongs to, by key */
  readonly structure?: string;
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly start: number;
  readonly end: number;
}

const CONTEXT = 24;

export function selectionAnchors(root: HTMLElement, selection: Selection | null = window.getSelection()): TextAnchor[] {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return [];
  const range = selection.getRangeAt(0);
  const out: TextAnchor[] = [];
  for (const block of root.querySelectorAll<HTMLElement>('.stage__text-block')) {
    if (!range.intersectsNode(block)) continue;
    const lines = [...block.querySelectorAll<HTMLElement>('.stage__text-line')];
    const whole = lines.map((line) => line.textContent ?? '').join(block.dataset['role'] === 'code' ? '\n' : ' ');
    let from = Number.POSITIVE_INFINITY;
    let to = -1;
    for (const line of lines) {
      const node = line.firstChild;
      if (node === null || !range.intersectsNode(node)) continue;
      const text = node.textContent ?? '';
      const base = Number(line.dataset['start'] ?? 0);
      const a = range.startContainer === node ? range.startOffset : 0;
      const b = range.endContainer === node ? range.endOffset : text.length;
      if (b <= a) continue;
      from = Math.min(from, base + a);
      to = Math.max(to, base + b);
    }
    if (to < 0) continue;
    const part = block.dataset['part'];
    const structure = block.dataset['structure'];
    out.push({
      element: block.dataset['element'] ?? block.dataset['key'] ?? '',
      ...(part === undefined ? {} : { part }),
      ...(structure === undefined ? {} : { structure }),
      quote: whole.slice(from, to),
      prefix: whole.slice(Math.max(0, from - CONTEXT), from),
      suffix: whole.slice(to, to + CONTEXT),
      start: from,
      end: to,
    });
  }
  return out;
}

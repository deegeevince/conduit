import { LineAssembler, LineReader } from '@conduit/language';
import type { ParseResult } from '@conduit/language';
import type { BrainEvent } from './brain';

function toEvent(raw: string, result: ParseResult): BrainEvent | null {
  if (result.kind === 'line') return { type: 'line', line: result.line, issues: result.issues };
  if (result.kind === 'reject') return { type: 'reject', raw, issues: result.issues };
  return null;
}

/**
 * The edge between model output and the domain: text chunks of any size in,
 * parsed lines out, each one the moment its newline arrives. With `typing`, the unfinished line is also yielded after each chunk, for the pane
 * that shows the stream as it is written.
 */
export async function* brainEventsFromText(chunks: AsyncIterable<string>, definedStyles: Iterable<string> = [], typing = false): AsyncGenerator<BrainEvent> {
  const assembler = new LineAssembler();
  // One reader per turn: it remembers that a sprite is being written, so a bare row of cells is read as a row.
  const reader = new LineReader(definedStyles);
  for await (const chunk of chunks) {
    for (const raw of assembler.push(chunk)) {
      const event = toEvent(raw, reader.read(raw));
      if (event !== null) yield event;
    }
    if (typing && assembler.pending !== '') yield { type: 'typing', text: assembler.pending };
  }
  for (const raw of assembler.flush()) {
    const event = toEvent(raw, reader.read(raw));
    if (event !== null) yield event;
  }
}

/**
 * Turns a stream of text chunks into whole lines. A model's tokens do not
 * respect line boundaries, and a line is only actionable once it is complete.
 */
export class LineAssembler {
  private buffer = '';

  /** Returns every line completed by this chunk. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      lines.push(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
    }
    return lines;
  }

  /** Returns the unterminated last line, if any, and empties the buffer. Call when the stream ends. */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = '';
    return rest.trim() === '' ? [] : [rest];
  }
}

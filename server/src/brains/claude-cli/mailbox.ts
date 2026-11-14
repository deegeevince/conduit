// A one-way hand-off between something that produces events on its own clock and the generator that yields them.
//
// Agent mode needs it: while the model waits for the owner's yes, no text arrives, yet the stage must be told (`permission`) at once.
// A generator that only yields when the process speaks would hold that back for as long as the owner took, and the owner could not
// answer a question that had not been asked. So the process's events are pumped into a mailbox and the turn's generator drains it.

export class Mailbox<T> {
  private readonly items: T[] = [];
  private ended = false;
  private failure: { readonly error: unknown } | null = null;
  private waker: (() => void) | null = null;

  push(item: T): void {
    if (this.ended) return;
    this.items.push(item);
    this.wake();
  }

  /** No more is coming; what is already here is still yielded. */
  close(): void {
    this.ended = true;
    this.wake();
  }

  /** Ends it with an error, thrown by `drain` once what came before it has been yielded. */
  fail(error: unknown): void {
    if (this.ended) return;
    this.failure = { error };
    this.ended = true;
    this.wake();
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.ended) {
        if (this.failure !== null) throw this.failure.error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waker = resolve;
      });
    }
  }

  private wake(): void {
    const w = this.waker;
    this.waker = null;
    w?.();
  }
}

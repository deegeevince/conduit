// A pen answer to an ask on the stage: the work mode (web/src/app/work-mode.ts) says whether the pen has written anything and how to read it. While it
// has, Check is ready with the field empty, and pressing it reads the handwriting (a small Claude process, server side) and checks what was read, as if it
// had been typed; the words read are put in the field, so she sees what was understood. Nothing here knows how the reading is done.

export interface PenAnswer {
  /** whether the pen has written something that waits to be read */
  readonly has: () => boolean;
  /** reads it: the words written, or null (the person has been told why) */
  readonly read: () => Promise<string | null>;
}

let pen: PenAnswer | null = null;

export const setPen = (next: PenAnswer | null): void => {
  pen = next;
};
export const penReady = (): boolean => pen !== null && pen.has();
export const penRead = (): Promise<string | null> => (pen === null ? Promise.resolve(null) : pen.read());

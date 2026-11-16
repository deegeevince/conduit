// Palm rejection and who may draw. Pure policy over pointer facts; the layer asks it what to do with each pointer.
//
// The rules, in order of what a hand does on a tablet:
// 1. A pen (and a mouse) always draws. The pen's eraser end or barrel eraser button erases.
// 2. A touch is a finger or a palm. While a pen is in contact, hovering, or lifted less than `GRACE_MS` ago, a touch is ignored altogether
//    (a resting palm must neither draw nor drag the page).
// 3. A touch whose contact is bigger than a fingertip is a palm.
// 4. When the pen touches down while a touch is drawing, that touch was a palm after all: its stroke is thrown away.
// 5. Otherwise a touch draws only when no pen has ever been seen on this page (a phone, a finger-only desk): with a pen about, a finger pans and
//    scrolls what is under it and does not draw. `fingerDraws` fixes the choice either way.

export type PointerKind = 'pen' | 'touch' | 'mouse';

export interface PointerFacts {
  readonly kind: PointerKind;
  readonly id: number;
  /** milliseconds on the page's clock (`event.timeStamp`) */
  readonly time: number;
  /** the contact's width and height in CSS pixels, when the browser says (0 or 1 when it does not) */
  readonly width: number;
  readonly height: number;
  /** the pen's eraser end, or its eraser button */
  readonly eraser: boolean;
  readonly primaryButton: boolean;
}

export type Verdict =
  | { readonly act: 'draw'; readonly erase: boolean }
  /** moves what is under it (scroll, pan); draws nothing */
  | { readonly act: 'pan' }
  /** nothing: a palm, or a second hand while the pen is busy */
  | { readonly act: 'ignore'; readonly why: 'palm' | 'pen-busy' | 'button' };

export const GRACE_MS = 450;
/** a fingertip is about 10 mm, 50 CSS pixels on a tablet; a palm is several times that */
export const PALM_SIZE = 110;

export class PalmGuard {
  private penDown = new Set<number>();
  private penEverSeen = false;
  private penLastSeen = -Infinity;
  /** touches that are drawing now, so a pen arriving can cancel them */
  private drawingTouches = new Set<number>();

  constructor(private fingerDraws: 'auto' | boolean = 'auto') {}

  setFingerDraws(value: 'auto' | boolean): void {
    this.fingerDraws = value;
  }
  /** whether a finger draws right now */
  get fingerDrawing(): boolean {
    return this.fingerDraws === 'auto' ? !this.penEverSeen : this.fingerDraws;
  }
  get seenPen(): boolean {
    return this.penEverSeen;
  }
  get penInContact(): boolean {
    return this.penDown.size > 0;
  }

  /** The pen is near: hovering or moving, down or not. */
  penNear(time: number): void {
    this.penEverSeen = true;
    this.penLastSeen = time;
  }
  penLifted(id: number, time: number): void {
    this.penDown.delete(id);
    this.penLastSeen = time;
  }

  /** Whether a pen is at work or has only just left the screen: any touch now is a hand resting by it. */
  penBusy(time: number): boolean {
    return this.penDown.size > 0 || time - this.penLastSeen < GRACE_MS;
  }

  /** What `down` would decide for a pointer that is about to go down, with nothing recorded: the lens asks it about a finger to know whose it is. */
  peek(f: PointerFacts): Verdict {
    if (f.kind === 'pen') return { act: 'draw', erase: f.eraser };
    if (f.kind === 'mouse') return f.primaryButton ? { act: 'draw', erase: false } : { act: 'ignore', why: 'button' };
    if (this.penBusy(f.time)) return { act: 'ignore', why: 'pen-busy' };
    if (Math.max(f.width, f.height) > PALM_SIZE) return { act: 'ignore', why: 'palm' };
    return this.fingerDrawing ? { act: 'draw', erase: false } : { act: 'pan' };
  }

  /** Decides for a pointer that has just gone down. `cancel` lists touch pointers whose strokes must be thrown away (rule 4). */
  down(f: PointerFacts): { readonly verdict: Verdict; readonly cancel: readonly number[] } {
    const verdict = this.peek(f);
    if (f.kind === 'pen') {
      this.penNear(f.time);
      this.penDown.add(f.id);
      const cancel = [...this.drawingTouches];
      this.drawingTouches.clear();
      return { verdict, cancel };
    }
    if (verdict.act === 'draw' && f.kind === 'touch') this.drawingTouches.add(f.id);
    return { verdict, cancel: [] };
  }

  /** A move or an end of a touch already decided: a pen that has come close since turns a pan into nothing. */
  touchMayContinue(time: number): boolean {
    return this.penDown.size === 0 && time - this.penLastSeen >= 0;
  }

  released(id: number): void {
    this.drawingTouches.delete(id);
  }
}

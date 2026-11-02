// Type definitions for Crumple 1.0.0

export type CrumpleEvent = 'crumple' | 'pickup' | 'hover' | 'throw' | 'score' | 'miss' | 'restore' | 'restored';

/** A crumpled sheet. Treat it as an opaque handle: pass it back to discard() or restore(). */
export interface CrumpleBall {
  readonly el: HTMLElement;
  readonly state: 'crumple' | 'held' | 'hover' | 'free' | 'bin' | 'flyback';
}

export interface CrumpleOptions {
  /** Where the overlay is mounted. Default: document.body. */
  container?: HTMLElement | null;
  /** z-index of the overlay. Default: 1000. */
  zIndex?: number;
  /** Synthesized sound effects. Default: true. */
  sound?: boolean;
  /** 0 to 1: how much a near miss is bent toward the bin. Default: 0.5. */
  assist?: number;
  /** Gravity in px/s². Default: 3.3 x the viewport height. */
  gravity?: number | null;
  /** Ball radius in px while held. Default: based on the viewport. */
  ballSize?: number | null;
  /** 'glass' (frosted, default), 'light' (white steel) or 'dark' (black steel). */
  binTheme?: 'glass' | 'light' | 'dark';
  /** Apparent size of the bin at the back of the room, 1 = on the screen plane. Default: 0.5. */
  binDepth?: number;
  /** Seconds to crumple. Default: 0.72. */
  crumpleTime?: number;
  /** Colour of the back of the sheet, [r, g, b] from 0 to 1. Default: the element background, a bit darker. */
  paperBack?: [number, number, number] | null;
  /** The element's own shadow, so the swap to WebGL is invisible. */
  shadow?: { y?: number; blur?: number; alpha?: number; radius?: number };
  /** The backdrop that fades in behind the bin, or false. Default: { color: 'rgba(255,255,255,.6)', blur: 22 }. */
  stage?: { color: string; blur?: number } | false;
  /** Turns an element into a canvas. Default: window.modernScreenshot.domToCanvas. */
  snapshot?: ((el: HTMLElement, scale: number) => Promise<HTMLCanvasElement>) | null;
  /** true, false or 'auto' (follows prefers-reduced-motion). */
  reducedMotion?: boolean | 'auto';
  onCrumple?: (ball: CrumpleBall) => void;
  onThrow?: (ball: CrumpleBall, info: { vx?: number; vy?: number; auto?: boolean }) => void;
  onScore?: (ball: CrumpleBall) => void;
  onMiss?: (ball: CrumpleBall) => void;
}

export interface Crumple {
  /** Capture the element ahead of time, so the crumple starts on the first frame. */
  prepare(el: HTMLElement): Promise<HTMLCanvasElement>;
  /** Start crumpling under the pointer of a pointerdown event. */
  grab(el: HTMLElement, event: PointerEvent): Promise<CrumpleBall | null>;
  /** Keyboard path: crumple in place and make a perfect shot. */
  throwInto(el: HTMLElement): Promise<CrumpleBall | null>;
  /** Take a ball out of the bin without animation (a quiet undo). */
  discard(ball: CrumpleBall): void;
  /** The ball flies back out of the bin and unfolds into its element, which shows again. */
  restore(ball?: CrumpleBall): Promise<boolean>;
  /** Remove every ball and hide the bin. */
  clear(): void;
  destroy(): void;
  setSound(on: boolean): void;
  setAssist(value: number): void;
  on(name: CrumpleEvent, fn: (ball: CrumpleBall, info?: unknown) => void): () => void;
  off(name: CrumpleEvent, fn: (ball: CrumpleBall, info?: unknown) => void): void;
}

declare const CrumpleNS: {
  create(options?: CrumpleOptions): Crumple;
  readonly version: string;
};
export default CrumpleNS;

declare global {
  interface Window {
    Crumple: typeof CrumpleNS;
  }
}

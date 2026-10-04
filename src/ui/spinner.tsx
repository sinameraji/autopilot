import { performance } from "node:perf_hooks";
import { useSyncExternalStore } from "react";
import { Text } from "ink";

/**
 * Drop-in replacement for ink-spinner backed by one shared animation clock.
 *
 * ink-spinner gives every spinner its own setInterval, so N visible spinners
 * mean N separate Ink renders per tick. Here all spinners subscribe to a
 * single interval that exists only while at least one spinner is mounted, so
 * they advance in one React commit, and an idle UI has no timers at all.
 */

const FRAMES = {
  dots: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  dots2: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
  line: ["-", "\\", "|", "/"],
} as const;

export type SpinnerType = keyof typeof FRAMES;

export const ANIMATION_TICK_MS = 100;

let tick = 0;
let startedAt: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

/** Compute the clock tick from elapsed time so delayed callbacks don't slow the animation. */
export function animationTickAt(start: number, now: number): number {
  return Math.max(0, Math.floor((now - start) / ANIMATION_TICK_MS));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    tick = 0;
    startedAt = performance.now();
    timer = setInterval(() => {
      if (startedAt === null) return;
      const nextTick = animationTickAt(startedAt, performance.now());
      if (nextTick === tick) return;
      tick = nextTick;
      for (const l of listeners) l();
    }, ANIMATION_TICK_MS);
    timer.unref?.();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      startedAt = null;
    }
  };
}

const getTick = () => tick;

/** Number of mounted spinners. Zero means the animation clock is stopped. */
export function activeSpinnerCount(): number {
  return listeners.size;
}

export default function Spinner({ type = "dots" }: { type?: SpinnerType }) {
  const t = useSyncExternalStore(subscribe, getTick, getTick);
  const frames = FRAMES[type] ?? FRAMES.dots;
  return <Text>{frames[t % frames.length]}</Text>;
}

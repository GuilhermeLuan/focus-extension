export type HoldTimer = unknown;

export type HoldTimers = {
  setTimeout(callback: () => void, delayMs: number): HoldTimer;
  clearTimeout(timer: HoldTimer): void;
};

export type HoldControllerOptions = {
  now: () => number;
  timers: HoldTimers;
  onComplete: () => void;
  thresholdMs?: number;
};

export type HoldController = {
  pointerDown(button?: number): void;
  pointerUp(): void;
  pointerCancel(): void;
  pointerLeave(): void;
  blur(): void;
  keyDown(key: string, repeat?: boolean): void;
  keyUp(key: string): void;
  dispose(): void;
  progress(at?: number): number;
};

type HoldState = "idle" | "holding" | "completed";

const supportedKeys = new Set([" ", "Enter"]);

export function createHoldController(options: HoldControllerOptions): HoldController {
  const thresholdMs = options.thresholdMs ?? 2_000;
  let state: HoldState = "idle";
  let startedAt = 0;
  let timer: HoldTimer | undefined;
  let disposed = false;

  const clearScheduledTimer = () => {
    if (timer !== undefined) {
      options.timers.clearTimeout(timer);
      timer = undefined;
    }
  };

  const reset = () => {
    clearScheduledTimer();
    if (!disposed) state = "idle";
    startedAt = 0;
  };

  const completeWhenDue = () => {
    timer = undefined;
    if (disposed || state !== "holding") return;
    const remaining = thresholdMs - (options.now() - startedAt);
    if (remaining > 0) {
      timer = options.timers.setTimeout(completeWhenDue, remaining);
      return;
    }
    state = "completed";
    options.onComplete();
  };

  const begin = () => {
    if (disposed || state !== "idle") return;
    state = "holding";
    startedAt = options.now();
    timer = options.timers.setTimeout(completeWhenDue, thresholdMs);
  };

  return {
    pointerDown(button = 0) {
      if (button === 0) begin();
    },
    pointerUp: reset,
    pointerCancel: reset,
    pointerLeave: reset,
    blur: reset,
    keyDown(key, repeat = false) {
      if (supportedKeys.has(key) && !repeat) begin();
    },
    keyUp(key) {
      if (supportedKeys.has(key)) reset();
    },
    dispose() {
      clearScheduledTimer();
      disposed = true;
      state = "idle";
      startedAt = 0;
    },
    progress(at = options.now()) {
      if (state === "completed") return 1;
      if (state !== "holding") return 0;
      return Math.min(1, Math.max(0, (at - startedAt) / thresholdMs));
    }
  };
}

import { describe, expect, it, vi } from "vitest";
import { createHoldController, type HoldTimer } from "./hold";

function fakeTime() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    timers: {
      setTimeout(callback: () => void, delay: number): HoldTimer {
        const id = ++nextId;
        timers.set(id, { at: now + delay, callback });
        return id;
      },
      clearTimeout(timer: HoldTimer) {
        timers.delete(timer as number);
      }
    },
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pending: () => timers.size
  };
}

describe("createHoldController", () => {
  it("emits once exactly at two seconds and not at 1,999 ms", () => {
    const clock = fakeTime();
    const onComplete = vi.fn();
    const hold = createHoldController({ now: clock.now, timers: clock.timers, onComplete });

    hold.pointerDown(0);
    clock.advance(1_999);
    expect(onComplete).not.toHaveBeenCalled();
    expect(hold.progress()).toBeCloseTo(0.999);
    clock.advance(1);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(hold.progress()).toBe(1);
    clock.advance(10_000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it.each(["pointerUp", "pointerCancel", "pointerLeave", "blur", "dispose"])(
    "cancels and resets on %s before the threshold",
    (cancellation) => {
      const clock = fakeTime();
      const onComplete = vi.fn();
      const hold = createHoldController({ now: clock.now, timers: clock.timers, onComplete });
      hold.pointerDown(0);
      clock.advance(500);

      hold[cancellation as "pointerUp" | "pointerCancel" | "pointerLeave" | "blur" | "dispose"]();
      expect(hold.progress()).toBe(0);
      expect(clock.pending()).toBe(0);
      clock.advance(2_000);
      expect(onComplete).not.toHaveBeenCalled();
    }
  );

  it("supports Space and Enter while ignoring key repeat and keyup after completion", () => {
    const clock = fakeTime();
    const onComplete = vi.fn();
    const hold = createHoldController({ now: clock.now, timers: clock.timers, onComplete });

    hold.keyDown(" ");
    hold.keyDown(" ", true);
    hold.keyDown("Enter");
    expect(clock.pending()).toBe(1);
    clock.advance(2_000);
    hold.keyUp(" ");
    expect(onComplete).toHaveBeenCalledTimes(1);

    hold.keyDown("Escape");
    expect(clock.pending()).toBe(0);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThrottleLever, SHUTDOWN_HOLD_MS, type ThrottleLeverEngine, type ThrottleLeverView } from "../src/throttleLever";

/** A 114 px lever with a 14 px handle: 100 px of travel, idle's centre at y = 107. */
function mount(view: Partial<ThrottleLeverView> = {}, engineControl = true, combined = false) {
  const box = document.createElement("div");
  box.className = "flight-hud__slider-control flight-hud__slider-control--throttle";
  document.body.append(box);
  const onThrottleChange = vi.fn();
  const onStartHold = vi.fn();
  const onShutdown = vi.fn();
  const onPowerChange = vi.fn();
  const lever = createThrottleLever(box, {
    onThrottleChange,
    ...(engineControl ? { onStartHold, onShutdown } : {}),
    ...(combined ? { onPowerChange } : {}),
  });
  const slider = box.querySelector<HTMLElement>('[data-control="throttle"]')!;
  const handle = box.querySelector<HTMLElement>(".flight-throttle__handle")!;
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 14, 114));
  vi.spyOn(handle, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 14, 14));
  const output = box.querySelector("output")!;
  const show = (next: Partial<ThrottleLeverView>) => lever.update({ throttle: 0, engine: null, ...view, ...next });
  show({});
  return { box, slider, output, lever, show, onThrottleChange, onPowerChange, onStartHold, onShutdown };
}

const at = (value: number) => 107 - value * 100;
function pointer(target: Element, type: string, clientY: number, pointerId = 1) {
  target.dispatchEvent(new PointerEvent(type, { pointerId, clientY, button: 0, pointerType: "mouse", bubbles: true, cancelable: true }));
}
function key(target: Element, type: "keydown" | "keyup", name: string, repeat = false) {
  target.dispatchEvent(new KeyboardEvent(type, { key: name, repeat, bubbles: true, cancelable: true }));
}

const RUNNING: ThrottleLeverEngine = { state: "running", startProgress: 1 };
const STOPPED: ThrottleLeverEngine = { state: "stopped", startProgress: 0 };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("combined throttle and brake lever", () => {
  it("releases keyboard brakes when the host updates synchronously during the command", () => {
    const t = mount({}, false, true);
    t.onPowerChange.mockImplementation(command => t.show(command));
    key(t.slider, "keydown", "Home");
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 1 });
    key(t.slider, "keyup", "Home");
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 0 });
    expect(t.box.firstElementChild!.textContent).toBe("THR");
    expect(t.output.value).toBe("0%");
  });
  it("uses the upper 80% for throttle and lower 20% for brakes in atomic commands", () => {
    const t = mount({ engine: RUNNING }, true, true);
    expect(t.slider.style.getPropertyValue("--throttle-value")).toBe("0.2");
    pointer(t.slider, "pointerdown", at(0.6));
    expect(t.onPowerChange.mock.lastCall![0].throttle).toBeCloseTo(0.5, 9);
    expect(t.onPowerChange.mock.lastCall![0].brake).toBe(0);
    pointer(t.slider, "pointermove", at(0.1));
    expect(t.onPowerChange.mock.lastCall![0].throttle).toBe(0);
    expect(t.onPowerChange.mock.lastCall![0].brake).toBeCloseTo(0.5, 9);
    expect(t.box.firstElementChild!.textContent).toBe("BRK");
    expect(t.output.value).toBe("50%");
    expect(t.slider.getAttribute("aria-label")).toBe("Brakes");
    expect(t.slider.getAttribute("aria-valuetext")).toBe("Brakes, 50%");
    expect(t.slider.getAttribute("aria-valuemin")).toBe("-100");
    expect(t.slider.getAttribute("aria-valuenow")).toBe("-50");
    pointer(t.slider, "pointermove", at(0));
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 1 });
    pointer(t.slider, "pointermove", at(1));
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 1, brake: 0 });
    expect(t.box.firstElementChild!.textContent).toBe("THR");
    expect(t.output.value).toBe("100%");
    expect(t.onThrottleChange).not.toHaveBeenCalled();
  });

  it("shows the active host range and keeps afterburner out of the brake readout", () => {
    const t = mount({ engine: RUNNING, throttle: 0.5 }, true, true);
    expect(Number(t.slider.style.getPropertyValue("--throttle-value"))).toBeCloseTo(0.6, 9);
    expect(t.output.value).toBe("50%");
    t.show({ throttle: 0, brake: 0.75, afterburner: true });
    expect(Number(t.slider.style.getPropertyValue("--throttle-value"))).toBeCloseTo(0.05, 9);
    expect(t.output.value).toBe("75%");
    expect(t.box.dataset.afterburner).toBe("inactive");
    t.show({ throttle: 0, brake: 0 });
    expect(t.box.firstElementChild!.textContent).toBe("THR");
    expect(t.output.value).toBe("0%");
    expect(t.box.dataset.power).toBe("throttle");
  });

  it("holds to shut down at the idle detent but cancels that hold when pulled into brakes", () => {
    const t = mount({ engine: RUNNING }, true, true);
    pointer(t.slider, "pointerdown", at(0.2));
    expect(t.box.dataset.hold).toBe("shutdown");
    pointer(t.slider, "pointermove", at(0.1));
    expect(t.box.dataset.hold).toBeUndefined();
    expect(t.onPowerChange.mock.lastCall![0].brake).toBeCloseTo(0.5, 9);
    vi.advanceTimersByTime(SHUTDOWN_HOLD_MS);
    expect(t.onShutdown).not.toHaveBeenCalled();
    pointer(t.slider, "pointerup", at(0.1));
    t.show({ brake: 0 });
    pointer(t.slider, "pointerdown", at(0.2));
    vi.advanceTimersByTime(SHUTDOWN_HOLD_MS);
    expect(t.onShutdown).toHaveBeenCalledOnce();
  });

  it("never starts an engine hold while the brake handle is held", () => {
    const t = mount({ engine: RUNNING, brake: 0.5, keepBrakes: true }, true, true);
    pointer(t.slider, "pointerdown", at(0.1));
    vi.advanceTimersByTime(SHUTDOWN_HOLD_MS * 2);
    expect(t.onShutdown).not.toHaveBeenCalled();
    expect(t.box.dataset.hold).toBeUndefined();
    pointer(t.slider, "pointerup", at(0.1));
    t.show({ engine: STOPPED });
    key(t.slider, "keydown", " ");
    expect(t.onStartHold).not.toHaveBeenCalled();
    expect(t.output.value).toBe("50%");
    expect(t.slider.getAttribute("aria-valuetext")).toBe("Brakes, 50%. Engine off.");
  });

  it("applies and releases the brakes with the engine off, then starts from idle", () => {
    const t = mount({ engine: STOPPED, keepBrakes: true }, true, true);
    pointer(t.slider, "pointerdown", at(0));
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 1 });
    expect(t.onStartHold).not.toHaveBeenCalled();
    pointer(t.slider, "pointerup", at(0));
    t.show({ brake: 1 });
    expect(t.box.firstElementChild!.textContent).toBe("BRK");
    // The throttle range starts the engine at idle and releases the brakes atomically.
    pointer(t.slider, "pointerdown", at(0.2));
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 0 });
    expect(t.onStartHold).toHaveBeenLastCalledWith(true);
    pointer(t.slider, "pointermove", at(0.6));
    expect(t.onPowerChange.mock.lastCall![0].throttle).toBeCloseTo(0.5, 9);
    expect(t.onPowerChange.mock.lastCall![0].brake).toBe(0);
    pointer(t.slider, "pointerup", at(0.6));
    expect(t.onStartHold).toHaveBeenLastCalledWith(false);
    t.show({ throttle: 0.5, brake: 0 });
    expect(t.slider.style.getPropertyValue("--throttle-value")).toBe("0.2");
    expect(t.output.value).toBe("OFF");
  });

  it("crosses idle with the keyboard and allows only the brake range while stopped", () => {
    const t = mount({ engine: RUNNING }, true, true);
    key(t.slider, "keydown", "PageDown");
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 0.5 });
    key(t.slider, "keydown", "ArrowUp");
    expect(t.onPowerChange.mock.lastCall![0].brake).toBeCloseTo(0.45, 9);
    key(t.slider, "keydown", "PageUp");
    expect(t.onPowerChange.mock.lastCall![0].throttle).toBeCloseTo(0.0125, 9);
    key(t.slider, "keydown", "Home");
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 1 });
    key(t.slider, "keydown", "End");
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 1, brake: 0 });
    t.show({ engine: STOPPED });
    key(t.slider, "keydown", "End");
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 0 });
    key(t.slider, "keydown", "Home");
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 1 });
  });

  it("springs pointer and keyboard brakes back to idle by default", () => {
    const t = mount({ engine: RUNNING }, true, true);
    pointer(t.slider, "pointerdown", at(0));
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 1 });
    t.show({ brake: 1 });
    pointer(t.slider, "pointerup", at(0));
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 0 });
    expect(t.slider.style.getPropertyValue("--throttle-value")).toBe("0.2");
    expect(t.box.firstElementChild!.textContent).toBe("THR");
    // A delayed status still showing brakes cannot pull the spring back down.
    t.show({ brake: 1 });
    expect(t.output.value).toBe("0%");
    t.show({ brake: 0 });
    key(t.slider, "keydown", "Home");
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 1 });
    key(t.slider, "keyup", "Home");
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 0 });
  });

  it("keeps brakes on normal pointer and key release only when explicitly enabled", () => {
    const t = mount({ engine: RUNNING, keepBrakes: true }, true, true);
    pointer(t.slider, "pointerdown", at(0));
    t.show({ brake: 1 });
    pointer(t.slider, "pointerup", at(0));
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 1 });
    expect(t.output.value).toBe("100%");
    key(t.slider, "keydown", "ArrowUp");
    const beforeRelease = t.onPowerChange.mock.lastCall![0];
    key(t.slider, "keyup", "ArrowUp");
    expect(t.onPowerChange).toHaveBeenLastCalledWith(beforeRelease);
    expect(beforeRelease.brake).toBeCloseTo(0.95, 9);
  });

  it("clears brakes on cancellation, focus loss and explicit release even when retention is enabled", () => {
    const t = mount({ engine: RUNNING, keepBrakes: true }, true, true);
    for (const event of ["pointercancel", "lostpointercapture"]) {
      t.show({ brake: 0 });
      pointer(t.slider, "pointerdown", at(0));
      pointer(t.slider, event, at(0));
      expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 0 });
    }
    t.show({ brake: 0 });
    t.show({ brake: 0.5 });
    t.slider.dispatchEvent(new FocusEvent("blur"));
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 0 });
    t.show({ brake: 0 });
    key(t.slider, "keydown", "Home");
    t.lever.release();
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 0 });
  });

  it("releases retained brakes when the setting is turned off", () => {
    const t = mount({ engine: RUNNING, brake: 0.5, keepBrakes: true }, true, true);
    t.show({ brake: 0.5, keepBrakes: false });
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0, brake: 0 });
    expect(t.slider.style.getPropertyValue("--throttle-value")).toBe("0.2");
    expect(t.box.firstElementChild!.textContent).toBe("THR");
  });

  it("restores the original throttle when the host switches to another aircraft", () => {
    const t = mount({ engine: RUNNING, throttle: 0.5 }, true, true);
    pointer(t.slider, "pointerdown", at(0.6));
    t.show({ brakeRange: false, throttle: 0.5 });
    expect(t.box.dataset.brakeRange).toBe("false");
    expect(t.slider.getAttribute("aria-valuemin")).toBe("0");
    expect(t.slider.style.getPropertyValue("--throttle-value")).toBe("0.5");
    expect(t.slider.getAttribute("aria-valuetext")).toBe("50%");
    key(t.slider, "keydown", "PageUp");
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(0.6);
    expect(t.onPowerChange).not.toHaveBeenCalled();
  });
});

describe("afterburner detent", () => {
  /** A host that shows what the lever sends, as the HUD does a frame later. */
  function host(view: Partial<ThrottleLeverView>, combined = false) {
    const t = mount({ engine: RUNNING, afterburnerDetent: 0.99, ...view }, true, combined);
    t.onThrottleChange.mockImplementation(throttle => t.show({ throttle }));
    t.onPowerChange.mockImplementation(command => t.show(command));
    return t;
  }

  it("stops one drag at the detent, and a second push from there lights the afterburner", () => {
    const t = host({ throttle: 0.5 });
    pointer(t.slider, "pointerdown", at(0.5));
    pointer(t.slider, "pointermove", at(1));
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(0.99);
    expect(t.box.title).toBe("Afterburner detent. Let go and push again to light the afterburner.");
    pointer(t.slider, "pointerup", at(1));
    pointer(t.slider, "pointerdown", at(0.99));
    pointer(t.slider, "pointermove", at(1));
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(1);
    // Coming out is free, and so is going back within the press that started there.
    pointer(t.slider, "pointermove", at(0.4));
    expect(t.onThrottleChange.mock.lastCall![0]).toBeCloseTo(0.4, 9);
    pointer(t.slider, "pointermove", at(1));
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(1);
  });

  it("stops a tap on the track at the detent; the handle there then pushes through", () => {
    const t = host({ throttle: 0.5 });
    pointer(t.slider, "pointerdown", at(1));
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(0.99);
    pointer(t.slider, "pointerup", at(1));
    pointer(t.slider, "pointerdown", at(1));
    pointer(t.slider, "pointermove", at(1.05));
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(1);
  });

  it("stops a held key at the detent, and passes the next press", () => {
    const t = host({ throttle: 0.95 });
    key(t.slider, "keydown", "ArrowUp");
    for (let repeat = 0; repeat < 10; repeat++) key(t.slider, "keydown", "ArrowUp", true);
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(0.99);
    key(t.slider, "keyup", "ArrowUp");
    key(t.slider, "keydown", "ArrowUp");
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(1);
    key(t.slider, "keydown", "Home");
    key(t.slider, "keydown", "End");
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(0.99);
    key(t.slider, "keydown", "End");
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(1);
  });

  it("stops at the detent itself on the combined lever, not a rounding above it", () => {
    const t = host({ throttle: 0, brake: 0.5 }, true);
    pointer(t.slider, "pointerdown", at(0.1));
    pointer(t.slider, "pointermove", at(1));
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 0.99, brake: 0 });
    expect(t.output.value).toBe("99%");
    pointer(t.slider, "pointerup", at(1));
    pointer(t.slider, "pointerdown", at(0.2 + 0.99 * 0.8));
    pointer(t.slider, "pointermove", at(1));
    expect(t.onPowerChange).toHaveBeenLastCalledWith({ throttle: 1, brake: 0 });
  });

  it("stops the power chosen while holding to start at the detent", () => {
    const t = host({ engine: STOPPED });
    pointer(t.slider, "pointerdown", at(0));
    t.show({ engine: { state: "starting", startProgress: 0.5 } });
    pointer(t.slider, "pointermove", at(1));
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(0.99);
  });

  it("lets one drag through without a detent", () => {
    const t = host({ throttle: 0.5, afterburnerDetent: null });
    pointer(t.slider, "pointerdown", at(0.5));
    pointer(t.slider, "pointermove", at(1));
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(1);
  });
});

describe("throttle lever", () => {
  it("keeps command and actual throttle separate without sending input for telemetry", () => {
    const t = mount({ throttle: .8, actualThrottle: .2, engine: RUNNING });
    const marker = t.slider.querySelector<HTMLElement>(".flight-throttle__actual")!;
    expect(marker.hidden).toBe(false);
    expect(t.slider.style.getPropertyValue("--throttle-value")).toBe("0.8");
    expect(t.slider.style.getPropertyValue("--throttle-actual")).toBe("0.2");
    expect(t.slider.getAttribute("aria-valuetext")).toContain("80% commanded throttle; 20% actual throttle");
    const observer = new MutationObserver(() => {});
    observer.observe(t.box, { subtree: true, attributes: true, childList: true, characterData: true });
    t.show({ actualThrottle: .6 });
    const records = observer.takeRecords();
    expect(records.some(record => record.type === "childList" || record.type === "characterData")).toBe(false);
    expect(records.some(record => record.attributeName === "aria-valuenow")).toBe(false);
    t.show({ actualThrottle: .6 });
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    expect(t.slider.style.getPropertyValue("--throttle-value")).toBe("0.8");
    expect(t.slider.style.getPropertyValue("--throttle-actual")).toBe("0.6");
    expect(t.onThrottleChange).not.toHaveBeenCalled();
    expect(t.onPowerChange).not.toHaveBeenCalled();
    t.show({ actualThrottle: .8 });
    expect(marker.hidden).toBe(true);
    t.show({ actualThrottle: undefined });
    expect(marker.hidden).toBe(true);
    expect(t.slider.getAttribute("aria-valuetext")).toBe("80%");
  });

  it("maps actual brake travel into the lower fifth without moving the commanded handle", () => {
    const t = mount({ throttle: 0, brake: .75, actualBrake: .25, engine: RUNNING }, true, true);
    expect(Number(t.slider.style.getPropertyValue("--throttle-value"))).toBeCloseTo(.05);
    expect(Number(t.slider.style.getPropertyValue("--throttle-actual"))).toBeCloseTo(.15);
    expect(t.slider.getAttribute("aria-valuetext")).toContain("75% commanded brakes; 25% actual brakes");
    expect(t.onPowerChange).not.toHaveBeenCalled();
  });

  it("is a plain accessible throttle for a host that cannot start or stop the engine", () => {
    const t = mount({ throttle: 0.5, engine: RUNNING }, false);
    expect(t.slider.getAttribute("role")).toBe("slider");
    expect(t.slider.getAttribute("aria-valuenow")).toBe("50");
    expect(t.output.value).toBe("50%");
    expect(t.box.dataset.engine).toBeUndefined();
    // A press off the handle jumps the lever there, then it follows the pointer.
    pointer(t.slider, "pointerdown", at(0.8));
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(0.8);
    pointer(t.slider, "pointermove", at(0.9));
    expect(t.onThrottleChange.mock.lastCall![0]).toBeCloseTo(0.9, 9);
    pointer(t.slider, "pointerup", at(0.9));
    key(t.slider, "keydown", "PageDown");
    expect(t.onThrottleChange.mock.lastCall![0]).toBeCloseTo(0.8, 9);
    // Holding at idle does nothing without engine control.
    t.show({ throttle: 0 });
    pointer(t.slider, "pointerdown", at(0));
    vi.advanceTimersByTime(SHUTDOWN_HOLD_MS * 2);
    expect(t.box.dataset.hold).toBeUndefined();
  });

  it("rests at idle while the engine is off, and the arrow keys cannot move it", () => {
    const t = mount({ throttle: 0.6, engine: STOPPED });
    expect(t.slider.getAttribute("aria-valuenow")).toBe("0");
    expect(t.output.value).toBe("OFF");
    expect(t.box.dataset.engine).toBe("stopped");
    expect(t.slider.getAttribute("aria-valuetext")).toBe("Engine off. Press and hold to start.");
    key(t.slider, "keydown", "ArrowUp");
    key(t.slider, "keydown", "End");
    expect(t.onThrottleChange).not.toHaveBeenCalled();
  });

  it("holds the starter while pressed anywhere, drags up from idle, and drops back if let go before the engine runs", () => {
    const t = mount({ engine: STOPPED });
    pointer(t.slider, "pointerdown", at(0.7));
    expect(t.onStartHold).toHaveBeenLastCalledWith(true);
    expect(t.box.dataset.hold).toBe("start");
    // The press does not jump the lever: it stays at idle until dragged.
    expect(t.onThrottleChange).not.toHaveBeenCalled();
    expect(t.slider.getAttribute("aria-valuenow")).toBe("0");
    pointer(t.slider, "pointermove", at(0.7) - 30);
    expect(t.onThrottleChange.mock.lastCall![0]).toBeCloseTo(0.3, 9);
    t.show({ engine: { state: "starting", startProgress: 0.4 } });
    expect(t.box.dataset.engine).toBe("starting");
    expect(t.box.style.getPropertyValue("--throttle-ring")).toBe("0.4");
    expect(t.slider.getAttribute("aria-valuetext")).toBe("Starting, 40%. Keep holding.");
    pointer(t.slider, "pointerup", 0);
    expect(t.onStartHold).toHaveBeenLastCalledWith(false);
    t.show({ throttle: 0.3, engine: STOPPED });
    expect(t.slider.getAttribute("aria-valuenow")).toBe("0");
    expect(t.output.value).toBe("OFF");
  });

  it("becomes an ordinary throttle when the engine runs while still held", () => {
    const t = mount({ engine: STOPPED });
    pointer(t.slider, "pointerdown", at(0));
    pointer(t.slider, "pointermove", at(0) - 50);
    t.show({ throttle: 0.5, engine: RUNNING });
    expect(t.box.dataset.engine).toBe("running");
    // It ran: the ring goes, though the pointer is still down.
    expect(t.box.dataset.hold).toBeUndefined();
    pointer(t.slider, "pointermove", at(0) - 60);
    expect(t.onThrottleChange.mock.lastCall![0]).toBeCloseTo(0.6, 9);
    pointer(t.slider, "pointerup", 0);
    expect(t.onStartHold.mock.calls).toEqual([[true], [false]]);
  });

  it("shuts the engine down when the handle is held at idle until the ring closes", () => {
    const t = mount({ engine: RUNNING });
    expect(t.slider.getAttribute("aria-valuetext")).toBe("0%");
    expect(t.box.title).toContain("shut the engine down");
    pointer(t.slider, "pointerdown", at(0) + 3);
    expect(t.box.dataset.hold).toBe("shutdown");
    // A tremor inside the slop is still a hold.
    pointer(t.slider, "pointermove", at(0) + 3 - 5);
    vi.advanceTimersByTime(SHUTDOWN_HOLD_MS - 1);
    expect(t.onShutdown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.onShutdown).toHaveBeenCalledOnce();
    expect(t.onThrottleChange).not.toHaveBeenCalled();
    t.show({ engine: STOPPED });
    // Still held after the ring closed: moving it does nothing until it is let go.
    pointer(t.slider, "pointermove", at(0) - 50);
    expect(t.onThrottleChange).not.toHaveBeenCalled();
    pointer(t.slider, "pointerup", at(0) - 50);
    expect(t.onStartHold).not.toHaveBeenCalled();
    expect(t.output.value).toBe("OFF");
  });

  it("cancels the ring when the handle moves away, or is let go, or the engine stops by itself", () => {
    const t = mount({ engine: RUNNING });
    pointer(t.slider, "pointerdown", at(0));
    pointer(t.slider, "pointermove", at(0) - 20);
    expect(t.box.dataset.hold).toBeUndefined();
    expect(t.onThrottleChange.mock.lastCall![0]).toBeCloseTo(0.2, 9);
    vi.advanceTimersByTime(SHUTDOWN_HOLD_MS * 2);
    pointer(t.slider, "pointerup", 0);
    t.show({ throttle: 0, engine: RUNNING });
    pointer(t.slider, "pointerdown", at(0));
    pointer(t.slider, "pointerup", at(0));
    pointer(t.slider, "pointerdown", at(0));
    t.show({ engine: STOPPED });
    vi.advanceTimersByTime(SHUTDOWN_HOLD_MS * 2);
    expect(t.onShutdown).not.toHaveBeenCalled();
  });

  it("only rings at idle: above it, the handle simply drags", () => {
    const t = mount({ throttle: 0.5, engine: RUNNING });
    pointer(t.slider, "pointerdown", at(0.5));
    expect(t.box.dataset.hold).toBeUndefined();
    pointer(t.slider, "pointermove", at(0.5) + 10);
    expect(t.onThrottleChange.mock.lastCall![0]).toBeCloseTo(0.4, 9);
    vi.advanceTimersByTime(SHUTDOWN_HOLD_MS * 2);
    expect(t.onShutdown).not.toHaveBeenCalled();
  });

  it("does with Space or Enter held what holding the pointer on the handle does", () => {
    const t = mount({ engine: STOPPED });
    key(t.slider, "keydown", " ");
    key(t.slider, "keydown", " ", true);
    expect(t.onStartHold.mock.calls).toEqual([[true]]);
    key(t.slider, "keydown", "ArrowUp");
    expect(t.onThrottleChange).toHaveBeenLastCalledWith(0.01);
    key(t.slider, "keyup", " ");
    expect(t.onStartHold).toHaveBeenLastCalledWith(false);

    t.show({ throttle: 0, engine: RUNNING });
    key(t.slider, "keydown", "Enter");
    vi.advanceTimersByTime(SHUTDOWN_HOLD_MS);
    expect(t.onShutdown).toHaveBeenCalledOnce();
  });

  it("adds up quick key presses before the aircraft shows them", () => {
    const t = mount({ throttle: 0.5, engine: RUNNING });
    key(t.slider, "keydown", "ArrowUp");
    key(t.slider, "keydown", "ArrowUp");
    expect(t.onThrottleChange.mock.lastCall![0]).toBeCloseTo(0.52, 9);
  });

  it("lets go of a start when focus leaves, and ignores the pointer while disabled", () => {
    const t = mount({ engine: STOPPED });
    pointer(t.slider, "pointerdown", at(0));
    t.slider.dispatchEvent(new FocusEvent("blur"));
    expect(t.onStartHold.mock.calls).toEqual([[true], [false]]);
    t.show({ disabled: true });
    expect(t.slider.getAttribute("aria-disabled")).toBe("true");
    pointer(t.slider, "pointerdown", at(0), 2);
    expect(t.onStartHold).toHaveBeenCalledTimes(2);
  });

  it("touches the page only when what it shows changes", () => {
    const t = mount({ throttle: 0.25, engine: RUNNING, afterburner: false });
    const observer = new MutationObserver(() => {});
    observer.observe(t.box, { attributes: true, childList: true, subtree: true, characterData: true });
    t.show({ throttle: 0.25, engine: { ...RUNNING }, afterburner: false });
    expect(observer.takeRecords()).toHaveLength(0);
    t.show({ throttle: 0.3, engine: RUNNING, afterburner: false });
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    observer.disconnect();
  });

  it("marks afterburner the way the HUD always has", () => {
    const t = mount({ throttle: 1, engine: RUNNING, afterburner: true });
    expect(t.output.value).toBe("100🔥");
    expect(t.box.dataset.afterburner).toBe("active");
    expect(t.slider.getAttribute("aria-valuetext")).toBe("100%, afterburner active");
    t.lever.destroy();
    expect(t.box.childElementCount).toBe(0);
  });
});

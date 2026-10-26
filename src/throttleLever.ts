import type { EngineRunState } from "./engineControl";

/**
 * The throttle lever, shared by the desktop HUD and the phone controller: the
 * same DOM, drawn by the same code, so the two cannot drift apart. Each host
 * gives it a box and says where its input goes; the HUD drives the aircraft
 * directly and the phone sends the same intents over its channel.
 *
 * It is a slider that also starts and stops the engine. Hosts may opt into a
 * combined lever: the upper 80% commands throttle, the lower 20% wheel brakes.
 *
 * - Engine off, it sits at idle and will not move. Press and hold it to start:
 *   the starter turns while it is held, the ring fills as the engine spools,
 *   and it may be dragged up meanwhile to choose the power it starts to. Let go
 *   before the engine runs and the start is abandoned; the lever drops back.
 * - Engine running, it is an ordinary throttle. Press and hold its handle at
 *   idle without moving and a ring fills around it; when it closes, the engine
 *   shuts down. Moving away first cancels the ring and drags the lever.
 *
 * Keyboard: the arrow, Page and Home/End keys move it, and holding Space or
 * Enter does what holding the pointer on the handle does.
 */

export interface ThrottleLeverEngine {
  state: EngineRunState;
  /** How far a start has got, 0 to 1. */
  startProgress: number;
  /** Why a start cannot finish now, such as an empty tank. */
  blocked?: string | null;
}

export interface ThrottleLeverView {
  /** The throttle the aircraft is given, 0 to 1. While the pilot drags, the lever shows the drag instead. */
  throttle: number;
  /** Physical throttle position, when the aircraft reports one; never engine speed. */
  actualThrottle?: number;
  /** Wheel brakes, 0 to 1, when the host opts into the combined lever. */
  brake?: number;
  /** Physical wheel-brake actuator position, when available. */
  actualBrake?: number;
  /** False temporarily restores an ordinary throttle, for hosts that switch aircraft. */
  brakeRange?: boolean;
  /** Keep the selected brakes after pointer/key release; defaults to springing back to idle. */
  keepBrakes?: boolean;
  /** Null when the host cannot start or stop the engine: the lever is then a plain throttle. */
  engine: ThrottleLeverEngine | null;
  afterburner?: boolean | null;
  disabled?: boolean;
}

export interface ThrottleBrakeCommand {
  throttle: number;
  brake: number;
}

export interface ThrottleLeverOptions {
  onThrottleChange(value: number): void;
  /** Opts into an 80% throttle / lower 20% brake lever; receives one atomic command. */
  onPowerChange?(command: ThrottleBrakeCommand): void;
  /** Held to start: true when the press begins, false when it ends, whether or not the engine ran. */
  onStartHold?(held: boolean): void;
  /** The ring filled at idle. */
  onShutdown?(): void;
  /** How long the ring takes to fill at idle. */
  shutdownHoldMs?: number;
}

export interface ThrottleLeverHandle {
  update(view: ThrottleLeverView): void;
  /** Cancels held input and releases slider brakes, including retained brakes. */
  release(): void;
  destroy(): void;
}

/** Long enough not to happen by accident, short enough not to feel like waiting. */
export const SHUTDOWN_HOLD_MS = 1500;
/** A press on the handle that moves less than this is still a hold, not a drag. */
const HOLD_SLOP_PX = 6;
/** At or below this the lever is at idle. */
const IDLE = 0.005;
/** The lower fifth of an opted-in lever applies wheel brakes below throttle idle. */
const BRAKE_RANGE = 0.2;
const KEY_STEPS: Readonly<Record<string, number>> = {
  ArrowUp: 0.01, ArrowRight: 0.01, ArrowDown: -0.01, ArrowLeft: -0.01, PageUp: 0.1, PageDown: -0.1,
};

type Gesture =
  | { kind: "start" | "drag"; pointerId: number | "key"; originY: number; originValue: number }
  | { kind: "shutdown"; pointerId: number | "key"; originY: number }
  | { kind: "done"; pointerId: number | "key" };

const clamp01 = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const setAttribute = (element: Element, name: string, value: string): void => {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
};
const setStyle = (element: HTMLElement, name: string, value: string): void => {
  if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
};

export function createThrottleLever(box: HTMLElement, options: ThrottleLeverOptions): ThrottleLeverHandle {
  const holdMs = options.shutdownHoldMs ?? SHUTDOWN_HOLD_MS;
  const label = document.createElement("span");
  label.textContent = "THR";
  const output = document.createElement("output");
  output.dataset.output = "throttle";
  const slider = document.createElement("div");
  slider.className = "flight-throttle";
  slider.dataset.control = "throttle";
  slider.setAttribute("role", "slider");
  slider.setAttribute("aria-label", "Throttle");
  slider.setAttribute("aria-orientation", "vertical");
  slider.setAttribute("aria-valuemin", "0");
  slider.setAttribute("aria-valuemax", "100");
  // A slider's keys, and Space and Enter, which hold it as the pointer does. The flight's keys pass.
  slider.setAttribute("data-takes-keys", "ArrowUp ArrowDown ArrowLeft ArrowRight PageUp PageDown Home End Space Enter");
  slider.tabIndex = 0;
  slider.innerHTML = `
    <span class="flight-throttle__track"><span class="flight-throttle__fill"></span></span>
    <span class="flight-throttle__idle" aria-hidden="true"></span>
    <span class="flight-throttle__actual" aria-hidden="true" hidden></span>
    <span class="flight-throttle__handle">
      <svg class="flight-throttle__ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle class="flight-throttle__ring-back" cx="18" cy="18" r="15.5" />
        <circle class="flight-throttle__ring-fill" cx="18" cy="18" r="15.5" pathLength="1" />
      </svg>
    </span>`;
  const handle = slider.querySelector<HTMLElement>(".flight-throttle__handle")!;
  const actualMarker = slider.querySelector<HTMLElement>(".flight-throttle__actual")!;
  box.replaceChildren(label, output, slider);
  box.style.setProperty("--throttle-hold-ms", `${holdMs}ms`);

  let view: ThrottleLeverView = { throttle: 0, engine: null };
  let gesture: Gesture | null = null;
  /** What the pilot's own input says while it drives the lever; null when the view does. */
  let local: number | null = null;
  /** A key's value until the host shows it, so quick presses add up. */
  let keyed: { value: number; at: number } | null = null;
  /** Keeps a spring release visible while a remote host acknowledges the zero-brake command. */
  let brakeReleasePending = false;
  const brakeKeys = new Set<string>();
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let drawn = "";

  const controlsEngine = (): boolean => view.engine !== null && Boolean(options.onStartHold && options.onShutdown);
  const engineState = (): EngineRunState | null => (controlsEngine() ? view.engine!.state : null);
  const combined = (): boolean => Boolean(options.onPowerChange) && view.brakeRange !== false;
  const idle = (): number => combined() ? BRAKE_RANGE : 0;
  const power = (value: number): ThrottleBrakeCommand => !combined()
    ? { throttle: value, brake: 0 }
    : value < BRAKE_RANGE
      ? { throttle: 0, brake: clamp01((BRAKE_RANGE - value) / BRAKE_RANGE) }
      : { throttle: clamp01((value - BRAKE_RANGE) / (1 - BRAKE_RANGE)), brake: 0 };
  const position = (value: number): number => combined() && Math.abs(value - BRAKE_RANGE) < 1e-9 ? BRAKE_RANGE : clamp01(value);
  const viewValue = (): number => {
    if (!combined()) return clamp01(view.throttle);
    const brake = clamp01(view.brake ?? 0);
    return brake > 0 ? BRAKE_RANGE * (1 - brake) : BRAKE_RANGE + clamp01(view.throttle) * (1 - BRAKE_RANGE);
  };
  const stuck = (): boolean => engineState() === "stopped" && gesture?.kind !== "start";
  const shown = (): number => position(local ?? (brakeReleasePending ? idle() : stuck() ? Math.min(idle(), viewValue()) : viewValue()));

  const metrics = () => {
    const rect = slider.getBoundingClientRect();
    const size = handle.getBoundingClientRect().height || 14;
    return { bottom: rect.bottom - size / 2, travel: Math.max(1, rect.height - size), reach: size / 2 + 8 };
  };

  const render = (): void => {
    const value = shown();
    const command = power(value);
    const braking = command.brake > 0;
    const percent = Math.round((braking ? command.brake : command.throttle) * 100);
    const state = engineState();
    // Once the engine runs, a hold that started it is just a drag: the ring goes.
    const hold = gesture?.kind === "shutdown" ? "shutdown"
      : gesture?.kind === "start" && state !== "running" ? "start" : null;
    // Held but not yet stepped (paused, say) counts as starting.
    const starting = state === "starting" || (state === "stopped" && hold === "start");
    const afterburner = view.afterburner === true && !braking;
    const progress = starting ? clamp01(view.engine!.startProgress) : 0;
    const blocked = state !== "running" ? view.engine?.blocked ?? null : null;
    const knownThrottle = Number.isFinite(view.actualThrottle);
    const knownBrake = combined() && Number.isFinite(view.actualBrake);
    const actualBraking = knownBrake && view.actualBrake! > 0;
    const actual = actualBraking ? clamp01(view.actualBrake!) : knownThrottle ? clamp01(view.actualThrottle!) : knownBrake ? 0 : undefined;
    const actualPosition = actual === undefined ? undefined : actualBraking ? BRAKE_RANGE * (1 - actual)
      : combined() ? BRAKE_RANGE + actual * (1 - BRAKE_RANGE) : actual;
    const actualPercent = actual === undefined ? undefined : Math.round(actual * 100);
    const showActual = actual !== undefined && (actualBraking !== braking || actualPercent !== percent);
    let text: string;
    let title: string;
    if (braking) {
      text = `Brakes, ${percent}%${state === "stopped" ? ". Engine off." : ""}`;
      title = "Wheel brakes. Move up to idle to release the brakes, then farther up for throttle.";
    } else if (state === "stopped" && !hold) {
      text = `Engine off. Press and hold to start.${blocked ? ` ${blocked}.` : ""}`;
      title = "Engine off. Press and hold the throttle to start the engine, and keep holding until it runs; drag up as you hold to choose the power it starts to.";
    } else if (starting) {
      text = `Starting, ${Math.round(progress * 100)}%. Keep holding.${blocked ? ` ${blocked}.` : ""}`;
      title = "Starting. Keep holding until the engine runs; letting go now abandons the start.";
    } else {
      text = `${combined() ? "Throttle, " : ""}${percent}%${afterburner ? ", afterburner active" : ""}`;
      title = state === "running" && command.throttle <= IDLE
        ? "Idle. Press and hold the handle until the ring closes to shut the engine down."
        : combined() ? "Throttle. The lower 20% of the lever applies wheel brakes." : "Throttle";
    }
    if (blocked) title = `${title} ${blocked}.`;
    if (actual !== undefined) {
      text = `${text}; ${percent}% commanded ${braking ? "brakes" : "throttle"}; ${actualPercent}% actual ${actualBraking ? "brakes" : "throttle"}`;
      title = `${title} ${percent}% commanded; ${actualPercent}% actual ${actualBraking ? "brakes" : "throttle"}. Round handle: command. White I-beam: actual position.`;
    }
    const key = [value, actualPosition, showActual, state, hold, afterburner, progress, text, title, combined(), view.disabled === true].join("|");
    if (key === drawn) return;
    drawn = key;
    setStyle(slider, "--throttle-value", String(value));
    setStyle(slider, "--throttle-fill-start", String(braking ? value : idle()));
    setStyle(slider, "--throttle-fill-size", String(Math.abs(value - idle())));
    if (actualMarker.hidden === showActual) actualMarker.hidden = !showActual;
    if (showActual) setStyle(slider, "--throttle-actual", String(actualPosition));
    setStyle(box, "--throttle-ring", String(progress));
    const nextLabel = braking ? "BRK" : "THR";
    if (label.textContent !== nextLabel) label.textContent = nextLabel;
    const nextOutput = state === "stopped" && !hold && !braking ? "OFF" : `${percent}${afterburner ? "🔥" : "%"}`;
    if (output.value !== nextOutput) output.value = nextOutput;
    setAttribute(output, "aria-label", text);
    setAttribute(slider, "aria-label", braking ? "Brakes" : "Throttle");
    setAttribute(slider, "aria-valuemin", combined() ? "-100" : "0");
    setAttribute(slider, "aria-valuenow", String(braking ? -percent : percent));
    setAttribute(slider, "aria-valuetext", text);
    setAttribute(slider, "aria-disabled", String(view.disabled === true));
    setAttribute(slider, "tabindex", view.disabled ? "-1" : "0");
    setAttribute(box, "title", title);
    setAttribute(box, "data-afterburner", afterburner ? "active" : "inactive");
    setAttribute(box, "data-brake-range", String(combined()));
    setAttribute(box, "data-power", braking ? "brake" : "throttle");
    if (state) setAttribute(box, "data-engine", state);
    else if (box.hasAttribute("data-engine")) delete box.dataset.engine;
    if (hold) setAttribute(box, "data-hold", hold);
    else if (box.hasAttribute("data-hold")) delete box.dataset.hold;
  };

  const send = (value: number): void => {
    const next = position(value);
    brakeReleasePending = false;
    if (local !== null) local = next;
    keyed = { value: next, at: performance.now() };
    if (combined()) options.onPowerChange!(power(next));
    else options.onThrottleChange(next);
  };

  const cancelShutdown = (): void => {
    clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
  };

  /** Begins what a press on the handle means now: a start, a shutdown ring, or nothing. */
  const beginHold = (pointerId: number | "key", originY: number): boolean => {
    const state = engineState();
    if (state === "stopped" && (pointerId !== "key" || power(shown()).brake === 0)) {
      gesture = { kind: "start", pointerId, originY, originValue: idle() };
      local = idle();
      if (combined() && clamp01(view.brake ?? 0) > 0) send(idle());
      options.onStartHold?.(true);
      return true;
    }
    const command = power(shown());
    if (state === "running" && command.throttle <= IDLE && command.brake === 0) {
      gesture = { kind: "shutdown", pointerId, originY };
      shutdownTimer = setTimeout(() => {
        shutdownTimer = undefined;
        if (gesture?.kind !== "shutdown") return;
        gesture = { kind: "done", pointerId: gesture.pointerId };
        options.onShutdown?.();
        render();
      }, holdMs);
      return true;
    }
    return false;
  };

  const releaseBrake = (force: boolean): void => {
    if (!combined() || (!force && view.keepBrakes)) return;
    const commanded = local ?? (keyed && performance.now() - keyed.at < 250 ? keyed.value : shown());
    if (power(commanded).brake <= 0) return;
    send(idle());
    brakeReleasePending = true;
  };

  const end = (forceBrakeRelease = false): void => {
    if (!gesture && !forceBrakeRelease) return;
    const started = gesture?.kind === "start";
    releaseBrake(forceBrakeRelease);
    brakeKeys.clear();
    cancelShutdown();
    gesture = null;
    local = null;
    if (started) options.onStartHold?.(false);
    render();
  };

  const capture = (pointerId: number): void => {
    try { slider.setPointerCapture?.(pointerId); } catch { /* A pointer that already ended cannot be captured. */ }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (view.disabled || gesture || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    capture(event.pointerId);
    const { bottom, travel, reach } = metrics();
    const value = shown();
    const onHandle = Math.abs(event.clientY - (bottom - value * travel)) <= reach;
    const requested = clamp01((bottom - event.clientY) / travel);
    // The brake range always drags; engine holds belong to idle and the throttle range.
    const inBrakeRange = combined() && requested < idle();
    const holding = !inBrakeRange && (onHandle || engineState() === "stopped") && beginHold(event.pointerId, event.clientY);
    if (holding) {
      render();
      return;
    }
    if (onHandle) {
      gesture = { kind: "drag", pointerId: event.pointerId, originY: event.clientY, originValue: value };
      local = value;
    } else {
      const jump = stuck() ? Math.min(idle(), requested) : requested;
      gesture = { kind: "drag", pointerId: event.pointerId, originY: event.clientY, originValue: jump };
      local = jump;
      send(jump);
    }
    render();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.kind === "done") return;
    event.preventDefault();
    const rise = gesture.originY - event.clientY;
    if (gesture.kind === "shutdown") {
      if (Math.abs(rise) <= HOLD_SLOP_PX) return;
      cancelShutdown();
      gesture = { kind: "drag", pointerId: gesture.pointerId, originY: gesture.originY, originValue: shown() };
      local = shown();
    }
    const requested = clamp01(gesture.originValue + rise / metrics().travel);
    const next = stuck() ? Math.min(idle(), requested) : requested;
    if (next !== local) send(next);
    render();
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (gesture?.pointerId === event.pointerId) end(event.type !== "pointerup");
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (view.disabled) return;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat && !gesture && beginHold("key", 0)) render();
      return;
    }
    const step = KEY_STEPS[event.key];
    const absolute = event.key === "Home" ? 0 : event.key === "End" ? 1 : null;
    if (step === undefined && absolute === null) return;
    event.preventDefault();
    // Engine off, the lever stays at idle unless it is held to start.
    if (stuck() && !combined()) return;
    if (gesture?.kind === "shutdown") {
      cancelShutdown();
      gesture = null;
    }
    const base = keyed && performance.now() - keyed.at < 250 ? keyed.value : shown();
    const requested = clamp01(absolute ?? base + step!);
    const next = stuck() ? Math.min(idle(), requested) : requested;
    send(next);
    if (combined() && power(next).brake > 0) brakeKeys.add(event.key);
    else brakeKeys.clear();
    render();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (brakeKeys.delete(event.key) && brakeKeys.size === 0) {
      releaseBrake(false);
      render();
    }
    if ((event.key === " " || event.key === "Enter") && gesture?.pointerId === "key") end();
  };

  const onBlur = (): void => end(true);
  const onVisibilityChange = (): void => { if (document.hidden) end(true); };
  // A start is held for as long as the engine takes to spool: a long press must not open a menu.
  const onContextMenu = (event: Event): void => event.preventDefault();

  slider.addEventListener("pointerdown", onPointerDown);
  slider.addEventListener("pointermove", onPointerMove);
  slider.addEventListener("pointerup", onPointerEnd);
  slider.addEventListener("pointercancel", onPointerEnd);
  slider.addEventListener("lostpointercapture", onPointerEnd);
  slider.addEventListener("keydown", onKeyDown);
  slider.addEventListener("keyup", onKeyUp);
  slider.addEventListener("blur", onBlur);
  slider.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibilityChange);
  render();

  return {
    update(next) {
      const wasCombined = combined();
      const keptBrakes = view.keepBrakes === true;
      view = next;
      if (wasCombined !== combined()) {
        keyed = null;
        brakeKeys.clear();
        brakeReleasePending = false;
        end();
      }
      if (keptBrakes && !view.keepBrakes) end(true);
      if (clamp01(view.brake ?? 0) === 0 || view.throttle > 0) brakeReleasePending = false;
      if (keyed && Math.abs(viewValue() - keyed.value) < 0.005) keyed = null;
      // Nothing to hold once the engine is no longer where the hold began.
      if (gesture?.kind === "shutdown" && engineState() !== "running") end();
      if (view.disabled) end(true);
      render();
    },
    release: () => end(true),
    destroy() {
      end(true);
      slider.removeEventListener("pointerdown", onPointerDown);
      slider.removeEventListener("pointermove", onPointerMove);
      slider.removeEventListener("pointerup", onPointerEnd);
      slider.removeEventListener("pointercancel", onPointerEnd);
      slider.removeEventListener("lostpointercapture", onPointerEnd);
      slider.removeEventListener("keydown", onKeyDown);
      slider.removeEventListener("keyup", onKeyUp);
      slider.removeEventListener("blur", onBlur);
      slider.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      box.replaceChildren();
      box.removeAttribute("title");
      delete box.dataset.engine;
      delete box.dataset.hold;
      delete box.dataset.brakeRange;
      delete box.dataset.power;
    },
  };
}

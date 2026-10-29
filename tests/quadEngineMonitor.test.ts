// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuadEngineMonitor, type QuadEngineMonitor, type QuadEngineReading } from "../src/quadEngineMonitor";
import { engineParameterDefaults } from "../src/settings";

const renderers = vi.hoisted(() => [] as {
  host: HTMLElement; options: Record<string, unknown>; draw: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>;
}[]);
vi.mock("../src/engineSpoolRenderer", () => ({
  createEngineSpoolRenderer: (host: HTMLElement, options: Record<string, unknown>) => {
    const renderer = { host, options, draw: vi.fn(), destroy: vi.fn() };
    renderers.push(renderer);
    return { ...renderer, canDraw: () => host.isConnected, configure: vi.fn() };
  },
}));
const reading = (): QuadEngineReading => ({
  aircraftId: "mini", label: "Mini 2", hoverRpm: 10000, maxRpm: 16000, simTimeS: 1, source: "simulated",
  // Intentionally not in DOM order: identity, not array order, selects each motor.
  motors: [{ position: "rear-right", rpm: 10004, direction: 1 }, { position: "front-left", rpm: 10001, direction: 1 },
    { position: "rear-left", rpm: 10003, direction: -1 }, { position: "front-right", rpm: 10002, direction: -1 }],
});
let monitor: QuadEngineMonitor;
let root: HTMLElement;
beforeEach(() => {
  renderers.length = 0;
  root = document.createElement("div"); document.body.append(root);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => { monitor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("quadcopter engine monitor", () => {
  it("maps independent motor readings to the shared Cessna RPM faces and retains missing as unavailable", () => {
    monitor = createQuadEngineMonitor(root);
    monitor.update(reading(), true);
    const values = () => Object.fromEntries([...root.querySelectorAll<HTMLElement>(".flight-quad-engine__motor")]
      .map(motor => [motor.dataset.position, motor.querySelector(".flight-engine__rpm .flight-engine__spool-value")?.textContent]));
    expect(values()).toEqual({ "front-left": "10001", "front-right": "10002", "rear-left": "10003", "rear-right": "10004" });
    expect(root.querySelector<HTMLElement>('[data-position="front-left"] .flight-engine__spools')?.title).toContain("10001 RPM (simulated)");
    expect(monitor.getReading()).toEqual(reading());
    const next = reading(); next.motors = [{ position: "front-left", rpm: 0, direction: -1 }, { position: "rear-right", rpm: NaN, direction: 1 }];
    monitor.update(next, true);
    expect(values()).toEqual({ "front-left": "0", "front-right": "—", "rear-left": "—", "rear-right": "—" });
    expect(root.querySelector<HTMLElement>('[data-position="front-left"]')?.dataset.direction).toBe("-1");
    expect(root.textContent).toContain("Simulated");
    expect(root.textContent).not.toContain("Estimated");
    expect(root.textContent).not.toContain("UNKNOWN");
    expect(root.querySelector(".flight-engine__flow:not([hidden])")).toBeNull();
  });

  it("borrows the supplied device, requires WebGPU, lazily attaches details and disposes only its own resources", () => {
    const device = {} as GPUDevice;
    const onOpen = vi.fn();
    monitor = createQuadEngineMonitor(root, { gpuDevice: device, onOpen });
    expect(renderers).toHaveLength(4);
    for (const renderer of renderers) expect(renderer.options).toMatchObject({ device, webgpuOnly: true, preference: "webgpu" });
    root.querySelector<HTMLButtonElement>("button")!.click(); expect(onOpen).toHaveBeenCalledOnce();
    monitor.update(reading(), true);
    const host = document.createElement("div"); document.body.append(host);
    const irrelevant = document.createElement("div"); irrelevant.textContent = "Piston fuel settings";
    const detach = monitor.attachDetails(host, irrelevant);
    expect(renderers).toHaveLength(8);
    expect(host.querySelectorAll(".flight-engine__rpm")).toHaveLength(4);
    expect(host.textContent).toContain("Mini 2 motors");
    expect(host.textContent).toContain("Simulated");
    expect(host.textContent).toContain("each propeller's speed from the rotor model");
    expect(host.textContent).toContain("first-order lag");
    expect(host.textContent).toContain("no ESC, motor or battery model");
    expect(host.textContent).toContain("not telemetry from a real aircraft");
    expect(host.textContent).not.toMatch(/estimated|twice hover/i);
    expect(host.textContent).not.toContain("Piston fuel settings");
    expect(root.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    detach(); detach();
    expect(host.children).toHaveLength(0);
    expect(renderers.slice(4).every(renderer => renderer.destroy.mock.calls.length === 1)).toBe(true);
    monitor.destroy(); monitor.destroy();
    expect(renderers.every(renderer => renderer.destroy.mock.calls.length === 1)).toBe(true);
    expect(root.children).toHaveLength(0);
  });

  it("scales each rotor's motion to the model maximum independently of the hover reference", () => {
    let now = 0;
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    monitor = createQuadEngineMonitor(root, { now: () => now,
      parameters: engineParameterDefaults({ "osfs.engineMonitor.orbTurnsPerSecond": 2 }) });
    const next = { ...reading(), hoverRpm: 0, maxRpm: 12500 };
    monitor.update(next);
    now = 100; monitor.update({ ...next, simTimeS: 1.1 });
    expect(frames.size).toBe(4);
    now = 200;
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(now);
    for (let index = 0; index < renderers.length; index++) {
      const rpm = 10001 + index;
      expect(renderers[index].draw.mock.lastCall?.[0].outerAngle).toBeCloseTo(0.1 * 2 * Math.PI * 2 * rpm / 12500);
    }
    expect(frames.size).toBe(0);
  });

  it("holds rotor animation on pause and releases summary observers on destruction", () => {
    const disconnects: ReturnType<typeof vi.fn>[] = [];
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect = vi.fn();
      constructor() { disconnects.push(this.disconnect); }
    });
    let now = 0;
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    monitor = createQuadEngineMonitor(root, { now: () => now,
      parameters: engineParameterDefaults({ "osfs.engineMonitor.orbTurnsPerSecond": 2 }) });
    monitor.update(reading());
    now = 100; monitor.update({ ...reading(), simTimeS: 1.1 });
    expect(frames.size).toBe(4);
    monitor.update({ ...reading(), simTimeS: 1.1 }, true);
    expect(frames.size).toBe(0);
    const draws = renderers.map(renderer => renderer.draw.mock.calls.length);
    now = 500; monitor.update({ ...reading(), simTimeS: 1.1 }, true);
    expect(renderers.map(renderer => renderer.draw.mock.calls.length)).toEqual(draws);
    monitor.destroy();
    expect(disconnects).toHaveLength(4);
    expect(disconnects.every(disconnect => disconnect.mock.calls.length === 1)).toBe(true);
    expect(frames.size).toBe(0);
  });
});

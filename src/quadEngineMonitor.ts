import "./quadEngineMonitor.css";
import { createHelpTooltip } from "foss-earth/shell";
import { createEngineSummary, engineRotorSpeeds, type EngineSummaryView } from "./engineSummary";
import { createEngineSpoolAnimation } from "./engineSpoolAnimation";
import { createEngineSpoolRenderer, type EngineSpoolConfiguration } from "./engineSpoolRenderer";
import { engineParameterDefaults, type EngineParameterStore } from "./settings";

export type QuadMotorPosition = "front-left" | "front-right" | "rear-left" | "rear-right";
export interface QuadEngineReading {
  aircraftId: string;
  label: string;
  hoverRpm: number;
  maxRpm: number;
  simTimeS: number;
  motors: readonly { position: QuadMotorPosition; rpm: number; direction: 1 | -1 }[];
  source: "simulated";
}
export interface QuadEngineMonitorOptions {
  /** Borrowed from the flight renderer; this component never requests a device. */
  gpuDevice?: GPUDevice | null;
  parameters?: EngineParameterStore;
  now?: () => number;
  onOpen?(): void;
}
export interface QuadEngineMonitor {
  update(reading: QuadEngineReading | null, held?: boolean): void;
  getReading(): QuadEngineReading | null;
  attachDetails(host: HTMLElement, settingsContent?: HTMLElement): () => void;
  destroy(): void;
}
const POSITIONS: readonly [QuadMotorPosition, string][] = [
  ["front-left", "FL"], ["front-right", "FR"], ["rear-left", "RL"], ["rear-right", "RR"],
];

/** Four instances of the Cessna RPM face, arranged as the airframe viewed from above. */
export function createQuadEngineMonitor(root: HTMLElement, options: QuadEngineMonitorOptions = {}): QuadEngineMonitor {
  const document = root.ownerDocument;
  const parameters = options.parameters ?? engineParameterDefaults();
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const text = (node: HTMLElement, value: string) => { if (node.textContent !== value) node.textContent = value; };
  const container = element("section", "flight-engine flight-quad-engine");
  container.setAttribute("aria-label", "Quadcopter motor monitor");
  const toggle = element("button", "flight-engine__summary flight-quad-engine__summary");
  toggle.type = "button";
  toggle.setAttribute("aria-label", "Open quadcopter engine details");
  const details = element("section", "flight-engine flight-quad-engine__details");
  details.setAttribute("aria-label", "Quadcopter engine details");
  const heading = element("strong", "flight-quad-engine__heading", "Quadcopter motors");
  const source = element("span", "flight-quad-engine__source", "Simulated");
  const helpContent = element("p", "", "Top view, nose up: FL/FR are front left/right, RL/RR are rear left/right. RPM is each propeller's speed from the rotor model. The rotor follows the flight controller's command with a first-order lag. There is no ESC, motor or battery model, so this is not telemetry from a real aircraft. The ring motion is slowed for readability and scaled to the model's maximum rotor RPM. Pausing holds the rotors. Numeric readings remain available if WebGPU drawing is disabled or unavailable.");
  const help = createHelpTooltip({ label: "Explain quadcopter motor RPM", content: helpContent });
  const titleRow = element("div", "flight-quad-engine__title");
  titleRow.append(heading, source, help.element);
  const detailSlot = element("div", "flight-quad-engine__detail-slot");
  details.append(titleRow, detailSlot);
  const compactSource = element("span", "flight-quad-engine__source", "Simulated");
  let reading: QuadEngineReading | null = null;
  let held = true;
  let destroyed = false;
  let detailFace: ReturnType<typeof createFace> | null = null;
  let attached: HTMLElement | null = null;

  const configuration = (): EngineSpoolConfiguration => ({
    preference: parameters.get("osfs.renderer.engineOrbs") === "off" ? "off" : "webgpu",
    maxFps: parameters.get("osfs.engineMonitor.orbFps"),
    pixelRatio: parameters.get("osfs.engineMonitor.orbPixelRatio"),
    maxPatternStep: parameters.get("osfs.engineMonitor.orbMaxPatternStep"),
    outerBlades: 2, innerBlades: 0,
  });
  function createFace() {
    const grid = element("span", "flight-quad-engine__grid");
    grid.setAttribute("role", "group"); grid.setAttribute("aria-label", "Motor RPM, top view, front up");
    const front = element("span", "flight-quad-engine__front", "↑");
    front.setAttribute("aria-hidden", "true"); grid.append(front);
    const motors = POSITIONS.map(([position, short]) => {
      const motor = element("span", "flight-quad-engine__motor");
      motor.dataset.position = position;
      motor.setAttribute("aria-label", `${position.replaceAll("-", " ")} motor`);
      const label = element("span", "flight-quad-engine__motor-label", short);
      const summary = createEngineSummary();
      const renderer = createEngineSpoolRenderer(summary.spools, {
        ...configuration(), device: options.gpuDevice ?? null, webgpuOnly: true,
      });
      const animation = createEngineSpoolAnimation({
        now: options.now, document,
        canDraw: () => renderer.canDraw(),
        draw: (frame, at) => renderer.draw(frame, at),
      });
      motor.append(label, summary.diagram); grid.append(motor);
      return { motor, position, summary, renderer, animation };
    });
    return {
      grid,
      update(next: QuadEngineReading | null, paused: boolean) {
        const config = configuration();
        const maxRpm = next && Number.isFinite(next.maxRpm) && next.maxRpm > 0 ? next.maxRpm : null;
        for (const motor of motors) {
          const datum = next?.motors.find(value => value.position === motor.position);
          const rpm = datum && Number.isFinite(datum.rpm) && datum.rpm >= 0 ? datum.rpm : null;
          const direction = datum?.direction ?? (motor.position === "front-left" || motor.position === "rear-right" ? 1 : -1);
          const directionText = String(direction);
          if (motor.motor.dataset.direction !== directionText) motor.motor.dataset.direction = directionText;
          const rpmText = rpm === null ? "" : String(Math.round(rpm));
          if (motor.motor.dataset.rpm !== rpmText) motor.motor.dataset.rpm = rpmText;
          const view: EngineSummaryView = { kind: "piston", phase: null, label: "", rpm, maxRpm,
            rpmDescription: `${motor.position.replaceAll("-", " ")} · ${rpm === null ? "Unavailable" : `${Math.round(rpm)} RPM (simulated)`}`,
            n1Pct: null, n2Pct: null, thrustLbf: null, fuelFlowPph: null, fuelFlowGph: null };
          motor.summary.render(view, "lb/h");
          motor.renderer.configure(config);
          motor.animation.update({ simTimeS: next?.simTimeS ?? null, held: paused,
            speeds: engineRotorSpeeds(view), turnsPerSecond: parameters.get("osfs.engineMonitor.orbTurnsPerSecond"),
            enabled: config.preference !== "off" && rpm !== null && maxRpm !== null });
        }
      },
      destroy() {
        for (const motor of motors) { motor.animation.destroy(); motor.renderer.destroy(); motor.summary.destroy(); }
        grid.remove();
      },
    };
  }
  const compact = createFace();
  toggle.append(compact.grid, compactSource);
  container.append(toggle); root.append(container);
  const open = () => { if (!destroyed) options.onOpen?.(); };
  toggle.addEventListener("click", open);
  const detach = () => {
    help.close();
    details.remove(); attached = null;
    detailFace?.destroy(); detailFace = null;
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.setAttribute("aria-expanded", "false");
  const handle: QuadEngineMonitor = {
    update(next, paused = false) {
      if (destroyed) return;
      reading = next; held = paused;
      text(heading, next?.label ? `${next.label} motors` : "Quadcopter motors");
      compact.update(next, paused); detailFace?.update(next, paused);
    },
    getReading: () => reading,
    attachDetails(host) {
      if (destroyed) return () => {};
      detach(); attached = host;
      detailFace = createFace(); detailSlot.replaceChildren(detailFace.grid);
      host.append(details);
      toggle.setAttribute("aria-expanded", "true");
      detailFace.update(reading, held);
      return () => { if (attached === host) detach(); };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; detach(); compact.destroy();
      toggle.removeEventListener("click", open);
      help.destroy(); container.remove(); reading = null;
    },
  };
  handle.update(null, true);
  return handle;
}

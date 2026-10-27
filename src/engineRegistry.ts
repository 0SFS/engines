import type { EngineRotorBladeCounts } from "./engineRotorDefinitions";

/** One engine mod's simulator-facing definition. Aircraft profiles still carry the copy they fly with. */
export interface RegisteredEngine {
  id: string;
  label: string;
  summary: string;
  type: "piston" | "turbine";
  jsbsimEngineFiles: readonly string[];
  rotorBlades: EngineRotorBladeCounts;
  startSpeed: { property: string; runningAt: number };
  maxEngineRpm?: number;
  gauges: { primary: string; secondary: string | null; label: string };
}

const engines = new Map<string, RegisteredEngine>();

export function registerEngine(engine: RegisteredEngine): void {
  engines.set(engine.id, engine);
}

export function getRegisteredEngine(id: string): RegisteredEngine | undefined {
  return engines.get(id);
}

export function registeredEngines(): readonly RegisteredEngine[] {
  return [...engines.values()];
}

import { OwnedRegistry } from "@0sfs/mods/ownedRegistry";
import type { EngineRotorBladeCounts } from "./engineRotorDefinitions";

/** One engine mod's simulator-facing definition. Electric motors have no native combustion gauges. */
interface RegisteredEngineBase {
  id: string;
  label: string;
  summary: string;
}
export interface RegisteredNativeEngine extends RegisteredEngineBase {
  type: "piston" | "turbine";
  jsbsimEngineFiles: readonly string[];
  rotorBlades: EngineRotorBladeCounts;
  startSpeed: { property: string; runningAt: number };
  maxEngineRpm?: number;
  gauges: { primary: string; secondary: string | null; label: string };
}
export interface RegisteredElectricEngine extends RegisteredEngineBase {
  type: "electric";
  electric: { propeller: {
    radiusM: number; blades: number; chordM: number; pitchM: number;
    zeroLiftDeg: number; liftSlope: number; profileDrag: number;
    inertiaKgM2: number; timeConstantS: number; maxRpm: number; idleRpm: number;
  } };
}
export type RegisteredEngine = RegisteredNativeEngine | RegisteredElectricEngine;

const engines = new OwnedRegistry<RegisteredEngine>();

export function registerEngine(engine: RegisteredEngine, owner?: string): void {
  engines.set(engine.id, engine, owner);
}

export function unregisterEngine(id: string, owner?: string): void {
  engines.remove(id, owner);
}

export function getRegisteredEngine(id: string): RegisteredEngine | undefined {
  return engines.get(id);
}

export function registeredEngines(): readonly RegisteredEngine[] {
  return engines.values();
}

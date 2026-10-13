/** How the engine orbs are drawn, on the desktop HUD and, sent in the heartbeat, on the phone. */
export interface EngineOrbSettings {
  fps: number;
  turnsPerSecond: number;
  /** Optional on older hosts; clients use their shared default when absent. */
  maxPatternStep?: number;
  pixelRatio: number;
  renderer: "auto" | "webgpu" | "webgl2" | "webgl1" | "off";
}

import { describe, expect, it } from "vitest";
import { getRegisteredEngine, registeredEngines, registerEngine, unregisterEngine, type RegisteredNativeEngine } from "../src/engineRegistry";

const original: RegisteredNativeEngine = { id: "test-owned-piston", label: "Original", summary: "Original engine", type: "piston",
  jsbsimEngineFiles: [], rotorBlades: { outer: 2, inner: null, outerEstimated: false, innerEstimated: false },
  startSpeed: { property: "rpm", runningAt: 400 }, gauges: { primary: "rpm", secondary: null, label: "RPM" } };

describe("engine definition ownership", () => {
  it("restores the installed native engine after removing a replacement with the same engine ID", () => {
    registerEngine(original, "0sfs/original");
    const replacement = { ...original, label: "Replacement" };
    registerEngine(replacement, "local:pilot/replacement");
    try {
      expect(getRegisteredEngine(original.id)).toBe(replacement);
      expect(registeredEngines().filter(engine => engine.id === original.id)).toEqual([replacement]);
      unregisterEngine(original.id, "local:pilot/replacement");
      expect(getRegisteredEngine(original.id)).toBe(original);
      unregisterEngine(original.id, "unrelated-owner");
      expect(getRegisteredEngine(original.id)).toBe(original);
    } finally {
      unregisterEngine(original.id, "local:pilot/replacement");
      unregisterEngine(original.id, "0sfs/original");
    }
  });
});

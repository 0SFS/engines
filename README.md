# Engines

Shared engine code for 0SFS: the engine monitor, instruments, history, and the Engine panel. The F135, FJ33, and IO-320 packages build on it.

The fly app depends on this package and runs its tests. From the `fly` directory, `npm test` includes them.

`quadEngineMonitor` exports `createQuadEngineMonitor(root, options)`, a compact four-motor widget and attachable Engine-tab detail view. It reuses the Cessna RPM face and shaft animation, arranging independent readings as front-left/right above rear-left/right. Hosts supply plain motor readings, simulation time and pause state through `update`; this module imports no drone controller or aircraft implementation. Fly loads it through the applied drone feature. `attachDetails` returns a detach function, and `destroy` releases both views, GPU resources, animation callbacks and summary observers.

The widget marks the rotor model's propeller speeds **Simulated** and scales the animation by the supplied `maxRpm`. Rotor speed follows the flight controller's command with a first-order lag; there is no ESC, motor or battery model, and these readings are not telemetry from a real aircraft. It borrows the host's WebGPU device and never requests another device or falls back to WebGL; numeric RPM stays available if drawing is off or unavailable. The common Engine shaft indicator settings control visual cadence and speed.

## Community

- [Code of conduct](https://github.com/0SFS/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/0SFS/.github/blob/main/CONTRIBUTING.md)
- [License](LICENSE)
- [Security](https://github.com/0SFS/.github/blob/main/SECURITY.md)

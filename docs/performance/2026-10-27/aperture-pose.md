# Aperture pose reuse — 27 October 2026

Status: retained. Same flap and bearing products, stored on one quaternion per
part. Repeated observations still perform no writes; the existing early-out is
unchanged.

A creeping aperture (`+6.8e-9` per frame) still updates all 112 flaps, which is
why the early-out does not cover steady F135 flight. The previous update
allocated `azimuth.multiply(Quaternion.RotationAxis(...))` for each flap. The
candidate writes that product into a quaternion owned by the flap.

Six interleaved pairs of 4,000 frames, NullEngine, same geometry function.
Legacy precomputes azimuths once, matching bind time, then allocates the hinge
product every frame. Bearing angles stay fixed so only the aperture loop is
timed. Runner: `aircraft/build/pose-bench.test.ts`.

| Pair | Legacy ms | Current ms | Current / legacy |
| ---: | ---: | ---: | ---: |
| 1 | 9.36 | 7.71 | 0.824 |
| 2 | 9.42 | 7.81 | 0.829 |
| 3 | 9.05 | 7.70 | 0.851 |
| 4 | 8.92 | 7.70 | 0.863 |
| 5 | 9.00 | 7.68 | 0.853 |
| 6 | 9.39 | 7.64 | 0.813 |

Median ratio 0.851. At 60 fps that is about 0.02 ms/s. Not an FPS claim.
Quantizing the creeping nozzle command would avoid the update entirely and
changes the pose; it remains unshipped.

`F135/tests/engineNozzleRig.test.ts` checks bearing and convergent components
with `Object.is` against the allocating product, and still requires the same
quaternion objects when the observation repeats.

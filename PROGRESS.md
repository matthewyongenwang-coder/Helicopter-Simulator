# Progress

## Milestone status

| # | Milestone | Status |
|---|---|---|
| 1 | Architecture + headless flight model, controls, autohover, physics tests | **Done** |
| 2 | Terrain streaming, water, biomes, seed | **Done** |
| 3 | Settlements, roads, bridges, forests, props | In progress |
| 4 | Six aircraft, models, spawn menu | Not started (spec data for all six already written) |
| 5 | HUD, cameras, audio, weather, day/night, damage, polish | Not started |
| 6 | Performance pass, playtest, README | Not started |

## Milestone 1

- `docs/ARCHITECTURE.md`: the proposal.
- `src/data/`: aircraft specs, physics tuning, key bindings. No numbers live in the logic.
- `src/sim/`: pure TypeScript, fixed 120 Hz, no DOM or Three.js imports.
- `tests/physics/`: 51 Vitest tests, all passing (`npm test`). They drive the sim with key
  codes through the default bindings, the same path the game uses.

Verified by tests, on the medium aircraft unless noted:

| Behaviour from the brief | Result |
|---|---|
| J starts the engine, rotor spools slowly | Green band reached 10–18 s after J |
| Space lifts off only once RPM is in the green | Space held through the whole start, at minimum weight: wheels never leave the ground. After lowering the lever the start completes and Space lifts off |
| W with no collective change sinks while moving forward; collective restores altitude | Pass |
| Releasing keys leaves it tilted and accelerating | Tilt constant within 0.3° over 4 s, speed still rising |
| X from a steep tilt and fast drift → level, motionless in under 2 s | 38° bank, 8 m/s drift, 2.8 m/s sink: **1.78 s** |
| Autohover: hold W / A / D / Space / Shift / Q / E, release → brakes and holds | Pass for each axis |
| Autohover leans against its motion, holds in wind and gusts, needs engine + green RPM, off leaves everything as it is | Pass |
| Ground effect, translational lift, vortex ring, retreating-blade stall, autorotation, power and weight limits, fuel burn, top speed | Pass |
| Suspension, hard landing damage, crash, rotor strike, tail strike, water | Pass |

## Milestone 2

- `src/world/`: seeded simplex noise, the terrain function (continents, hills, ridged
  mountains, lakes, rivers carved to sea level), biome classification and chunk mesh
  generation. Pure functions of `(seed, x, z)`.
- `src/render/`: engine with a floating origin, terrain quadtree (7 LOD levels, skirts,
  parent stays until all four children are ready), water, sky. Meshes are built in workers.
- `src/game/`: frame loop, chase camera, keyboard input, the `Environment` the flight model
  flies in. Runs in the browser with `npm run dev`. The HUD is a temporary text read-out.
- Seed: random per launch, shown on screen as `XXXX-XXX`, settable with `?seed=`.

Verified:

| Check | Result |
|---|---|
| Same seed, same world | Heights and chunk bytes identical (`tests/world`, 12 tests) |
| Different seeds differ; launches pick different seeds | Pass |
| 20 minute straight flight never reaches an edge | 102 km on four headings, plus chunks at 1,000–8,000 km out |
| Loads, frame rate, console errors (`npm run e2e`, headless Chromium on the GPU) | Ready in about 1 s, 60 fps, no errors, on two seeds |
| No pop-in at speed | 45 s at 165 kt: every LOD split was ready on time, queue never above 5 jobs |
| Floating origin | Re-centres during the cruise (0 → 3072 m) |
| Memory | Geometry count stays bounded in the cruise (208 → max 339) |

Generation costs about 0.7 µs per height sample and 8 ms per 64-cell chunk.

## Milestone 3

- `src/world/settlements.ts`: one candidate site per 6 km cell; every 18 km block holds a
  city and two earmarked towns wherever the land allows. Density is 1 downtown and falls
  smoothly to 0 at the edge. The ground under a settlement is levelled.
- `src/world/roads.ts`: neighbouring settlements are joined by wandering roads (highways
  between towns and cities). The height profile is smoothed, grade-limited to 12 % by fill,
  and becomes a bridge wherever the stretch below it contains water.
- `src/world/structures.ts`: per 1 km cell, buildings from a street grid (towers, mid-rise,
  houses by density), street and road ribbons, bridge girders, piers, railings, towers and
  cables on long spans, helipads (ground and rooftop), street lights, power lines beside
  some roads, wind farms, boats, distant trees, and collision boxes for all of it.
- `src/world/forest.ts`: individual trees in 256 m cells near the camera.
- `src/render/propSystem.ts`: streams and instances the above. Trees shrink away at the edge
  of their radius instead of popping. Windows, lit windows at night and road markings are
  drawn in shaders.
- `src/game/colliders.ts`: buildings, decks, pads and masts as oriented boxes in a grid.
  Roofs, bridge decks and helipads can be landed on.
- The game now starts on the nearest city heliport.

Verified (`tests/world/settlements.test.ts`, 18 tests, and `npm run e2e`):

| Check | Result |
|---|---|
| A typical area has water, forest, towns, a dense city, roads and a bridge | The 25 km around the start, on 8 seeds in the test and 20 in a survey: every one has all six. Fewest seen: 1 town, 76 towers over 60 m, 21 km of road, 3 bridges |
| Density fades smoothly | Monotonic from the centre, never more than 0.03 per 10 m |
| Skyscrapers downtown, houses at the edge | Mean height in the inner quarter is over 1.8× the next ring; over 90 % of houses are in the outer half |
| Roads follow terrain | Ground meets the road within 0.25 m on land; grade never above 12 % |
| Bridges | Span real water with at least 6.5 m clearance; deck is landable from above and solid from below |
| Helipads | One ground pad per settlement, rooftop pads in cities, all reported as helipad surface by the flight model's environment |
| Browser | City, town, bridge, dusk and night views all 60 fps, 180–260 draw calls, no console errors; the aircraft rests on the city heliport |
| Memory | The same 6 km round trip twice ends on the same GPU geometry count (277 and 277) |

## Decisions

- **Settlement kinds are capped by peak density**, so only cities reach tower density and
  villages are houses only.
- **Low beach is not a bridge.** A stretch at the waterline only becomes a bridge if it
  contains water; otherwise the road is carried on fill.
- **A point more than 2.5 m inside a solid wrecks the aircraft** instead of being pushed out,
  and contact forces are bounded, so no collision can blow the simulation up.
- **Trees do not collide.** The brief lists terrain, water, buildings and bridges.
- **One water level.** Sea, lakes and rivers all sit at y = 0. Rivers are the zero contour of
  a warped noise field and fade out as the ground climbs, so they never run uphill.
- **Physics reads the analytic height**, not the mesh. The shortest terrain wavelength is
  48 m, so the two differ by a couple of centimetres at most.
- **Shallow water shows the bed; deep water does not.** The terrain shader fades the sea bed
  to the water colour with depth, and a dark floor plane sits under everything, so chunks
  that are entirely deep are not drawn at all.
- **Rate-command attitude.** Pitch, roll and yaw are control moment against rotor damping.
  Nothing returns the aircraft to level. A fin adds weathervaning in yaw at speed, which is
  what makes a banked turn come round.
- **Tail-rotor side force is left out**, so a level aircraft does not drift.
- **Start sequence is torque-limited per aircraft** so no weight can lift off below the green.
  Holding Space during the start stalls the spool-up until the lever is lowered (HUD warning).
- **Collective range exceeds engine power.** Full lever overpitches: torque pegs at the limit
  and RPM droops below the green. Rated power is the 100 % torque mark; 115 % is available
  briefly and wears the transmission after about 12 s.
- **Autohover authority.** It may use more cyclic than the keyboard (`autohover.authority`),
  which is how it meets the 1–2 s target. It needs RPM in the green to engage, then rides
  through droop down to 86 %.
- **Autohover lean limit for held keys.** With autohover on, a held cyclic key tilts up to
  32° and stays there, so holding W is steady forward flight. With autohover off there is no
  limit, as the brief asks.
- **Vortex-ring protection in autohover.** While sinking it brakes only as hard as keeps the
  rotor out of its own wake, and keeps some airspeed on in a fast vertical descent.
- **Drag area is derived from the listed top speed.** Climb rate, ceiling, endurance and range
  for the menu are computed from the same model, not typed in.
- **"Loses authority at low speed"** is implemented two ways: tail-rotor thrust scales with
  rotor RPM², and it is less effective in the hover than in forward flight.

## Known issues

- The 2 s autohover figure depends on the entry state. On the medium, 10 m/s drift takes
  about 2.0 s and 12 m/s about 2.3 s. Engine power sets the limit, not the controller.
- First look at all six aircraft in the same scenario: scout 1.98 s, utility 1.93 s,
  medium 1.78 s, rescue 1.78 s, attack 2.18 s, heavy 2.66 s. The scout should be quickest.
  To fix in milestone 4.
- With autohover off, holding W for 3 s pitches past vertical (36°/s, no limit). This is what
  the brief specifies.
- A hands-off hover away from sea level yaws slowly (about 0.6°/s at 300 m) because the pedal
  interlink is calibrated at sea level and standard weight.
- Wind pushes the aircraft only through fuselage drag, so a 20 kt wind needs about 0.3° of lean.
  Real rotors add flapback; that is left out to keep attitude purely pilot-driven.
- Climb rates from the model (14–23 m/s) are higher than real aircraft of these classes.
- The GateGuard hook blocks the first write of every new file until its facts are stated.

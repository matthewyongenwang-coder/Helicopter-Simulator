# Architecture

## Layers

```
src/data/     Plain data. Aircraft specs, physics tuning, world-gen parameters,
              default key bindings, graphics presets. No logic.
src/sim/      Flight physics. Pure TypeScript, no DOM, no Three.js. Fixed 120 Hz.
src/world/    World generation. Pure functions of (seed, x, z). Runs unchanged on
              the main thread (physics queries, minimap), in Web Workers (meshing)
              and in Node (tests).
src/render/   Three.js: terrain streaming, props, water, sky, aircraft models, cameras.
src/ui/       DOM/canvas overlay: spawn menu, HUD, minimap, controls overlay.
src/audio/    Web Audio synthesis.
src/game/     Orchestration: main loop, input, settings, spawn/respawn.
```

Dependencies only point downward in that list (`game → render/ui/audio → world/sim → data`).
`sim` talks to the world through one small interface (`Environment`): surface height
and normal, wind, air density, obstacle collision. Tests plug in a flat environment.

## Flight model (`src/sim`)

A 6-DOF rigid body integrated with semi-implicit Euler at a fixed 120 Hz.
The governing rule: **no key applies a force**. Keys move the collective lever and
command attitude rates. Every translational force is rotor thrust along the rotor
axis, gravity, drag or contact.

| Subsystem | Model |
|---|---|
| Thrust | Blade-element thrust from blade pitch, rotor speed and inflow. Collective drives blade pitch through a servo lag; induced velocity is a lagged state (dynamic inflow). |
| Induced flow | Momentum theory (Glauert) in climb and forward flight, empirical curve in axial descent, windmill-brake branch beyond. Translational lift, vertical damping and autorotation all fall out of this rather than being scripted. |
| Ground effect | Cheeseman–Bennett reduction of induced velocity by rotor height, fading with forward speed. |
| Vortex ring state | Thrust loss and buffet when descending at 0.35–1.7× hover induced velocity with low airspeed. |
| Retreating-blade stall | Thrust loss, roll-left and pitch-up above a limit in advance ratio and blade loading. |
| Engine and rotor | Rotor speed is a state: `I·dΩ/dt = Q_engine − Q_rotor`. A governor with a collective anticipator and turbine lag holds 100 %. Start runs a 15 s reference ramp at idle torque only, so full power is unavailable until RPM is in the green. Overpitching droops RPM. With the engine out the airflow drives the rotor (autorotation). |
| Anti-torque | The fuselage feels engine shaft torque. Tail-rotor thrust comes from pedal = interlink(collective) + trim + key, and scales with rotor RPM² and airspeed. Raising collective leaves a residual that yaws the nose. |
| Attitude | Cyclic gives a control moment against rotor damping, which makes pitch/roll/yaw rate-command axes: hold a key for a steady rate, release and the attitude stays. Nothing returns the aircraft to level. A vertical fin adds weathervaning in yaw at speed. |
| Drag and wind | Body-axis drag areas on air-relative velocity. Wind and gusts come from the environment. |
| Mass | Empty + crew + payload + fuel. Fuel burn follows engine power and lightens the aircraft. |
| Contact | Spring-damper gear points (skids or wheels) with stick/slip friction, stiff hull points, rotor-tip strike points, water. Impact speed drives damage. |

Derived quantities (blade pitch range, drag area that yields the listed top speed,
inertia, pedal interlink, gear stiffness) are computed from the data file in
`sim/derive.ts`, so the numbers in `data/aircraft.ts` are the ones a pilot would
recognise: mass, rotor diameter, power, top speed, rates.

### Autohover (`sim/autohover.ts`)

A cascaded controller that only writes to the same channels the pilot has:
attitude-rate commands, the collective lever and pedal trim.

- Horizontal: velocity/position error → desired acceleration → desired thrust
  direction (a lean against the motion) → attitude-rate commands.
- Vertical: altitude/vertical-speed error → required thrust → collective, using the
  inverse of the rotor model plus an integrator.
- Yaw: heading error → yaw-rate command; pedal trim follows the torque it measures.

Each axis is handed back to the pilot while its key is held and recaptured on release.
The controller may use more cyclic authority than the keyboard does, which is how it
reaches a stable hover in 1–2 s. It is unavailable unless the engine is running with
RPM in the green. Switching it off changes nothing: lever and trim stay where they are.

### Testing

`Simulation` wraps the helicopter with the key-binding map and a fixed-step clock.
Tests feed it scripted key events (`press KeyJ at t=0`, `release Space at t=21.5`)
and assert on the resulting state. Nothing in the tests reaches into the controller.

## World (`src/world`)

One seed drives everything. All generation is a deterministic function of position:

- **Terrain**: layered noise (continents, hills, ridged mountains), with rivers and
  lakes carved to a single global water level. Settlement sites and road corridors
  flatten the terrain around them.
- **Regions**: the plane is divided into coarse cells. Each cell deterministically
  yields settlement sites (hamlet → city) and the roads that link neighbouring sites.
  Regions are computed lazily and cached, so there is no edge.
- **Chunks**: workers build terrain meshes for a quadtree of LOD nodes and instance
  lists for props (buildings, trees, lights, pylons). Results transfer as typed arrays.
- **Floating origin**: physics keeps double-precision world coordinates. The renderer
  subtracts an origin that re-centres on the aircraft, so GPU floats stay small.

## Rendering, UI, audio

- Terrain quadtree with skirts, vertex-coloured biomes, distance fog matched to the sky.
- Instanced props in cell layers with their own view radii and distance fade.
- Water plane with analytic waves, fresnel sky reflection and sun glint.
- Procedural aircraft built from primitives per spec.
- HUD and menus as a DOM/canvas overlay; minimap samples the world functions directly.
- Audio graph per aircraft: blade-pass thump, turbine whine, wind, warnings.

## Verification

- `npm test`: Vitest physics and world tests (headless, scripted inputs).
- `npm run e2e`: Playwright loads the built game, checks console errors and frame
  rate, drives a flight, and saves screenshots.

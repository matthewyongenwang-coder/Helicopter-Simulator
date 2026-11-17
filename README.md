# Helicopter Simulator

A browser helicopter flight simulator with an infinite, seeded open world. Six aircraft,
a 6-DOF flight model running at a fixed 120 Hz, and an autohover system that only ever
moves the same controls the pilot has. Everything you see and hear is generated: there
are no downloaded models, textures or audio files.

Built with Three.js, TypeScript and Vite.

## Running it

```bash
npm install
```

```bash
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173). Pick an aircraft and a
helipad in the menu and press **Fly**.

Other scripts:

| Command | What it does |
|---|---|
| `npm run build` | Typecheck and build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Physics and world tests (Vitest, headless) |
| `npm run e2e` | Load the game in headless Chromium, fly it, check frame rate and errors, save screenshots to `tests/e2e/out/` |

URL parameters: `?seed=K7M2-QX9` (any text works), `quality=low|medium|high`,
`aircraft=scout|utility|medium|heavy|attack|rescue`, `weather=clear|fair|overcast|rain|storm|fog|snow`,
`hour=0–24`, `autostart=1` (skip the menu).

## Flying

No key moves the helicopter directly. The keys change the collective (rotor thrust) and
the attitude of the aircraft; all motion comes from where the thrust points.

| Key | Action |
|---|---|
| **J** | Engine start / stop. The rotor takes about 15 s to reach the green. |
| **Space** / **Shift** | Raise / lower the collective. The lever stays where you leave it. |
| **W** / **S** | Pitch nose down / up |
| **A** / **D** | Roll left / right |
| **Q** / **E** | Yaw left / right |
| **X** | Autohover on / off |
| **B** | Wheel brake (wheeled aircraft) |
| **L** | Landing light |
| **C** | Chase / cockpit camera |
| **V** (hold) or mouse drag | Free look |
| **M** | Minimap zoom |
| **H** or **F1** | Controls overlay (rebind any key here) |
| **R** | Respawn at the last helipad you landed on |
| **Esc** / **P** | Menu (with Resume) |
| **`** | Debug read-out |

Your first flight:

1. Press **J** and keep the collective down while the rotor spools up. The NR gauge turns green.
2. Hold **Space** until the aircraft lifts off, then press **X**. Autohover levels it and holds the hover.
3. Hold **W** to fly forward. Let go and autohover leans back, brakes and stops.
4. To land, give **Shift** short pushes to step down, and let autohover hold each new height.

With autohover off, the aircraft does exactly what you tell it. A tilt you leave in stays,
and the aircraft keeps accelerating. Raising the collective also yaws the nose (torque),
so you need a little **Q**/**E** to hold heading. Things to watch for:

- **Low rotor RPM**: pulling more collective than the engine can drive droops the rotor.
- **Vortex ring state**: descending steeply and slowly into your own downwash loses lift.
- **Retreating blade stall**: too fast for the rotor causes vibration, then a roll and pitch-up.
- **Autorotation**: with the engine out, lower the collective to keep the rotor turning and flare at the bottom.
- **Hard landings** damage the airframe; rotor or tail strikes and crashes destroy it.

## Aircraft

| | Role | Character |
|---|---|---|
| Wasp | Light scout | Nimble and twitchy, easy to over-correct |
| Mule | Utility transport | Two-bladed, steady, slow |
| Nightjar | Medium assault | The all-rounder |
| Atlas | Heavy lift | Huge, sluggish, very powerful |
| Shrike | Attack | Agile and tough |
| Petrel | Rescue / medevac | Fast, long range |

The menu compares their specs in a table. Climb rate, hover ceiling and range are
computed from the flight model, not typed in.

## The world

Every launch gets a random seed, shown at the top left; the same seed always builds the
same world. Terrain, rivers, lakes and biomes come from layered noise. Settlements range
from hamlets to cities with skyscraper downtowns, joined by roads with bridges, and there
are forests, helipads, power lines, wind farms and boats. Terrain is meshed in Web Workers,
streamed as a level-of-detail quadtree, and drawn around a floating origin, so there is
no edge and no precision jitter.

Weather is either changing (it blends between presets) or fixed in the menu: clear,
fair, overcast, rain, storm (with lightning and thunder), fog or snow. A day passes in
48 minutes. Wind veers and gusts, and the air is rougher over mountains and cities,
bumpy with thermals over sunny land, and calmer over water.

## Architecture

```
src/data/    Plain data: aircraft, visuals and sound, tuning, world-gen, weather, graphics, bindings
src/sim/     Flight physics. Pure TypeScript, no DOM or Three.js, fixed 120 Hz
src/world/   World generation. Pure functions of (seed, x, z); runs in workers, the main thread and tests
src/render/  Three.js: engine and floating origin, terrain, props, water, sky, clouds, effects, models, cameras
src/ui/      Menu, HUD, minimap, controls overlay
src/audio/   Web Audio synthesis
src/game/    Orchestration: frame loop, input, settings, weather, spawn and respawn
```

Dependencies only point down that list. The flight model sees the world through one small
`Environment` interface (surface height, wind, air density, obstacles), so the tests can
fly it over flat ground with scripted key presses.

- **Flight model**: blade-element rotor thrust with dynamic inflow, momentum-theory induced
  flow with an empirical descent branch (which gives translational lift, vortex ring state
  and autorotation), ground effect, retreating-blade stall, a governed engine and rotor-speed
  state, tail-rotor anti-torque, rate-command attitude, drag and wind, fuel burn, and
  spring-damper gear contact.
- **Autohover**: a cascaded controller that writes only to the pilot's own channels
  (attitude-rate commands, the collective lever, pedal trim). Each axis is handed back while
  its key is held.
- **Rendering**: terrain quadtree with skirts and cloud shadows; instanced buildings and
  trees with lit windows at night; analytic water with fresnel sky reflection; a ray-marched
  cloud layer; sun shadows around the aircraft; a sky environment map for reflections;
  particles for downwash, smoke, fire, rain and snow; a rotor that cones under load and leads
  the fuselage when you move the cyclic.
- **Audio**: blade slap from noise modulated at each aircraft's blade-passing frequency,
  turbine whine, gearbox rumble, wind and rain, alerts and impacts, all synthesised.

More detail is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). [PROGRESS.md](PROGRESS.md)
covers what was verified, the design decisions and the known issues.

## Tests

- `npm test` runs 101 Vitest tests: engine start, lift-off only in the green, manual flight
  without self-levelling, autohover from a steep tilt in under 2 s, each autohover axis,
  ground effect, translational lift, vortex ring, blade stall, autorotation, contact and
  damage, the six aircraft against each other, seeded worlds, settlements and bridges,
  weather and turbulence.
- `npm run e2e` checks the menu, every aircraft model, the HUD, weather, damage, the
  cockpit, rebinding, pause and resume, and the city, bridge and night scenes. It flies a
  165 kt streaming cruise and a real key-press playtest (start, lift off, hover, fly out,
  return and land on the pad), checks for leaks, and measures frame rate. Add `--soak=300`
  for a long flight that watches memory.

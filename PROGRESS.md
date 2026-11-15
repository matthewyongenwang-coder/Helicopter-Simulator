# Progress

## Milestone status

| # | Milestone | Status |
|---|---|---|
| 1 | Architecture + headless flight model, controls, autohover, physics tests | **In progress** |
| 2 | Terrain streaming, water, biomes, seed | Not started |
| 3 | Settlements, roads, bridges, forests, props | Not started |
| 4 | Six aircraft, models, spawn menu | Not started (spec data for all six already written) |
| 5 | HUD, cameras, audio, weather, day/night, damage, polish | Not started |
| 6 | Performance pass, playtest, README | Not started |

## Milestone 1 detail

Done:
- Project scaffold (Vite, TypeScript, Vitest, Playwright installed).
- `docs/ARCHITECTURE.md`.
- Data files: `src/data/aircraft.ts` (six aircraft), `tuning.ts`, `controls.ts`.
- Pure sim in `src/sim/`: maths, rotor aerodynamics (blade element + dynamic inflow,
  ground effect, vortex ring, retreating-blade stall), engine/governor/rotor speed,
  anti-torque, rate-command attitude, drag, gear and hull contact, damage, fuel,
  autohover, key-binding state, fixed 120 Hz `Simulation` with key-script replay.
- Type-check passes.

Checked only by exploratory scripts in `scratch/` (not yet by tests):
- Medium aircraft spools to the green in about 13.5 s, lifts off on Space, yaws right under torque.
- W with no collective change: nose down, sinks, accelerates; attitude stays after release.
- Autohover from 30° bank + 10 m/s drift + 2 m/s sink: level and still in about 1.8 s.

Not done:
- **No Vitest tests exist yet.** `tests/physics/` is empty. None of the listed flight
  behaviours is asserted by a test.
- No rendering, no `index.html`, nothing runs in a browser yet.
- Only the medium aircraft has been flown; the other five are derived but unflown.

## Decisions

- Pitch, roll and yaw are rate-command axes (control moment against rotor damping).
  Nothing returns the aircraft to level. A fin adds weathervaning in yaw at speed.
- Tail-rotor side force is left out so a level aircraft does not drift.
- Start sequence is torque-limited per aircraft so no weight can lift off below the green.
  Holding Space during the start stalls the spool-up until the lever is lowered.
- Autohover may use more cyclic authority than the keyboard (data: `autohover.authority`).
  It needs RPM in the green to engage, then rides through droop down to 86 %.
- Autohover keeps some airspeed while sinking fast, to avoid vortex ring state.
- Drag area is derived from the listed top speed; climb rate, ceiling and range shown
  in the menu will be computed from the model, not typed in.

## Known issues

- Autohover recovery margin against the 2 s target is thin (about 1.8 s on the medium).
- Holding W for 3 s pitches past vertical (36°/s, no limit). This follows the spec; revisit rates.
- Hands-off hover at 300 m yaws about 0.65°/s (pedal interlink is calibrated at sea level).
- Climb rates from the model (13–22 m/s) are higher than real aircraft of these classes.
- The GateGuard hook blocks the first write of every new file; each needs its facts stated first.

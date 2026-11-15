# Progress

## Milestone status

| # | Milestone | Status |
|---|---|---|
| 1 | Architecture + headless flight model, controls, autohover, physics tests | **Done** |
| 2 | Terrain streaming, water, biomes, seed | In progress |
| 3 | Settlements, roads, bridges, forests, props | Not started |
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

## Decisions

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

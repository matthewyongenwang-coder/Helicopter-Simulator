# Progress

## Milestone status

| # | Milestone | Status |
|---|---|---|
| 1 | Architecture + headless flight model, controls, autohover, physics tests | **Done** |
| 2 | Terrain streaming, water, biomes, seed | **Done** |
| 3 | Settlements, roads, bridges, forests, props | **Done** |
| 4 | Six aircraft, models, spawn menu | **Done** |
| 5 | HUD, cameras, audio, weather, day/night, damage, polish | **Done** |
| 6 | Performance pass, playtest, README | **Done** |
| 7 | Multiplayer (Cloudflare relay) and a bug and security sweep | **Done**, relay not yet deployed |

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

## Milestone 4

- `src/data/aircraft.ts`: six aircraft (Wasp scout, Mule utility, Nightjar medium, Atlas heavy-lift,
  Shrike attack, Petrel rescue). `src/data/aircraftVisual.ts`: how each one looks (lofted fuselage
  stations, pods, slabs, tail, rotor, gear, cockpit frame, eye point).
- `src/render/heliModel.ts`: builds each model from that data; rotor and tail-rotor blades with
  blur discs, nav lights, beacon, landing light, cockpit frame for the cockpit camera.
- `src/ui/menu.ts`: spawn menu with the aircraft list, a spec table comparing all six (15 rows,
  climb, ceiling and range computed from the flight model), start location (helipads near the
  start, or free flight), fuel and payload sliders, seed entry, graphics quality, controls.
- `src/render/cameras.ts`: chase, cockpit and menu orbit, with free look on any of them.
- `src/game/settings.ts`: settings and bindings saved to local storage.

Verified (`tests/physics/aircraft.test.ts`, 11 tests, and `npm run e2e`):

| Check | Result |
|---|---|
| Same inputs, different results | Pitch, roll, yaw, climb, fuel burn and damage all distinct across the six |
| Heavy-lift sluggish, scout nimble | Scout pitches over 3.5× and rolls over 3.5× as far as the heavy for the same key press; a quarter-second tap banks the scout over 15°, the heavy under 5° |
| Autohover on all, faster on light ones | Every aircraft settles from a 30° bank and 8 m/s drift; scout fastest, heavy slowest |
| Each starts and lifts off only in the green | Pass for all six, including empty with Space held through the start |
| Menu | Six aircraft, spec table, helipads and free flight, seed shown, Fly starts the chosen aircraft |

## Milestone 5

- `src/ui/hud.ts`: heading tape, attitude indicator (pitch ladder, bank scale, yaw-rate bar),
  airspeed and ground speed, barometric and radar altitude, vertical speed, rotor RPM with the
  green band, torque with the 100 % mark, collective, fuel, engine state, airframe health,
  autohover and warning pills, context hints that follow the start sequence, crash banner.
- `src/ui/minimap.ts`: north-up moving map. Terrain tiles are hill-shaded in the chunk workers
  (`buildMapTile`) and cached at three zoom levels; roads, towns, helipads, the respawn point and
  a wind arrow are drawn on top.
- `src/ui/overlays.ts`: controls overlay with every binding grouped, click-to-rebind, reset to
  defaults. Opening it pauses the flight. Esc in flight opens the menu with Resume.
- `src/game/weather.ts`, `src/data/weather.ts`: seven presets (clear, fair, overcast, rain, storm,
  fog, snow), blended over 90 s in "changing" mode; wind that veers; lightning with thunder
  delayed by distance; a day clock (2 real minutes per hour). Wind and gusts feed the flight
  model, plus **turbulence that varies by area**: mechanical turbulence over rough terrain and
  city blocks (scaled by wind), daytime thermals over land, calmer air over water, all fading
  with height above the ground.
- `src/render/clouds.ts`: a ray-marched cumulus layer (flat bases, noise-driven tops) seen from
  below, inside and above, lit by the sun with a self-shadowing term, drifting with the wind.
  The terrain shader casts the same cloud field's shadows on the ground.
- `src/render/effects.ts`: rotor downwash (dust coloured by the ground under the aircraft,
  spray over water, little over paving), engine smoke under 60 % health and fire under 30 %,
  explosion and burning wreck, rain streaks stretched by the camera's own motion, snow.
- Lighting: sun shadows around the aircraft (2048–4096 map), sky environment map regenerated
  every 2 s for reflections on the aircraft, wreck scorching.
- Rotor: blades droop at rest and cone up with thrust/weight as RPM rises; the disc leads the
  fuselage toward the commanded rate (flapping); textured blur disc with a tip-path ring.
- Cockpit: glass displays on the panel, eyes resting slightly below the horizon.
- `src/audio/audio.ts`: Web Audio synthesis. Blade slap is noise amplitude-modulated by a pulse
  train at the blade-passing frequency of each aircraft (its rotor speed and blade count), louder
  with blade load, airspeed and descent through the wake. Turbine whine follows a lagged gas
  generator speed; gearbox rumble; wind; rain; cockpit muffling; low-rotor horn; master caution;
  autohover tones; impacts; explosion; thunder.

Verified (`tests/world/weather.test.ts`, 9 tests, and `npm run e2e`):

| Check | Result |
|---|---|
| Weather is deterministic per seed and blends without jumps | Pass; cover never moves more than 3 % in a second |
| Storms make lightning, clear skies do not | Pass |
| Turbulence by area | Mountains over 3× plains, city over 2× plains, water calmest, fades to under 20 % by 600 m |
| Thermals | Present over sunny land by day, zero at night |
| Storm wind reaches the flight model | 13–17 m/s with 6 m/s gusts in the environment the sim reads |
| HUD, crash banner, respawn, cockpit camera, controls overlay, rebinding, reset, minimap zoom, pause and resume | All pass in the browser |
| Frame rate with clouds, shadows, particles, rain | 60 fps in every shot, no console errors |
| Memory | Same trip twice costs the same GPU geometry count (304 and 304) |

## Milestone 6

- `Game.cpuMs`: main-thread time per frame (sim, streaming, effects, render submission), shown
  in the debug read-out (`` ` ``) and reported by the end-to-end run.
- Playtest in the browser with real key presses (`npm run e2e`): from a town heliport, J starts
  the engine (13.5 s to the green), Space lifts off, X settles the hover, holding W flies forward
  at 20 m/s, releasing it brakes to a hover, cyclic pulses fly back over the pad, and short
  Shift pushes let down onto it: landed on the helipad 3.6 m from the start point at 1.4 m/s,
  airframe undamaged.
- Soak (`npm run e2e -- --soak=300`): a 5-minute, 21 km flight at 70 m/s, turning every 20 s,
  with the weather cycling 15× faster than normal.
- `README.md`: running, controls, a first-flight guide, aircraft, world, architecture, tests.

Verified:

| Check | Result |
|---|---|
| Main-thread time per frame | 2.5–3.4 ms (medium and low), leaving most of the frame for the GPU |
| Frame rate | 60 fps in every scene on medium and low, including storm, fog, snow, above the clouds, a city at night and a 165 kt cruise |
| Low preset | 0.2–0.5 M triangles against 1.6 M on medium; no clouds or shadows; no errors |
| Memory over a long flight | JS heap 54–76 MB with no trend (middle third 63 MB, last third 68 MB); GPU geometries level off near 500; 7 textures throughout |
| Production build | `npm run build` passes, 205 KB gzipped plus a 29 KB worker |
| Unit tests | 101 passing |

## Milestone 7: multiplayer

- `relay/`: a Cloudflare Worker with one Durable Object per room. The room is the world
  seed. It stamps and fans out messages, keeps the wrecks for late joiners, forgets them
  when the room empties, and uses WebSocket hibernation.
- `src/net/`: the wire format and validators (shared with the relay), a reconnecting
  client, and the pose buffer that smooths other aircraft.
- `src/game/multiplayer.ts`, `src/render/remoteView.ts`, `src/ui/pilotTags.ts`: other
  pilots' aircraft, callsign tags, minimap arrows, their effects, and shared wrecks.
- Menu: callsign, Play online / Go offline, Copy invite link. `?online=1` joins on load.
- Compounds rebuild 120 s after they fall. The relay forgets a fallen compound after the
  same time (`WRECK_MEMORY`, tested equal to `COMPOUNDS.respawnTime`), sends joiners each
  wreck's age so it rebuilds for them on the same schedule, and clears a fallen compound's
  parts so kills on the rebuilt one are shared again.

Verified:

| Check | Result |
|---|---|
| Relay (`node tests/net/relay.mjs`, local `wrangler dev`) | 12/12: welcome, join, leave, stamped and cleaned relay, bad poses dropped, wreck kept once, late joiner gets wrecks, empty room resets, rate limit and flood cut-off |
| Two browsers (`node tests/e2e/multiplayer.mjs`) | 14/14: each sees the other at the right place (0.1 m off at 40 m), name tag, wreck shared, compound falls live for the other, credited only to the pilot who did it, late joiner sees the ruin, leaving and going offline, no console errors |
| Unit tests | 135 pass, including smoothing, message validation, and wrecks from other pilots |

## Pilot against pilot

- Shooter decides: bullets and missiles are tested against where the shooter's game draws
  the other aircraft; hits are summed and sent every 0.1 s (`hit`); the target's game
  applies them, scaled by its own aircraft's fragility, and on going down sends `kill` with
  the last pilot to hit it within 15 s. Tuning is in `PVP` in `src/data/weapons.ts`.
- The seeker prefers a pilot in its cone over compound parts; the launch names the target
  (`launch.at`) so their game sounds the missile warning; their flares, relayed, can decoy it.
- The gunsight ranges on an aircraft on the sight line, so the turret's drop compensation
  matches the target, not the ground behind it.
- Mid-air collisions are checked by each game for its own aircraft (rotor discs meeting, or a
  knock faster than 6 m/s). Two aircraft on the ground only nudge apart; 5 s spawn grace.
- Markers over pilots within 3 km (`PVP.markerRange`).

Verified: 5 new unit tests (gun hits, lock and missile kill, launch names the target,
flare decoy, no hits on a wreck); the two-browser test adds 9 checks (marker at 60 m and
2.5 km, none at 4 km, hit damages the target, lock warning, shot down by name, "You shot
down Bravo", wreck not hittable, mid-air collision).

## Sweep (bugs, logic, security)

| Found | Fix |
|---|---|
| `?aircraft=constructor` or `?weather=toString` crashed the game at start (inherited object keys passed the lookups); a peer could do the same to everyone with `"a":"toString"` | Own-key checks (`Object.hasOwn`) for URL parameters, saved settings and network ids; regression test |
| A world-generation error inside a worker left that worker busy forever, so terrain could stop streaming and the game hang on "Generating world" | The worker always answers (an `error` reply), the pool frees the worker and logs it, and worker crashes are handled too |
| `?hour=` and saved hours were not range-checked | Only 0 to 24 (or the default) accepted |
| Relay open to floods and unbounded storage | Per-socket rate limits, disconnect past 400 messages a second, caps on stored wrecks, optional `ALLOWED_ORIGINS` |
| Hidden tabs piled up incoming poses | Pose backlog capped; wreck events always kept |
| Peer could force a model rebuild every update by alternating aircraft | At most one swap a second per pilot |
| No security headers on the Vercel site | `vercel.json`: nosniff, referrer policy, frame options, permissions policy |

Checked and fine: no `innerHTML` or `eval` anywhere (all text goes through `textContent`),
saved settings are validated field by field, `npm audit` reports no vulnerabilities in either
package, and the relay address is fixed at build time.

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
- **The playtest flies from a town pad, not downtown.** Flying forward at 40 m between
  skyscrapers ends in a rotor strike, which the sim correctly reports; a scripted pilot has no
  eyes, so it takes off where the air around the pad is clear.
- **The playtest waits in simulated time.** The browser can advance the sim slower than the
  wall clock when frames are slow, so key holds measured in real milliseconds flew different
  flights on different runs. Holding W for 4 simulated seconds gives the same 20 m/s every time.
- **The weather drives the clock and the sky.** Tests that need a time of day set
  `weather.hour`, not the sky directly.
- **Aircraft shadow only below 350 m.** The sun's disc blurs a small aircraft's shadow away above
  that, and it keeps the shadow map focused where it matters, on landing.
- **Area turbulence goes through the same gust field** as the weather's gusts, so it is felt as
  real disturbances in the 6-DOF model, and autohover fights it like any other gust.
- **"Loses authority at low speed"** is implemented two ways: tail-rotor thrust scales with
  rotor RPM², and it is less effective in the hover than in forward flight.

## Known issues

- The 2 s autohover figure depends on the entry state. On the medium, 10 m/s drift takes
  about 2.0 s and 12 m/s about 2.3 s. Engine power sets the limit, not the controller.
- With autohover off, holding W for 3 s pitches past vertical (36°/s, no limit). This is what
  the brief specifies.
- A hands-off hover away from sea level yaws slowly (about 0.6°/s at 300 m) because the pedal
  interlink is calibrated at sea level and standard weight.
- Wind pushes the aircraft only through fuselage drag, so a 20 kt wind needs about 0.3° of lean.
  Real rotors add flapback; that is left out to keep attitude purely pilot-driven.
- Climb rates from the model (14–23 m/s) are higher than real aircraft of these classes.
- The GateGuard hook blocks the first write of every new file until its facts are stated.
- The full `npm run e2e` takes over ten minutes because of the cruise, playtest and leak
  checks. `--cruise=0 --playtest=0 --world=0` gives a quick run.
- Performance has only been measured on an Apple M3 Pro. The main-thread budget suggests a
  mid-range laptop will manage, but the low preset is the fallback if it does not.
- Cloud edges show some fine grain at grazing angles (a short ray march without temporal
  accumulation).
- Rain and snow do not yet stop under bridges or roofs.
- Multiplayer: each pilot's compounds shoot only at that pilot; other aircraft make no
  engine sound. PvP hits are decided by the shooter's game, so a modified client could
  cheat; fine among friends, not for strangers.
- The relay is not deployed yet: it needs a Cloudflare account (`npx wrangler login`), then
  `VITE_RELAY_URL` set in Vercel. Until then the menu says multiplayer needs a relay.

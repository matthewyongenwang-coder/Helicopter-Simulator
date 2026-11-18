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
`aircraft=scout|utility|medium|heavy|attack|rescue`, `weather=clear|fair|gale|mist|overcast|showers|rain|storm|fog|snow`,
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
| **N** | Night vision (white phosphor) |
| **C** | Chase / cockpit camera |
| Mouse | Look around: click the view once and the camera follows the mouse. **Esc** frees the cursor. |
| **V** | Centre the view |
| **M** | Minimap zoom |
| **H** or **F1** | Controls overlay (rebind any key here) |
| Left click / **F** | Fire the gun (hold) |
| Right click / **G** | Fire a missile (hold to ripple-fire) |
| **K** | Release flares |
| **R** | Respawn at the last helipad you landed on |
| **Esc** / **P** | Menu (with Resume) |
| **`** | Debug read-out |

Your first flight:

1. Press **J** and keep the collective down while the rotor spools up. The NR gauge turns green.
2. Hold **Space** until the aircraft lifts off, then press **X**. Autohover levels it and holds the hover.
3. Hold **W** to fly forward. Let go and autohover leans back, brakes and stops.
4. To land, give **Shift** short pushes to step down, and let autohover hold each new height.

With autohover off, the aircraft does exactly what you tell it. A tilt you leave in stays,
and the aircraft keeps accelerating. The flight model is built for flying hard, not for
procedure: the rotor holds 100 % whatever you do with the lever, pulling past the engine's
power just tops out the lift, the nose never yaws on its own when you move the collective,
and there is no vortex ring state, retreating-blade stall or overtorque. Loops, rolls and
full-collective pull-ups are all fair game. What still matters:

- **Autorotation**: with the engine out, lower the collective to keep the rotor turning and flare at the bottom.
- **Hard landings** damage the airframe; rotor or tail strikes and crashes destroy it.

The card at the top left shows the time of day on a sun and moon dial, the weather (with
the change under way, if one is), and the wind.

## Aircraft

| | Role | Character |
|---|---|---|
| Wasp | Light scout | Nimble and twitchy, easy to over-correct |
| Mule | Utility transport | Two-bladed, steady, slow |
| Nightjar | Medium assault | The all-rounder |
| Atlas | Heavy lift | Huge, sluggish, very powerful |
| Shrike | Attack | Agile and tough |
| Mantis | Heavy gunship | Heavier, 24 missiles |
| Petrel | Rescue / medevac | Fast, long range |

The menu compares their specs in a table. Climb rate, hover ceiling and range are
computed from the flight model, not typed in.

## Combat

Hostile compounds are scattered through the countryside, away from towns and roads. Each is
a walled outpost (command post, barracks, fuel, ammunition, trucks, guard towers) defended
by machine-gun nests, often a flak gun, and usually a surface-to-air missile launcher with
its radar. Red diamonds mark them on screen and on the minimap. Come within about 1.1 km and
the machine guns open up; flak reaches 1.7 km; the SAM site locks on out to 3.3 km once you
are more than 14 m above the ground and it can see you. Hills block their line of sight, so
low, terrain-masked flight is the way in.

| Aircraft | Weapons | Flares |
|---|---|---|
| Wasp | 12.7 mm gun pods, 2 missiles | 30 |
| Nightjar | 20 mm turret, 4 missiles | 60 |
| Shrike | 30 mm chin turret, 8 missiles | 60 |
| Mantis | 30 mm chin turret, 24 missiles | 90 |
| Mule, Atlas, Petrel | Unarmed | 30–90 |

The reticle shows where you are aiming: the guns fire where you look (turrets traverse,
fixed pods only a little). Hold the reticle near a target and the missile seeker locks on
(the box closes and turns red); a missile fired without a lock flies to the reticle. Hold the missile button to
ripple-fire: the Mantis empties all 24 rails in about five seconds. When a
SAM launches you hear a fast warning tone and see a red tick around the reticle pointing at
it. Press **K** to dump flares, which pull most missiles off. Parts of a compound burn and
blow up as you hit them, and fuel and ammunition take their neighbours with them. Break it
below 40 % and the whole compound goes up, then burns for minutes under a column of smoke.
A missile's blast also shakes the whole compound, so two or three well-placed missiles bring
one down. Put the reticle on a compound (or lock a missile onto it) and a card at the top of
the screen names it and shows its strength, marked **Raiding** while it stands and
**Secured** once it falls. Two minutes after it falls the enemy moves back in: once you are
more than 1.2 km away the compound is rebuilt at full strength, and a **reoccupied** notice
tells you it is hostile again.

**Supply points** (a green cross on a painted apron, crates and a blinking green beacon;
green tiles on the minimap, and a green marker on screen for the nearest) stand in open
fields every few kilometres, well out of reach of the compounds. The helipad you start from
is one too. Land inside the ring and stay put: after a second the ground crew patches the
airframe (fully in about 20 s, tail rotor included), fills the tanks and reloads the gun,
missiles and flares. The card at the top of the screen shows their progress.

## The world

Every launch gets a random seed, shown at the top left; the same seed always builds the
same world. Terrain, rivers, lakes and biomes come from layered noise. Settlements range
from hamlets to cities with skyscraper downtowns, joined by roads with bridges, and there
are forests, helipads, power lines, wind farms and boats. Terrain is meshed in Web Workers,
streamed as a level-of-detail quadtree, and drawn around a floating origin, so there is
no edge and no precision jitter.

Weather is either changing (a new spell every one to three minutes, blended over 40
seconds) or fixed in the menu: clear, fair, gale, mist, overcast, showers, rain, storm
(with lightning and thunder), fog or snow. No two spells are drawn quite alike, and
within one the cloud, haze, gusts and rain swell and ease; showers come and go. A day
passes in about 12 minutes, with nights running faster than daylight. Wind veers and
gusts, and the air is rougher over mountains and cities, bumpy with thermals over sunny
land, and calmer over water.

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
  flow with an empirical descent branch (which gives translational lift and autorotation),
  ground effect, an ideal governor that holds rotor speed while the engine runs (excess
  demand caps thrust instead), rate-command attitude and yaw, drag and wind, fuel burn, and
  spring-damper gear contact.
- **Night vision**: the scene is drawn into a linear HDR target, then amplified with an
  auto-gain, given grain, halos around bright lights and an eyepiece vignette, and written
  out in white phosphor.
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

- `npm test` runs 123 Vitest tests: engine start, lift-off only in the green, manual flight
  without self-levelling, a full loop with no warning, autohover from a steep tilt in under
  2 s, each autohover axis, ground effect, translational lift, no rotor droop at full
  collective, autorotation, contact and
  damage, the seven aircraft against each other, seeded worlds, settlements and bridges,
  weather and turbulence, compound placement, aiming and missile lock, enemy fire, flares,
  destroying a compound, its rebuild, and ripple fire.
- `node tests/e2e/combat.mjs` flies the Shrike at a compound in headless Chromium: it is
  engaged, dodges a SAM with flares, destroys the compound with guns and missiles, and
  saves screenshots of the explosion to `tests/e2e/out/`.
- `npm run e2e` checks the menu, every aircraft model, the HUD, weather, damage, the
  cockpit, rebinding, pause and resume, and the city, bridge and night scenes. It flies a
  165 kt streaming cruise and a real key-press playtest (start, lift off, hover, fly out,
  return and land on the pad), checks for leaks, and measures frame rate. Add `--soak=300`
  for a long flight that watches memory.

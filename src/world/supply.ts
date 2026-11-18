import { SUPPLY } from '../data/weapons';
import { compoundsNear } from './compounds';
import { hash2, rng } from './rng';
import type { World } from './world';

/**
 * Supply points: a painted landing apron in a cleared field, with ammunition,
 * fuel and a ground crew. Land inside the zone and stay put to be repaired,
 * refuelled and rearmed. Placement is a pure function of the seed.
 */

export interface SupplySite {
  /** Stable key: the generation cell (or 'home'). */
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** A painted apron with crates around it; the home pad is a heliport and has neither. */
  field: boolean;
}

const NAMES = ['Kestrel', 'Osprey', 'Heron', 'Falcon', 'Merlin', 'Harrier', 'Plover', 'Curlew', 'Swift', 'Wren', 'Raven', 'Lark', 'Petrel', 'Tern', 'Egret', 'Finch', 'Robin', 'Shrike', 'Condor', 'Kite'];

/** Level, dry, open ground away from buildings, roads and compounds? */
function siteOk(world: World, x: number, z: number): boolean {
  const h0 = world.height(x, z);
  if (h0 < 3 || h0 > 1300) return false;
  let lo = h0, hi = h0;
  for (const r of [SUPPLY.radius * 0.6, SUPPLY.radius * 1.2]) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const h = world.height(x + Math.cos(a) * r, z + Math.sin(a) * r);
      if (h < 1.5) return false;
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
  }
  if (hi - lo > SUPPLY.maxRelief) return false;
  if (world.density(x, z) > 0.002) return false;
  const road = world.roadAt(x, z);
  if (road && road.d < road.road!.halfWidth + SUPPLY.propRing + SUPPLY.roadClear) return false;
  if (compoundsNear(world, x, z, SUPPLY.compoundClear).length) return false;
  return true;
}

/** The supply point in generation cell (i, j), or null if the cell holds none. */
export function supplyInCell(world: World, i: number, j: number): SupplySite | null {
  const seed = world.seed ^ 0x5a99e7;
  if (hash2(i, j, seed) / 4294967296 >= SUPPLY.chance) return null;
  const rand = rng(hash2(i, j, seed + 11));
  const C = SUPPLY.cell;
  for (let t = 0; t < 8; t++) {
    const x = (i + 0.15 + rand() * 0.7) * C;
    const z = (j + 0.15 + rand() * 0.7) * C;
    if (!siteOk(world, x, z)) continue;
    return {
      id: `${i}:${j}`,
      name: `Supply ${NAMES[hash2(i, j, seed + 3) % NAMES.length]}`,
      x, z, y: Math.max(0, world.height(x, z)),
      yaw: rand() * Math.PI * 2,
      field: true,
    };
  }
  return null;
}

/** Every supply point within `range` of a point. `cache` keeps generated cells between calls. */
export function suppliesNear(world: World, x: number, z: number, range: number, cache?: Map<string, SupplySite | null>): SupplySite[] {
  const C = SUPPLY.cell;
  const out: SupplySite[] = [];
  for (let j = Math.floor((z - range) / C); j <= Math.floor((z + range) / C); j++) {
    for (let i = Math.floor((x - range) / C); i <= Math.floor((x + range) / C); i++) {
      const key = `${i}:${j}`;
      let site = cache?.get(key);
      if (site === undefined) {
        site = supplyInCell(world, i, j);
        cache?.set(key, site);
      }
      if (site && Math.hypot(site.x - x, site.z - z) <= range) out.push(site);
    }
  }
  return out;
}

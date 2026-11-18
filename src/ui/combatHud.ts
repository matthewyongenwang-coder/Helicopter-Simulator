import { compoundHealth, type Combat, type CombatEvent } from '../game/combat';
import { el } from './menu';

/** Screen position of a world point: pixels, and whether it is in front of the camera. */
export type Projector = (x: number, y: number, z: number) => { x: number; y: number; front: boolean };

export interface CombatHudFrame {
  combat: Combat;
  events: CombatEvent[];
  project: Projector;
  /** Reticle height as normalised device y. */
  aimNdcY: number;
  /** Camera forward on the ground plane (unit x, z), for threat bearings. */
  camFx: number;
  camFz: number;
  /** Aircraft position, for ranges. */
  x: number;
  y: number;
  z: number;
  flash: number;
  alive: boolean;
  keys: Record<string, string>;
}

const SVG = 'http://www.w3.org/2000/svg';
const MARKERS = 8;
const TICKS = 8;

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

const km = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

/**
 * The weapons layer of the HUD: the reticle and hit marker, the missile lock
 * box, markers over compounds, a target card, the weapons panel, threat ticks
 * round the reticle, and the flashes that go with being hit or a big blast.
 */
export class CombatHud {
  private reticle = el('div', { class: 'reticle', 'aria-hidden': 'true' });
  private hitMark: SVGElement;
  private threats: HTMLElement[] = [];
  private lockBox = el('div', { class: 'lockbox', 'aria-hidden': 'true' }, el('span', {}, 'LOCK'));
  private markers: { root: HTMLElement; label: HTMLElement }[] = [];
  private card = el('div', { class: 'target-card hud-panel', 'aria-live': 'polite' });
  private cardName = el('div', { class: 'name' });
  private cardMeta = el('div', { class: 'meta num' });
  private cardBar = el('i', {});
  private panel = el('div', { class: 'hud-weapons hud-panel' });
  private toast = el('div', { class: 'toast', role: 'status' });
  private flash = el('div', { class: 'screen-flash', 'aria-hidden': 'true' });
  private vignette = el('div', { class: 'hit-vignette', 'aria-hidden': 'true' });
  private hitTimer = 0;
  private hurt = 0;
  private lastPanel = '';
  private lastCard = '';
  private toastTimer = 0;

  constructor(root: HTMLElement) {
    const s = svg('svg', { viewBox: '-30 -30 60 60', width: 60, height: 60 });
    s.append(
      svg('circle', { class: 'ring', r: 13, 'stroke-dasharray': '16.4 4', transform: 'rotate(-58)' }),
      svg('circle', { class: 'dot', r: 1.6 }),
    );
    this.hitMark = svg('g', { class: 'hitmark' });
    for (const a of [45, 135, 225, 315]) this.hitMark.append(svg('line', { x1: 0, y1: 6, x2: 0, y2: 12, transform: `rotate(${a})` }));
    s.append(this.hitMark);
    this.reticle.append(s);
    for (let i = 0; i < TICKS; i++) {
      const t = el('i', { class: 'tick' });
      this.threats.push(t);
      this.reticle.append(t);
    }
    for (let i = 0; i < MARKERS; i++) {
      const label = el('span', { class: 'num' });
      const m = el('div', { class: 'marker', 'aria-hidden': 'true' }, el('b', {}), label);
      this.markers.push({ root: m, label });
      root.append(m);
    }
    this.card.append(this.cardName, this.cardMeta, el('div', { class: 'bar' }, this.cardBar));
    root.append(this.flash, this.vignette, this.reticle, this.lockBox, this.card, this.panel, this.toast);
  }

  /** Show a short message in the middle of the screen. */
  say(text: string, kind: 'ok' | 'info' | 'warn' = 'info'): void {
    this.toast.textContent = text;
    this.toast.className = `toast ${kind}`;
    // Restart the entrance even when the same message repeats.
    void this.toast.offsetWidth;
    this.toast.classList.add('on');
    this.toastTimer = 2.6;
  }

  update(f: CombatHudFrame, dt: number): void {
    const c = f.combat;
    for (const e of f.events) {
      if (e.type === 'hitConfirm') {
        this.hitTimer = e.kill ? 0.3 : 0.14;
        this.hitMark.classList.toggle('kill', e.kill);
      } else if (e.type === 'playerHit') this.hurt = Math.min(1, this.hurt + (e.missile ? 1 : 0.35 + e.amount * 8));
      else if (e.type === 'compoundDestroyed') this.say(`${e.compound.site.name} destroyed`, 'ok');
      else if (e.type === 'empty') this.say(e.weapon === 'gun' ? 'Gun empty' : e.weapon === 'missile' ? (c.loadout.missile ? 'No missiles left' : 'No missiles on this aircraft') : 'No flares left', 'warn');
    }
    this.hitTimer -= dt;
    this.hitMark.classList.toggle('on', this.hitTimer > 0);
    this.hurt *= Math.exp(-dt * 2.2);
    this.vignette.style.opacity = this.hurt.toFixed(3);
    this.flash.style.opacity = Math.min(0.85, f.flash).toFixed(3);
    this.toastTimer -= dt;
    if (this.toastTimer <= 0) this.toast.classList.remove('on');

    // Reticle: where the sight line points; red over a compound.
    this.reticle.style.top = `${((1 - f.aimNdcY) / 2) * 100}%`;
    this.reticle.classList.toggle('on-target', !!c.aim.compound);
    this.reticle.classList.toggle('dead', !f.alive);

    // Threat ticks round the reticle: compounds shooting, and missiles inbound (flashing).
    const rx = -f.camFz, rz = f.camFx;
    const dirs: [number, boolean][] = c.threats.map((b) => [b, false]);
    for (const m of c.missiles) if (m.enemy && m.target.kind === 'player') dirs.push([Math.atan2(m.x - f.x, m.z - f.z), true]);
    this.threats.forEach((t, i) => {
      const d = dirs[i];
      t.style.display = d ? '' : 'none';
      if (!d) return;
      const dx = Math.sin(d[0]), dz = Math.cos(d[0]);
      const a = Math.atan2(dx * rx + dz * rz, dx * f.camFx + dz * f.camFz);
      t.style.transform = `rotate(${a}rad) translateY(-30px)`;
      t.classList.toggle('missile', d[1]);
    });

    this.updateLock(f);
    this.updateMarkers(f);
    this.updateCard(f);
    this.updatePanel(f);
  }

  private updateLock(f: CombatHudFrame): void {
    const L = f.combat.lock;
    const p = L.part;
    const s = p && f.alive ? f.project(p.cx, p.cy, p.cz) : null;
    if (!p || !s || !s.front) {
      this.lockBox.style.display = 'none';
      return;
    }
    this.lockBox.style.display = '';
    // The box closes in on the target as the seeker settles.
    const size = 26 + 40 * (1 - L.progress);
    this.lockBox.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
    this.lockBox.style.width = this.lockBox.style.height = `${size}px`;
    this.lockBox.classList.toggle('locked', L.locked);
  }

  private updateMarkers(f: CombatHudFrame): void {
    const W = window.innerWidth, H = window.innerHeight, pad = 28;
    const list = f.combat.active.filter((c) => !c.destroyed).sort((a, b) => a.dist - b.dist);
    this.markers.forEach((m, i) => {
      const c = list[i];
      if (!c || !f.alive) {
        m.root.style.display = 'none';
        return;
      }
      const s = f.project(c.site.x, c.site.y + 22, c.site.z);
      let x = s.x, y = s.y;
      const off = !s.front || x < pad || x > W - pad || y < pad || y > H - pad;
      if (off) {
        // Pin to the screen edge in the compound's direction.
        let dx = x - W / 2, dy = y - H / 2;
        if (!s.front) {
          dx = -dx;
          dy = -dy;
        }
        const k = Math.min((W / 2 - pad) / Math.max(1e-3, Math.abs(dx)), (H / 2 - pad) / Math.max(1e-3, Math.abs(dy)));
        x = W / 2 + dx * k;
        y = H / 2 + dy * k;
      }
      m.root.style.display = '';
      m.root.style.transform = `translate(${x}px, ${y}px)`;
      m.root.classList.toggle('edge', off);
      m.root.classList.toggle('hot', c.engaged);
      m.label.textContent = km(c.dist);
    });
  }

  private updateCard(f: CombatHudFrame): void {
    const c = f.combat.aim.compound ?? f.combat.lock.compound;
    if (!c || !f.alive) {
      this.card.classList.remove('on');
      return;
    }
    const part = f.combat.aim.part ?? f.combat.lock.part;
    const health = compoundHealth(c);
    const d = Math.hypot(c.site.x - f.x, c.site.z - f.z);
    const key = `${c.site.id}|${part?.type.name}|${Math.round(health * 100)}|${Math.round(d / 50)}`;
    this.card.classList.add('on');
    if (key === this.lastCard) return;
    this.lastCard = key;
    this.cardName.textContent = c.site.name;
    this.cardMeta.textContent = `${part ? `${part.type.name} · ` : ''}${km(d)}`;
    this.cardBar.style.width = `${health * 100}%`;
    this.cardBar.className = health > 0.5 ? '' : health > 0.2 ? 'mid' : 'low';
  }

  private updatePanel(f: CombatHudFrame): void {
    const c = f.combat, L = c.loadout, k = f.keys;
    const key = `${c.gunAmmo}|${c.missilesLeft}|${c.flaresLeft}|${c.destroyedCount}|${c.lock.locked}|${k.fireGun}|${k.fireMissile}|${k.flares}|${L === c.loadout}`;
    if (key === this.lastPanel) return;
    this.lastPanel = key;
    const rows: HTMLElement[] = [];
    const row = (label: string, value: HTMLElement | string, hint: string, low: boolean) =>
      el('div', { class: `wrow${low ? ' low' : ''}` }, el('span', { class: 'label' }, label), typeof value === 'string' ? el('b', { class: 'num' }, value) : value, el('kbd', {}, hint));
    if (L.gun) rows.push(row('Gun', String(c.gunAmmo), `Click · ${k.fireGun}`, c.gunAmmo < L.gun.ammo * 0.15));
    if (L.missile) {
      const pips = el('b', { class: 'pips' });
      for (let i = 0; i < L.missile.rails.length; i++) pips.append(el('i', { class: i < c.missilesLeft ? 'full' : '' }));
      rows.push(row(c.lock.locked ? 'Missile · Lock' : 'Missile', pips, `Right click · ${k.fireMissile}`, c.missilesLeft === 0));
    }
    rows.push(row('Flares', String(c.flaresLeft), k.flares, c.flaresLeft < L.salvo * 2));
    if (!L.gun && !L.missile) rows.push(el('div', { class: 'note' }, 'Unarmed · flares only'));
    if (c.destroyedCount > 0) rows.push(el('div', { class: 'note' }, `Compounds destroyed · ${c.destroyedCount}`));
    this.panel.replaceChildren(...rows);
  }
}

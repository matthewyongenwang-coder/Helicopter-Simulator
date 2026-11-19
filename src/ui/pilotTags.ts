import { el } from './menu';

export interface PilotTag {
  name: string;
  x: number;
  y: number;
  z: number;
  dist: number;
  dead: boolean;
}

/** Tags are hidden beyond this range (the minimap still shows the pilot). */
const RANGE = 6000;

const km = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

/** Callsign and distance over each other pilot's aircraft. */
export class PilotTags {
  private tags: { root: HTMLElement; label: HTMLElement }[] = [];

  constructor(private root: HTMLElement) {}

  update(list: PilotTag[], project: (x: number, y: number, z: number) => { x: number; y: number; front: boolean }): void {
    while (this.tags.length < list.length) {
      const label = el('span', {});
      const r = el('div', { class: 'marker pilot', 'aria-hidden': 'true' }, el('b', {}), label);
      this.root.append(r);
      this.tags.push({ root: r, label });
    }
    const W = window.innerWidth, H = window.innerHeight;
    this.tags.forEach((t, i) => {
      const p = list[i];
      const s = p && p.dist < RANGE ? project(p.x, p.y + 6, p.z) : null;
      if (!p || !s || !s.front || s.x < 0 || s.y < 0 || s.x > W || s.y > H) {
        t.root.style.display = 'none';
        return;
      }
      t.root.style.display = '';
      t.root.style.transform = `translate(${s.x}px, ${s.y}px)`;
      t.root.classList.toggle('dead', p.dead);
      // textContent, never innerHTML: callsigns come from other players.
      t.label.textContent = `${p.name} · ${km(p.dist)}`;
    });
  }

  hide(): void {
    for (const t of this.tags) t.root.style.display = 'none';
  }
}

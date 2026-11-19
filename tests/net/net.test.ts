import { describe, expect, it } from 'vitest';
import { PoseBuffer } from '../../src/net/interp';
import { cleanName, cleanRoom, encodePose, isEvent, isPose } from '../../src/net/protocol';

const pose = (x: number, vx = 0, a = 'medium') => encodePose(a, x, 100, 0, 0, 0, 0, 1, vx, 0, 0, 1, 24);

describe('pose buffer', () => {
  it('blends between the updates either side of the draw time', () => {
    const b = new PoseBuffer(), out: number[] = [];
    b.push(0, pose(0, 10));
    b.push(0.1, pose(1, 10));
    b.sample(0.05, out);
    expect(out[0]).toBeCloseTo(0.5, 3);
    expect(out[1]).toBe(100);
  });

  it('follows the velocities: a cubic through both updates', () => {
    const b = new PoseBuffer(), out: number[] = [];
    // Accelerating from rest to 20 m/s over 0.1 s covers 1 m: the curve sits below the straight line early on.
    b.push(0, pose(0, 0));
    b.push(0.1, pose(1, 20));
    b.sample(0.025, out);
    expect(out[0]).toBeLessThan(0.25);
    expect(out[0]).toBeGreaterThan(0);
  });

  it('coasts briefly past the newest update, then holds', () => {
    const b = new PoseBuffer(), out: number[] = [];
    b.push(0, pose(0, 10));
    b.sample(0.1, out);
    expect(out[0]).toBeCloseTo(1, 3);
    b.sample(5, out);
    expect(out[0]).toBeCloseTo(3, 3);
  });

  it('snaps on a respawn instead of sweeping across the map', () => {
    const b = new PoseBuffer(), out: number[] = [];
    b.push(0, pose(0));
    b.push(0.1, pose(5000));
    expect(b.size).toBe(1);
    b.sample(0.05, out);
    expect(out[0]).toBe(5000);
  });

  it('starts over when the pilot changes aircraft', () => {
    const b = new PoseBuffer();
    b.push(0, pose(0));
    b.push(0.1, pose(0, 0, 'scout'));
    expect(b.size).toBe(1);
    expect(b.latest?.a).toBe('scout');
  });

  it('keeps rotations unit length and takes the short way round', () => {
    const b = new PoseBuffer(), out: number[] = [];
    b.push(0, encodePose('medium', 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0));
    // The same rotation written with the opposite sign: no spin on the way.
    b.push(0.1, encodePose('medium', 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, 1, 0));
    b.sample(0.05, out);
    expect(Math.hypot(out[3], out[4], out[5], out[6])).toBeCloseTo(1, 6);
    expect(Math.abs(out[6])).toBeCloseTo(1, 6);
  });

  it('gives distinct times to two updates in the same frame', () => {
    const b = new PoseBuffer(), out: number[] = [];
    b.push(1, pose(0, 10));
    b.push(1, pose(1, 10));
    expect(b.size).toBe(2);
    expect(Number.isFinite(b.sample(1.0005, out)?.t)).toBe(true);
    expect(out.every(Number.isFinite)).toBe(true);
  });
});

describe('messages', () => {
  it('accepts a real pose and rejects malformed ones', () => {
    expect(isPose(pose(1))).toBe(true);
    expect(isPose({ ...pose(1), s: [1, 2, 3] })).toBe(false);
    expect(isPose({ ...pose(1), s: [NaN, 0, 0, 0, 0, 0, 1, 0, 0, 0] })).toBe(false);
    expect(isPose({ ...pose(1), a: 'x'.repeat(100) })).toBe(false);
    expect(isPose(null)).toBe(false);
    expect(isPose('p')).toBe(false);
  });

  it('accepts known events only', () => {
    expect(isEvent({ t: 'ev', e: { k: 'part', id: '3:-4', i: 2 } })).toBe(true);
    expect(isEvent({ t: 'ev', e: { k: 'part', id: '3:-4', i: -1 } })).toBe(false);
    expect(isEvent({ t: 'ev', e: { k: 'part', id: '3:-4', i: 1.5 } })).toBe(false);
    expect(isEvent({ t: 'ev', e: { k: 'boom', x: 0, y: 0, z: 0, s: Infinity } })).toBe(false);
    expect(isEvent({ t: 'ev', e: { k: 'nuke' } })).toBe(false);
    expect(isEvent({ t: 'ev' })).toBe(false);
    expect(isEvent({ t: 'ev', e: { k: 'hit', to: 3, a: 0.25, c: 0.03, m: false } })).toBe(true);
    expect(isEvent({ t: 'ev', e: { k: 'hit', to: 3, a: 5, c: 0, m: false } })).toBe(false);
    expect(isEvent({ t: 'ev', e: { k: 'hit', to: 3, a: -0.1, c: 0, m: false } })).toBe(false);
    expect(isEvent({ t: 'ev', e: { k: 'hit', to: 0, a: 0.1, c: 0, m: false } })).toBe(false);
    expect(isEvent({ t: 'ev', e: { k: 'hit', to: 3, a: 0.1, c: 0, m: 'yes' } })).toBe(false);
    expect(isEvent({ t: 'ev', e: { k: 'kill', by: 2 } })).toBe(true);
    expect(isEvent({ t: 'ev', e: { k: 'kill', by: 'x' } })).toBe(false);
    expect(isEvent({ t: 'ev', e: { k: 'launch', x: 0, y: 0, z: 0, at: 4 } })).toBe(true);
    expect(isEvent({ t: 'ev', e: { k: 'launch', x: 0, y: 0, z: 0, at: -1 } })).toBe(false);
  });

  it('cleans callsigns and room codes', () => {
    expect(cleanName('<img src=x onerror=alert(1)>')).toBe('img srcx onerror');
    expect(cleanName('   ')).toBe('Pilot');
    expect(cleanName(42)).toBe('Pilot');
    expect(cleanName('Émilie_2')).toBe('Émilie_2');
    expect(cleanRoom('k7m2-qx9/../x')).toBe('K7M2-QX9X');
  });

  it('packs a pose small', () => {
    const p = encodePose('medium', 12345.678912, 345.6789, -9876.54321, 0.123456, 0.2, 0.3, 0.9, 12.3456, -1.2, 0.5, 0.98765, 24);
    expect(p.s[0]).toBe(12345.68);
    expect(p.s[3]).toBe(0.1235);
    expect(JSON.stringify(p).length).toBeLessThan(160);
  });
});

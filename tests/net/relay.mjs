// Two pilots against a running relay (`npm run dev` in relay/): join, see each other, share a wreck,
// a late joiner gets the wreck, and leaving is announced. Usage: node tests/net/relay.mjs [ws://localhost:8787]
const base = process.argv[2] ?? 'ws://localhost:8787';
const room = 'TEST-' + Math.random().toString(36).slice(2, 7).toUpperCase();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function pilot(name) {
  const ws = new WebSocket(`${base}/room/${room}`);
  const inbox = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
  const ready = new Promise((res, rej) => {
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'hi', name })); res(); };
    ws.onerror = rej;
  });
  return { ws, inbox, ready, send: (m) => ws.send(JSON.stringify(m)), find: (f) => inbox.find(f) };
}

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failed++; };

const a = pilot('Alpha');
await a.ready; await wait(200);
const b = pilot('Bravo<script>');
await b.ready; await wait(300);
const wa = a.find((m) => m.t === 'welcome'), wb = b.find((m) => m.t === 'welcome');
check(wa && wa.peers.length === 0, 'first pilot is welcomed alone');
check(wb && wb.peers.length === 1 && wb.peers[0].name === 'Alpha', 'second pilot sees the first');
check(a.find((m) => m.t === 'join' && m.name === 'Bravoscript'), 'join is announced with a cleaned name');

a.send({ t: 'p', a: 'scout', s: [1, 2, 3, 0, 0, 0, 1, 0, 0, 0], r: 1, f: 24, junk: 'x' });
a.send({ t: 'p', a: 'scout', s: [1, 2], r: 1, f: 0 });
a.send({ t: 'ev', e: { k: 'part', id: 'cmpA', i: 2 } });
a.send({ t: 'ev', e: { k: 'part', id: 'cmpA', i: 2 } });
a.send({ t: 'ev', e: { k: 'boom', x: 1, y: 2, z: 3, s: 1 } });
await wait(300);
const poses = b.inbox.filter((m) => m.t === 'p');
check(poses.length === 1 && poses[0].from === wa.id && !('junk' in poses[0]), 'valid pose relayed, stamped, extras dropped; bad pose dropped');
check(b.inbox.filter((m) => m.t === 'ev' && m.e.k === 'part').length === 1, 'part kill relayed once');
check(b.find((m) => m.t === 'ev' && m.e.k === 'boom'), 'explosion relayed');
check(!a.inbox.some((m) => m.t === 'p' || m.t === 'ev'), 'sender does not get its own messages');

const c = pilot('Charlie');
await c.ready; await wait(300);
const wc = c.find((m) => m.t === 'welcome');
check(wc && wc.peers.length === 2 && wc.parts.includes('cmpA:2'), 'late joiner gets peers and the wreck');

// The whole compound falls: joiners get it with its age, and its parts are no longer listed.
c.send({ t: 'ev', e: { k: 'cmp', id: 'cmpA' } });
c.send({ t: 'ev', e: { k: 'part', id: 'cmpA', i: 5 } });
await wait(300);
check(a.inbox.filter((m) => m.t === 'ev' && m.e.k === 'part' && m.e.i === 5).length === 0, 'parts of a fallen compound are not relayed');
const g = pilot('Golf');
await g.ready; await wait(300);
const wg = g.find((m) => m.t === 'welcome');
check(wg && wg.cmps.includes('cmpA') && wg.ages[0] >= 0 && wg.ages[0] < 5 && !wg.parts.includes('cmpA:2'), 'joiner gets the fallen compound and its age', JSON.stringify(wg && { cmps: wg.cmps, ages: wg.ages, parts: wg.parts }));
g.ws.close(); await wait(200);

b.ws.close(); await wait(400);
check(a.find((m) => m.t === 'leave' && m.id === wb.id), 'leave is announced');
a.ws.close(); c.ws.close(); await wait(400);

const d = pilot('Delta');
await d.ready; await wait(300);
check(d.find((m) => m.t === 'welcome')?.parts.length === 0, 'empty room forgets its wrecks');
d.ws.close();
await wait(100);

// Flooding: poses past the rate limit are dropped, and a pilot sending hundreds a second is cut off.
const e = pilot('Echo'), f = pilot('Foxtrot');
await e.ready; await f.ready; await wait(300);
const closed = new Promise((res) => (e.ws.onclose = (ev) => res(ev.code)));
for (let i = 0; i < 450; i++) e.send({ t: 'p', a: 'scout', s: [i, 0, 0, 0, 0, 0, 1, 0, 0, 0], r: 1, f: 0 });
const code = await Promise.race([closed, wait(2000).then(() => 0)]);
await wait(300);
const got = f.inbox.filter((m) => m.t === 'p').length;
check(got <= 30, 'poses past 30 a second are dropped', `${got} relayed`);
check(code === 1008, 'a flooding pilot is disconnected', `close code ${code}`);
f.ws.close();
await wait(100);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

// Synthetic IMU generator for testing the rep engine.
// Builds a world-frame trajectory (position + orientation) at 1040 Hz, derives what the
// accelerometer and gyro would read, then adds the imperfections seen on the real board
// (gyro bias, accel scale error, noise, 1/1000 g quantisation, lost BLE samples) at 104 Hz.

export const FS = 104, UP = 10, FH = FS * UP, G = 9.80665;

export function rng(seed) {
  let a = seed >>> 0;
  const r = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.u = (lo, hi) => lo + (hi - lo) * r();
  r.n = (s = 1) => { let u = 0, v = 0; while (!u) u = r(); v = r(); return s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  r.i = (lo, hi) => Math.floor(r.u(lo, hi + 1));
  return r;
}

// ---- quaternions [w,x,y,z]
const qmul = (a, b) => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2], a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
const qconj = q => [q[0], -q[1], -q[2], -q[3]];
const qaxis = (ax, ang) => { const n = Math.hypot(...ax), s = Math.sin(ang / 2); return [Math.cos(ang / 2), ax[0] / n * s, ax[1] / n * s, ax[2] / n * s]; };
const qrot = (q, v) => qmul(qmul(q, [0, ...v]), qconj(q)).slice(1);
export function randomQuat(r) { const u1 = r(), u2 = r(), u3 = r(); return [Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2), Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2), Math.sqrt(u1) * Math.sin(2 * Math.PI * u3), Math.sqrt(u1) * Math.cos(2 * Math.PI * u3)]; }

// ---- piecewise minimum-jerk tracks
const mj = s => s * s * s * (10 - 15 * s + 6 * s * s);
class Track {
  constructor(v0 = 0) { this.k = [{ t: 0, v: v0 }]; }
  get t() { return this.k[this.k.length - 1].t; }
  get v() { return this.k[this.k.length - 1].v; }
  to(dur, v) { this.k.push({ t: this.t + dur, v }); return this; }
  hold(dur) { return this.to(dur, this.v); }
  sample(n) {
    const o = new Float64Array(n); let k = 0;
    for (let i = 0; i < n; i++) {
      const t = i / FH;
      while (k < this.k.length - 2 && this.k[k + 1].t <= t) k++;
      const a = this.k[k], b = this.k[k + 1];
      if (!b || t >= b.t) { o[i] = (b || a).v; continue; }
      o[i] = a.v + (b.v - a.v) * mj((t - a.t) / (b.t - a.t));
    }
    return o;
  }
}

// A scene keeps several tracks in sync and records the true reps.
class Scene {
  constructor() { this.tr = {}; this.reps = []; this.sets = []; this.extra = []; }
  T(name) { return this.tr[name] || (this.tr[name] = new Track(0)); }
  get t() { return Math.max(0, ...Object.values(this.tr).map(t => t.t)); }
  sync() { const t = this.t; for (const k in this.tr) { const tr = this.tr[k]; if (tr.t < t) tr.hold(t - tr.t); } }
  hold(d) { this.sync(); for (const k in this.tr) this.tr[k].hold(d); }
}

// ---------------------------------------------------------------- exercises
// Each adds one set to the scene and records truth. "z" is the vertical sensor position for bar work;
// for wrist work an angle track drives the forearm/arm and position follows from it.

function barSet(sc, r, kind) {
  const z = sc.T('z'), x = sc.T('x'), pitch = sc.T('pitch');
  // Optional form faults for the form tests (none of these draw random numbers, so the default
  // sessions are exactly what they were): tiltDeg = one end leads by this much mid-lift,
  // spinDeg = how far the bar rolls in the hands on the way down, stick = slow-down mid-lift (0..1).
  const O = sc.opts || {}, D2R = Math.PI / 180;
  const tilt = O.tiltDeg ? sc.T('tilt') : null, zb = O.stick ? sc.T('zb') : null;
  const spin = (O.spinDeg || 0) * D2R;
  const fault = (cd, rom) => {
    if (tilt) tilt.to(cd / 2, O.tiltDeg * D2R).to(cd / 2, 0);
    if (zb) zb.hold(cd * 0.3).to(cd * 0.25, -O.stick * rom).to(cd * 0.3, 0);
  };
  sc.sync();
  const n = O.reps || r.i(3, 12);
  const P = {
    squat: { rom: r.u(0.45, 0.62), ecc: r.u(1.2, 2.4), con: r.u(0.55, 1.0), startTop: true, walk: 0.3, jx: 0.02 },
    bench: { rom: r.u(0.30, 0.45), ecc: r.u(0.9, 1.8), con: r.u(0.45, 0.9), startTop: true, walk: 0.3, jx: 0.07 },
    deadlift: { rom: r.u(0.48, 0.62), ecc: r.u(0.8, 1.6), con: r.u(0.7, 1.4), startTop: false, walk: 0, jx: 0.02 },
    ohp: { rom: r.u(0.42, 0.55), ecc: r.u(0.9, 1.6), con: r.u(0.6, 1.1), startTop: false, walk: 0.25, jx: 0.05 },
  }[kind];
  const set = { exercise: kind, start: sc.t, reps: [] };
  // unrack / walk out
  if (P.walk) {
    z.to(0.6, z.v + 0.05); sc.sync();
    x.to(1.6, x.v - P.walk); z.to(0.4, z.v + 0.012).to(0.4, z.v).to(0.4, z.v + 0.012).to(0.4, z.v); sc.sync();
    sc.hold(r.u(0.8, 2));
  } else sc.hold(r.u(0.5, 1.5));
  const base = z.v, bx = x.v;
  for (let k = 0; k < n; k++) {
    const fat = 1 + 0.07 * k * r.u(0.6, 1.4) + (k === n - 1 ? r.u(0, 0.4) : 0);
    const rom = P.rom * (1 + r.n(0.03));
    if (P.startTop) {
      const t0 = sc.t;
      z.to(P.ecc * (1 + r.n(0.08)), base - rom); x.to(z.t - x.t, bx - P.jx); pitch.to(z.t - pitch.t, spin + r.n(0.03)); sc.sync();
      const pb = r() < 0.3 ? r.u(0.3, 1.0) : r.u(0, 0.1); sc.hold(pb);
      const cs = sc.t, cd = P.con * fat;
      z.to(cd, base); x.to(cd, bx); pitch.to(cd, 0); fault(cd, rom); sc.sync();
      set.reps.push({ conStart: cs, conEnd: cs + cd, rom, eccStart: t0 });
      sc.hold(r.u(0.2, 1.4));
    } else {
      const cs = sc.t, cd = P.con * fat;
      z.to(cd, base + rom); x.to(cd, bx + P.jx * 0.3); pitch.to(cd, spin + r.n(0.03)); fault(cd, rom); sc.sync();
      set.reps.push({ conStart: cs, conEnd: cs + cd, rom });
      sc.hold(r.u(0.3, 1.0));
      z.to(P.ecc * (1 + r.n(0.08)), base); x.to(z.t - x.t, bx); pitch.to(z.t - pitch.t, 0); sc.sync();
      sc.hold(r.u(0.2, 1.0));
    }
  }
  if (P.walk) { x.to(1.6, x.v + P.walk); sc.sync(); z.to(0.6, z.v - 0.05); sc.sync(); }
  set.end = sc.t;
  sc.sets.push(set);
}

// Wrist exercises: an angle track "ang" rotates the arm about a joint; the sensor sits on the wrist.
function wristSet(sc, r, kind) {
  const ang = sc.T('ang'), z = sc.T('z');
  sc.sync();
  const P = {
    curl: { lo: r.u(0.05, 0.25), hi: r.u(2.1, 2.5), radius: 0.32, axis: 'y', con: r.u(0.7, 1.3), ecc: r.u(1.0, 2.2), concentric: 'up' },
    lateral: { lo: r.u(0.1, 0.25), hi: r.u(1.25, 1.55), radius: 0.62, axis: 'x', con: r.u(0.8, 1.4), ecc: r.u(1.0, 2.0), concentric: 'up' },
    pulldown: { lo: r.u(2.3, 2.6), hi: r.u(1.2, 1.5), radius: 0.62, axis: 'y', con: r.u(0.7, 1.2), ecc: r.u(1.0, 1.8), concentric: 'down' },
  }[kind];
  const n = r.i(5, 15);
  const set = { exercise: kind, start: sc.t, reps: [], concentric: P.concentric, wrist: P };
  // pick the weight up from the floor (a big one-off vertical move) for dumbbell work
  if (kind !== 'pulldown') { z.to(1.0, -0.55).hold(0.4).to(1.0, 0); sc.sync(); }
  ang.to(1.0, P.lo); sc.sync(); sc.hold(r.u(0.5, 1.5));
  const rad = P.radius, hgt = a => -rad * Math.cos(a);
  for (let k = 0; k < n; k++) {
    const fat = 1 + 0.06 * k * r.u(0.6, 1.4);
    const top = P.hi + r.n(0.04), cs = sc.t, cd = P.con * fat;
    ang.to(cd, top); sc.sync();
    set.reps.push({ conStart: cs, conEnd: cs + cd, rom: Math.abs(hgt(top) - hgt(P.lo)) });
    sc.hold(r.u(0.1, 0.5));
    ang.to(P.ecc * (1 + r.n(0.08)), P.lo); sc.sync();
    sc.hold(r.u(0.05, 0.4));
  }
  if (kind !== 'pulldown') { ang.to(0.8, 0); sc.sync(); z.to(1.0, -0.55).hold(0.3).to(1.0, 0); sc.sync(); }
  else { ang.to(1.0, 0); sc.sync(); }
  set.end = sc.t;
  sc.sets.push(set);
}

// Rest between sets. Bar: racked and still. Wrist: walking around, swinging arms, turning, fidgeting.
function rest(sc, r, wrist, dur) {
  sc.sync();
  if (!wrist) { sc.hold(dur); return; }
  const ang = sc.T('ang'), z = sc.T('z'), yaw = sc.T('yaw'), x = sc.T('x');
  const end = sc.t + dur;
  while (sc.t < end - 1) {
    const mode = r();
    if (mode < 0.45) {           // walk: arm swing + body bob + turning
      const steps = r.i(4, 14), f = r.u(0.8, 1.0);
      sc.stepCount = (sc.stepCount || 0) + 2 * steps;   // each arm swing = two steps (truth for the step counter test)
      for (let s = 0; s < steps; s++) {
        ang.to(0.5 / f, r.u(0.25, 0.4)).to(0.5 / f, -r.u(0.15, 0.3));
        z.to(0.25 / f, 0.025).to(0.25 / f, 0).to(0.25 / f, 0.025).to(0.25 / f, 0);
        if (r() < 0.15) yaw.to(1 / f, yaw.v + r.u(-1.6, 1.6)); else yaw.hold(1 / f);
        x.to(1 / f, x.v + 0.6);
      }
      sc.sync();
    } else if (mode < 0.7) {     // stand / sit, small fidgets
      for (let s = 0; s < r.i(2, 6); s++) { ang.to(r.u(0.5, 1.5), r.u(-0.2, 0.6)); z.to(r.u(0.5, 1.5), r.n(0.03)); }
      sc.sync();
    } else if (mode < 0.85) {    // check phone: lift hand to chest, hold, lower
      ang.to(0.8, r.u(1.6, 2.2)); sc.sync(); sc.hold(r.u(2, 8)); ang.to(0.8, 0); sc.sync();
    } else {                     // drink / wipe face
      ang.to(0.7, r.u(2.3, 2.7)); sc.sync(); sc.hold(r.u(0.5, 2)); ang.to(0.7, 0); sc.sync();
    }
  }
  sc.sync();
}

// ---------------------------------------------------------------- render scene -> IMU samples
function render(sc, r, wrist, mount, noise) {
  sc.sync();
  const N = Math.ceil((sc.t + 0.5) * FH);
  const S = {}; for (const k of ['x', 'y', 'z', 'ang', 'yaw', 'pitch', 'tilt', 'zb']) S[k] = (sc.tr[k] || new Track(0)).sample(N);
  const axis = wrist ? (sc.sets[0]?.wrist?.axis || 'y') : 'y';
  const rad = wrist ? (sc.sets[0]?.wrist?.radius || 0.32) : 0;
  const pos = new Float64Array(N * 3), quat = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = S.ang[i], yaw = qaxis([0, 0, 1], S.yaw[i]);
    let q, p;
    if (wrist) {
      const qa = axis === 'y' ? qaxis([0, 1, 0], -a) : qaxis([1, 0, 0], a);
      const arm = qrot(qa, [0, 0, -rad]);          // joint -> wrist
      p = qrot(yaw, arm); p[0] += S.x[i]; p[2] += S.z[i];
      q = qmul(yaw, qa);
    } else {
      // the bar lies along y: pitch = rolling around its own axis, tilt = one end higher than the other
      q = qmul(qaxis([0, 0, 1], 0.2 * S.yaw[i]), qaxis([0, 1, 0], S.pitch[i] * Number(process.env.PITCH ?? 1)));
      if (sc.tr.tilt) q = qmul(qmul(qaxis([0, 0, 1], 0.2 * S.yaw[i]), qaxis([1, 0, 0], S.tilt[i])), qaxis([0, 1, 0], S.pitch[i]));
      p = [S.x[i], S.y[i], S.z[i] + S.zb[i]];
    }
    q = qmul(q, mount);
    if (i && q[0] * quat[i - 1][0] + q[1] * quat[i - 1][1] + q[2] * quat[i - 1][2] + q[3] * quat[i - 1][3] < 0) q = q.map(v => -v);
    pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; quat[i] = q;
  }
  const h = 1 / FH, out = [], idx = [], truthZ = [];
  const { bias, scale, off } = noise.sensor;
  let k = 0;
  for (let i = UP; i < N - UP; i += UP) {
    const acc = [0, 1, 2].map(j => (pos[(i + 1) * 3 + j] - 2 * pos[i * 3 + j] + pos[(i - 1) * 3 + j]) / (h * h));
    acc[2] += G;
    const q = quat[i], fb = qrot(qconj(q), acc).map(v => v / G);
    const qd = [0, 1, 2, 3].map(j => (quat[i + 1][j] - quat[i - 1][j]) / (2 * h));
    const w = qmul(qconj(q), qd).slice(1).map(v => 2 * v * 180 / Math.PI);
    const s = [
      ...fb.map((v, j) => Math.round((v * scale[j] + off[j] + r.n(noise.a)) * 1000) / 1000),
      ...w.map((v, j) => Math.round((v + bias[j] + r.n(noise.g)) * 10) / 10),
    ];
    // lost BLE samples: short bursts
    if (noise.drop && r() < noise.drop) { k += r.i(1, 8); continue; }
    out.push(s); idx.push(k); truthZ.push(pos[i * 3 + 2]); k++;
  }
  return { samples: out, indices: idx, truthZ };
}

// Truth mean concentric velocity from the vertical track (trimmed like the engine).
function truthMetrics(sc, wrist) {
  const N = Math.ceil((sc.t + 0.5) * FH);
  let z;
  if (wrist) {
    const a = sc.tr.ang.sample(N), zz = (sc.tr.z || new Track(0)).sample(N), rad = sc.sets[0].wrist.radius;
    z = a.map((v, i) => -rad * Math.cos(v) + zz[i]);
  } else z = sc.tr.z.sample(N);
  for (const set of sc.sets) {
    const sgn = set.concentric === 'down' ? -1 : 1;
    for (const rep of set.reps) {
      const a = Math.round(rep.conStart * FH), b = Math.round(rep.conEnd * FH);
      // same definition as the engine: mean over samples moving at >= 10% of peak speed
      let s = 0, c = 0, pk = 0;
      for (let i = a; i < b; i++) pk = Math.max(pk, sgn * (z[i + 1] - z[i]) * FH);
      const cut = Math.max(0.03, 0.1 * pk);
      for (let i = a; i < b; i++) { const v = sgn * (z[i + 1] - z[i]) * FH; if (v >= cut) { s += v; c++; } }
      rep.mcv = c ? s / c : 0; rep.pv = pk;
      rep.rom = Math.abs(z[b] - z[a]);
    }
  }
}

// ---------------------------------------------------------------- public: build a session
// kind: squat | bench | deadlift | ohp | curl | lateral | pulldown | rest-only
export function makeSession(seed, kind, opts = {}) {
  const r = rng(seed);
  const wrist = ['curl', 'lateral', 'pulldown', 'rest-only'].includes(kind);
  const sc = new Scene();
  sc.opts = opts;
  sc.T('z'); sc.T('ang');
  const nSets = kind === 'rest-only' ? 0 : (opts.sets || r.i(1, 3));
  rest(sc, r, wrist, r.u(3, wrist ? 12 : 5));
  for (let s = 0; s < nSets; s++) {
    if (wrist) wristSet(sc, r, kind); else barSet(sc, r, kind);
    rest(sc, r, wrist, r.u(wrist ? 15 : 8, wrist ? 40 : 20));
  }
  if (kind === 'rest-only') { sc.sets.push({ wrist: { axis: 'y', radius: 0.32 } }); rest(sc, r, true, 90); }
  if (kind !== 'rest-only') truthMetrics(sc, wrist);
  const mount = randomQuat(r);
  const clean = opts.clean ?? !!process.env.CLEAN;
  const noise = clean ? { a: 0, g: 0, drop: 0, clean: true } : { a: 0.003, g: 0.15, drop: opts.drop ?? 0.002 };
  // per-board sensor errors (the real board read 1.04 g on Z)
  noise.sensor = clean ? { bias: [0, 0, 0], scale: [1, 1, 1], off: [0, 0, 0] }
    : { bias: [r.u(-4, 4), r.u(-4, 4), r.u(-4, 4)], scale: [1 + r.n(0.02), 1 + r.n(0.02), 1.04 + r.n(0.01)], off: [r.n(0.01), r.n(0.01), r.n(0.01)] };
  const data = render(sc, r, wrist, mount, noise);
  // What the 6-side calibration on the phone would capture with this board: the mean of 2 s
  // lying on each face, held by hand slightly off-level.
  data.calibPoints = [];
  for (const face of [[0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0]]) {
    const tilt = qaxis([r.n(), r.n(), r.n()], r.n(0.05));
    const g = qrot(tilt, face);
    data.calibPoints.push(g.map((v, j) => v * noise.sensor.scale[j] + noise.sensor.off[j] + r.n(noise.a / Math.sqrt(200))));
  }
  const sets = kind === 'rest-only' ? [] : sc.sets;
  // convert truth times to sample indices at 104 Hz (render starts at i = UP)
  for (const set of sets) {
    set.startIdx = Math.round(set.start * FS) - 1; set.endIdx = Math.round(set.end * FS) - 1;
    for (const rep of set.reps) { rep.conStartIdx = Math.round(rep.conStart * FS) - 1; rep.conEndIdx = Math.round(rep.conEnd * FS) - 1; }
  }
  return { kind, wrist, concentric: kind === 'pulldown' ? 'down' : 'up', sets, steps: sc.stepCount || 0, ...data };
}

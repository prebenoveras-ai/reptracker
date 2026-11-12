// RepTracker analysis engine.
// Turns raw IMU samples (accel in g, gyro in deg/s, sensor frame) into sets and reps
// with bar speed, range of motion, tempo, power and fatigue.
//
// The same file runs in the phone page (ES module) and in Node for the tests in tools/.
//
// Pipeline per sample:
//   1. Stillness detection -> gyro bias and gravity magnitude are learned while still.
//   2. Madgwick orientation filter (6-axis) -> which way is up.
//   3. Acceleration rotated to the world frame, gravity removed -> vertical and horizontal acceleration.
// Per analysis window:
//   4. Integrate to velocity; remove drift by forcing velocity to zero wherever it really is zero
//      (when still, and at every turnaround at the top and bottom of a rep). Two passes.
//   5. Integrate to position; find the up/down swings with an adaptive hysteresis.
//   6. Each concentric swing is a rep; measure it.

export const G = 9.80665;
const D2R = Math.PI / 180;

// ---------------------------------------------------------------- exercise profiles
// concentric: which way the sensor moves during the lifting (hard) phase.
// mvt: typical mean velocity at a 1-rep max (m/s), approximate published averages for barbell lifts.
//      Used to estimate reps in reserve and 1RM. null = no reliable value (isolation lifts).
const PROFILES = [
  { re: /pull.?down|push.?down|triceps?.*(cable|rope)|straight.?arm|face.?pull/i, concentric: 'down', mvt: null, name: 'pull-down' },
  { re: /pull.?up|chin.?up/i, concentric: 'up', mvt: 0.23, name: 'pull-up' },
  { re: /dead|rdl|romanian|stiff|good.?morning|rack pull/i, concentric: 'up', mvt: 0.17, name: 'deadlift' },
  { re: /hip thrust|glute bridge/i, concentric: 'up', mvt: 0.25, name: 'hip thrust' },
  { re: /bench|floor press|dip|push.?up/i, concentric: 'up', mvt: 0.17, name: 'bench' },
  { re: /squat|lunge|split|leg press|hack|step.?up/i, concentric: 'up', mvt: 0.30, name: 'squat' },
  { re: /overhead|ohp|military|shoulder press|push press|arnold/i, concentric: 'up', mvt: 0.19, name: 'overhead press' },
  { re: /row/i, concentric: 'up', mvt: 0.45, name: 'row' },
  { re: /curl|raise|fly|flye|extension|kickback|shrug|calf/i, concentric: 'up', mvt: null, name: 'isolation' },
];
export function profileFor(exercise) {
  const ex = String(exercise || '');
  for (const p of PROFILES) if (p.re.test(ex)) return { concentric: p.concentric, mvt: p.mvt, kind: p.name };
  return { concentric: 'up', mvt: null, kind: 'generic' };
}

// Velocity zones commonly used in velocity-based training (mean concentric velocity, m/s).
export const ZONES = [
  { max: 0.5, name: 'Strength' },
  { max: 0.75, name: 'Strength-speed' },
  { max: 1.0, name: 'Speed-strength' },
  { max: 1.3, name: 'Speed' },
  { max: Infinity, name: 'Starting strength' },
];
export function zoneFor(v) { for (const z of ZONES) if (v < z.max) return z.name; return ''; }

// ---------------------------------------------------------------- quaternion helpers
function qRotate(q, x, y, z, out) {
  // v' = q v q*  (sensor -> world)
  const [w, qx, qy, qz] = q;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out[0] = x + w * tx + (qy * tz - qz * ty);
  out[1] = y + w * ty + (qz * tx - qx * tz);
  out[2] = z + w * tz + (qx * ty - qy * tx);
  return out;
}

// ---------------------------------------------------------------- accelerometer calibration
// Each axis has its own small gain and offset error (the real board read 1.04 g on Z, 1.00 g on Y).
// Given the average reading in several still poses, find offset o and gain k per axis so that
// |k * (a - o)| = 1 g in every pose. Gauss-Newton on 6 parameters.
export function fitCalibration(points) {
  if (points.length < 6) return null;
  let o = [0, 0, 0], k = [1, 1, 1];
  for (let it = 0; it < 20; it++) {
    const JtJ = Array.from({ length: 6 }, () => new Float64Array(6)), Jtr = new Float64Array(6);
    for (const p of points) {
      const c = [0, 1, 2].map(j => k[j] * (p[j] - o[j]));
      const nrm = Math.hypot(...c) || 1, r = nrm - 1;
      const J = [0, 1, 2].map(j => -k[j] * c[j] / nrm).concat([0, 1, 2].map(j => (p[j] - o[j]) * c[j] / nrm));
      for (let a = 0; a < 6; a++) { Jtr[a] += J[a] * r; for (let b = 0; b < 6; b++) JtJ[a][b] += J[a] * J[b]; }
    }
    for (let a = 0; a < 6; a++) JtJ[a][a] += 1e-9;
    const d = solve(JtJ, Jtr);
    if (!d) return null;
    for (let j = 0; j < 3; j++) { o[j] -= d[j]; k[j] -= d[3 + j]; }
    if (Math.hypot(...d) < 1e-9) break;
  }
  const res = Math.sqrt(mean(points.map(p => (Math.hypot(...[0, 1, 2].map(j => k[j] * (p[j] - o[j]))) - 1) ** 2)));
  if (k.some(x => x < 0.8 || x > 1.2) || o.some(x => Math.abs(x) > 0.2)) return null;
  return { offset: o, scale: k, residual: res };
}
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// ---------------------------------------------------------------- per-sample preprocessing
export class Preprocessor {
  constructor(fs = 104, calib = null) {
    this.fs = fs; this.dt = 1 / fs;
    this.calib = calib;            // { offset:[3], scale:[3] } from fitCalibration
    this.q = null;
    this.bias = [0, 0, 0];         // deg/s
    this.g0 = 1;                   // measured gravity magnitude in g (absorbs accel scale error)
    this.calibrated = false;
    this.win = 32;                 // ~0.3 s stillness window
    this.ringA = new Float32Array(this.win); this.ringW = new Float32Array(this.win);
    this.ringRaw = new Float32Array(this.win * 6);
    this.k = 0; this.filled = 0;
    this._v = [0, 0, 0];
    this.count = 0;
    this.calibratedAt = -1;        // sample count when the gyro bias was first known
    if (calib && calib.gyroBias) { this.bias = calib.gyroBias.slice(); this.calibrated = true; this.calibratedAt = 0; }
  }

  _setCalibrated(gm, m, reinit = true) {
    this.bias = gm.slice(); this.g0 = m; this.calibrated = true; this.calibratedAt = this.count;
    if (!reinit) return;
    // restart orientation from the averaged gravity reading (removes drift from the unknown bias so far)
    let ax = 0, ay = 0, az = 0;
    for (let i = 0; i < this.win; i++) { ax += this.ringRaw[i * 6]; ay += this.ringRaw[i * 6 + 1]; az += this.ringRaw[i * 6 + 2]; }
    this._init(ax, ay, az);
  }

  _init(ax, ay, az) {
    const n = Math.hypot(ax, ay, az) || 1;
    const ux = ax / n, uy = ay / n, uz = az / n;
    // rotation taking u to +Z
    const d = uz;
    if (d < -0.9999) { this.q = [0, 1, 0, 0]; return; }
    const w = 1 + d, x = uy, y = -ux, z = 0;   // cross(u, z) = (uy, -ux, 0)
    const m = Math.hypot(w, x, y, z);
    this.q = [w / m, x / m, y / m, z / m];
  }

  // Madgwick IMU update. gx..gz in rad/s, a in any unit.
  _madgwick(ax, ay, az, gx, gy, gz, beta) {
    let [q0, q1, q2, q3] = this.q;
    let qd0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
    let qd1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy);
    let qd2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx);
    let qd3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx);
    const an = Math.hypot(ax, ay, az);
    if (an > 0 && beta > 0) {
      ax /= an; ay /= an; az /= an;
      const _2q0 = 2 * q0, _2q1 = 2 * q1, _2q2 = 2 * q2, _2q3 = 2 * q3;
      const _4q0 = 4 * q0, _4q1 = 4 * q1, _4q2 = 4 * q2, _8q1 = 8 * q1, _8q2 = 8 * q2;
      const q0q0 = q0 * q0, q1q1 = q1 * q1, q2q2 = q2 * q2, q3q3 = q3 * q3;
      let s0 = _4q0 * q2q2 + _2q2 * ax + _4q0 * q1q1 - _2q1 * ay;
      let s1 = _4q1 * q3q3 - _2q3 * ax + 4 * q0q0 * q1 - _2q0 * ay - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az;
      let s2 = 4 * q0q0 * q2 + _2q0 * ax + _4q2 * q3q3 - _2q3 * ay - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az;
      let s3 = 4 * q1q1 * q3 - _2q1 * ax + 4 * q2q2 * q3 - _2q2 * ay;
      const sn = Math.hypot(s0, s1, s2, s3);
      if (sn > 0) { qd0 -= beta * s0 / sn; qd1 -= beta * s1 / sn; qd2 -= beta * s2 / sn; qd3 -= beta * s3 / sn; }
    }
    q0 += qd0 * this.dt; q1 += qd1 * this.dt; q2 += qd2 * this.dt; q3 += qd3 * this.dt;
    const m = Math.hypot(q0, q1, q2, q3);
    this.q = [q0 / m, q1 / m, q2 / m, q3 / m];
  }

  // raw: [ax, ay, az (g), gx, gy, gz (deg/s)]. Returns a frame object (reused).
  step(raw, out) {
    let [ax, ay, az, gxd, gyd, gzd] = raw;
    if (this.calib) {
      const { offset: o, scale: k } = this.calib;
      ax = k[0] * (ax - o[0]); ay = k[1] * (ay - o[1]); az = k[2] * (az - o[2]);
      raw = [ax, ay, az, gxd, gyd, gzd];
    }
    const am = Math.hypot(ax, ay, az);
    // stillness window
    const k = this.k;
    this.ringA[k] = am;
    for (let j = 0; j < 6; j++) this.ringRaw[k * 6 + j] = raw[j];
    const wb = Math.hypot(gxd - this.bias[0], gyd - this.bias[1], gzd - this.bias[2]);
    this.ringW[k] = wb;
    this.k = (k + 1) % this.win; if (this.filled < this.win) this.filled++;
    let still = false;
    if (this.filled === this.win) {
      let m = 0, mw = 0, maxW = 0;
      for (let i = 0; i < this.win; i++) { m += this.ringA[i]; mw += this.ringW[i]; if (this.ringW[i] > maxW) maxW = this.ringW[i]; }
      m /= this.win; mw /= this.win;
      let v = 0; for (let i = 0; i < this.win; i++) v += (this.ringA[i] - m) ** 2;
      const sd = Math.sqrt(v / this.win);
      // Raw gyro spread (bias independent) so the very first still period is found before calibration.
      let gm = [0, 0, 0]; for (let i = 0; i < this.win; i++) for (let j = 0; j < 3; j++) gm[j] += this.ringRaw[i * 6 + 3 + j];
      gm = gm.map(x => x / this.win);
      let gsd = 0; for (let i = 0; i < this.win; i++) for (let j = 0; j < 3; j++) gsd += (this.ringRaw[i * 6 + 3 + j] - gm[j]) ** 2;
      gsd = Math.sqrt(gsd / this.win);
      // Still = steady readings AND the total equals gravity (a steady push up or down is not still).
      const gyroQuiet = this.calibrated ? (mw < 2 && maxW < 5) : (gsd < 1 && Math.hypot(...gm) < 15);
      const gravOk = this.calibrated ? Math.abs(m - this.g0) < 0.012 : Math.abs(m - 1) < 0.08;
      still = sd < 0.008 && gyroQuiet && gravOk;
      this.stillRun = still ? (this.stillRun || 0) + 1 : 0;
      // learn gyro bias and gravity scale only once settled for a full second
      if (still && this.stillRun >= this.fs) {
        if (!this.calibrated) this._setCalibrated(gm, m);
        else {
          const r = 0.01;
          for (let j = 0; j < 3; j++) this.bias[j] += r * (gm[j] - this.bias[j]);
          this.g0 += r * (m - this.g0);
        }
      }
      // Fallback when the board never rests fully (worn on the wrist): after 5 s take the calmest
      // half-second seen so far as the reference.
      if (!this.calibrated) {
        const score = gsd + 10 * sd + 5 * Math.abs(m - 1);
        if (!this.best || score < this.best.score) this.best = { score, gm, m };
        if (this.count > 5 * this.fs && this.best.score < 4) this._setCalibrated(this.best.gm, this.best.m, false);
      }
    }
    this.count++;
    if (!this.q) this._init(ax, ay, az);
    const gx = (gxd - this.bias[0]) * D2R, gy = (gyd - this.bias[1]) * D2R, gz = (gzd - this.bias[2]) * D2R;
    // Trust the accelerometer for tilt only when it reads close to 1 g (not accelerating).
    const dev = (am - this.g0) / 0.08;
    const beta = still ? 0.15 : 0.04 * Math.exp(-dev * dev);
    this._madgwick(ax, ay, az, gx, gy, gz, beta);
    const w = qRotate(this.q, ax, ay, az, this._v);
    out.lx = w[0] * G; out.ly = w[1] * G; out.lz = (w[2] - this.g0) * G;
    out.still = still;
    out.wx = gx; out.wy = gy; out.wz = gz;
    // gravity direction in the sensor frame: q* (0,0,1) q
    const [q0, q1, q2, q3] = this.q;
    out.ux = 2 * (q1 * q3 - q0 * q2); out.uy = 2 * (q0 * q1 + q2 * q3); out.uz = q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3;
    return out;
  }
}

// ---------------------------------------------------------------- frame storage
const FIELDS = ['lx', 'ly', 'lz', 'wx', 'wy', 'wz', 'ux', 'uy', 'uz'];
export class Frames {
  constructor(cap = 4096) {
    this.cap = cap; this.n = 0; this.base = 0;   // absolute index of element 0
    for (const f of FIELDS) this[f] = new Float32Array(cap);
    this.still = new Uint8Array(cap);
  }
  get end() { return this.base + this.n; }
  push(fr) {
    if (this.n === this.cap) this._grow();
    const i = this.n++;
    for (const f of FIELDS) this[f][i] = fr[f];
    this.still[i] = fr.still ? 1 : 0;
  }
  _grow() {
    this.cap *= 2;
    for (const f of [...FIELDS, 'still']) { const a = new this[f].constructor(this.cap); a.set(this[f]); this[f] = a; }
  }
  // drop everything before absolute index abs
  trim(abs) {
    const k = Math.min(this.n, Math.max(0, abs - this.base));
    if (k <= 0) return;
    for (const f of [...FIELDS, 'still']) this[f].copyWithin(0, k, this.n);
    this.n -= k; this.base += k;
  }
}

// ---------------------------------------------------------------- signal helpers
function cumsum(src, dt) { const o = new Float64Array(src.length); let s = 0; for (let i = 0; i < src.length; i++) { s += src[i] * dt; o[i] = s; } return o; }

// Subtract a piecewise-linear trend that passes through v at every anchor index.
function detrend(v, anchors) {
  const n = v.length, o = new Float64Array(n);
  if (!anchors.length) { o.set(v); return o; }
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k < anchors.length - 1 && anchors[k + 1] <= i) k++;
    let off;
    if (i <= anchors[0]) off = v[anchors[0]];
    else if (k >= anchors.length - 1) off = v[anchors[anchors.length - 1]];
    else { const a = anchors[k], b = anchors[k + 1]; off = v[a] + (v[b] - v[a]) * (i - a) / (b - a); }
    o[i] = v[i] - off;
  }
  return o;
}

function movingAvg(v, w) {
  const n = v.length, o = new Float64Array(n), ps = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + v[i];
  const h = Math.max(1, Math.floor(w / 2));
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - h), b = Math.min(n, i + h + 1); o[i] = (ps[b] - ps[a]) / (b - a); }
  return o;
}

// Alternating extrema with hysteresis thr. Returns confirmed extrema plus the pending one.
function extrema(p, thr) {
  const ext = []; let mode = 0, hi = 0, lo = 0;
  for (let i = 1; i < p.length; i++) {
    if (mode === 0) {
      if (p[i] > p[hi]) hi = i; if (p[i] < p[lo]) lo = i;
      if (p[hi] - p[i] >= thr && hi < i) { ext.push({ i: hi, t: 1 }); mode = -1; lo = i; }
      else if (p[i] - p[lo] >= thr && lo < i) { ext.push({ i: lo, t: -1 }); mode = 1; hi = i; }
    } else if (mode === 1) {
      if (p[i] > p[hi]) hi = i;
      else if (p[hi] - p[i] >= thr) { ext.push({ i: hi, t: 1 }); mode = -1; lo = i; }
    } else {
      if (p[i] < p[lo]) lo = i;
      else if (p[i] - p[lo] >= thr) { ext.push({ i: lo, t: -1 }); mode = 1; hi = i; }
    }
  }
  return { ext, mode, pending: mode === 1 ? hi : mode === -1 ? lo : -1 };
}

const nearestStart = (reps, start, tol) => { let b = null, d = tol; for (const r of reps) { const x = Math.abs(r.start - start); if (x <= d) { d = x; b = r; } } return b; };
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

// ---------------------------------------------------------------- window analysis
// Analyse frames[a..b) (absolute indices). opts: { fs, concentric, final, loadKg }
// Returns { reps, M, v, p } where reps are completed reps with metrics.
export function analyzeWindow(F, a, b, opts) {
  const fs = opts.fs || 104, dt = 1 / fs;
  const o0 = a - F.base, n = b - a;
  if (n < fs) return { reps: [], M: 0 };
  const lz = F.lz.subarray(o0, o0 + n), lx = F.lx.subarray(o0, o0 + n), ly = F.ly.subarray(o0, o0 + n);
  // Only long still periods (racked bar, rest) count as "velocity is zero": a slow, smooth eccentric
  // can look still to a short window, and zeroing it would erase the movement.
  const stillRaw = F.still.subarray(o0, o0 + n), still = new Uint8Array(n);
  const minRun = Math.round((opts.minStill ?? 1.2) * fs);
  for (let i = 0; i < n;) {
    if (!stillRaw[i]) { i++; continue; }
    let j = i; while (j < n && stillRaw[j]) j++;
    if (j - i >= minRun || i === 0 && j - i >= minRun / 2) still.fill(1, i, j);
    i = j;
  }
  const stillIdx = []; for (let i = 0; i < n; i++) if (still[i]) stillIdx.push(i);
  const vzRaw = cumsum(lz, dt), vxRaw = cumsum(lx, dt), vyRaw = cumsum(ly, dt);

  // pass 1: drift removed at long still periods. Without any (continuous wrist motion),
  // fall back to a slow high-pass just to locate the turnarounds roughly.
  let v = detrend(vzRaw, stillIdx);
  const stillCover = stillIdx.length ? (stillIdx[stillIdx.length - 1] - stillIdx[0]) / n : 0;
  if (stillCover < 0.5) {
    const hp = movingAvg(v, Math.round(4 * fs));
    v = v.map((x, i) => (still[i] ? 0 : x - hp[i]));
  }
  let p = cumsum(v, dt);
  let { ext } = extrema(p, 0.04);

  // passes 2-4: velocity is exactly zero at every turnaround -> use them as anchors and refine
  let thr = 0.05, M = 0;
  for (let pass = 0; pass < 3; pass++) {
    const anchors = [...new Set([...stillIdx, ...ext.map(e => e.i)])].sort((x, y) => x - y);
    v = detrend(vzRaw, anchors);
    p = cumsum(v, dt);
    const r1 = extrema(p, 0.04);
    const amps = [];
    for (let k = 1; k < r1.ext.length; k++) amps.push(Math.abs(p[r1.ext[k].i] - p[r1.ext[k - 1].i]));
    const big = amps.filter(x => x >= 0.08);
    M = big.length ? median(big) : 0;
    thr = Math.max(0.05, 0.4 * M);
    ext = extrema(p, thr).ext;
  }
  if (!M) return { reps: [], M: 0 };
  const res = extrema(p, thr);
  ext = res.ext.slice();

  // Accept a final unconfirmed extreme: the set ended at the top (or the live window ends mid-turnaround).
  if (res.pending > 0 && ext.length) {
    const last = ext[ext.length - 1], pi = res.pending, amp = Math.abs(p[pi] - p[last.i]);
    let accept = false;
    if (amp >= Math.max(thr, 0.55 * M)) {
      if (opts.final) accept = true;
      else {
        // live: the phase has finished when velocity has died down after the extreme
        let peakV = 0; for (let i = last.i; i <= pi; i++) peakV = Math.max(peakV, Math.abs(v[i]));
        const tail = n - 1 - pi;
        accept = tail >= Math.round(0.12 * fs) && Math.abs(v[n - 1]) < 0.3 * peakV;
      }
    }
    if (accept) ext.push({ i: pi, t: res.mode === 1 ? 1 : -1, provisional: !opts.final });
  }

  // Split a one-way move that pauses in the middle (pick the dumbbell up, pause, curl) into two moves.
  {
    const pauseLen = Math.round(0.3 * fs), out = [ext[0]];
    for (let k = 1; k < ext.length; k++) {
      const a0 = ext[k - 1].i, b0 = ext[k].i, dir = ext[k].t;     // dir +1: rising to a max
      let s = -1;
      for (let i = a0 + 1; i < b0; i++) {
        if (Math.abs(v[i]) < 0.04) { if (s < 0) s = i; }
        else if (s >= 0) {
          if (i - s >= pauseLen && Math.abs(p[s] - p[a0]) >= 0.5 * thr && Math.abs(p[b0] - p[i]) >= 0.5 * thr) {
            out.push({ i: s, t: dir }, { i: i - 1, t: -dir });
          }
          s = -1;
        }
      }
      out.push(ext[k]);
    }
    if (ext.length) ext = out;
  }

  // horizontal velocity with the same anchors (for bar path)
  const anchorsF = [...new Set([...stillIdx, ...ext.map(e => e.i)])].sort((x, y) => x - y);
  const vx = detrend(vxRaw, anchorsF), vy = detrend(vyRaw, anchorsF);
  const px = cumsum(vx, dt), py = cumsum(vy, dt);

  const up = opts.concentric !== 'down';
  const sgn = up ? 1 : -1;
  // concentric phases
  const cand = [];
  for (let k = 1; k < ext.length; k++) {
    const e0 = ext[k - 1], e1 = ext[k];
    const amp = (p[e1.i] - p[e0.i]) * sgn;
    if (amp <= 0) continue;
    let rot = 0;
    for (let i = e0.i; i <= e1.i; i++) { const j = o0 + i; rot += Math.hypot(F.wx[j], F.wy[j], F.wz[j]) * dt; }
    cand.push({ k, i0: e0.i, i1: e1.i, amp, rot: rot / D2R, provisional: !!e1.provisional });
  }
  if (!cand.length) return { reps: [], M, v, p };
  // consistency: drop set-up moves at the edges (picking the weight up, walking it out) and tiny wiggles
  const Mc = median(cand.map(c => c.amp));
  let keep = cand.filter(c => c.amp >= 0.45 * Mc);
  if (keep.length >= 3) {
    const m2 = median(keep.map(c => c.amp)), r2 = median(keep.map(c => c.rot));
    // For wrist work every real rep turns the forearm; a pick-up or set-down barely does.
    const odd = c => c.amp > 1.6 * m2 || c.amp < 0.5 * m2 || (r2 > 40 && (c.rot < 0.45 * r2 || c.rot > 2 * r2));
    while (keep.length >= 3 && odd(keep[0])) keep.shift();
    while (keep.length >= 3 && odd(keep[keep.length - 1])) keep.pop();
  }
  keep = keep.filter(c => { const d = (c.i1 - c.i0) / fs; return d >= 0.15 && d <= 8; });

  const firstDown = ext.length && ext[0].t === (up ? 1 : -1);   // set starts with the eccentric
  const vmin = 0.03;
  const reps = keep.map((c, idx) => {
    // The lift itself: grow outwards from the fastest point until the bar stops. This drops pauses
    // and set-up moves that merged into the phase (unracking then pressing is one long "up").
    // Mean concentric velocity is measured where the bar moves at >= 10% of this rep's peak speed,
    // so slow tails and leftover drift at the turnarounds don't dilute it.
    let pk = c.i0; for (let i = c.i0; i <= c.i1; i++) if (v[i] * sgn > v[pk] * sgn) pk = i;
    const vcut = Math.max(vmin, 0.1 * v[pk] * sgn);
    let s = pk, e = pk;
    while (s > c.i0 && v[s - 1] * sgn >= vcut) s--;
    while (e < c.i1 && v[e + 1] * sgn >= vcut) e++;
    const romMove = (p[e] - p[s]) * sgn;
    let sumV = 0, peakV = 0, peakI = s, sumP = 0, peakP = 0, peakA = 0;
    for (let i = s; i <= e; i++) {
      const vi = v[i] * sgn; sumV += vi;
      if (vi > peakV) { peakV = vi; peakI = i; }
      if (opts.loadKg > 0) { const P = opts.loadKg * (G + lz[i] * sgn) * vi; sumP += P; if (P > peakP) peakP = P; }
      if (lz[i] * sgn > peakA) peakA = lz[i] * sgn;
    }
    const cnt = Math.max(1, e - s + 1);
    // eccentric phase: the swing before (squat/bench) or after (deadlift) the concentric
    const ek = firstDown ? c.k - 1 : c.k + 1;
    let ecc = 0, eccRom = 0, pauseB = 0;
    const ea = firstDown ? ext[ek - 1] : ext[c.k], eb = firstDown ? ext[ek] : ext[ek];
    if (ea && eb && eb.i > ea.i) {
      let es = ea.i, ee = eb.i;
      while (es < ee && Math.abs(v[es]) < vmin) es++;
      while (ee > es && Math.abs(v[ee]) < vmin) ee--;
      ecc = (ee - es) / fs; eccRom = Math.abs(p[eb.i] - p[ea.i]);
      pauseB = firstDown ? Math.max(0, (s - ee) / fs) : 0;
    }
    // bar path: furthest horizontal distance from where the concentric started
    let hDev = 0;
    for (let i = c.i0; i <= c.i1; i++) hDev = Math.max(hDev, Math.hypot(px[i] - px[c.i0], py[i] - py[c.i0]));
    const rep = {
      n: idx + 1,
      start: a + s, end: a + e, top: a + c.i1,
      // if the moving part covers most of the swing, report the full swing (turnaround to turnaround)
      rom: romMove > 0.8 * c.amp ? c.amp : romMove,
      mcv: sumV / cnt,
      pv: peakV,
      conDur: (e - s + 1) / fs,
      eccDur: ecc, eccRom,
      pauseBottom: pauseB,
      ttpv: (peakI - s) / fs,
      peakAcc: peakA,
      hDev,
      rotDeg: c.rot,
      provisional: c.provisional,
    };
    if (opts.loadKg > 0) { rep.meanPower = sumP / cnt; rep.peakPower = peakP; }
    return rep;
  });
  return { reps, M, v, p };
}

// ---------------------------------------------------------------- set summary and estimates
export function summarizeSet(reps, { exercise, loadKg, mvt } = {}) {
  const prof = profileFor(exercise);
  const MVT = mvt ?? prof.mvt;
  const mcvs = reps.map(r => r.mcv);
  const roms = reps.map(r => r.rom);
  const best = mcvs.length ? Math.max(...mcvs.slice(0, Math.min(3, mcvs.length))) : 0;
  const last = mcvs.length ? mcvs[mcvs.length - 1] : 0;
  const romMean = mean(roms);
  const romSd = Math.sqrt(mean(roms.map(x => (x - romMean) ** 2)));
  const s = {
    reps: reps.length,
    meanMcv: mean(mcvs), bestMcv: best, lastMcv: last, firstMcv: mcvs[0] || 0,
    velocityLoss: best > 0 ? Math.max(0, (best - last) / best) : 0,
    romMean, romCv: romMean > 0 ? romSd / romMean : 0,
    tut: reps.reduce((t, r) => t + r.conDur + r.eccDur, 0),
    meanConDur: mean(reps.map(r => r.conDur)), meanEccDur: mean(reps.map(r => r.eccDur)),
    meanPauseBottom: mean(reps.map(r => r.pauseBottom)),
    hDevMean: mean(reps.map(r => r.hDev)),
    rotMean: mean(reps.map(r => r.rotDeg)),
    zone: zoneFor(mean(mcvs)),
    mvt: MVT,
  };
  if (loadKg > 0) {
    s.meanPower = mean(reps.map(r => r.meanPower || 0));
    s.peakPower = Math.max(0, ...reps.map(r => r.peakPower || 0));
  }
  s.rir = estimateRir(mcvs, MVT);
  if (loadKg > 0) s.e1rmReps = loadKg * (1 + (reps.length + (s.rir?.value ?? 0)) / 30);   // Epley including reps left
  // Tempo string: eccentric / bottom pause / concentric, seconds
  s.tempo = reps.length ? `${s.meanEccDur.toFixed(1)}-${s.meanPauseBottom.toFixed(1)}-${s.meanConDur.toFixed(1)}` : '';
  // Consistency score 0-100: steady range of motion and steady tempo
  const conCv = (() => { const m = s.meanConDur; if (!m) return 0; return Math.sqrt(mean(reps.map(r => (r.conDur - m) ** 2))) / m; })();
  s.consistency = Math.round(100 * Math.max(0, 1 - 1.5 * s.romCv - 0.5 * Math.max(0, conCv - 0.15)));
  return s;
}

// Reps left before velocity reaches the 1RM velocity (linear trend over the last reps).
export function estimateRir(mcvs, mvt) {
  if (!mvt || mcvs.length < 3) return null;
  const tail = mcvs.slice(-5);
  const n = tail.length, xs = tail.map((_, i) => i), mx = mean(xs), my = mean(tail);
  let num = 0, den = 0; for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (tail[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  const lastFit = my + slope * (n - 1 - mx);
  if (lastFit <= mvt) return { value: 0, text: '0' };
  if (slope >= -0.005) return { value: 6, text: '5+' };
  const r = (lastFit - mvt) / -slope;
  return r > 5 ? { value: 6, text: '5+' } : { value: Math.round(r), text: String(Math.round(r)) };
}

// Load-velocity profile from several sets of one exercise: [{loadKg, mcv}] (mcv of the fastest rep).
export function loadVelocityProfile(points, mvt) {
  const pts = points.filter(p => p.loadKg > 0 && p.mcv > 0);
  const loads = new Set(pts.map(p => p.loadKg));
  if (loads.size < 2 || !mvt) return null;
  const mx = mean(pts.map(p => p.mcv)), my = mean(pts.map(p => p.loadKg));
  let num = 0, den = 0; for (const p of pts) { num += (p.mcv - mx) * (p.loadKg - my); den += (p.mcv - mx) ** 2; }
  if (!den) return null;
  const slope = num / den;               // kg per m/s (negative)
  if (slope >= 0) return null;
  const intercept = my - slope * mx;
  const e1rm = intercept + slope * mvt;
  const v0 = -intercept / slope;          // velocity at zero load
  let ss = 0, st = 0; for (const p of pts) { ss += (p.loadKg - (intercept + slope * p.mcv)) ** 2; st += (p.loadKg - my) ** 2; }
  return { e1rm, slope, intercept, v0, r2: st ? 1 - ss / st : 0, points: pts.length };
}

// ---------------------------------------------------------------- features for exercise recognition
export function setFeatures(F, set) {
  const r = set.reps;
  const at = i => { const j = i - F.base; return j >= 0 && j < F.n ? [F.ux[j], F.uy[j], F.uz[j]] : [0, 0, 0]; };
  const u = r.length ? at(r[0].start) : [0, 0, 0];
  return [
    median(r.map(x => x.rom)) * 4,
    median(r.map(x => x.conDur)),
    median(r.map(x => x.eccDur)),
    median(r.map(x => x.rotDeg)) / 60,
    median(r.map(x => x.hDev)) * 8,
    u[0] * 1.5, u[1] * 1.5, u[2] * 1.5,
  ];
}
export function classify(features, library, k = 3) {
  if (!library.length) return null;
  const d = library.map(l => ({ label: l.label, d: Math.hypot(...features.map((f, i) => f - l.features[i])) })).sort((a, b) => a.d - b.d);
  const votes = {};
  for (const x of d.slice(0, k)) votes[x.label] = (votes[x.label] || 0) + 1 / (0.1 + x.d);
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  const total = Object.values(votes).reduce((a, b) => a + b, 0);
  return { label: best[0], confidence: best[1] / total, distance: d[0].d };
}

// ---------------------------------------------------------------- streaming session
// Feeds samples in, detects sets automatically and reports reps live.
// events: onRep(rep, liveSet), onSetStart(info), onSetEnd(set)
export class Session {
  constructor(opts = {}) {
    this.fs = opts.fs || 104;
    this.pre = new Preprocessor(this.fs, opts.calib || null);
    this.F = new Frames(8192);
    this.longStillBefore = false;
    this.fr = {};
    this.exercise = opts.exercise || '';
    this.loadKg = opts.loadKg || 0;
    this.on = { rep: opts.onRep || (() => {}), setStart: opts.onSetStart || (() => {}), setEnd: opts.onSetEnd || (() => {}) };
    this.active = null;          // current set
    this.lastSetEnd = 0;         // absolute index
    this.stillRun = 0;           // consecutive still samples
    this.motionStart = -1;       // start of the current motion bout
    this.lastStillEnd = 0;
    this.tick = 0;
    this.sets = [];
    this.lastIdx = null;
    this.lastRaw = null;
    // Armed = the app knows a set is about to start (the lifter pressed "start" and held still).
    // Then a set starts after ONE clean rep instead of three, so counting begins at rep 1.
    this.armed = !!opts.armed;
    this.stillBefore = 0;
  }

  setExercise(name, loadKg) { this.exercise = name || ''; this.loadKg = Number(loadKg) || 0; }
  setArmed(on) { this.armed = !!on; }
  get profile() { return profileFor(this.exercise); }
  get now() { return this.F.end; }

  // raw: [ax, ay, az, gx, gy, gz]; idx: sample index from the board (gaps get filled)
  push(raw, idx) {
    if (idx !== undefined && this.lastIdx !== null && idx > this.lastIdx + 1 && idx - this.lastIdx <= 52) {
      const gap = idx - this.lastIdx - 1;
      for (let g = 1; g <= gap; g++) {
        const f = g / (gap + 1);
        this._one(this.lastRaw.map((x, j) => x + (raw[j] - x) * f));
      }
    }
    if (idx !== undefined) this.lastIdx = idx;
    this.lastRaw = raw.slice();
    this._one(raw);
  }

  _one(raw) {
    const fr = this.pre.step(raw, this.fr);
    this.F.push(fr);
    const now = this.F.end;
    if (fr.still) { this.stillRun++; }
    else {
      // only a real rest (not a short pause between reps) restarts the search window
      if (this.stillRun >= 4 * this.fs || this.motionStart < 0) {
        this.longStillBefore = this.stillRun >= 4 * this.fs;
        this.lastStillEnd = now - 1; this.motionStart = now; this.singleChecked = false;
      }
      // remember the last proper still period (2 s or more): an armed session needs one before its first rep
      if (this.stillRun >= 2 * this.fs) this.stillBefore = this.stillRun;
      this.stillRun = 0;
    }
    if (++this.tick % 13 !== 0) return;      // analyse 8 times a second
    this._analyse(now, fr.still);
  }

  // Is rep x part of the set built so far? 'ok', 'reject' (an odd one-off move) or 'end' (too late: set is over).
  _judge(list, x) {
    const fs = this.fs;
    if (!list.length) return 'ok';
    const prev = list[list.length - 1], gap = x.top - prev.top;
    if (list.length >= 3) {
      const gaps = []; for (let k = 1; k < list.length; k++) gaps.push(list[k].top - list[k - 1].top);
      const mp = median(gaps);
      if (gap > Math.max(2.0 * mp, mp + 3 * fs)) return 'end';
    } else if (gap > 9 * fs) return 'end';
    if (list.length >= 3) {
      const mr = median(list.map(r => r.rom)), mt = median(list.map(r => r.rotDeg));
      if (x.rom > 1.6 * mr || x.rom < 0.45 * mr) return 'reject';
      if (mt > 40 && (x.rotDeg < 0.45 * mt || x.rotDeg > 1.6 * mt)) return 'reject';
      if (this._isRack(x, list)) return 'reject';
    }
    return 'ok';
  }

  // Racking the bar after the last rep: a bigger sweep that also turns clearly more than the reps before it
  // (real data: 75 cm and 48 deg after eight reps of 50 cm and 23 deg).
  _isRack(x, list) {
    if (list.length < 3) return false;
    const mr = median(list.map(r => r.rom)), mt = median(list.map(r => r.rotDeg));
    return x.rom > 1.3 * mr && x.rotDeg > 1.5 * mt + 5;
  }

  // Keep the reps that belong together by rhythm; returns the newest group.
  _rhythmGroup(reps) {
    let group = [];
    for (const x of reps) {
      if (group.length && x.start <= group[group.length - 1].top) continue;
      const v = this._judge(group, x);
      if (v === 'end') group = [x];
      else if (v === 'ok') group.push(x);
    }
    return group;
  }

  _analyse(now, stillNow) {
    const fs = this.fs;
    if (this.active) {
      const S = this.active;
      const r = analyzeWindow(this.F, S.winStart, now, { fs, concentric: this.profile.concentric, final: false, loadKg: this.loadKg });
      const reps = r.reps.filter(x => x.start >= S.firstStart - fs);
      // refresh the metrics of reps already counted (they sharpen as more data arrives)
      for (let k = 0; k < S.liveReps.length; k++) {
        const m = nearestStart(reps, S.liveReps[k].start, 0.35 * fs);
        if (m) S.liveReps[k] = { ...m, n: k + 1 };
      }
      let lastTop = S.liveReps.length ? S.liveReps[S.liveReps.length - 1].top : -1e12;
      for (const x of reps) {
        // a new rep must begin after the previous one topped out (the top of a rep that is
        // still being held drifts as the estimate sharpens; that is the same rep, not a new one)
        if (x.start <= lastTop) continue;
        if (S.rejected.some(t => Math.abs(t - x.start) < 0.35 * fs)) continue;
        const verdict = this._judge(S.liveReps, x);
        if (verdict === 'end') { this._finishSet(now, lastTop + Math.round(0.5 * fs)); return; }
        if (verdict === 'reject') { S.rejected.push(x.start); continue; }
        const rep = { ...x, n: S.liveReps.length + 1 };
        S.liveReps.push(rep); lastTop = x.top; S.lastRepEnd = x.top;
        this.on.rep(rep, S);
      }
      const periods = []; for (let k = 1; k < S.liveReps.length; k++) periods.push((S.liveReps[k].top - S.liveReps[k - 1].top) / fs);
      // End of set: bar put down (2.5 s truly still) or no rep for much longer than the rep rhythm.
      // A breath at the top between reps must not end the set.
      const endGap = Math.max(6, 2.5 * (median(periods) || 2.5));
      const stillLong = stillNow && this.stillRun >= 2.5 * fs && now - S.lastRepEnd > 1.0 * fs;
      if (stillLong || (now - S.lastRepEnd) / fs > endGap) this._finishSet(now, Math.min(now, S.lastRepEnd + Math.round(0.5 * fs)));
      return;
    }
    // idle: look for the start of a set in the recent motion
    if (stillNow) {
      // a single heavy rep between two still periods (e.g. a 1RM attempt) only shows up at the end
      if (this.stillRun >= 2.5 * fs && !this.singleChecked && this.motionStart >= 0) { this.singleChecked = true; this._tryShort(now); }
      return;
    }
    if (!this.pre.calibrated) return;
    const from = Math.max(this.lastSetEnd, this.F.base, now - 25 * fs, this.lastStillEnd - Math.round(0.5 * fs), this.pre.calibratedAt);
    if (now - from < 2 * fs) return;
    const r = analyzeWindow(this.F, from, now, { fs, concentric: this.profile.concentric, final: false, loadKg: this.loadKg });
    const reps = this._rhythmGroup(r.reps);
    // Three steady reps start a set live (earlier reps are counted retroactively). Sets of one or two
    // heavy reps are picked up when the bar is put down again (see _tryShort).
    // When armed, one clean rep is enough, as long as it follows a real rest (the countdown) and looks
    // like real lifting: big enough, and for bar work without much rotation.
    // Wrist-style exercises (curls, raises, pull-downs) are too noisy for this: they still need three reps
    // until there is real data to tune them on.
    const wristy = this.profile.kind === 'isolation' || this.profile.kind === 'pull-down';
    if (reps.length < (this.armed && !wristy ? 1 : 3) || r.M < 0.08) return;
    if (reps.length < 3) {
      if (!(this.stillBefore >= 2 * fs)) return;
      if (reps.some(x => x.rom < 0.2 || x.rotDeg > 45)) return;
    }
    const last = reps[reps.length - 1];
    if ((now - last.top) / fs > 3) return;
    const roms = reps.map(x => x.rom), m = median(roms);
    const cv = Math.sqrt(mean(roms.map(x => (x - m) ** 2))) / m;
    if (cv > 0.35 || m < 0.12) return;   // below 12 cm it is arm swing, not a lift
    // walking swings the wrist up and down every ~0.6 s; real reps take longer
    const gaps = []; for (let k = 1; k < reps.length; k++) gaps.push((reps[k].top - reps[k - 1].top) / fs);
    // (a lone rep has no gaps: judge it by how long its lift took instead)
    if (gaps.length ? median(gaps) < 0.9 : reps[0].conDur < 0.35) return;
    this._startSet(from, reps);
  }

  _startSet(from, reps) {
    const fs = this.fs;
    this.active = {
      id: Date.now(), exercise: this.exercise, loadKg: this.loadKg, rejected: [],
      winStart: from, firstStart: reps[0].start, liveReps: [], lastRepEnd: reps[reps.length - 1].top, startedAt: Date.now() - (this.now - reps[0].start) / fs * 1000,
    };
    this.on.setStart(this.active);
    for (const r of reps) { const rep = { ...r, n: this.active.liveReps.length + 1 }; this.active.liveReps.push(rep); this.on.rep(rep, this.active); }
  }

  _tryShort(now) {
    const fs = this.fs;
    const from = Math.max(this.lastSetEnd, this.F.base, now - 40 * fs, this.pre.calibratedAt);
    if (now - from < 1.5 * fs) return;
    const r = analyzeWindow(this.F, from, now, { fs, concentric: this.profile.concentric, final: true, loadKg: this.loadKg });
    // The weight was put down after a burst of movement. A short set may have ended before the live
    // detector (which waits for three reps) committed. Steady groups of 3+ count; one or two reps count
    // only if big and with little rotation (bar work: lifting the hand to look at a phone is one big
    // move too, but it turns the wrist a lot).
    if (!this.longStillBefore) return;
    const reps = this._rhythmGroup(r.reps);
    if (!reps.length) return;
    if (reps.length >= 3) {
      const m = median(reps.map(x => x.rom));
      if (m < 0.12 || Math.sqrt(mean(reps.map(x => (x.rom - m) ** 2))) / m > 0.35) return;
    } else if (reps.some(x => x.rom < 0.2 || x.rotDeg > 45)) return;
    this._startSet(from, reps);
    this._finishSet(now);
  }

  // cut: absolute index where the set is over (just after its last rep)
  _finishSet(now, cut = now) {
    const S = this.active; this.active = null;
    const fs = this.fs;
    const end = Math.max(cut, Math.min(now, S.lastRepEnd + fs));
    const r = analyzeWindow(this.F, S.winStart, end, { fs, concentric: this.profile.concentric, final: true, loadKg: S.loadKg });
    // Final metrics come from the whole set at once; keep exactly the reps that were counted live
    // (the athlete already heard that count), each matched to its refined version.
    let reps = S.liveReps.map(x => nearestStart(r.reps, x.start, 0.35 * fs) || x);
    // A rep is first judged on provisional numbers; with the final numbers a trailing rep can turn out to be
    // the bar being racked. Drop it.
    while (reps.length > 3 && this._isRack(reps[reps.length - 1], reps.slice(0, -1))) reps.pop();
    reps = reps.map((x, k) => ({ ...x, n: k + 1, provisional: false }));
    const set = {
      id: S.id, exercise: S.exercise, loadKg: S.loadKg, startedAt: S.startedAt,
      endedAt: S.startedAt + (reps.length ? (reps[reps.length - 1].top - reps[0].start) / fs * 1000 : 0),
      reps, summary: summarizeSet(reps, { exercise: S.exercise, loadKg: S.loadKg }),
    };
    set.features = setFeatures(this.F, set);
    set.restBefore = this.sets.length ? (S.startedAt - this.sets[this.sets.length - 1].endedAt) / 1000 : null;
    this.sets.push(set);
    this.lastSetEnd = cut;
    this.singleChecked = true;
    this.on.setEnd(set);
    // keep memory bounded: nothing before the previous set end is needed again
    this.F.trim(now - 30 * fs);
  }

  // force-close an open set (e.g. the user tapped "end set")
  flush() { if (this.active) this._finishSet(this.now); }
}

// ---------------------------------------------------------------- offline helper
// samples: array of [ax, ay, az, gx, gy, gz]; returns the sets found.
export function analyzeRecording(samples, opts = {}) {
  const sets = [];
  const s = new Session({ ...opts, onSetEnd: set => sets.push(set) });
  for (let i = 0; i < samples.length; i++) s.push(samples[i], opts.indices ? opts.indices[i] : undefined);
  // pad a second of the final reading so a set that ends the recording gets closed
  const last = samples[samples.length - 1];
  for (let i = 0; i < 52; i++) s.push(last);
  s.flush();
  return { sets, session: s };
}

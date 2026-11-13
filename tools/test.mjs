// Quick regression checks for the engine. Run: npm test
import { Preprocessor, fitCalibration, analyzeRecording, estimateRir, loadVelocityProfile, summarizeSet, stickingPoint } from '../docs/engine.js';
import { makeSession, rng, randomQuat, FS } from './sim.mjs';
import { DayLogger, decodeAct, decodeAngle } from './day.mjs';

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) fail++; };

// 1. a still board in any orientation reads zero motion, and bias/gravity are learned
{
  const r = rng(5);
  let worst = 0;
  for (let t = 0; t < 10; t++) {
    const [w, x, y, z] = randomQuat(r);
    const g = [2 * (x * z - w * y), 2 * (w * x + y * z), w * w - x * x - y * y + z * z].map(v => v * 1.04);
    const p = new Preprocessor(FS), fr = {};
    for (let i = 0; i < 520; i++) p.step([...g, 2, -3, 1], fr);
    worst = Math.max(worst, Math.abs(fr.lz), Math.abs(fr.lx), Math.abs(fr.ly));
    ok(Math.abs(p.bias[0] - 2) < 0.01 && Math.abs(p.g0 - 1.04) < 0.001, `pose ${t}: gyro bias and gravity scale learned`);
  }
  ok(worst < 0.05, `still board shows < 0.05 m/s2 motion (worst ${worst.toFixed(3)})`);
}

// 2. six-side calibration recovers per-axis gain and offset
{
  const sim = makeSession(42, 'squat');
  const c = fitCalibration(sim.calibPoints);
  ok(c && c.residual < 0.003, `calibration fit residual ${c && c.residual.toFixed(4)} g`);
}

// 3. a simulated squat session: every set found, rep counts within one
{
  const sim = makeSession(1505, 'squat');
  const { sets } = analyzeRecording(sim.samples, { fs: FS, exercise: 'back squat', indices: sim.indices, calib: fitCalibration(sim.calibPoints) });
  ok(sets.length === sim.sets.length, `squat: ${sets.length} sets found of ${sim.sets.length}`);
  sim.sets.forEach((t, i) => ok(sets[i] && Math.abs(sets[i].reps.length - t.reps.length) <= 1, `squat set ${i + 1}: ${sets[i]?.reps.length} reps vs ${t.reps.length}`));
}

// 4. estimates
{
  const rir = estimateRir([0.6, 0.57, 0.53, 0.49, 0.45], 0.3);
  ok(rir && rir.value >= 3 && rir.value <= 5, `reps in reserve from slowing reps: ${rir && rir.text}`);
  const lv = loadVelocityProfile([{ loadKg: 60, mcv: 0.9 }, { loadKg: 80, mcv: 0.7 }, { loadKg: 100, mcv: 0.5 }], 0.3);
  ok(lv && Math.abs(lv.e1rm - 120) < 0.5, `load-velocity 1RM ${lv && lv.e1rm.toFixed(1)} kg (expected 120)`);
  const s = summarizeSet([{ mcv: 0.6, rom: 0.5, conDur: 1, eccDur: 1.5, pauseBottom: 0, hDev: 0.02, rotDeg: 5 }, { mcv: 0.48, rom: 0.5, conDur: 1.2, eccDur: 1.5, pauseBottom: 0, hDev: 0.02, rotDeg: 5 }], { exercise: 'squat' });
  ok(Math.abs(s.velocityLoss - 0.2) < 1e-9, `velocity loss ${(s.velocityLoss * 100).toFixed(0)}%`);
}

// 5. sticking point: a speed curve with a dip in the middle is found, a smooth one is not
{
  const fs = FS, n = fs, v = new Float64Array(n), p = new Float64Array(n);
  const curve = dipAt => { for (let i = 0; i < n; i++) { const t = i / (n - 1); v[i] = Math.sin(Math.PI * t) * (1 - (dipAt ? 0.5 * Math.exp(-(((t - dipAt) / 0.08) ** 2)) : 0)); p[i] = (i ? p[i - 1] : 0) + v[i] / fs; } };
  curve(0); ok(stickingPoint(v, p, 0, n - 1, 1, fs) === null, 'smooth lift: no sticking point');
  curve(0.5); const s1 = stickingPoint(v, p, 0, n - 1, 1, fs);
  ok(s1 && Math.abs(s1.at - 0.5) < 0.08 && s1.dip > 0.3, `dip in the middle: sticking point at ${s1 && (s1.at * 100).toFixed(0)}% of the range, ${s1 && (s1.dip * 100).toFixed(0)}% slower`);
  curve(0.35); const s2 = stickingPoint(v, p, 0, n - 1, 1, fs);
  ok(s2 && s2.at < s1.at, `earlier dip: sticking point lower (${s2 && (s2.at * 100).toFixed(0)}%)`);
}

// 6. form through the whole engine on simulated bench sets
{
  const run = (seed, o) => { const sim = makeSession(seed, 'bench', { sets: 1, reps: 8, ...o }); return analyzeRecording(sim.samples, { fs: FS, exercise: 'bench press', indices: sim.indices, calib: fitCalibration(sim.calibPoints) }).sets[0]; };
  let worstFalse = 0, n = 0, falseStick = 0;
  for (let s = 0; s < 8; s++) { const set = run(300 + s, { spinDeg: 12 }); if (!set) continue; n++; if (set.summary.tiltLead !== undefined) worstFalse = Math.max(worstFalse, set.summary.tiltLead); if (set.summary.stickAt !== undefined) falseStick++; }
  ok(n >= 7 && worstFalse < 1.0, `level bar reads level (worst ${worstFalse.toFixed(2)} deg over ${n} sets)`);
  ok(falseStick === 0, `smooth reps: no sticking point reported (${falseStick} of ${n} sets)`);
  const errs = [];
  for (let s = 0; s < 8; s++) for (const deg of [2, 4]) { const set = run(400 + s, { spinDeg: 12, tiltDeg: deg }); if (set && set.summary.tiltLead !== undefined) errs.push({ deg, got: set.summary.tiltLead, same: set.summary.tiltSame }); }
  const worst = Math.max(...errs.map(e => Math.abs(e.got - e.deg)));
  ok(errs.length >= 14 && worst < 0.8 && errs.every(e => e.same === 1), `bar tilt of 2 and 4 deg measured within ${worst.toFixed(2)} deg, same side every rep (${errs.length} sets)`);
  const flat = run(500, { spinDeg: 0, tiltDeg: 3 });
  ok(flat && flat.summary.tiltLead === undefined, 'a bar that does not roll: tilt is left out instead of guessed');
  let found = 0, tot = 0; const ats = [];
  for (let s = 0; s < 8; s++) { const set = run(600 + s, { stick: 0.14 }); if (!set) continue; tot++; if (set.summary.stickAt !== undefined) { found++; ats.push(set.summary.stickAt); } }
  ok(found >= tot - 1 && ats.every(a => a > 0.25 && a < 0.75), `mid-lift slow-down found in ${found} of ${tot} sets (at ${ats.map(a => (a * 100).toFixed(0)).join(', ')}% of the range)`);
}

// 7. all-day logger (the PC twin of firmware/libraries/RepDay): steps, stillness, record format
{
  const run = (sim, usb = false) => { const lg = new DayLogger(), recs = []; for (let i = 0; i < sim.samples.length; i++) { if (sim.indices[i] % 4) continue; const s = sim.samples[i]; const r = lg.feed(sim.indices[i] * 1000 / FS, s[0], s[1], s[2], usb); if (r) recs.push(r); } return { recs, steps: recs.reduce((a, r) => a + r[3], 0) + lg.steps }; };
  let truth = 0, got = 0;
  for (let seed = 1; seed <= 10; seed++) { const sim = makeSession(seed * 31, 'rest-only'); truth += sim.steps; got += run(sim).steps; }
  ok(Math.abs(got - truth) / truth < 0.15, `steps on simulated walking: ${got} counted of ${truth} (${(100 * got / truth).toFixed(0)}%)`);
  // a board lying on a table for three minutes (with sensor noise)
  const r = rng(9), still = { samples: [], indices: [] };
  for (let i = 0; i < FS * 185; i++) { still.samples.push([0.02 + r.n(0.003), -0.01 + r.n(0.003), 1.04 + r.n(0.003)]); still.indices.push(i); }
  const q = run(still, true);
  ok(q.recs.length === 3 && q.steps === 0 && q.recs.every(x => (x[2] & 127) === 0 && decodeAct(x[0]) < 6), `still board: 3 minute records, no steps, no turning, movement ${q.recs.map(x => decodeAct(x[0]).toFixed(1)).join('/')} mg`);
  ok(q.recs.every(x => (x[2] & 0x80) !== 0 && decodeAngle(x[1]) > 80), 'still board: USB flag set and angle reads flat on its back');
}

// 8. remembered gyro offset: a session that starts while the weight is already moving
{
  const sim = makeSession(1505, 'squat');
  const calib = fitCalibration(sim.calibPoints);
  // learn the board's offset from the whole session (it has still moments)
  const full = analyzeRecording(sim.samples, { fs: FS, exercise: 'back squat', indices: sim.indices, calib });
  const seed = full.session.learned;
  ok(seed && seed.gyroBias.every(Number.isFinite), `offset learned during a still second (${seed && seed.gyroBias.map(x => x.toFixed(1)).join(', ')} deg/s)`);
  // now start listening just as the first rep of the first set begins: no still second before it
  const t = sim.sets[0], from = sim.indices.findIndex(i => i >= t.reps[0].conStartIdx - Math.round(2.0 * FS));
  const cut = sim.samples.slice(from), idx = sim.indices.slice(from);
  const fresh = analyzeRecording(cut, { fs: FS, exercise: 'back squat', indices: idx, calib }).sets[0];
  const seeded = analyzeRecording(cut, { fs: FS, exercise: 'back squat', indices: idx, calib, seed }).sets[0];
  ok(seeded && seeded.reps.length === t.reps.length, `started mid-movement with the offset remembered: ${seeded && seeded.reps.length} reps of ${t.reps.length} (without it: ${fresh ? fresh.reps.length : 0})`);
  const stale = analyzeRecording(sim.samples, { fs: FS, exercise: 'back squat', indices: sim.indices, calib, seed: { gyroBias: [40, -40, 40], g0: 1 } });
  ok(stale.sets.length === sim.sets.length && stale.session.learned && Math.abs(stale.session.learned.gyroBias[0] - seed.gyroBias[0]) < 0.5, 'a remembered offset that is badly wrong is replaced at the first still second');
}

// 9. reps in reserve: the more a set slows down, the fewer are left; never generous on a grind
{
  const easy = estimateRir([0.60, 0.61, 0.59, 0.60, 0.58], null), mid = estimateRir([0.60, 0.58, 0.54, 0.50, 0.45, 0.42], null), hard = estimateRir([0.60, 0.57, 0.50, 0.44, 0.38, 0.31], null);
  ok(easy.value >= 5 && mid.value >= 2 && mid.value <= 4 && hard.value <= 1, `slow-down alone (no 1RM speed): easy ${easy.text}, medium ${mid.text}, hard ${hard.text}`);
  ok(estimateRir([0.5, 0.5, 0.49, 0.48, 0.34], null).value <= 1, 'a last rep that suddenly grinds leaves at most one');
}

console.log(fail ?`\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);

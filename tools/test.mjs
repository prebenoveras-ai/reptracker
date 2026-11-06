// Quick regression checks for the engine. Run: npm test
import { Preprocessor, fitCalibration, analyzeRecording, estimateRir, loadVelocityProfile, summarizeSet } from '../docs/engine.js';
import { makeSession, rng, randomQuat, FS } from './sim.mjs';

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

console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);

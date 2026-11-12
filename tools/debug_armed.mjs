// Trace when an armed session announces its first reps vs when the truth reps finish.
// Usage: node tools/debug_armed.mjs [kind=squat] [seed=1505]
import { makeSession, FS } from './sim.mjs';
import { Session, fitCalibration, analyzeWindow } from '../docs/engine.js';
const kind = process.argv[2] || 'squat', seed = Number(process.argv[3] || 1505);
const EX = { squat: 'back squat', bench: 'bench press', deadlift: 'deadlift', ohp: 'overhead press', curl: 'dumbbell curl' };
const sim = makeSession(seed, kind, { sets: 1 });
const t = sim.sets[0];
const a = Math.max(0, t.startIdx - Math.round(5.5 * FS)), b = t.endIdx + 4 * FS;
console.log('truth reps conEnd (s from window start):', t.reps.map(r => ((r.conEndIdx - a) / FS).toFixed(1)).join(' '));
for (const armed of [false, true]) {
  let sess; const ev = [];
  sess = new Session({ fs: FS, exercise: EX[kind], calib: fitCalibration(sim.calibPoints), armed,
    onRep: (rep, S) => ev.push(`rep${S.liveReps.length}@${((sess.now) / FS).toFixed(1)}s`),
    onSetStart: () => ev.push(`START@${(sess.now / FS).toFixed(1)}s`) });
  const trace = [];
  for (let i = a; i < b; i++) {
    sess.push(sim.samples[i], sim.indices[i]);
    if (armed && !sess.active && sess.pre.calibrated && (i - a) % 26 === 0 && (i - a) / FS > 5 && (i - a) / FS < 19) {
      const fs = FS, now = sess.now;
      const from = Math.max(sess.lastSetEnd, sess.F.base, now - 25 * fs, sess.lastStillEnd - Math.round(0.5 * fs), sess.pre.calibratedAt);
      const r = analyzeWindow(sess.F, from, now, { fs, concentric: sess.profile.concentric, final: false, loadKg: 0 });
      trace.push(`t=${(now / fs).toFixed(1)} from=${(from / fs).toFixed(1)} reps=${r.reps.length} rom=${r.reps.map(x => x.rom.toFixed(2)).join('/')} rot=${r.reps.map(x => Math.round(x.rotDeg)).join('/')} M=${r.M.toFixed(2)} stillBefore=${(sess.stillBefore / fs).toFixed(1)}s stillRun=${(sess.stillRun / fs).toFixed(1)}s active=${!!sess.active}`);
    }
  }
  if (armed) console.log(trace.join('\n'));
  console.log(armed ? 'armed ' : 'normal', ev.slice(0, 6).join(' '), '| longStillBefore:', sess.longStillBefore);
}

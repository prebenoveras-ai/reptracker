// Debug one simulated session: core analysis on each true set window, plus the streaming session.
// Usage: node tools/debug.mjs kind seed
import { makeSession, FS } from './sim.mjs';
import { Preprocessor, Frames, analyzeWindow, analyzeRecording } from '../docs/engine.js';

const kind = process.argv[2] || 'squat', seed = Number(process.argv[3] || 1505);
const EX = { squat: 'squat', bench: 'bench', deadlift: 'deadlift', ohp: 'overhead press', curl: 'curl', lateral: 'lateral raise', pulldown: 'lat pulldown' };
const sim = makeSession(seed, kind);
const pre = new Preprocessor(FS), F = new Frames(1024), fr = {};
// fill gaps like Session does
let last = null, lastIdx = null;
for (let i = 0; i < sim.samples.length; i++) {
  const idx = sim.indices[i], raw = sim.samples[i];
  if (lastIdx !== null && idx > lastIdx + 1) for (let g = 1; g < idx - lastIdx; g++) F.push(pre.step(last, fr));
  F.push(pre.step(raw, fr)); last = raw; lastIdx = idx;
}
let stillCount = 0; for (let i = 0; i < F.n; i++) stillCount += F.still[i];
console.log(`${kind} seed ${seed}: ${F.n} frames, still ${(100 * stillCount / F.n).toFixed(0)}%, bias ${pre.bias.map(v => v.toFixed(2))} g0 ${pre.g0.toFixed(3)}`);
for (const t of sim.sets) {
  const a = Math.max(0, t.startIdx - FS), b = Math.min(F.n, t.endIdx + 2 * FS);
  const r = analyzeWindow(F, a, b, { fs: FS, concentric: sim.concentric, final: true });
  console.log(` truth set ${t.reps.length} reps [${t.startIdx}-${t.endIdx}] -> core ${r.reps.length} reps, M=${r.M.toFixed(3)}`);
  console.log('   truth rom', t.reps.map(x => x.rom.toFixed(2)).join(' '), ' mcv', t.reps.map(x => x.mcv.toFixed(2)).join(' '));
  console.log('   found rom', r.reps.map(x => x.rom.toFixed(2)).join(' '), ' mcv', r.reps.map(x => x.mcv.toFixed(2)).join(' '));
  // position extremes (truth vs estimate) for a sanity check
  if (process.env.TRACE && r.p) { const step = 26; let s = ''; for (let i = 0; i < r.p.length; i += step) s += (r.p[i] * 100).toFixed(0) + ' '; console.log('   p(cm)', s); s = ''; for (let i = a; i < b; i += step) s += ((sim.truthZ[i] - sim.truthZ[a]) * 100).toFixed(0) + ' '; console.log('   truth', s); }
}
const { sets } = analyzeRecording(sim.samples, { fs: FS, exercise: EX[kind], indices: sim.indices });
console.log(' session sets:', sets.map(s => `${s.reps.length}@${s.reps[0]?.start}`).join(', '));

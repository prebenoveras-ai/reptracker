// Accuracy bench: simulated sessions -> engine -> compare with truth.
// Usage: node tools/bench.mjs [sessionsPerKind=12] [seed=1] [kinds=all]
import { makeSession, FS } from './sim.mjs';
import { analyzeRecording, fitCalibration } from '../docs/engine.js';
const useCal = process.env.CAL !== '0';

const per = Number(process.argv[2] || 12), seed0 = Number(process.argv[3] || 1);
const KINDS = (process.argv[4] || 'squat,bench,deadlift,ohp,curl,lateral,pulldown,rest-only').split(',');
const EXNAME = { squat: 'back squat', bench: 'bench press', deadlift: 'deadlift', ohp: 'overhead press', curl: 'dumbbell curl', lateral: 'lateral raise', pulldown: 'lat pulldown', 'rest-only': 'curl' };

const rows = [];
const tot = { sets: 0, found: 0, exact: 0, off1: 0, falseSets: 0, romErr: [], mcvErr: [], mcvRel: [], countErr: [] };
for (const kind of KINDS) {
  const k = { kind, sets: 0, found: 0, exact: 0, off1: 0, falseSets: 0, romErr: [], mcvErr: [], mcvRel: [], countErr: [], misses: [] };
  for (let s = 0; s < per; s++) {
    const seed = seed0 * 1000 + s * 17 + kind.length * 101;
    const sim = makeSession(seed, kind);
    const calib = useCal ? fitCalibration(sim.calibPoints) : null;
    const { sets } = analyzeRecording(sim.samples, { fs: FS, exercise: EXNAME[kind], indices: sim.indices, calib });
    const used = new Set();
    for (const t of sim.sets) {
      k.sets++;
      const d = sets.find((x, i) => !used.has(i) && x.reps.some(r => r.top >= t.startIdx && r.top <= t.endIdx + FS));
      if (!d) { k.countErr.push(-t.reps.length); k.misses.push(`seed ${seed}: missed set of ${t.reps.length}`); continue; }
      used.add(sets.indexOf(d));
      k.found++;
      // reps of this detected set that fall inside the truth set
      const dr = d.reps;
      const err = dr.length - t.reps.length;
      k.countErr.push(err);
      if (err === 0) k.exact++; else if (Math.abs(err) === 1) k.off1++;
      if (err) k.misses.push(`seed ${seed}: ${dr.length} vs ${t.reps.length}`);
      for (const tr of t.reps) {
        let best = null, bd = 1e9;
        for (const r of dr) { const dd = Math.abs(r.top - tr.conEndIdx); if (dd < bd) { bd = dd; best = r; } }
        if (!best || bd > 0.6 * FS) continue;
        k.romErr.push(best.rom - tr.rom);
        k.mcvErr.push(best.mcv - tr.mcv);
        k.mcvRel.push((best.mcv - tr.mcv) / tr.mcv);
      }
    }
    k.falseSets += sets.length - used.size;
    if (sets.length - used.size) k.misses.push(`seed ${seed}: ${sets.length - used.size} false set(s) of ${sets.filter((_, i) => !used.has(i)).map(x => x.reps.length).join('/')} reps`);
  }
  rows.push(k);
  for (const f of ['sets', 'found', 'exact', 'off1', 'falseSets']) tot[f] += k[f];
  for (const f of ['romErr', 'mcvErr', 'mcvRel', 'countErr']) tot[f].push(...k[f]);
}

const mae = a => a.length ? a.reduce((s, x) => s + Math.abs(x), 0) / a.length : NaN;
const bias = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const pct = (a, b) => b ? (100 * a / b).toFixed(0) + '%' : '-';
const fmt = k => [
  k.kind.padEnd(10), String(k.sets).padStart(4), pct(k.found, k.sets).padStart(6), pct(k.exact, k.sets).padStart(7), pct(k.exact + k.off1, k.sets).padStart(7),
  String(k.falseSets).padStart(6),
  (mae(k.romErr) * 100).toFixed(1).padStart(7), (bias(k.romErr) * 100).toFixed(1).padStart(7),
  mae(k.mcvErr).toFixed(3).padStart(7), (mae(k.mcvRel) * 100).toFixed(1).padStart(6),
].join(' ');
console.log('kind       sets  found  exact  +-1    false  ROMcm  ROMbias MCVm/s MCV%');
for (const k of rows) console.log(fmt(k));
console.log(fmt({ ...tot, kind: 'ALL' }));
if (process.env.VERBOSE) for (const k of rows) for (const m of k.misses) console.log(k.kind, m);

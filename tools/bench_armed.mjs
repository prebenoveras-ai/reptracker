// Armed-mode bench: mimics "press start, hold still, lift, rest".
// For every simulated set, run the engine on [5.5 s before the set .. 4 s after] with and without armed mode.
// Reports: exact rep count, false sets, and how many reps were already done when the FIRST rep was announced.
// Usage: node tools/bench_armed.mjs [sessionsPerKind=12] [seed=1] [kinds=squat,bench,deadlift,ohp,curl,lateral,pulldown]
import { makeSession, FS } from './sim.mjs';
import { Session, fitCalibration } from '../docs/engine.js';

const per = Number(process.argv[2] || 12), seed0 = Number(process.argv[3] || 1);
const KINDS = (process.argv[4] || 'squat,bench,deadlift,ohp,curl,lateral,pulldown').split(',');
const EXNAME = { squat: 'back squat', bench: 'bench press', deadlift: 'deadlift', ohp: 'overhead press', curl: 'dumbbell curl', lateral: 'lateral raise', pulldown: 'lat pulldown' };

function run(sim, a, b, armed, kind) {
  const calib = fitCalibration(sim.calibPoints);
  const sets = [], announced = [];
  let sess;
  sess = new Session({ fs: FS, exercise: EXNAME[kind], calib, armed, onSetEnd: s => sets.push(s), onRep: (rep, S) => announced.push({ n: S.liveReps.length, at: sess.now }) });
  for (let i = Math.max(0, a); i < Math.min(sim.samples.length, b); i++) sess.push(sim.samples[i], sim.indices[i]);
  sess.flush();
  return { sets, announced, base: Math.max(0, a) };
}

const out = {};
for (const kind of KINDS) {
  const mk = () => ({ sets: 0, exact: 0, off1: 0, miss: 0, falseSets: 0, first: [] });
  const k = { armed: mk(), normal: mk() };
  for (let s = 0; s < per; s++) {
    const seed = seed0 * 1000 + s * 17 + kind.length * 101;
    const sim = makeSession(seed, kind);
    for (const t of sim.sets) {
      const a = t.startIdx - Math.round(5.5 * FS), b = t.endIdx + 4 * FS;
      for (const mode of ['armed', 'normal']) {
        const r = run(sim, a, b, mode === 'armed', kind), m = k[mode];
        m.sets++;
        const good = r.sets.filter(x => x.reps.some(rep => (rep.top + r.base) >= t.startIdx && (rep.top + r.base) <= t.endIdx + FS));
        m.falseSets += r.sets.length - good.length;
        if (!good.length) { m.miss++; continue; }
        const err = good[0].reps.length - t.reps.length;
        if (err === 0) m.exact++; else if (Math.abs(err) === 1) m.off1++;
        // reps already finished (truth) when the first rep was announced
        const first = r.announced[0];
        if (first) { const at = first.at + r.base; m.first.push(t.reps.filter(x => x.conEndIdx <= at).length); }
      }
    }
  }
  out[kind] = k;
}

const pct = (x, n) => n ? (100 * x / n).toFixed(0) + '%' : '-';
const avg = a => a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : '-';
console.log('kind       mode    sets  exact  +-1   miss  false  reps done when 1st rep announced (avg)');
for (const kind of KINDS) for (const mode of ['normal', 'armed']) {
  const m = out[kind][mode];
  console.log(kind.padEnd(10), mode.padEnd(7), String(m.sets).padStart(4), pct(m.exact, m.sets).padStart(6), pct(m.exact + m.off1, m.sets).padStart(5), String(m.miss).padStart(5), String(m.falseSets).padStart(6), avg(m.first).padStart(8));
}

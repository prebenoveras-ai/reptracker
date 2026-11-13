// Replays real recordings through the engine and compares the count with the real rep count.
// Usage: node tools/real.mjs <file.csv | file.json> [more files] [--armed] [--verbose]
//   CSV  = the RepTracker page's "Share all" export (set_id,exercise,placement,reps,sample,t_s,ax_g..gz_dps)
//   JSON = VitaBrief's "Share recordings" export ({ sets: [{ exercise, reps (what you really did), counted,
//          rate, apg, gpd, goIdx, data: base64 int16 x 6 per sample }] })
// A recording that starts with the weight already moving gets one calm second put in front of it
// (the engine needs a still moment to learn the gyro offset; live it gets that before the set).
import fs from 'node:fs';
import { Session } from '../docs/engine.js';

const args = process.argv.slice(2), files = args.filter(a => !a.startsWith('--'));
const verbose = args.includes('--verbose'), forceArmed = args.includes('--armed');
if (!files.length) { console.error('usage: node tools/real.mjs <recordings.csv|json> [--armed] [--verbose]'); process.exit(1); }

function loadCsv(file) {
  const sets = new Map();
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 12) continue;
    let s = sets.get(c[0]);
    if (!s) sets.set(c[0], s = { id: c[0], exercise: c[1], placement: c[2], reps: Number(c[3]), fs: 104, samples: [], goIdx: -1 });
    s.samples.push([+c[6], +c[7], +c[8], +c[9], +c[10], +c[11]]);
  }
  return [...sets.values()];
}
function loadJson(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (j.sets || []).map(s => {
    const b = Buffer.from(s.data, 'base64'), n = Math.floor(b.length / 12), samples = [];
    for (let i = 0; i < n; i++) samples.push([0, 1, 2].map(k => b.readInt16LE(i * 12 + k * 2) / (s.apg || 1000)).concat([3, 4, 5].map(k => b.readInt16LE(i * 12 + k * 2) / (s.gpd || 10))));
    return { id: s.id, exercise: s.exercise, placement: s.placement || '', reps: Number(s.reps), counted: s.counted, fs: s.rate || 104, samples, goIdx: Number.isFinite(s.goIdx) ? s.goIdx : -1, calib: s.calib || null, seed: s.seed || null, note: s.note || '' };
  });
}

// Runs one recording the way the app does. Returns the reps of the set the engine reports.
export function replay(rec, opts = {}) {
  const fs_ = rec.fs || 104;
  let found = [];
  const S = new Session({ fs: fs_, exercise: rec.exercise, calib: rec.calib || null, seed: rec.seed || null, onSetEnd: set => { if (set.reps.length > found.length) found = set.reps; S.lastSummary = set.summary; } });
  let lead = 0;
  if (rec.goIdx < 0) {
    // No countdown in the recording (it starts with the weight already moving): put three calm
    // seconds in front. The calm reading is built from the recording itself: the direction of its
    // first samples at the usual size of gravity, and the average rotation as the gyro's offset
    // (over whole reps the real rotation averages out to nothing).
    const n = rec.samples.length, k = Math.min(10, n), mean = [0, 0, 0, 0, 0, 0], first = [0, 0, 0];
    for (const x of rec.samples) for (let j = 0; j < 6; j++) mean[j] += x[j] / n;
    for (let i = 0; i < k; i++) for (let j = 0; j < 3; j++) first[j] += rec.samples[i][j] / k;
    const mags = rec.samples.map(x => Math.hypot(x[0], x[1], x[2])).sort((x, y) => x - y), g0 = mags[n >> 1];
    const fl = Math.hypot(...first) || 1;
    const calm = [first[0] / fl * g0, first[1] / fl * g0, first[2] / fl * g0, mean[3], mean[4], mean[5]];
    lead = fs_ * 3;
    for (let i = 0; i < lead; i++) S.push(calm);
    if (opts.armed) S.setArmed(true);
  }
  for (let i = 0; i < rec.samples.length; i++) {
    if (rec.goIdx >= 0 && i === rec.goIdx) { if (S.active) S.flush(); found = []; S.setArmed(true); }
    S.push(rec.samples[i]);
  }
  const last = rec.samples[rec.samples.length - 1];
  for (let i = 0; i < fs_ * 4; i++) S.push(last);
  S.flush();
  return { reps: found, summary: S.lastSummary };
}

if (process.argv[1] && process.argv[1].endsWith('real.mjs')) {
  let n = 0, exact = 0, off1 = 0;
  for (const f of files) {
    const recs = f.toLowerCase().endsWith('.json') ? loadJson(f) : loadCsv(f);
    for (const rec of recs) {
      if (!(rec.reps > 0)) continue;
      const r = replay(rec, { armed: forceArmed });
      const got = r.reps.length, err = got - rec.reps;
      n++; if (!err) exact++; else if (Math.abs(err) === 1) off1++;
      const rir = r.summary && r.summary.rir ? r.summary.rir.text : '-';
      console.log(`${err ? 'MISS ' : 'ok   '}${String(rec.exercise).padEnd(26)} ${String(rec.placement || '').padEnd(6)} real ${String(rec.reps).padStart(2)} counted ${String(got).padStart(2)}${rec.counted !== undefined ? ' (phone said ' + rec.counted + ')' : ''}  RIR ${rir}  ${(rec.samples.length / (rec.fs || 104)).toFixed(0)} s${rec.note ? '  ' + rec.note : ''}`);
      if (verbose) console.log('     ' + r.reps.map(x => `${x.rom.toFixed(2)}m ${x.mcv.toFixed(2)}m/s ${x.conDur.toFixed(1)}s rot${Math.round(x.rotDeg)}`).join(' | '));
    }
  }
  console.log(`\n${n} sets: ${exact} exact, ${off1} off by one, ${n - exact - off1} worse`);
}

# RepTracker handover (2026-11-06)

## Built while you were away

- **Analysis engine** (`docs/engine.js`). It works out which way is up from any mounting, then finds sets and reps automatically. For each rep it measures bar speed, range of motion, tempo, power, bar drift and wrist rotation. For each set it gives velocity loss, reps in reserve, estimated 1RM, time under tension and a consistency score.
- **Simulator and accuracy bench** (`tools/`). Realistic squat, bench, deadlift, overhead press, curl, lateral raise and pulldown sessions, with walking around between sets, using your board's real error profile.
- **Workout app** (https://prebenoveras-ai.github.io/reptracker/docs/, in Chrome):
  - **Workout:** just lift. You get a big rep counter, colour-coded speed per rep, a velocity-loss "stop now" alert, a spoken count and speed, vibration and a rest timer.
  - **History:** per-rep tables, load-velocity 1RM, a progress chart, and VitaBrief / JSON / CSV export.
  - **Setup:** 6-side calibration, feedback options and exercise learning.
  - **Record:** labelled raw sets. Every set from Workout is saved here too, and **Check accuracy** re-runs the engine against your real rep counts.
- **Tested on the real board** (over Bluetooth from the PC, 40 s on the desk): noise is 6x lower than the simulator assumes, 0 lost samples, 0 false sets. The board was never moved, so real lifting hasn't been tested yet.

## Accuracy so far (simulated, 185 unseen sets)

- **Barbell lifts:** 96-100% of sets found, 92-100% exact rep count, range within 2-4 cm, speed within 2-4%.
- **Wrist exercises:** 26-53% exact rep count. They need your real recordings to tune.

## What to do when you're back (about 15 minutes)

1. Open the app link in **Chrome** and pull down to refresh.
2. **Setup → Calibrate.** Connect, tap Start, then lay the board on each of its 6 sides for about 2 s each.
3. **Workout.** Type the exercise and load. Do a few real sets with the board on the bar (magnet or tape), then a few with it on your wrist.
4. **Record → Check accuracy.** Fix any wrong rep counts in the list first (type the real number), then check again.
5. **Record → Share all.** Send the CSV to your PC and tell me where it is. I'll tune the engine on your real data.

## Decision needed: how it gets into VitaBrief

VitaBrief runs as a Capacitor APK. **Web Bluetooth doesn't work inside Android WebViews**, so the RepTracker page can't simply be pasted into VitaBrief. The options:

1. **Import** (smallest): add "Import from RepTracker" to VitaBrief. You paste or share the JSON this app already exports (same shape as `gym_sessions`, plus a `sensor` field). The sensor data still has to be wired into Coach and Brief context.
2. **Native BLE inside VitaBrief** (best experience): add the `@capacitor-community/bluetooth-le` plugin and run `docs/engine.js` inside VitaBrief. You get live reps in the VitaBrief workout screen. This needs a native plugin and an APK rebuild, so it's beyond editing `index.html`.
3. **Shared Firebase**: the RepTracker page writes finished workouts to your Firebase account and VitaBrief picks them up. Needs sign-in on the RepTracker page.

Nothing in the VitaBrief repo was changed.

## Known limits

- Wrist rep counting is not reliable yet (see above).
- Exercises with under 12 cm of movement (calf raises, shrugs) are ignored on purpose, so arm swings while walking aren't counted.
- Reps-in-reserve and 1RM velocities are published averages for barbell lifts. They get personal once History has several loads per exercise.
- A set of 1-2 reps only appears after the bar has been still for about 2.5 s.
- The board needs about 1 s of stillness after connecting to learn its gyro offset. Calibration stores it, so this is quicker afterwards.

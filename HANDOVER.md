# RepTracker handover (2026-11-06, sleep section added 2026-11-10)

## Sleep and wake (written 2026-11-10 - NOT yet confirmed on the real board)

The board now puts itself to sleep when it lies still and wakes when it is moved. Code: `firmware/libraries/RepPower` (new), wake mode in `RepImu` (`armWake`), `RepBle::stop()`, and the sequence in `firmware/imu_ble/imu_ble.ino` (`goToSleep()`).

- **Wake:** the IMU's wake-up interrupt (accelerometer only, 26 Hz, 62 mg jolt, latched) drives its INT1 pin, which is nRF pin P0.11 (Arduino D18, from the Seeed board definition). That pin is the System OFF wake source. Waking resets the board, so it boots straight back into streaming/advertising.
- **Sleep rules** (constants at the top of `imu_ble.ino`): nothing moved for 15 min with a phone connected, or 4 min with nobody connected. "Moved" = acceleration changes more than 0.05 g from its own half-second average, or rotation above 8 deg/s, for at least 3 samples in a row. Board noise is 0.0005 g / 0.05 dps, so vibration doesn't count. A phone connecting or leaving restarts the timer.
- **Never sleeps on USB power** (charging, flashing, serial monitor). Set `SLEEP_WHEN_USB_POWERED = true` only to test sleep on a cable.
- **Order on the way down:** two short red flashes, stop advertising and hang up, put the IMU into watch mode and check INT1 is low, then System OFF. If INT1 won't settle (board being moved) it restarts instead of sleeping. **Wake:** one short green flash.
- **Charging** is set to 100 mA (P0.13 driven low, per the Seeed wiki). `FAST_CHARGE = false` goes back to 50 mA.
- **Quick test build** (20 s / 40 s timeouts): add `--build-property "compiler.cpp.extra_flags=-DREP_QUICK_TEST"` to the compile command. Don't use `build.extra_flags`, it removes the chip definition.
- **Reset button / bootloader:** untouched. Double-tap reset still gives the XIAO-SENSE drive.

**App behaviour when the board sleeps (unchanged, needs your decision):** both the RepTracker page and VitaBrief save what they have and show "disconnected" when the link drops. Neither reconnects by itself, so after the board wakes you tap Connect (or the Reps button in VitaBrief) again. Sleep only happens after 15 min still while connected, so it shouldn't cut a set. Auto-reconnect would be a separate app change.

**Not verified:** (1) that the IMU keeps its power pin high in System OFF (the Nordic forums say GPIO levels are kept; the real test is whether it wakes), (2) the IMU register bits, which come from ST's AN4650 for the older LSM6DS3 (the TR-C datasheet would not download), (3) sleep current. Expected asleep: tens of microamps, so months on 600 mAh, with the battery's own self-discharge as the limit. Expected awake and streaming: roughly 4-8 mA (the main loop never idles the CPU), so a few days of continuous use. These are estimates; measure before trusting them.

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

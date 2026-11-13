# RepTracker handover (2026-11-06, form + all-day mode added 2026-11-13)

## Form, strength readiness and all-day mode (2026-11-13)

Three additions, all visible in VitaBrief v10.49. Tested on the PC and in the browser with simulated data. **Nothing here has run on the real board or the phone yet.**

**1. Strength readiness (VitaBrief only, no firmware).** For each exercise VitaBrief learns how fast a given weight usually moves, from the first three sensor sets of your earlier workouts (last 10 weeks). After a recorded set it says how today compares ("4% slower than your usual"), gives an estimated max for today and, when the day is clearly off, a weight for the next set. It needs two earlier workouts with the sensor on that exercise first. It only means something if every rep is pushed up as fast as you can. Within 5% either way counts as a normal day. Coach and Brief get the same numbers.

**2. Form (engine, `docs/engine.js`).**
- *Sticking point:* where in the lift the bar slows down before speeding up again (percent of the way up, and how much speed is lost). Reported when at least a third of the reps show it.
- *Bar tilt:* how many degrees one end of the bar leads mid-lift, and whether it is the same end every rep. The board cannot know how it is mounted, so the bar's direction is worked out from how the bar rolls during the set. If the bar does not roll at least a few degrees (likely on deadlifts), tilt is left out instead of guessed. **It cannot say which end leads** (left or right); that needs a set-up step that isn't built.
- Simulated accuracy (`npm test`): tilt of 2 and 4 degrees measured within 0.12 degrees, a level bar reads level, no false sticking points in 1,200 simulated reps. Rep counting is unchanged (`node tools/bench.mjs 12 7` gives the same table as before).
- The engine is copied into VitaBrief with `node tools/copy_to_vitabrief.mjs` (`--check` only compares). Don't edit VitaBrief's copy by hand.

**3. All-day mode (firmware + VitaBrief), for wearing the board on the wrist.**
- Switched on in VitaBrief: RepTracker sheet -> "All-day mode (wrist)". The phone tells the board, and the board remembers it across resets (not across a flat battery).
- In this mode the board **never switches itself off**. With no phone listening it watches the accelerometer at 26 Hz in low power (gyro off) and stores one 4-byte record per minute: movement, wrist angle, turning, steps. It keeps the last 3 days in memory. When VitaBrief connects for a workout it streams at 104 Hz as usual and keeps logging.
- The board has no clock. Minutes are numbered from when logging started, and the phone gives them real times when it collects them.
- VitaBrief collects when you connect, with the "Collect wrist data now" button, and tries by itself when the app is opened near the board. From the minutes it works out the night's rest (start, end, still time, wake-ups, restlessness) and the day's steps, active minutes and longest still stretch. They show on the Today page and go to Coach and Brief.
- New code: `firmware/libraries/RepDay` (the minute logger; its PC twin `tools/day.mjs` is what the tests run, keep the two identical), low-power mode in `RepImu` (`setLowPower`), three new Bluetooth values in `RepBle` (`a6e10005` status, `a6e10006` commands, `a6e10007` log), and the mode handling in `imu_ble.ino`.
- Firmware compiles (133 KB). **Not flashed.**

**Not verified, in order of how likely it is to need fixing:**
1. Battery life in all-day mode. Nothing was measured. The design should draw well under 1 mA, which would be weeks on 600 mAh, but the earlier sleep and battery firmware is also still unconfirmed, so treat this as unknown until the board has been worn for a day and the percentage read.
2. The app collecting by itself when opened (Android connecting to a known board without the picker). If it doesn't, the Collect button after connecting does the same job.
3. The low-power register settings (same ST app note as the wake-up settings) and that the mode survives a reset (retained register GPREGRET2).
4. The night and activity cut-offs (what counts as rest, a wake-up, an active minute). They are first guesses from the sleep-research method (wrist angle changes), to be tuned on your real nights. Step counting was 95% on simulated walking; real walking will differ.
5. Unsynced minutes live in memory only: a reset or a flat battery loses whatever the phone has not collected.

**First test (about 10 minutes plus a night):** flash `imu_ble`, connect in VitaBrief, check the battery still shows, switch all-day mode on, wear it for an hour, open the sheet and tap Collect. Steps and "worn" time should appear. Then wear it overnight and collect in the morning.


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

## Battery gauge (2026-11-12, firmware compiled, NOT yet flashed or tested on the board)

New `RepBattery` library and a Battery characteristic `a6e10004` (read): `[u16 millivolts][u8 percent][u8 flags: bit0 charging, bit1 USB]`, refreshed every 30 s. The board reads the LiPo on P0.31 through the divider that P0.14 switches in (LOW only during the reading, then HIGH again, as Seeed's own setup leaves it). The 1 Mohm / 510 kohm divider and the 3.0 V, 12-bit ADC are from community posts, not Seeed documentation, so calibrate once with the multimeter: set `BATT_TRIM` in `imu_ble.ino` to multimeter volts / reported volts. Percent is an estimate from a typical LiPo curve (reads high while charging). Apps: VitaBrief v10.48 shows it on the Reps card ("Reps - 82%"), in the RepTracker sheet (bar, volts, charging, age) and warns once at 20% and 10%; the RepTracker page shows it in its status bar. Boards with older firmware simply show "update firmware".

## First real data (2026-11-12, 21 auto-saved Workout sets, all really 8 reps)

The page saves the raw data of every set it finds (3 s before the first counted rep to 2 s after the last) and labels it with ITS OWN count, so a labelled file only measures accuracy if the user confirms the real counts. They did: 20 of 21 final counts were right (bench x3, deadlift x3, squat x3, an unknown bar lift, and 11 wrist sets all 8), one bench set was counted 9. The extra rep was the bar being racked after rep 8 (75 cm and 48 deg against 50 cm and 23 deg for the real reps). Fixed with `_isRack` (rejects a rep that is more than 1.3x the median range AND turns more than 1.5x the median rotation + 5 deg; also re-checked on the final numbers when the set ends). The slow, late-feeling counter was the three-rep rule (see Armed mode). Not yet understood: wrist sets start with the arm already moving, so the board never gets a still moment to learn its gyro offset from; offline replays of those fail even though the live count was right. Replay tools (scratchpad, not in the repo): parse the CSV, loop the first second as a calm lead-in, feed the engine.

## Armed mode (2026-11-12)

Real use showed counting only started at rep ~4: the engine waits for three steady reps before it commits to a set, then announces the earlier ones in one burst. When VitaBrief starts a recording (button + 5 s countdown) it now calls `session.setArmed(true)` at GO. Armed bar lifts start after ONE clean rep (at least 2 s of stillness first, 20 cm of range, little rotation, a lift of at least 0.35 s). Simulated result (`node tools/bench_armed.mjs 10 7`): the first rep is announced after about 1 rep instead of 3, with exact counts unchanged. Wrist-style exercises (curls, raises, pull-downs) stay at three reps because armed mode made them slightly worse in simulation. The misses and double counts seen on the real board still need real recordings to fix. VitaBrief's copy of the engine was re-copied with `scratchpad/replace_engine.cjs` (replaces the block between `const RepEngine = (() => {` and its `return {...}`).

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

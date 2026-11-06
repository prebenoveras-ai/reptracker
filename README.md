# RepTracker

A DIY gym rep counter built on the Seeed Studio XIAO nRF52840 Sense. It streams IMU data over BLE to a Web Bluetooth page on the phone, which will later feed into VitaBrief.

## Toolchain

- Arduino CLI 1.5.1 (`winget install ArduinoSA.CLI`), at `C:\Program Files\Arduino CLI\arduino-cli.exe`
- Board package: **Seeeduino:nrf52 1.1.13**, "Seeed nRF52 Boards" (the non-mbed one, which Seeed recommends for BLE and low power)
  - Board manager URL: `https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json`
  - FQBN: `Seeeduino:nrf52:xiaonRF52840Sense`
- IMU library: Seeed_Arduino_LSM6DS3 (from Stage 2 onwards)

## Path with spaces

This board package's compiler breaks on paths containing spaces ("AI Apps"). A junction gives a space-free path to the same folder, so always build through it:

```
C:\Users\Preben\RepTracker  ->  C:\Users\Preben\Desktop\AI Apps\Projects\RepTracker
```

## Build and upload

```
arduino-cli compile --fqbn Seeeduino:nrf52:xiaonRF52840Sense C:\Users\Preben\RepTracker\firmware\blink
arduino-cli upload  --fqbn Seeeduino:nrf52:xiaonRF52840Sense -p COM3 C:\Users\Preben\RepTracker\firmware\blink
```

The board shows up on COM3 when it's running a sketch. During upload it briefly switches to its bootloader port (COM5) by itself.

If the upload hangs or the board doesn't show up as a COM port, double-tap the reset button quickly. That forces the bootloader. Then upload again.

Sketches that use our own modules also need `--libraries C:\Users\Preben\RepTracker\firmware\libraries`.

The COM number changes depending on what's running: COM3 for blink, COM6 for sketches that use USB serial, COM5 for the bootloader. Run `arduino-cli board list` to check.

## Serial monitor

```
arduino-cli monitor -p COM6 -c baudrate=115200
```

In `imu_serial`, type `v` + Enter for the slow readable view, or `c` + Enter for CSV at the full rate.

## Layout

- `firmware/blink`: Stage 1 LED test (cycles red, green, blue)
- `firmware/libraries/RepImu`: reusable IMU module (104 Hz, +-8 g, +-1000 dps)
- `firmware/imu_serial`: Stage 2, prints IMU samples over USB serial
- `firmware/libraries/RepBle`: reusable BLE streaming module (batched notifications)
- `firmware/imu_ble`: Stage 3, streams IMU samples over BLE as "RepTracker"
- `docs/index.html`: the phone app (Workout, Live, Record, History, Setup). `?demo` plays simulated squats
- `docs/engine.js`: the analysis engine (runs in the browser and in Node)
- `tools/sim.mjs`: IMU simulator for squat, bench, deadlift, OHP, curl, lateral raise, pulldown and rest
- `tools/bench.mjs`: accuracy bench (`node tools/bench.mjs [perKind] [seed] [kinds]`)
- `tools/test.mjs`: regression checks (`npm test`)
- `tools/debug.mjs`: trace one simulated session

## How the engine works

1. **Stillness.** Steady readings that also total exactly 1 g. While still for a full second it learns the gyro offset and the real gravity reading.
2. **Orientation.** A Madgwick filter tracks which way is up, so the board can sit any way round on the bar or wrist.
3. **Vertical acceleration.** Readings are rotated to the world frame and gravity is removed.
4. **Drift-free speed.** Integrated to velocity, then drift is removed by forcing velocity to zero where it truly is zero: long still periods, and every turnaround at the top and bottom of a rep. This takes three passes, each refining the turnarounds.
5. **Reps.** Position swings found with an adaptive hysteresis. Each concentric swing is a rep. Set-up moves (unracking, picking a dumbbell up) are dropped by size and wrist rotation. A pause in the middle of a move splits it.
6. **Sets.** Three steady reps start a set live. Shorter sets are picked up when the bar is put down. A rep that comes far off the set's rhythm ends it.
7. **Metrics per rep.** Mean concentric velocity (over the part moving at 10% or more of peak), peak velocity, range of motion, eccentric, pause and concentric time, time to peak velocity, bar drift, wrist rotation, and power (with load).
8. **Per set.** Velocity loss, reps in reserve (velocity trend vs the lift's 1RM velocity), estimated 1RM (Epley including reps left, or a load-velocity profile when several loads were lifted), time under tension, tempo and a consistency score.

### Simulated accuracy

`node tools/bench.mjs 12 7` covers 185 sets the engine was not tuned on. It uses pessimistic noise: about 6x the accelerometer noise and 3-5x the gyro noise of the real board.

| Exercise | Sets found | Exact rep count | Within 1 | ROM error | Velocity error |
|---|---|---|---|---|---|
| Squat | 96% | 92% | 92% | 3.1 cm | 2.5% |
| Bench | 100% | 100% | 100% | 2.1 cm | 2.0% |
| Deadlift | 100% | 100% | 100% | 4.2 cm | 3.6% |
| Overhead press | 100% | 95% | 100% | 2.7 cm | 1.9% |
| Curl (wrist) | 85% | 26% | 48% | 5.5 cm | 3.8% |
| Lateral raise (wrist) | 77% | 35% | 65% | 5.2 cm | 6.1% |
| Lat pulldown (wrist) | 80% | 53% | 73% | 5.4 cm | 4.6% |

Barbell work is solid. Wrist work is not yet. Real recordings (the Record tab's **Check accuracy**) are the next step for tuning it.

Real board, 40 s still on a desk: accelerometer noise 0.0005 g, gyro noise 0.03-0.06 deg/s, 0 lost samples, 0 false sets.

## Phone page

Hosted on GitHub Pages from `docs/`: https://prebenoveras-ai.github.io/reptracker/

Open it in **Chrome** on Android. Samsung Internet doesn't support Web Bluetooth. Add `?demo` to the address to see fake data without the board.

### Workout tab

Type the exercise and load, then lift. Sets are found automatically. You get a big live rep count, each rep's speed coloured by training zone, velocity loss against your stop limit, range, peak speed, tempo and reps in reserve. Optionally the phone speaks the count and speed, and vibrates. A rest timer starts when the set ends. **Finish & save** stores the workout in History.

### History tab

Shows past workouts with per-rep tables, a load-velocity 1RM per exercise, and a trend chart of estimated 1RM and best speed. Export options are **Copy for VitaBrief** (JSON on the clipboard), **JSON** and **CSV**.

### VitaBrief export format

```
{ format: "vitabrief-gym-session", version: 1,
  session: { id, name, startedAt, completedAt, templateId: null, notes, source: "reptracker", importedAt,
    exercises: [ { exerciseName, sets: [ { weight, reps, type: "working", completed: true, completedAt,
      sensor: { meanVelocity, bestVelocity, velocityLoss, romCm, tempo, tutSec, rir, e1rmKg, meanPowerW,
                restBeforeSec, zone, placement, reps: [ { v, pv, romCm, up, down } ] } } ] } ] } }
```

This is the same shape as VitaBrief's `gym_sessions`. VitaBrief still has to map `exerciseName` to its catalogue (as `stravaEnsureExercise` does for Lyfta). The extra `sensor` field is add-only.

### Setup tab

- **6-side calibration.** Fixes per-axis gain and offset, and stores the gyro offset.
- **Feedback options.**
- **Exercise recognition.** Learns from your recordings (nearest neighbour on per-set features).

### Recording sets (Stage 4)

Type the exercise, pick where the board is worn and tap **Record**. A 3 s countdown with vibration is optional. Tap **Stop** when the set is done. The rep count can be typed before, during or after a set, including later in the saved list. Sets are kept in the phone browser's IndexedDB, so they survive a reload. Each set has its own **CSV** button, and **Download all** / **Share all** export everything as one file.

CSV columns: `set_id, exercise, placement, reps, sample, t_s, ax_g, ay_g, az_g, gx_dps, gy_dps, gz_dps`. `sample` counts from 0 at 104 Hz, and a jump in it means samples were lost over Bluetooth.

## BLE protocol

| What | UUID | Format |
|---|---|---|
| Service | `a6e10001-5b1e-4f3a-9c2d-7e0f1b2c3d4e` | |
| Samples (notify) | `a6e10002-5b1e-4f3a-9c2d-7e0f1b2c3d4e` | `u32 firstSampleIndex, u8 count, count x (ax ay az gx gy gz as i16)`, little endian |
| Info (read) | `a6e10003-5b1e-4f3a-9c2d-7e0f1b2c3d4e` | `u16 rateHz, u16 accelPerG (1000), u16 gyroPerDps (10)` |

With MTU 247, each packet carries 8 samples (about 13 packets a second). Gaps in `firstSampleIndex` show lost samples.

LED while running `imu_ble`: blue blink = waiting for a phone, solid green = streaming, fast red blink = IMU error.

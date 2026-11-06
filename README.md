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
- `docs/index.html`: Stage 3, Web Bluetooth page with live graphs (`?demo` shows fake data)

## Phone page

Hosted on GitHub Pages from `docs/`: https://prebenoveras-ai.github.io/reptracker/

Open it in **Chrome** on Android. Samsung Internet doesn't support Web Bluetooth. Add `?demo` to the address to see fake data without the board.

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

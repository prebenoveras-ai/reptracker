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

## Layout

- `firmware/blink`: Stage 1 LED test (cycles red, green, blue)

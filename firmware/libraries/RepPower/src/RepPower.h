// RepPower: decides when the board should sleep, and puts it into System OFF.
// Knows nothing about the IMU or Bluetooth: the sketch feeds it motion samples and
// does the shutdown steps in order (see imu_ble.ino, goToSleep()).
//
// How it works:
//   * feed() is called with every IMU sample. A sample counts as "moving" when the
//     acceleration differs from its own slow average by more than accelThresholdG, or the
//     board turns faster than gyroThresholdDps. Tiny vibrations stay far below that:
//     the real board's noise is 0.0005 g and 0.05 dps.
//   * shouldSleep() is true once nothing has moved for long enough. The wait is longer
//     while a phone is connected (rests between sets) than while just advertising.
//   * systemOff() arms the IMU's INT1 pin as a wake-up source and enters System OFF.
//     Waking up resets the chip, so the firmware simply boots again.
#pragma once
#include <Arduino.h>

struct PowerConfig {
  // How long the board must be still before it sleeps (seconds).
  uint32_t stillSecConnected = 900;    // phone connected: 15 min (rests between sets)
  uint32_t stillSecAdvertising = 240;  // nobody connected: 4 min

  // What counts as movement.
  float accelThresholdG = 0.05f;       // change from the slow average acceleration
  float gyroThresholdDps = 8.0f;       // rotation speed
  uint8_t minMovingSamples = 3;        // in a row (3 = about 30 ms) so a single knock is ignored

  // Never sleep while USB is plugged in (charging, flashing, serial monitor).
  bool sleepWhenUsbPowered = false;

  // Charge at 100 mA instead of 50 mA (600 mAh battery: about 6 h instead of 12 h).
  bool fastCharge = true;
};

class RepPower {
 public:
  // Applies the charge setting and starts the stillness timer.
  void begin(const PowerConfig& cfg = PowerConfig());

  // Call with every IMU sample (acceleration in g, rotation in deg/s).
  void feed(uint32_t t_ms, float ax, float ay, float az, float gx, float gy, float gz);

  // Restarts the stillness timer (e.g. when a phone connects or disconnects).
  void noteActivity(uint32_t now_ms);

  // True when the board has been still long enough and it is allowed to sleep.
  bool shouldSleep(bool phoneConnected, uint32_t now_ms) const;

  // Seconds since the last movement.
  uint32_t stillSeconds(uint32_t now_ms) const;

  // Enters System OFF with wakePin (an Arduino pin number) as the wake-up source, active high.
  // Does not return when it succeeds. Returns false without sleeping if the pin is already
  // high, because the board would wake up again immediately.
  bool systemOff(int wakePin);

  // True while USB power is present.
  static bool usbPowered();

  const PowerConfig& config() const { return cfg_; }

 private:
  PowerConfig cfg_;
  bool primed_ = false;
  float bx_ = 0, by_ = 0, bz_ = 0;  // slow average of the acceleration
  uint8_t run_ = 0;                 // consecutive "moving" samples
  uint32_t lastMotionMs_ = 0;
};

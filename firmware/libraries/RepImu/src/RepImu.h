// RepImu: reads the XIAO nRF52840 Sense's built-in LSM6DS3TR-C at a fixed rate.
// Board-agnostic wrapper around Seeed_Arduino_LSM6DS3 so other projects can reuse it.
//
// Usage:
//   RepImu imu;
//   imu.begin();                 // 104 Hz, +-8 g, +-1000 dps
//   ImuSample s;
//   if (imu.poll(s)) { ... }     // true once per sample period
#pragma once
#include <Arduino.h>

struct ImuSample {
  uint32_t t_ms;     // millis() when the sample was read
  float ax, ay, az;  // acceleration in g (1 g = gravity)
  float gx, gy, gz;  // rotation speed in degrees per second
};

struct ImuConfig {
  uint16_t rateHz = 104;      // 13, 26, 52, 104, 208, 416
  uint16_t accelRangeG = 8;   // 2, 4, 8, 16
  uint16_t gyroRangeDps = 1000; // 125, 245, 500, 1000, 2000
};

class RepImu {
 public:
  // Returns true if the IMU answered. Call once in setup().
  bool begin(const ImuConfig& cfg = ImuConfig());

  // Reads a new sample when one is due. Returns false between samples.
  bool poll(ImuSample& out);

  // Reads immediately, ignoring the schedule.
  void read(ImuSample& out);

  uint16_t rateHz() const { return cfg_.rateHz; }

  // ---- Sleep support --------------------------------------------------------
  // Puts the IMU into a low-power "watch for movement" mode: gyro off, accelerometer
  // at a low rate, and its wake-up interrupt routed to the INT1 pin (see wakePin()).
  // The interrupt is LATCHED: INT1 goes high on movement and stays high until
  // clearWake() (or begin()) is called, so a short bump can't be missed while the
  // main chip is asleep. The IMU keeps its own power while the main chip sleeps.
  //
  //   thresholdSteps  how big a jolt counts: 1 step = 31 mg (range +-2 g), so 2 = 62 mg.
  //   rateHz          13, 26 or 52. Lower = less current, slower to notice movement.
  //
  // Returns true when INT1 is low afterwards, i.e. it is safe to go to sleep.
  bool armWake(uint8_t thresholdSteps = 2, uint16_t rateHz = 26);

  // Reads (and so clears) a pending wake-up event. True if one was pending.
  bool clearWake();

  // The raw wake-up flags register, for debugging.
  uint8_t wakeSource();

  // True while the IMU is holding INT1 high.
  bool wakePinHigh() const;

  // Arduino pin number wired to the IMU's INT1 output (P0.11 on the XIAO nRF52840 Sense).
  static int wakePin();

 private:
  void disarmWake();
  ImuConfig cfg_;
  uint32_t periodUs_ = 0;
  uint32_t nextUs_ = 0;
};

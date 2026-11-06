#include "RepImu.h"
#include <LSM6DS3.h>
#include <Wire.h>

// 0x6A is the IMU's I2C address on the XIAO nRF52840 Sense (Seeed's example).
// The library powers the IMU (PIN_LSM6DS3TR_C_POWER) and picks the
// internal I2C bus (Wire1) itself, based on the board definition.
static LSM6DS3 sensor(I2C_MODE, 0x6A);

bool RepImu::begin(const ImuConfig& cfg) {
  cfg_ = cfg;
  sensor.settings.accelSampleRate = cfg.rateHz;
  sensor.settings.gyroSampleRate = cfg.rateHz;
  sensor.settings.accelRange = cfg.accelRangeG;
  sensor.settings.gyroRange = cfg.gyroRangeDps;
  sensor.settings.accelBandWidth = 50;  // filter out vibration above ~half the sample rate
  if (sensor.begin() != 0) return false;

  periodUs_ = 1000000UL / cfg.rateHz;
  nextUs_ = micros();
  return true;
}

void RepImu::read(ImuSample& s) {
  s.t_ms = millis();
  s.ax = sensor.readFloatAccelX();
  s.ay = sensor.readFloatAccelY();
  s.az = sensor.readFloatAccelZ();
  s.gx = sensor.readFloatGyroX();
  s.gy = sensor.readFloatGyroY();
  s.gz = sensor.readFloatGyroZ();
}

bool RepImu::poll(ImuSample& s) {
  uint32_t now = micros();
  if ((int32_t)(now - nextUs_) < 0) return false;
  nextUs_ += periodUs_;
  // If we fell far behind (e.g. a long Serial stall), resync instead of bursting.
  if ((int32_t)(now - nextUs_) > (int32_t)(periodUs_ * 4)) nextUs_ = now + periodUs_;
  read(s);
  return true;
}

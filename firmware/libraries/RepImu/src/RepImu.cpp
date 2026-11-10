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
  // After waking from sleep the IMU still holds its wake-up setup: undo it.
  disarmWake();

  periodUs_ = 1000000UL / cfg.rateHz;
  nextUs_ = micros();
  return true;
}

// ---- Sleep support ------------------------------------------------------------
// LSM6DS3TR-C registers (ST datasheet; the wake-up recipe is in ST app note AN4650, 4.3).
static const uint8_t REG_INT1_CTRL    = 0x0D;
static const uint8_t REG_CTRL1_XL     = 0x10;
static const uint8_t REG_CTRL6_C      = 0x15;
static const uint8_t REG_WAKE_UP_SRC  = 0x1B;
static const uint8_t REG_TAP_CFG      = 0x58;
static const uint8_t REG_WAKE_UP_THS  = 0x5B;
static const uint8_t REG_WAKE_UP_DUR  = 0x5C;
static const uint8_t REG_MD1_CFG      = 0x5E;
static const uint8_t REG_CTRL2_G      = 0x11;
static const uint8_t XL_HM_MODE       = 0x10;  // CTRL6_C bit 4: 1 = accelerometer low-power mode

static void setBits(uint8_t reg, uint8_t mask, bool on) {
  uint8_t v = 0;
  sensor.readRegister(&v, reg);
  v = on ? (v | mask) : (v & ~mask);
  sensor.writeRegister(reg, v);
}

int RepImu::wakePin() { return PIN_LSM6DS3TR_C_INT1; }

bool RepImu::wakePinHigh() const { return digitalRead(PIN_LSM6DS3TR_C_INT1) == HIGH; }

uint8_t RepImu::wakeSource() {
  uint8_t v = 0;
  sensor.readRegister(&v, REG_WAKE_UP_SRC);
  return v;
}

bool RepImu::clearWake() { return wakeSource() != 0; }

bool RepImu::armWake(uint8_t thresholdSteps, uint16_t rateHz) {
  uint8_t odr = rateHz <= 13 ? 0x1 : (rateHz <= 26 ? 0x2 : 0x3);  // 13 / 26 / 52 Hz
  pinMode(PIN_LSM6DS3TR_C_INT1, INPUT);
  // The IMU must stay powered while the main chip sleeps, or it can't wake us.
  pinMode(PIN_LSM6DS3TR_C_POWER, OUTPUT);
  digitalWrite(PIN_LSM6DS3TR_C_POWER, HIGH);

  sensor.writeRegister(REG_CTRL2_G, 0x00);        // gyro off (saves most of the current)
  sensor.writeRegister(REG_INT1_CTRL, 0x00);      // only the wake-up event may use INT1
  setBits(REG_CTRL6_C, XL_HM_MODE, true);         // accelerometer low-power mode
  sensor.writeRegister(REG_WAKE_UP_DUR, 0x20);    // must exceed the threshold for 1 sample
  sensor.writeRegister(REG_WAKE_UP_THS, thresholdSteps & 0x3F);
  sensor.writeRegister(REG_TAP_CFG, 0x81);        // interrupts on + slope filter + latched
  sensor.writeRegister(REG_MD1_CFG, 0x20);        // wake-up event -> INT1
  sensor.writeRegister(REG_CTRL1_XL, odr << 4);   // low rate, +-2 g: now watching

  delay(300);                                     // let the slope filter settle
  clearWake();                                    // drop any event the settling caused
  delay(5);
  return !wakePinHigh();
}

void RepImu::disarmWake() {
  sensor.writeRegister(REG_MD1_CFG, 0x00);
  sensor.writeRegister(REG_TAP_CFG, 0x00);
  sensor.writeRegister(REG_WAKE_UP_DUR, 0x00);
  sensor.writeRegister(REG_WAKE_UP_THS, 0x00);
  setBits(REG_CTRL6_C, XL_HM_MODE, false);        // back to high-performance mode
  clearWake();
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

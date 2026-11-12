// RepBattery: reads the LiPo voltage on the XIAO nRF52840 Sense and turns it into a percentage.
//
// How the board measures it (Seeed wiki, FAQ on battery reading): the battery voltage goes through a
// divider to pin P0.31. The divider is only connected while P0.14 is LOW; Seeed's board setup leaves
// P0.14 HIGH, so this module switches it LOW only for the moment of the reading and puts it back.
// Divider values (1 Mohm / 510 kohm) and the 3.0 V, 12-bit ADC come from community posts, not from Seeed
// documentation, so `trim` lets you correct the result against a multimeter (see imu_ble.ino).
//
// The percentage is an estimate from a typical LiPo discharge curve. It reads high while charging
// (the charger pushes the voltage up) and sags a little under load, so treat it as a fuel gauge, not a meter.
#pragma once
#include <Arduino.h>

struct BatteryReading {
  uint16_t mv;        // battery voltage in millivolts (0 = could not be read)
  uint8_t percent;    // 0..100, estimated
  bool charging;      // the charger chip says it is charging (its LED pin is low)
  bool usb;           // USB power is present
};

class RepBattery {
 public:
  // trim: multiply the result by this (1.00 = no correction). Measure the battery with a multimeter and
  // set trim = multimeterVolts / reportedVolts.
  void begin(float trim = 1.0f);

  // Takes a fresh reading (about 15 ms).
  BatteryReading read();

  // Estimated charge for a resting LiPo at this voltage.
  static uint8_t percentFromMv(uint16_t mv);

 private:
  float trim_ = 1.0f;
};

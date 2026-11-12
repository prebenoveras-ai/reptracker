// RepBle: streams 6-channel sensor samples to a phone over Bluetooth Low Energy.
// Uses the Adafruit Bluefruit library bundled with Seeed's nRF52 board package.
// Knows nothing about the IMU: the sketch hands it six int16 values per sample.
//
// GATT layout (UUIDs also in docs/index.html):
//   Service  a6e10001-5b1e-4f3a-9c2d-7e0f1b2c3d4e
//   Samples  a6e10002-...  notify  packet = [u32 firstSampleIndex][u8 count][count x 6 x i16], little endian
//   Info     a6e10003-...  read    [u16 rateHz][u16 accelPerG][u16 gyroPerDps]
//   Battery  a6e10004-...  read    [u16 millivolts][u8 percent][u8 flags]   (flags: bit0 charging, bit1 USB)
//
// Usage:
//   RepBle ble;
//   ble.begin("RepTracker", 104, 1000, 10);
//   int16_t v[6] = {...};
//   ble.push(v);                 // batches samples and sends when a packet is full
#pragma once
#include <Arduino.h>

class RepBle {
 public:
  // rateHz and the two scales are published in the Info characteristic so the
  // phone knows how to turn the integers back into g and deg/s.
  bool begin(const char* name, uint16_t rateHz, uint16_t accelPerG, uint16_t gyroPerDps);

  // Publishes the battery state in the Battery characteristic (read by the phone):
  //   [u16 millivolts][u8 percent][u8 flags: bit0 = charging, bit1 = USB power], little endian.
  // mv = 0 means "unknown". Call whenever there is a new reading.
  void setBattery(uint16_t mv, uint8_t percent, uint8_t flags);

  // True when a phone is connected and listening for samples.
  bool streaming() const;

  // True when a phone is connected, even if it isn't listening for samples yet.
  bool connected() const;

  // Stops advertising and drops any connection, so the radio can be switched off
  // cleanly before sleeping. Doesn't restart on its own: reboot or call begin() again.
  void stop();

  // Adds one sample (ax, ay, az, gx, gy, gz). Sends a packet once enough have built up.
  void push(const int16_t v[6]);

  // Samples that couldn't be sent (radio busy). Counted, not retried.
  uint32_t dropped() const { return dropped_; }

  static const uint8_t kMaxPerPacket = 8;

 private:
  void flush();
  uint8_t buf_[5 + kMaxPerPacket * 12];
  uint8_t count_ = 0;
  uint32_t sampleIndex_ = 0;   // index of the next sample pushed
  uint32_t dropped_ = 0;
};

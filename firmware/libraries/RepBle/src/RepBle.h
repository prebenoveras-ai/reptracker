// RepBle: streams 6-channel sensor samples to a phone over Bluetooth Low Energy.
// Uses the Adafruit Bluefruit library bundled with Seeed's nRF52 board package.
// Knows nothing about the IMU: the sketch hands it six int16 values per sample.
//
// GATT layout (UUIDs also in docs/index.html):
//   Service  a6e10001-5b1e-4f3a-9c2d-7e0f1b2c3d4e
//   Samples  a6e10002-...  notify  packet = [u32 firstSampleIndex][u8 count][count x 6 x i16], little endian
//   Info     a6e10003-...  read    [u16 rateHz][u16 accelPerG][u16 gyroPerDps]
//   Battery  a6e10004-...  read    [u16 millivolts][u8 percent][u8 flags]   (flags: bit0 charging, bit1 USB)
//   DayStat  a6e10005-...  read    all-day log status, built by the sketch (see imu_ble.ino)
//   DayCtrl  a6e10006-...  write   [u8 command][u32 argument]  (1 = all-day mode on/off, 2 = send the log from minute N)
//   DayLog   a6e10007-...  notify  [u32 firstMinute][u8 count][count x 4 bytes]; count 0 = that was everything
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

  // ---- All-day log (RepBle only moves the bytes; RepDay makes them) ----------
  // Called when the phone writes a command: cmd and a 32-bit argument (0 if none was sent).
  // Runs on the Bluetooth task: only set a flag in it and do the work in loop().
  typedef void (*DayCommandFn)(uint8_t cmd, uint32_t arg);
  void onDayCommand(DayCommandFn fn);

  // Publishes the status bytes the phone reads before collecting the log (up to 20 bytes).
  void setDayStatus(const uint8_t* data, uint8_t len);

  // True when a phone is connected and listening for log packets.
  bool logListening() const;

  // How many 4-byte records fit in one log packet on this connection (at most kMaxLogRecords).
  uint8_t logFit() const;

  // Sends one log packet. count 0 = "that was everything". False = radio busy, try again later.
  bool sendLog(uint32_t firstMinute, const uint8_t* records, uint8_t count);

  // Advertise once a second instead of 6 times: slower to find, but much less battery.
  // Used in all-day mode, where the board is never switched off.
  void setSlowAdvertising(bool slow);

  static const uint8_t kMaxLogRecords = 48;

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

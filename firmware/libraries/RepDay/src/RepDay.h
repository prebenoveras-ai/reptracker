// RepDay: all-day wrist logger. Turns accelerometer samples into one small record per minute and
// keeps the last three days of them in memory for the phone to collect.
// Knows nothing about the IMU or Bluetooth: the sketch feeds it samples and passes its records on.
//
// One record = 4 bytes:
//   act    how much the wrist moved: round(8 * sqrt(mean movement in mg)), 0..255
//          (movement = average distance of the acceleration size from its own 5-second mean)
//   angle  average wrist angle against level, degrees, -90..90 (signed)
//   turn   how much the wrist's direction changed during the minute, degrees, 0..126;
//          bit 7 = on USB power (charging, so not on the wrist)
//   steps  steps counted in the minute, 0..255
//
// Time: the board has no clock. Records are numbered by "minutes since logging started" and the
// phone works out the real time when it collects them (it knows what time it is now and which
// minute the board is on now). Records live in RAM, so a reset or an empty battery loses whatever
// the phone has not collected yet.
//
// The logic is mirrored line for line in tools/day.mjs, which is what gets tested on the PC.
// Change both together.
//
// Usage:
//   RepDay day;
//   day.begin(millis());
//   day.feed(millis(), ax, ay, az, onUsb);     // about 26 times a second
//   n = day.copy(fromMinute, buf, maxRecords, firstMinute);
#pragma once
#include <Arduino.h>

struct DayRecord {
  uint8_t act;
  int8_t angle;
  uint8_t turn;
  uint8_t steps;
};

class RepDay {
 public:
  static const uint16_t kCapacity = 4320;        // 3 days of minutes (about 17 KB of RAM)

  // Starts (or restarts) logging: forgets everything stored and begins minute 0 now.
  void begin(uint32_t now_ms);

  // One accelerometer sample in g. Call at about 26 Hz. Returns true when a minute was just stored.
  bool feed(uint32_t now_ms, float ax, float ay, float az, bool onUsb);

  // Index of the minute being recorded now (= number of minutes finished since begin()).
  uint32_t minuteNow() const { return minuteNow_; }
  // Seconds into the minute being recorded now.
  uint8_t secondsIntoMinute(uint32_t now_ms) const;
  // Oldest stored minute and how many are stored.
  uint32_t firstMinute() const { return minuteNow_ - count_; }
  uint16_t count() const { return count_; }

  // Copies up to max records starting at minute `from` (or the oldest stored, if that is later)
  // into out. Returns how many were copied and sets `first` to the minute of out[0].
  uint16_t copy(uint32_t from, DayRecord* out, uint16_t max, uint32_t& first) const;

 private:
  void closeEpoch();
  void closeMinute();

  DayRecord ring_[kCapacity];
  uint16_t head_ = 0;          // where the next record goes
  uint16_t count_ = 0;
  uint32_t minuteNow_ = 0;

  uint32_t minuteStart_ = 0, epochStart_ = 0;
  // current 5-second block
  static const uint16_t kMaxEpoch = 200;
  float mags_[kMaxEpoch];
  uint16_t n_ = 0;
  float sx_ = 0, sy_ = 0, sz_ = 0;
  // current minute
  float madSum_ = 0, angSum_ = 0, turnSum_ = 0;
  uint8_t epochs_ = 0;
  uint16_t steps_ = 0;
  bool havePrev_ = false;
  float px_ = 0, py_ = 0, pz_ = 0;   // direction of the last 5-second average
  // step detection
  float lp_ = 1, base_ = 1;
  bool primed_ = false, above_ = false;
  uint32_t lastStepMs_ = 0;
  uint16_t run_ = 0;
  bool usb_ = false;
};

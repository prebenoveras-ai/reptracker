#include "RepDay.h"
#include <math.h>

// Same numbers as DAY in tools/day.mjs.
static const uint32_t EPOCH_MS = 5000, MINUTE_MS = 60000;
static const float LP = 0.6f;            // smoothing of the acceleration size for step detection
static const float BASE = 0.02f;         // slow average it is compared with
static const float STEP_THR = 0.06f;     // g above the slow average that counts as a step
static const uint32_t STEP_MIN_MS = 250; // fastest believable step
static const uint32_t STEP_MAX_MS = 1500;// slowest: a longer gap ends the walk
static const uint16_t STEP_RUN = 6;      // steps in a row before any are counted

static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

void RepDay::begin(uint32_t now_ms) {
  head_ = 0; count_ = 0; minuteNow_ = 0;
  minuteStart_ = now_ms; epochStart_ = now_ms;
  n_ = 0; sx_ = sy_ = sz_ = 0;
  madSum_ = angSum_ = turnSum_ = 0; epochs_ = 0; steps_ = 0;
  havePrev_ = false;
  lp_ = 1; base_ = 1; primed_ = false; above_ = false;
  lastStepMs_ = now_ms; run_ = 0; usb_ = false;
}

uint8_t RepDay::secondsIntoMinute(uint32_t now_ms) const {
  uint32_t s = (uint32_t)(now_ms - minuteStart_) / 1000UL;
  return s > 59 ? 59 : (uint8_t)s;
}

void RepDay::closeEpoch() {
  uint16_t n = n_;
  if (n >= 8) {
    float m = 0;
    for (uint16_t i = 0; i < n; i++) m += mags_[i];
    m /= n;
    float mad = 0;
    for (uint16_t i = 0; i < n; i++) mad += fabsf(mags_[i] - m);
    mad = mad / n * 1000.0f;                       // mg
    float vx = sx_ / n, vy = sy_ / n, vz = sz_ / n;
    float len = sqrtf(vx * vx + vy * vy + vz * vz);
    if (len <= 0) len = 1;
    float ux = vx / len, uy = vy / len, uz = vz / len;
    if (havePrev_) {
      float d = clampf(ux * px_ + uy * py_ + uz * pz_, -1.0f, 1.0f);
      turnSum_ += acosf(d) * 57.29578f;
    }
    px_ = ux; py_ = uy; pz_ = uz; havePrev_ = true;
    madSum_ += mad;
    angSum_ += asinf(clampf(uz, -1.0f, 1.0f)) * 57.29578f;
    epochs_++;
  }
  n_ = 0; sx_ = sy_ = sz_ = 0;
}

void RepDay::closeMinute() {
  float e = epochs_ ? (float)epochs_ : 1.0f;
  float act = roundf(8.0f * sqrtf(madSum_ / e));
  float angle = clampf(roundf(angSum_ / e), -90.0f, 90.0f);
  float turn = roundf(turnSum_);
  DayRecord r;
  r.act = (uint8_t)(act > 255 ? 255 : act);
  r.angle = (int8_t)angle;
  r.turn = (uint8_t)(turn > 126 ? 126 : turn) | (usb_ ? 0x80 : 0);
  r.steps = (uint8_t)(steps_ > 255 ? 255 : steps_);
  ring_[head_] = r;
  head_ = (head_ + 1) % kCapacity;
  if (count_ < kCapacity) count_++;
  minuteNow_++;
  madSum_ = angSum_ = turnSum_ = 0; epochs_ = 0; steps_ = 0;
}

bool RepDay::feed(uint32_t now_ms, float ax, float ay, float az, bool onUsb) {
  float mag = sqrtf(ax * ax + ay * ay + az * az);
  if (n_ < kMaxEpoch) { mags_[n_++] = mag; sx_ += ax; sy_ += ay; sz_ += az; }
  usb_ = onUsb;

  // steps: a bump in the acceleration size, at walking rhythm, several in a row
  if (!primed_) { lp_ = mag; base_ = mag; primed_ = true; }
  lp_ += LP * (mag - lp_);
  base_ += BASE * (lp_ - base_);
  float x = lp_ - base_;
  if (!above_ && x > STEP_THR) {
    above_ = true;
    uint32_t gap = now_ms - lastStepMs_;
    if (gap >= STEP_MIN_MS) {
      if (gap > STEP_MAX_MS) run_ = 0;
      run_++;
      lastStepMs_ = now_ms;
      if (run_ == STEP_RUN) steps_ += STEP_RUN;    // the walk is real: count the ones held back
      else if (run_ > STEP_RUN) steps_++;
    }
  } else if (above_ && x < STEP_THR / 2) {
    above_ = false;
  }

  if ((uint32_t)(now_ms - epochStart_) >= EPOCH_MS) { closeEpoch(); epochStart_ += EPOCH_MS; }
  if ((uint32_t)(now_ms - minuteStart_) >= MINUTE_MS) { minuteStart_ += MINUTE_MS; closeMinute(); return true; }
  return false;
}

uint16_t RepDay::copy(uint32_t from, DayRecord* out, uint16_t max, uint32_t& first) const {
  uint32_t oldest = firstMinute();
  if (from < oldest) from = oldest;
  first = from;
  if (from >= minuteNow_) return 0;
  uint32_t avail = minuteNow_ - from;
  uint16_t n = avail > max ? max : (uint16_t)avail;
  // ring position of minute `from`: head_ points just past minute (minuteNow_ - 1)
  uint32_t back = minuteNow_ - from;                       // 1..count_
  uint16_t pos = (uint16_t)((head_ + kCapacity - (back % kCapacity)) % kCapacity);
  for (uint16_t i = 0; i < n; i++) out[i] = ring_[(pos + i) % kCapacity];
  return n;
}

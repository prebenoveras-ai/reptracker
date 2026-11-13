// Reference version of the board's all-day logger (firmware/libraries/RepDay/src/RepDay.cpp).
// The two are kept line for line the same on purpose: this one can be tested on the PC against
// simulated wrist data, the C++ one cannot. Change both together.
//
// Input: accelerometer samples in g at about 26 Hz. Output: one 4-byte record per minute.
//   act    how much the wrist moved: round(8 * sqrt(mean movement in mg)), 0..255
//          (movement = average distance of the acceleration size from its own 5-second mean)
//   angle  average wrist angle against level, degrees, -90..90
//   turn   how much the wrist's direction changed during the minute, degrees, 0..126
//          bit 7 = on USB power (charging, so not on the wrist)
//   steps  steps counted in the minute, 0..255

export const DAY = {
  EPOCH_MS: 5000, MINUTE_MS: 60000,
  LP: 0.6,           // smoothing of the acceleration size for step detection
  BASE: 0.02,        // slow average it is compared with
  STEP_THR: 0.06,    // g above the slow average that counts as a step
  STEP_MIN_MS: 250,  // fastest believable step
  STEP_MAX_MS: 1500, // slowest: a longer gap ends the walk
  STEP_RUN: 6,       // steps in a row before any are counted (so single knocks are not steps)
};

export class DayLogger {
  constructor() { this.reset(0); }

  reset(ms) {
    this.minuteStart = ms; this.epochStart = ms;
    this.n = 0; this.mags = new Float32Array(200); this.sx = 0; this.sy = 0; this.sz = 0;
    this.madSum = 0; this.angSum = 0; this.turnSum = 0; this.epochs = 0; this.steps = 0;
    this.prev = null;                 // direction of the last 5-second average
    this.lp = 1; this.base = 1; this.primed = false;
    this.above = false; this.peakMs = 0; this.lastStepMs = 0; this.run = 0;
    this.usb = false;
  }

  _closeEpoch() {
    const n = this.n;
    if (n >= 8) {
      let m = 0; for (let i = 0; i < n; i++) m += this.mags[i];
      m /= n;
      let mad = 0; for (let i = 0; i < n; i++) mad += Math.abs(this.mags[i] - m);
      mad = mad / n * 1000;           // mg
      const vx = this.sx / n, vy = this.sy / n, vz = this.sz / n, len = Math.hypot(vx, vy, vz) || 1;
      const u = [vx / len, vy / len, vz / len];
      if (this.prev) {
        const d = Math.max(-1, Math.min(1, u[0] * this.prev[0] + u[1] * this.prev[1] + u[2] * this.prev[2]));
        this.turnSum += Math.acos(d) * 180 / Math.PI;
      }
      this.prev = u;
      this.madSum += mad;
      this.angSum += Math.asin(Math.max(-1, Math.min(1, u[2]))) * 180 / Math.PI;
      this.epochs++;
    }
    this.n = 0; this.sx = 0; this.sy = 0; this.sz = 0;
  }

  _closeMinute() {
    const e = this.epochs || 1;
    const act = Math.min(255, Math.round(8 * Math.sqrt(this.madSum / e)));
    const angle = Math.max(-90, Math.min(90, Math.round(this.angSum / e)));
    const turn = Math.min(126, Math.round(this.turnSum)) | (this.usb ? 0x80 : 0);
    const rec = [act, angle & 0xFF, turn, Math.min(255, this.steps)];
    this.madSum = 0; this.angSum = 0; this.turnSum = 0; this.epochs = 0; this.steps = 0;
    return rec;
  }

  // Returns a finished minute record ([act, angle, turn, steps] as bytes) or null.
  feed(ms, ax, ay, az, usb) {
    const mag = Math.hypot(ax, ay, az);
    if (this.n < this.mags.length) { this.mags[this.n++] = mag; this.sx += ax; this.sy += ay; this.sz += az; }
    this.usb = !!usb;

    // steps: a bump in the acceleration size, at walking rhythm, several in a row
    if (!this.primed) { this.lp = mag; this.base = mag; this.primed = true; }
    this.lp += DAY.LP * (mag - this.lp);
    this.base += DAY.BASE * (this.lp - this.base);
    const x = this.lp - this.base;
    if (!this.above && x > DAY.STEP_THR) {
      this.above = true;
      const gap = ms - this.lastStepMs;
      if (gap >= DAY.STEP_MIN_MS) {
        if (gap > DAY.STEP_MAX_MS) this.run = 0;
        this.run++;
        this.lastStepMs = ms;
        if (this.run === DAY.STEP_RUN) this.steps += DAY.STEP_RUN;   // the walk is real: count the ones held back
        else if (this.run > DAY.STEP_RUN) this.steps++;
      }
    } else if (this.above && x < DAY.STEP_THR / 2) this.above = false;

    if (ms - this.epochStart >= DAY.EPOCH_MS) { this._closeEpoch(); this.epochStart += DAY.EPOCH_MS; }
    if (ms - this.minuteStart >= DAY.MINUTE_MS) { this.minuteStart += DAY.MINUTE_MS; return this._closeMinute(); }
    return null;
  }
}

export const decodeAct = b => (b / 8) ** 2;                    // mg
export const decodeAngle = b => (b > 127 ? b - 256 : b);       // degrees

// Stage 3 + sleep + all-day mode: read the IMU and stream it to the phone over BLE.
//
// Two ways of living (the phone picks one, see "All-day mode" below):
//
//   Gym mode (default). 104 Hz to the phone while it listens. The board switches itself off when
//   it lies still and wakes up when it is moved.
//
//   All-day mode (worn on the wrist). The board never switches off. While no phone is listening
//   it watches the accelerometer at 26 Hz in low power and stores one small record per minute
//   (movement, wrist angle, turning, steps) for the phone to collect later. As soon as the phone
//   asks for samples it streams at 104 Hz exactly like gym mode, and keeps logging minutes.
//
// LED: blue blinks slowly while waiting for a phone, green stays on while streaming.
//      One short green flash = just woke up / booted.
//      Two short red flashes = about to go to sleep.
//      All-day mode, no phone: everything off except a tiny blue blink every 10 s (saves battery).
// USB serial prints a status line once a second (rate, connection, dropped samples, stillness).
//
// Sleep rules in gym mode (change them in the constants below):
//   - Nothing moved for 15 min while a phone is connected, or 4 min while nobody is: sleep.
//   - Never sleeps while USB power is plugged in.
//   - Moving the board wakes it; it restarts and is advertising again within about a second.
//
// Quick test build (short timeouts so you don't have to wait minutes):
//   add  --build-property "compiler.cpp.extra_flags=-DREP_QUICK_TEST"  to the arduino-cli compile
//   command. (Don't use build.extra_flags: it replaces the board's own chip definition.)

#include <Adafruit_TinyUSB.h>  // Seeed: needed for Serial on the non-mbed nRF52 core
#include <RepImu.h>
#include <RepBle.h>
#include <RepPower.h>
#include <RepBattery.h>
#include <RepDay.h>
#include <nrf_soc.h>

// Fixed-point scales sent over BLE: 1000 counts per g, 10 counts per deg/s.
// With +-8 g and +-1000 dps both fit in int16.
const uint16_t ACCEL_PER_G = 1000;
const uint16_t GYRO_PER_DPS = 10;

// ---- Sleep settings -----------------------------------------------------------
#ifdef REP_QUICK_TEST
const uint32_t STILL_SEC_CONNECTED = 40;     // test build
const uint32_t STILL_SEC_ADVERTISING = 20;
#else
const uint32_t STILL_SEC_CONNECTED = 900;    // 15 min: rests between sets are 2-5 min
const uint32_t STILL_SEC_ADVERTISING = 240;  // 4 min
#endif
const float MOVE_ACCEL_G = 0.05f;            // acceleration change that counts as movement
const float MOVE_GYRO_DPS = 8.0f;            // rotation speed that counts as movement
const uint8_t WAKE_THRESHOLD_STEPS = 2;      // IMU wake-up jolt: 1 step = 31 mg, 2 = 62 mg
const bool SLEEP_WHEN_USB_POWERED = false;   // true only for testing sleep on a USB cable
const bool FAST_CHARGE = true;               // charge at 100 mA instead of 50 mA

// ---- Battery gauge ------------------------------------------------------------
// The phone reads the battery from the board. To calibrate: measure the battery with a multimeter,
// read the voltage the board reports (serial line "batt ... mV", or the app), and set
// BATT_TRIM = multimeter volts / reported volts (1.00 = no correction).
const float BATT_TRIM = 1.00f;
const uint32_t BATT_EVERY_MS = 30000;        // how often the reading is refreshed

// ---- All-day mode -------------------------------------------------------------
// Switched on and off by the phone (command 1). The choice is kept in a small register that
// survives sleep and resets (but not a flat battery), so the board comes back in the same mode.
// Phone commands (DayCtrl characteristic):  1 = all-day mode [0 off / 1 on]
//                                           2 = send the log, starting at minute N
// Status the phone reads (DayStat, 17 bytes, little endian):
//   [u8 version = 1][u8 flags: bit0 all-day on][u32 bootId][u32 minuteNow][u8 secondsIntoMinute]
//   [u32 firstStoredMinute][u16 storedMinutes]
const uint8_t ALLDAY_MAGIC = 0xA5;           // value kept in the retained register when all-day is on
const uint8_t CMD_ALLDAY = 1, CMD_SEND_LOG = 2;
// -------------------------------------------------------------------------------

RepImu imu;
RepBle ble;
RepPower power;
RepBattery battery;
RepDay day;
BatteryReading batt = {0, 0, false, false};
uint32_t lastBatt = 0;
uint32_t count = 0, lastReport = 0;
bool wasConnected = false;

bool allDay = false;                 // all-day mode is on
bool lowNow = false;                 // the IMU is in its low-power mode right now
uint32_t bootId = 1;                 // changes on every start, so the phone can tell a restart
uint32_t lastStatus = 0, lastBlink = 0;
uint8_t decimate = 0;
// set by the Bluetooth task, handled in loop()
volatile bool cmdAllDayPending = false, cmdAllDayValue = false;
volatile bool logPending = false;
volatile uint32_t logFrom = 0;

static int16_t toI16(float x) {
  if (x > 32767) return 32767;
  if (x < -32768) return -32768;
  return (int16_t)lroundf(x);
}

// Short LED flash(es). LEDs are active low. Brief on purpose: it saves battery.
static void flash(uint8_t led, uint8_t times, uint16_t onMs, uint16_t offMs = 120) {
  for (uint8_t i = 0; i < times; i++) {
    digitalWrite(led, LOW);
    delay(onMs);
    digitalWrite(led, HIGH);
    if (i + 1 < times) delay(offMs);
  }
}

// Measure the battery and hand the result to the Bluetooth module (the phone reads it from there).
static void updateBattery() {
  batt = battery.read();
  ble.setBattery(batt.mv, batt.percent, (batt.charging ? 1 : 0) | (batt.usb ? 2 : 0));
}

// The phone wrote a command. This runs on the Bluetooth task: remember it, loop() does the work.
static void onDayCommand(uint8_t cmd, uint32_t arg) {
  if (cmd == CMD_ALLDAY) { cmdAllDayValue = arg != 0; cmdAllDayPending = true; }
  else if (cmd == CMD_SEND_LOG) { logFrom = arg; logPending = true; }
}

// Remember the mode across sleep and resets (Bluetooth is running, so its own call must be used).
static void rememberAllDay(bool on) {
  sd_power_gpregret_clr(1, 0xFF);
  if (on) sd_power_gpregret_set(1, ALLDAY_MAGIC);
}

static void setAllDay(bool on, uint32_t now_ms) {
  if (on == allDay) return;
  allDay = on;
  rememberAllDay(on);
  if (on) day.begin(now_ms);
  ble.setSlowAdvertising(on);
  power.noteActivity(now_ms);
  Serial.println(on ? "# all-day mode on" : "# all-day mode off");
}

static void publishDayStatus(uint32_t now_ms) {
  uint8_t b[17];
  uint32_t minuteNow = day.minuteNow(), first = day.firstMinute();
  uint16_t stored = day.count();
  b[0] = 1;
  b[1] = allDay ? 1 : 0;
  memcpy(b + 2, &bootId, 4);
  memcpy(b + 6, &minuteNow, 4);
  b[10] = day.secondsIntoMinute(now_ms);
  memcpy(b + 11, &first, 4);
  memcpy(b + 15, &stored, 2);
  ble.setDayStatus(b, sizeof(b));
}

// Send the next piece of the log to the phone, if it asked and the radio has room.
static void pumpLog() {
  if (!logPending) return;
  if (!ble.logListening()) { if (!ble.connected()) logPending = false; return; }
  static DayRecord buf[RepBle::kMaxLogRecords];
  uint8_t fit = ble.logFit();
  if (fit < 1) return;
  uint32_t first = 0;
  uint16_t n = allDay ? day.copy(logFrom, buf, fit, first) : 0;
  if (!allDay) first = 0;
  if (!ble.sendLog(first, (const uint8_t*)buf, (uint8_t)n)) return;   // busy: try again next time round
  if (n == 0) logPending = false;      // the empty packet told the phone "that was everything"
  else logFrom = first + n;
}

// Switch everything off in a safe order, then sleep. Waking up restarts the board.
static void goToSleep() {
  Serial.println("# sleeping");
  flash(LED_RED, 2, 40);          // "about to sleep"
  ble.stop();                     // hang up and stop advertising
  bool armed = false;
  for (int tries = 0; tries < 3 && !armed; tries++) armed = imu.armWake(WAKE_THRESHOLD_STEPS);
  // If the board is being moved right now (or the wake-up pin won't settle), don't sleep:
  // restart instead, which brings everything back up cleanly.
  if (!armed || !power.systemOff(RepImu::wakePin())) NVIC_SystemReset();
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_RED, OUTPUT);   digitalWrite(LED_RED, HIGH);    // LEDs are active low
  pinMode(LED_GREEN, OUTPUT); digitalWrite(LED_GREEN, HIGH);
  pinMode(LED_BLUE, OUTPUT);  digitalWrite(LED_BLUE, HIGH);

  // Was all-day mode on before the last sleep or reset? (Bluetooth isn't running yet, so the
  // register can be read directly.)
  bool resumeAllDay = (NRF_POWER->GPREGRET2 == ALLDAY_MAGIC);

  PowerConfig pc;
  pc.stillSecConnected = STILL_SEC_CONNECTED;
  pc.stillSecAdvertising = STILL_SEC_ADVERTISING;
  pc.accelThresholdG = MOVE_ACCEL_G;
  pc.gyroThresholdDps = MOVE_GYRO_DPS;
  pc.sleepWhenUsbPowered = SLEEP_WHEN_USB_POWERED;
  pc.fastCharge = FAST_CHARGE;
  power.begin(pc);

  flash(LED_GREEN, 1, 50);        // "I'm awake"

  if (!imu.begin()) {
    while (true) { digitalToggle(LED_RED); delay(100); }  // fast red = IMU error
  }
  if (!ble.begin("RepTracker", imu.rateHz(), ACCEL_PER_G, GYRO_PER_DPS)) {
    while (true) { digitalToggle(LED_RED); delay(500); }  // slow red = BLE error
  }
  ble.onDayCommand(onDayCommand);
  battery.begin(BATT_TRIM);
  updateBattery();

  // A number that is different on every start: the clock, the battery reading and sensor noise.
  ImuSample s0;
  imu.read(s0);
  uint32_t bits = 0;
  memcpy(&bits, &s0.ax, 4);
  bootId = micros() ^ (bits * 2654435761UL) ^ ((uint32_t)batt.mv << 16);
  if (bootId == 0) bootId = 1;

  day.begin(millis());
  if (resumeAllDay) { allDay = true; ble.setSlowAdvertising(true); }
  publishDayStatus(millis());
}

void loop() {
  // Commands from the phone.
  if (cmdAllDayPending) { cmdAllDayPending = false; setAllDay(cmdAllDayValue, millis()); publishDayStatus(millis()); }

  // All-day mode with no phone listening for samples: low-power watching.
  bool wantLow = allDay && !ble.streaming();
  if (wantLow != lowNow) {
    imu.setLowPower(wantLow);
    lowNow = wantLow;
    decimate = 0;
    if (lowNow) { digitalWrite(LED_GREEN, HIGH); digitalWrite(LED_BLUE, HIGH); }
  }

  ImuSample s;
  if (!imu.poll(s)) {
    // Between samples in low power: really sleep (this is where the battery is saved).
    if (lowNow) { uint32_t ms = imu.msUntilNext(); delay(ms > 1 ? ms : 1); }
    return;
  }
  count++;

  bool connected = ble.connected();
  bool live = false;

  if (lowNow) {
    day.feed(s.t_ms, s.ax, s.ay, s.az, RepPower::usbPowered());
    if (s.t_ms - lastBlink >= 10000) {              // "still alive", too short to cost anything
      lastBlink = s.t_ms;
      if (!connected) { digitalWrite(LED_BLUE, LOW); delay(2); digitalWrite(LED_BLUE, HIGH); }
    }
  } else {
    int16_t v[6] = {
      toI16(s.ax * ACCEL_PER_G), toI16(s.ay * ACCEL_PER_G), toI16(s.az * ACCEL_PER_G),
      toI16(s.gx * GYRO_PER_DPS), toI16(s.gy * GYRO_PER_DPS), toI16(s.gz * GYRO_PER_DPS)};
    ble.push(v);
    // all-day mode during a workout: keep the minute log going on every 4th sample (26 Hz)
    if (allDay && (decimate++ & 3) == 0) day.feed(s.t_ms, s.ax, s.ay, s.az, RepPower::usbPowered());

    live = ble.streaming();
    digitalWrite(LED_GREEN, live ? LOW : HIGH);
    digitalWrite(LED_BLUE, (!live && (s.t_ms % 1000) < 100) ? LOW : HIGH);
  }

  // Sleep logic (gym mode only). A phone connecting or leaving counts as activity.
  if (connected != wasConnected) {
    wasConnected = connected;
    power.noteActivity(s.t_ms);
  }
  if (!lowNow) power.feed(s.t_ms, s.ax, s.ay, s.az, s.gx, s.gy, s.gz);
  if (!allDay && power.shouldSleep(connected, s.t_ms)) goToSleep();

  if (s.t_ms - lastBatt >= BATT_EVERY_MS) { lastBatt = s.t_ms; updateBattery(); }
  if (s.t_ms - lastStatus >= 1000) { lastStatus = s.t_ms; publishDayStatus(s.t_ms); }
  pumpLog();

  if (s.t_ms - lastReport >= 1000) {
    if (!lowNow || RepPower::usbPowered()) {
      Serial.printf("# rate %lu Hz, %s%s, dropped %lu, still %lu s%s, batt %u mV %u%%%s, day %lu min\n", (unsigned long)count,
                    live ? "streaming" : (connected ? "connected" : "advertising"), allDay ? (lowNow ? ", all-day low power" : ", all-day") : "",
                    (unsigned long)ble.dropped(), (unsigned long)power.stillSeconds(s.t_ms),
                    RepPower::usbPowered() ? ", usb" : "", (unsigned)batt.mv, (unsigned)batt.percent,
                    batt.charging ? " charging" : "", (unsigned long)day.count());
    }
    count = 0;
    lastReport = s.t_ms;
  }
}

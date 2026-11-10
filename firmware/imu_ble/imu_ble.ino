// Stage 3 + sleep: read the IMU at 104 Hz and stream it to the phone over BLE.
// The board sleeps by itself when it lies still, and wakes up when it is moved.
//
// LED: blue blinks slowly while waiting for a phone, green stays on while streaming.
//      One short green flash = just woke up / booted.
//      Two short red flashes = about to go to sleep.
// USB serial prints a status line once a second (rate, connection, dropped samples, stillness).
//
// Sleep rules (change them in the constants below):
//   - Nothing moved for 15 min while a phone is connected, or 4 min while nobody is: sleep.
//   - Never sleeps while USB power is plugged in.
//   - Moving the board wakes it; it restarts and is advertising again within about a second.
//
// Quick test build (short timeouts so you don't have to wait minutes):
//   add  --build-property "build.extra_flags=-DREP_QUICK_TEST"  to the arduino-cli compile command.

#include <Adafruit_TinyUSB.h>  // Seeed: needed for Serial on the non-mbed nRF52 core
#include <RepImu.h>
#include <RepBle.h>
#include <RepPower.h>

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
// -------------------------------------------------------------------------------

RepImu imu;
RepBle ble;
RepPower power;
uint32_t count = 0, lastReport = 0;
bool wasConnected = false;

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
}

void loop() {
  ImuSample s;
  if (!imu.poll(s)) return;
  count++;

  int16_t v[6] = {
    toI16(s.ax * ACCEL_PER_G), toI16(s.ay * ACCEL_PER_G), toI16(s.az * ACCEL_PER_G),
    toI16(s.gx * GYRO_PER_DPS), toI16(s.gy * GYRO_PER_DPS), toI16(s.gz * GYRO_PER_DPS)};
  ble.push(v);

  bool live = ble.streaming();
  digitalWrite(LED_GREEN, live ? LOW : HIGH);
  digitalWrite(LED_BLUE, (!live && (s.t_ms % 1000) < 100) ? LOW : HIGH);

  // Sleep logic. A phone connecting or leaving counts as activity.
  bool connected = ble.connected();
  if (connected != wasConnected) {
    wasConnected = connected;
    power.noteActivity(s.t_ms);
  }
  power.feed(s.t_ms, s.ax, s.ay, s.az, s.gx, s.gy, s.gz);
  if (power.shouldSleep(connected, s.t_ms)) goToSleep();

  if (s.t_ms - lastReport >= 1000) {
    Serial.printf("# rate %lu Hz, %s, dropped %lu, still %lu s%s\n", (unsigned long)count,
                  live ? "streaming" : (connected ? "connected" : "advertising"),
                  (unsigned long)ble.dropped(), (unsigned long)power.stillSeconds(s.t_ms),
                  RepPower::usbPowered() ? ", usb" : "");
    count = 0;
    lastReport = s.t_ms;
  }
}

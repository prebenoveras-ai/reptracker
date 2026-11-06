// Stage 3: read the IMU at 104 Hz and stream it to the phone over BLE.
//
// LED: blue blinks slowly while waiting for a phone, green stays on while streaming.
// USB serial prints a status line once a second (rate, connection, dropped samples).

#include <Adafruit_TinyUSB.h>  // Seeed: needed for Serial on the non-mbed nRF52 core
#include <RepImu.h>
#include <RepBle.h>

// Fixed-point scales sent over BLE: 1000 counts per g, 10 counts per deg/s.
// With +-8 g and +-1000 dps both fit in int16.
const uint16_t ACCEL_PER_G = 1000;
const uint16_t GYRO_PER_DPS = 10;

RepImu imu;
RepBle ble;
uint32_t count = 0, lastReport = 0;

static int16_t toI16(float x) {
  if (x > 32767) return 32767;
  if (x < -32768) return -32768;
  return (int16_t)lroundf(x);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_RED, OUTPUT);   digitalWrite(LED_RED, HIGH);    // LEDs are active low
  pinMode(LED_GREEN, OUTPUT); digitalWrite(LED_GREEN, HIGH);
  pinMode(LED_BLUE, OUTPUT);  digitalWrite(LED_BLUE, HIGH);

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

  if (s.t_ms - lastReport >= 1000) {
    Serial.printf("# rate %lu Hz, %s, dropped %lu\n", (unsigned long)count,
                  live ? "streaming" : "advertising", (unsigned long)ble.dropped());
    count = 0;
    lastReport = s.t_ms;
  }
}

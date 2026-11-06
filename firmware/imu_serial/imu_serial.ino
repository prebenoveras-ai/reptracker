// Stage 2: read the IMU at 104 Hz and print it over USB serial.
//
// Two output modes (type the letter and press Enter in the serial monitor):
//   c = CSV, every sample:  t_ms,ax,ay,az,gx,gy,gz   (default)
//   v = readable view, 5 times a second, for checking the axes by eye
// Once a second (CSV mode) a "# rate" line reports the real samples per second.

#include <Adafruit_TinyUSB.h>  // Seeed: needed for Serial on the non-mbed nRF52 core
#include <RepImu.h>

RepImu imu;
bool csvMode = true;
uint32_t count = 0, lastReport = 0, lastView = 0;

void setup() {
  Serial.begin(115200);
  uint32_t start = millis();
  while (!Serial && millis() - start < 3000) {}  // wait up to 3 s for the monitor

  pinMode(LED_RED, OUTPUT);
  digitalWrite(LED_RED, HIGH);  // off (active low)

  if (!imu.begin()) {
    Serial.println("# IMU not found");
    while (true) {  // fast red blink = IMU error
      digitalWrite(LED_RED, !digitalRead(LED_RED));
      delay(100);
    }
  }
  Serial.println("# IMU OK. t_ms,ax,ay,az,gx,gy,gz  (accel in g, gyro in deg/s)");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'c') csvMode = true;
    if (c == 'v') csvMode = false;
  }

  ImuSample s;
  if (!imu.poll(s)) return;
  count++;

  if (csvMode) {
    Serial.printf("%lu,%.3f,%.3f,%.3f,%.1f,%.1f,%.1f\n",
                  (unsigned long)s.t_ms, s.ax, s.ay, s.az, s.gx, s.gy, s.gz);
  } else if (s.t_ms - lastView >= 200) {
    lastView = s.t_ms;
    Serial.printf("accel g  X %6.2f  Y %6.2f  Z %6.2f   |   gyro dps  X %7.1f  Y %7.1f  Z %7.1f\n",
                  s.ax, s.ay, s.az, s.gx, s.gy, s.gz);
  }

  if (s.t_ms - lastReport >= 1000) {
    if (csvMode) Serial.printf("# rate %lu Hz\n", (unsigned long)count);
    count = 0;
    lastReport = s.t_ms;
  }
}

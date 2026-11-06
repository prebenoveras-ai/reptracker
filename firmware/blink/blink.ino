// Stage 1: blink test for the Seeed XIAO nRF52840 Sense.
// The onboard LEDs are active LOW (LOW = on, HIGH = off), per Seeed's wiki.
// Cycles red -> green -> blue so you can see all three LEDs work.

const int leds[] = {LED_RED, LED_GREEN, LED_BLUE};

void setup() {
  for (int pin : leds) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, HIGH);  // all off
  }
}

void loop() {
  for (int pin : leds) {
    digitalWrite(pin, LOW);   // on
    delay(400);
    digitalWrite(pin, HIGH);  // off
  }
}

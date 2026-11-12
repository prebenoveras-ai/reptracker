#include "RepBattery.h"
#include <nrf.h>

// Pins from the Seeed variant: D14 = P0.14 (read enable, LOW = on), D32 = P0.31 (ADC), D23 = P0.17 (charge LED, LOW = charging).
#ifndef VBAT_ENABLE
#define VBAT_ENABLE 14
#endif
#ifndef PIN_VBAT
#define PIN_VBAT 32
#endif
static const int PIN_CHG = 23;

static const float DIVIDER = (1000.0f + 510.0f) / 510.0f;   // 1 Mohm over 510 kohm: about 2.96
static const float ADC_MV = 3000.0f / 4096.0f;              // 3.0 V reference, 12 bit

void RepBattery::begin(float trim) {
  trim_ = trim;
  pinMode(PIN_CHG, INPUT);
  pinMode(VBAT_ENABLE, OUTPUT);
  digitalWrite(VBAT_ENABLE, HIGH);   // Seeed's default: divider off (no current drawn)
}

BatteryReading RepBattery::read() {
  analogReference(AR_INTERNAL_3_0);
  analogReadResolution(12);

  digitalWrite(VBAT_ENABLE, LOW);    // connect the divider
  delay(10);                          // let the input settle
  analogRead(PIN_VBAT);               // first reading after a switch is unreliable: throw it away
  uint32_t sum = 0;
  const int N = 8;
  for (int i = 0; i < N; i++) { sum += analogRead(PIN_VBAT); delayMicroseconds(200); }
  digitalWrite(VBAT_ENABLE, HIGH);   // disconnect again

  float raw = sum / (float)N;
  float mv = raw * ADC_MV * DIVIDER * trim_;

  BatteryReading r;
  r.mv = (mv > 0 && mv < 6000) ? (uint16_t)(mv + 0.5f) : 0;
  r.percent = r.mv ? percentFromMv(r.mv) : 0;
  r.charging = digitalRead(PIN_CHG) == LOW;
  r.usb = (NRF_POWER->USBREGSTATUS & POWER_USBREGSTATUS_VBUSDETECT_Msk) != 0;
  return r;
}

// Typical single-cell LiPo, resting, as (millivolts, percent), from full to empty.
uint8_t RepBattery::percentFromMv(uint16_t mv) {
  static const uint16_t V[] = {4200, 4150, 4110, 4080, 4020, 3980, 3950, 3910, 3870, 3850, 3840, 3820, 3800, 3790, 3770, 3750, 3730, 3710, 3690, 3610, 3270};
  static const uint8_t  P[] = { 100,   95,   90,   85,   80,   75,   70,   65,   60,   55,   50,   45,   40,   35,   30,   25,   20,   15,   10,    5,    0};
  const int n = sizeof(V) / sizeof(V[0]);
  if (mv >= V[0]) return 100;
  if (mv <= V[n - 1]) return 0;
  for (int i = 1; i < n; i++) {
    if (mv >= V[i]) {
      float f = (float)(mv - V[i]) / (float)(V[i - 1] - V[i]);
      return (uint8_t)(P[i] + f * (P[i - 1] - P[i]) + 0.5f);
    }
  }
  return 0;
}

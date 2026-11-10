#include "RepPower.h"
#include <nrf_gpio.h>
#include <nrf_soc.h>
#include <nrf_sdm.h>

void RepPower::begin(const PowerConfig& cfg) {
  cfg_ = cfg;
#ifdef PIN_CHARGING_CURRENT
  // BQ25100 charger, P0.13: floating = 50 mA, driven low = 100 mA (Seeed wiki).
  if (cfg_.fastCharge) {
    pinMode(PIN_CHARGING_CURRENT, OUTPUT);
    digitalWrite(PIN_CHARGING_CURRENT, LOW);
  } else {
    pinMode(PIN_CHARGING_CURRENT, INPUT);
  }
#endif
  primed_ = false;
  run_ = 0;
  lastMotionMs_ = millis();
}

void RepPower::feed(uint32_t t_ms, float ax, float ay, float az, float gx, float gy, float gz) {
  if (!primed_) {
    bx_ = ax; by_ = ay; bz_ = az;
    primed_ = true;
    lastMotionMs_ = t_ms;
    return;
  }
  float dx = ax - bx_, dy = ay - by_, dz = az - bz_;
  float da = sqrtf(dx * dx + dy * dy + dz * dz);
  float gm = sqrtf(gx * gx + gy * gy + gz * gz);
  bool moving = da > cfg_.accelThresholdG || gm > cfg_.gyroThresholdDps;

  // Slow average (about half a second at 104 Hz): a steady tilt isn't movement,
  // a change is.
  const float k = 0.02f;
  bx_ += k * (ax - bx_);
  by_ += k * (ay - by_);
  bz_ += k * (az - bz_);

  if (moving) {
    if (run_ < 255) run_++;
    if (run_ >= cfg_.minMovingSamples) lastMotionMs_ = t_ms;
  } else {
    run_ = 0;
  }
}

void RepPower::noteActivity(uint32_t now_ms) { lastMotionMs_ = now_ms; }

uint32_t RepPower::stillSeconds(uint32_t now_ms) const {
  return (uint32_t)(now_ms - lastMotionMs_) / 1000UL;
}

bool RepPower::usbPowered() {
  return (NRF_POWER->USBREGSTATUS & POWER_USBREGSTATUS_VBUSDETECT_Msk) != 0;
}

bool RepPower::shouldSleep(bool phoneConnected, uint32_t now_ms) const {
  if (!cfg_.sleepWhenUsbPowered && usbPowered()) return false;
  uint32_t limit = phoneConnected ? cfg_.stillSecConnected : cfg_.stillSecAdvertising;
  return stillSeconds(now_ms) >= limit;
}

bool RepPower::systemOff(int wakePin) {
  if (digitalRead(wakePin) == HIGH) return false;

  // Wake when the IMU drives its pin high. GPIO levels (the IMU's power pin, the charge
  // setting) are kept while the chip is in System OFF; the sense circuit is what wakes it.
  nrf_gpio_cfg_sense_input(g_ADigitalPinMap[wakePin], NRF_GPIO_PIN_NOPULL,
                           NRF_GPIO_PIN_SENSE_HIGH);

  uint8_t sdEnabled = 0;
  sd_softdevice_is_enabled(&sdEnabled);
  if (sdEnabled) {
    sd_power_system_off();           // Bluetooth stack is running: it must do this itself
  } else {
    NRF_POWER->SYSTEMOFF = 1;
  }
  while (true) { __WFE(); }          // not reached: the chip is off
  return true;
}

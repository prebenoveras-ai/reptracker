#include "RepBle.h"
#include <bluefruit.h>

static BLEService svc("a6e10001-5b1e-4f3a-9c2d-7e0f1b2c3d4e");
static BLECharacteristic samplesChr("a6e10002-5b1e-4f3a-9c2d-7e0f1b2c3d4e");
static BLECharacteristic infoChr("a6e10003-5b1e-4f3a-9c2d-7e0f1b2c3d4e");
static BLECharacteristic batteryChr("a6e10004-5b1e-4f3a-9c2d-7e0f1b2c3d4e");
static BLECharacteristic dayStatChr("a6e10005-5b1e-4f3a-9c2d-7e0f1b2c3d4e");
static BLECharacteristic dayCtrlChr("a6e10006-5b1e-4f3a-9c2d-7e0f1b2c3d4e");
static BLECharacteristic dayLogChr("a6e10007-5b1e-4f3a-9c2d-7e0f1b2c3d4e");
static RepBle::DayCommandFn dayCommandFn = nullptr;

static void onDayCtrlWrite(uint16_t conn, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  (void)conn; (void)chr;
  if (!dayCommandFn || len < 1) return;
  uint32_t arg = 0;
  if (len >= 5) memcpy(&arg, data + 1, 4);
  else if (len >= 2) arg = data[1];
  dayCommandFn(data[0], arg);
}

static volatile uint16_t connHandle = BLE_CONN_HANDLE_INVALID;

static void onConnect(uint16_t conn) {
  connHandle = conn;
  BLEConnection* c = Bluefruit.Connection(conn);
  // Ask for bigger packets and a faster link (same calls as Adafruit's throughput example).
  c->requestPHY();
  c->requestDataLengthUpdate();
  c->requestMtuExchange(247);
}

static void onDisconnect(uint16_t conn, uint8_t reason) {
  (void)conn; (void)reason;
  connHandle = BLE_CONN_HANDLE_INVALID;
}

bool RepBle::begin(const char* name, uint16_t rateHz, uint16_t accelPerG, uint16_t gyroPerDps) {
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);
  if (!Bluefruit.begin()) return false;
  Bluefruit.setName(name);
  Bluefruit.setTxPower(4);
  Bluefruit.autoConnLed(false);  // we drive the LEDs ourselves
  Bluefruit.Periph.setConnectCallback(onConnect);
  Bluefruit.Periph.setDisconnectCallback(onDisconnect);
  Bluefruit.Periph.setConnInterval(6, 12);  // 7.5 - 15 ms

  svc.begin();

  samplesChr.setProperties(CHR_PROPS_NOTIFY);
  samplesChr.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  samplesChr.setMaxLen(sizeof(buf_));
  samplesChr.begin();

  infoChr.setProperties(CHR_PROPS_READ);
  infoChr.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  infoChr.setFixedLen(6);
  infoChr.begin();
  uint16_t info[3] = {rateHz, accelPerG, gyroPerDps};
  infoChr.write(info, sizeof(info));

  batteryChr.setProperties(CHR_PROPS_READ);
  batteryChr.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  batteryChr.setFixedLen(4);
  batteryChr.begin();
  setBattery(0, 0, 0);   // unknown until the sketch measures it

  dayStatChr.setProperties(CHR_PROPS_READ);
  dayStatChr.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  dayStatChr.setMaxLen(20);
  dayStatChr.begin();
  uint8_t none[1] = {0};
  dayStatChr.write(none, 1);   // version 0 = no status yet

  dayCtrlChr.setProperties(CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP);
  dayCtrlChr.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  dayCtrlChr.setMaxLen(8);
  dayCtrlChr.setWriteCallback(onDayCtrlWrite);
  dayCtrlChr.begin();

  dayLogChr.setProperties(CHR_PROPS_NOTIFY);
  dayLogChr.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  dayLogChr.setMaxLen(5 + kMaxLogRecords * 4);
  dayLogChr.begin();

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(svc);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);  // 20 ms fast, 152.5 ms slow
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);              // advertise forever
  return true;
}

void RepBle::setBattery(uint16_t mv, uint8_t percent, uint8_t flags) {
  uint8_t b[4] = { (uint8_t)(mv & 0xFF), (uint8_t)(mv >> 8), percent, flags };
  batteryChr.write(b, sizeof(b));
}

void RepBle::onDayCommand(DayCommandFn fn) { dayCommandFn = fn; }

void RepBle::setDayStatus(const uint8_t* data, uint8_t len) {
  dayStatChr.write(data, len > 20 ? 20 : len);
}

bool RepBle::logListening() const {
  return connHandle != BLE_CONN_HANDLE_INVALID && dayLogChr.notifyEnabled(connHandle);
}

uint8_t RepBle::logFit() const {
  if (connHandle == BLE_CONN_HANDLE_INVALID) return 0;
  uint16_t mtu = Bluefruit.Connection(connHandle)->getMtu();
  if (mtu < 3 + 5 + 4) return 1;
  uint16_t fit = (mtu - 3 - 5) / 4;
  return fit > kMaxLogRecords ? kMaxLogRecords : (uint8_t)fit;
}

bool RepBle::sendLog(uint32_t firstMinute, const uint8_t* records, uint8_t count) {
  if (!logListening()) return false;
  if (count > kMaxLogRecords) count = kMaxLogRecords;
  uint8_t pkt[5 + kMaxLogRecords * 4];
  memcpy(pkt, &firstMinute, 4);   // little endian
  pkt[4] = count;
  if (count) memcpy(pkt + 5, records, (size_t)count * 4);
  return dayLogChr.notify(connHandle, pkt, 5 + (uint16_t)count * 4);
}

void RepBle::setSlowAdvertising(bool slow) {
  // units of 0.625 ms: fast 20 ms for the first 30 s, then 152.5 ms (normal) or about 1 s (slow)
  Bluefruit.Advertising.setInterval(32, slow ? 1636 : 244);
  if (connHandle == BLE_CONN_HANDLE_INVALID && Bluefruit.Advertising.isRunning()) {
    Bluefruit.Advertising.stop();
    Bluefruit.Advertising.start(0);
  }
}

bool RepBle::streaming() const {
  return connHandle != BLE_CONN_HANDLE_INVALID && samplesChr.notifyEnabled(connHandle);
}

bool RepBle::connected() const {
  return connHandle != BLE_CONN_HANDLE_INVALID;
}

void RepBle::stop() {
  Bluefruit.Advertising.restartOnDisconnect(false);  // don't start again after we hang up
  Bluefruit.Advertising.stop();
  if (connHandle != BLE_CONN_HANDLE_INVALID) {
    Bluefruit.Connection(connHandle)->disconnect();
    uint32_t t0 = millis();
    while (connHandle != BLE_CONN_HANDLE_INVALID && millis() - t0 < 500) delay(5);
  }
  count_ = 0;
}

void RepBle::push(const int16_t v[6]) {
  uint32_t idx = sampleIndex_++;
  if (!streaming()) { count_ = 0; return; }

  if (count_ == 0) memcpy(buf_, &idx, 4);  // nRF52 is little endian
  memcpy(buf_ + 5 + count_ * 12, v, 12);
  count_++;

  // Fit as many samples as the negotiated packet size allows (at least 1).
  uint16_t mtu = Bluefruit.Connection(connHandle)->getMtu();
  uint8_t fit = (mtu - 3 - 5) / 12;
  if (fit < 1) fit = 1;
  if (fit > kMaxPerPacket) fit = kMaxPerPacket;
  if (count_ >= fit) flush();
}

void RepBle::flush() {
  buf_[4] = count_;
  if (!samplesChr.notify(connHandle, buf_, 5 + count_ * 12)) dropped_ += count_;
  count_ = 0;
}

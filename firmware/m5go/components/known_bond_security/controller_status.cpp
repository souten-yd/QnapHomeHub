#include "controller_status.h"
#include "esphome/core/hal.h"
#include "esp_idf_version.h"

// This is an internal IDF ABI, deliberately restricted to the inspected build.
// A framework upgrade requires reinspection instead of silently losing evidence.
#if ESP_IDF_VERSION != ESP_IDF_VERSION_VAL(5, 5, 5)
#error "Controller status observation requires the audited ESP-IDF 5.5.5 ABI"
#endif

extern "C" void __real_btm_sec_encrypt_change(uint16_t handle, uint8_t status, uint8_t enabled);
extern "C" void __wrap_btm_sec_encrypt_change(uint16_t handle, uint8_t status, uint8_t enabled) {
  esphome::known_bond_security::controller_status::capture(esphome::millis(), status, enabled);
  // Always forward exactly once with the original arguments, even on overflow.
  __real_btm_sec_encrypt_change(handle, status, enabled);
}

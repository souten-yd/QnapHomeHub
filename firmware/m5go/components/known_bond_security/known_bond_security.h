#pragma once

#include <cstring>
#include <vector>
#include "esp_gap_ble_api.h"
#include "esp_gattc_api.h"
#include "esphome/core/component.h"
#include "esphome/core/log.h"

namespace esphome::known_bond_security {

class KnownBondSecurity : public Component {
 public:
  void gattc_event_handler(esp_gattc_cb_event_t event, esp_gatt_if_t,
                           esp_ble_gattc_cb_param_t *param) {
    if (event != ESP_GATTC_OPEN_EVT || param->open.status != ESP_GATT_OK)
      return;
    // A bond is stored separately from the current connection's encryption.
    // Never start security for an unknown peer or modify/delete stored keys.
    int count = esp_ble_get_bond_device_num();
    if (count <= 0 || count > 32)
      return;
    std::vector<esp_ble_bond_dev_t> bonds(count);
    if (esp_ble_get_bond_device_list(&count, bonds.data()) != ESP_OK)
      return;
    for (int i = 0; i < count; ++i) {
      if (std::memcmp(bonds[i].bd_addr, param->open.remote_bda, ESP_BD_ADDR_LEN) == 0) {
        // One request per successful connection, with no retry or unpair path.
        auto error = esp_ble_set_encryption(param->open.remote_bda, ESP_BLE_SEC_ENCRYPT);
        if (error != ESP_OK)
          ESP_LOGW("known_bond_security", "Encryption request failed (%d)", error);
        return;
      }
    }
  }
};

}  // namespace esphome::known_bond_security

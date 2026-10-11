#pragma once

#include <cstring>
#include <vector>
#include <string>
#include "esp_gap_ble_api.h"
#include "esp_gattc_api.h"
#include "esphome/core/component.h"
#include "esphome/core/log.h"
#include "esphome/components/text_sensor/text_sensor.h"

namespace esphome::known_bond_security {

class KnownBondSecurity : public Component {
 public:
  void set_diagnostic(text_sensor::TextSensor *diagnostic) { diagnostic_ = diagnostic; }

  void gap_event_handler(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t *param) {
    if (event != ESP_GAP_BLE_AUTH_CMPL_EVT || !tracking_ ||
        std::memcmp(peer_, param->ble_security.auth_cmpl.bd_addr, ESP_BD_ADDR_LEN) != 0)
      return;
    const auto &auth = param->ble_security.auth_cmpl;
    publish_(auth.success ? "authenticated" : "auth_failed:" + std::to_string(auth.fail_reason));
  }

  void gattc_event_handler(esp_gattc_cb_event_t event, esp_gatt_if_t,
                           esp_ble_gattc_cb_param_t *param) {
    if (event != ESP_GATTC_OPEN_EVT || param->open.status != ESP_GATT_OK)
      return;
    tracking_ = false;
    // A bond is stored separately from the current connection's encryption.
    // Never start security for an unknown peer or modify/delete stored keys.
    int count = esp_ble_get_bond_device_num();
    if (count <= 0 || count > 32) {
      publish_("bond_count:" + std::to_string(count));
      return;
    }
    std::vector<esp_ble_bond_dev_t> bonds(count);
    if (esp_ble_get_bond_device_list(&count, bonds.data()) != ESP_OK) {
      publish_("bond_list_failed");
      return;
    }
    for (int i = 0; i < count; ++i) {
      if (std::memcmp(bonds[i].bd_addr, param->open.remote_bda, ESP_BD_ADDR_LEN) == 0) {
        std::memcpy(peer_, param->open.remote_bda, ESP_BD_ADDR_LEN);
        tracking_ = true;
        // One request per successful connection, with no retry or unpair path.
        auto error = esp_ble_set_encryption(param->open.remote_bda, ESP_BLE_SEC_ENCRYPT);
        if (error != ESP_OK)
          ESP_LOGW("known_bond_security", "Encryption request failed (%d)", error);
        publish_(error == ESP_OK ? "encryption_requested" : "request_failed:" + std::to_string(error));
        return;
      }
    }
    publish_("peer_not_bonded");
  }

 protected:
  void publish_(const std::string &state) {
    // Phase/status only: no peer addresses, application keys or bond material.
    if (diagnostic_ != nullptr)
      diagnostic_->publish_state(state);
  }
  text_sensor::TextSensor *diagnostic_{nullptr};
  uint8_t peer_[ESP_BD_ADDR_LEN]{};
  bool tracking_{false};
};

}  // namespace esphome::known_bond_security

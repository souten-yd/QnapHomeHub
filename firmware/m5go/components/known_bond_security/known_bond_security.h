#pragma once

#include <cstring>
#include <vector>
#include <string>
#include <initializer_list>
#include "esphome/core/hal.h"
#include "esp_gap_ble_api.h"
#include "esp_gattc_api.h"
#include "esphome/core/component.h"
#include "esphome/core/log.h"
#include "esphome/components/text_sensor/text_sensor.h"
#include "controller_status.h"

namespace esphome::known_bond_security {

class KnownBondSecurity : public Component {
 public:
  void set_diagnostic(text_sensor::TextSensor *diagnostic) { diagnostic_ = diagnostic; }
  void set_session_diagnostic(text_sensor::TextSensor *diagnostic) { session_diagnostic_ = diagnostic; }
  void set_controller_diagnostic(text_sensor::TextSensor *diagnostic) { controller_diagnostic_ = diagnostic; }
  void setup() override { publish_session_(); publish_controller_(); }
  void loop() override { drain_controller_(); }

  // Authenticated Native API action, scoped to one peer and one OPEN attempt.
  // This only defers our eager encryption; explicit proxy pairing still owns SMP.
  bool prepare_bond(const std::string &address) {
    bond_prepared_ = false;
    if (tracking_ || address.size() != 17) return false;
    for (size_t i = 0; i < ESP_BD_ADDR_LEN; ++i) {
      if (i && address[i * 3 - 1] != ':') return false;
      int hi = hex_(address[i * 3]), lo = hex_(address[i * 3 + 1]);
      if (hi < 0 || lo < 0) return false;
      bond_peer_[i] = (hi << 4) | lo;
    }
    bond_prepared_at_ = millis();
    bond_prepared_ = true;
    return true;
  }
  bool cancel_bond() { bond_prepared_ = false; return true; }

  void gap_event_handler(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t *param) {
    if (event != ESP_GAP_BLE_AUTH_CMPL_EVT || !tracking_ ||
        std::memcmp(peer_, param->ble_security.auth_cmpl.bd_addr, ESP_BD_ADDR_LEN) != 0)
      return;
    const auto &auth = param->ble_security.auth_cmpl;
    drain_controller_();
    record_(auth.success ? "auth_ok" : "auth_fail",
            {auth.success ? 0 : static_cast<int>(auth.fail_reason), auth.auth_mode, auth.addr_type,
             auth.key_present ? 1 : 0});
    if (auth.success)
      inspect_bond_("bond_auth");
    publish_(auth.success ? "authenticated" : "auth_failed:" + std::to_string(auth.fail_reason));
  }

  void gattc_event_handler(esp_gattc_cb_event_t event, esp_gatt_if_t,
                           esp_ble_gattc_cb_param_t *param) {
    if (tracking_ && (event == ESP_GATTC_WRITE_DESCR_EVT || event == ESP_GATTC_WRITE_CHAR_EVT) &&
        param->write.conn_id == conn_id_) {
      // Only the first application write: never payloads or history traffic.
      if (event == ESP_GATTC_WRITE_DESCR_EVT || !first_write_) {
        record_(event == ESP_GATTC_WRITE_DESCR_EVT ? "cccd" : "write",
                {param->write.status, param->write.handle});
        if (event == ESP_GATTC_WRITE_CHAR_EVT)
          first_write_ = true;
      }
      return;
    }
    if (event == ESP_GATTC_DISCONNECT_EVT && tracking_ &&
        std::memcmp(peer_, param->disconnect.remote_bda, ESP_BD_ADDR_LEN) == 0) {
      controller_status::end();
      drain_controller_();
      inspect_bond_("bond_close");
      record_("disconnect", {param->disconnect.reason});
      tracking_ = false;
      publish_(last_security_ + ";disconnected:" + std::to_string(param->disconnect.reason));
      return;
    }
    if (event != ESP_GATTC_OPEN_EVT)
      return;
    controller_status::end();
    bool explicit_bond = bond_prepared_ && millis() - bond_prepared_at_ < 30000 &&
                         std::memcmp(bond_peer_, param->open.remote_bda, ESP_BD_ADDR_LEN) == 0;
    bond_prepared_ = false;  // Failed/foreign OPEN also consumes the reservation.
    ++sequence_;
    started_ = millis();
    controller_events_.clear();
    controller_overflow_ = false;
    controller_lost_ = controller_status::lost.load(std::memory_order_relaxed);
    publish_controller_();
    events_.clear();
    overflow_ = false;
    first_write_ = false;
    record_("open", {param->open.status});
    if (param->open.status != ESP_GATT_OK) {
      tracking_ = false;
      publish_("open_failed:" + std::to_string(param->open.status));
      return;
    }
    // Observe explicit first-time pairing too, without initiating security.
    std::memcpy(peer_, param->open.remote_bda, ESP_BD_ADDR_LEN);
    tracking_ = true;
    conn_id_ = param->open.conn_id;
    if (controller_diagnostic_ != nullptr)
      controller_status::begin(sequence_);
    // A bond is stored separately from the current connection's encryption.
    // Never start security for an unknown peer or modify/delete stored keys.
    if (inspect_bond_("bond_open") && !explicit_bond) {
      auto error = esp_ble_set_encryption(param->open.remote_bda, ESP_BLE_SEC_ENCRYPT);
      record_("encrypt", {error});
      if (error != ESP_OK)
        ESP_LOGW("known_bond_security", "Encryption request failed (%d)", error);
      publish_(error == ESP_OK ? "encryption_requested" : "request_failed:" + std::to_string(error));
    }
  }

 protected:
  void drain_controller_() {
    bool changed = false;
    controller_status::Event event;
    while (controller_status::pop(event)) {
      if (event.sequence != sequence_) continue;  // Never reuse another connection's result.
      if (controller_events_.size() >= controller_status::CAPACITY) {
        controller_overflow_ = true;
      } else {
        controller_events_.push_back("[" + std::to_string(event.at - started_) + "," +
                                     std::to_string(event.status) + "," + std::to_string(event.enabled) + "]");
      }
      changed = true;
    }
    if (!controller_overflow_ && controller_status::lost.load(std::memory_order_relaxed) != controller_lost_) {
      controller_overflow_ = true;
      changed = true;
    }
    if (changed) publish_controller_();
  }
  void publish_controller_() {
    if (controller_diagnostic_ == nullptr) return;
    std::string value = "{\"v\":1,\"seq\":" + std::to_string(sequence_) +
                        ",\"overflow\":" + (controller_overflow_ ? "true" : "false") + ",\"events\":[";
    for (size_t i = 0; i < controller_events_.size(); ++i) {
      if (i) value += ",";
      value += controller_events_[i];
    }
    controller_diagnostic_->publish_state(value + "]}");
  }
  static int hex_(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
  }
  bool inspect_bond_(const char *phase) {
    bool opening = std::strcmp(phase, "bond_open") == 0;
    int count = esp_ble_get_bond_device_num();
    if (count <= 0 || count > 32) {
      if (opening) publish_("bond_count:" + std::to_string(count));
      record_("bond_count", {count});
      return false;
    }
    std::vector<esp_ble_bond_dev_t> bonds(count);
    if (esp_ble_get_bond_device_list(&count, bonds.data()) != ESP_OK ||
        count < 0 || static_cast<size_t>(count) > bonds.size()) {
      if (opening) publish_("bond_list_failed");
      record_("bond_list_failed", {});
      return false;
    }
    for (int i = 0; i < count; ++i) {
      if (std::memcmp(bonds[i].bd_addr, peer_, ESP_BD_ADDR_LEN) == 0) {
        const auto &key = bonds[i].bond_key;
        bool enc = key.key_mask & ESP_BLE_ENC_KEY_MASK;
        bool id = key.key_mask & ESP_BLE_ID_KEY_MASK;
        record_(phase, {key.key_mask, enc ? key.penc_key.key_size : -1, bonds[i].bd_addr_type,
                        id ? (zero_(key.pid_key.irk, sizeof(key.pid_key.irk)) ? 1 : 0) : -1,
                        enc ? (key.penc_key.ediv == 0 ? 1 : 0) : -1,
                        enc ? (zero_(key.penc_key.rand, sizeof(key.penc_key.rand)) ? 1 : 0) : -1});
        return true;
      }
    }
    if (opening) publish_("peer_not_bonded");
    record_("peer_not_bonded", {});
    return false;
  }
  static bool zero_(const uint8_t *data, size_t length) {
    for (size_t i = 0; i < length; ++i)
      if (data[i] != 0) return false;
    return true;
  }
  void record_(const char *name, std::initializer_list<int> values) {
    if (events_.size() >= 24) {
      if (!overflow_) { overflow_ = true; publish_session_(); }
      return;
    }
    std::string entry = "[\"" + std::string(name) + "\"," + std::to_string(millis() - started_);
    for (auto value : values) entry += "," + std::to_string(value);
    events_.push_back(entry + "]");
    publish_session_();
  }
  void publish_session_() {
    if (session_diagnostic_ == nullptr) return;
    std::string value = "{\"v\":1,\"seq\":" + std::to_string(sequence_) +
                        ",\"overflow\":" + (overflow_ ? "true" : "false") + ",\"events\":[";
    for (size_t i = 0; i < events_.size(); ++i) {
      if (i) value += ",";
      value += events_[i];
    }
    session_diagnostic_->publish_state(value + "]}");
  }
  void publish_(const std::string &state) {
    // Phase/status only: no peer addresses, application keys or bond material.
    last_security_ = state;
    if (diagnostic_ != nullptr)
      diagnostic_->publish_state(state);
  }
  text_sensor::TextSensor *diagnostic_{nullptr};
  text_sensor::TextSensor *session_diagnostic_{nullptr};
  text_sensor::TextSensor *controller_diagnostic_{nullptr};
  std::vector<std::string> controller_events_;
  uint32_t controller_lost_{0};
  bool controller_overflow_{false};
  std::vector<std::string> events_;
  uint32_t sequence_{0}, started_{0};
  uint16_t conn_id_{0};
  bool overflow_{false}, first_write_{false};
  uint8_t peer_[ESP_BD_ADDR_LEN]{};
  bool tracking_{false};
  bool bond_prepared_{false};
  uint32_t bond_prepared_at_{0};
  uint8_t bond_peer_[ESP_BD_ADDR_LEN]{};
  std::string last_security_{"idle"};
};

}  // namespace esphome::known_bond_security

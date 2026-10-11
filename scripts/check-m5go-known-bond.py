"""Compile the real component against fake IDF calls; test its security boundary."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
STUB = r'''
#pragma once
#include <cstdint>
#include <cstring>
#include <string>
using esp_gattc_cb_event_t = int;
using esp_gap_ble_cb_event_t = int;
using esp_gatt_if_t = int;
constexpr int ESP_GATTC_OPEN_EVT=1, ESP_GATT_OK=0, ESP_OK=0, ESP_BD_ADDR_LEN=6, ESP_BLE_SEC_ENCRYPT=1;
constexpr int ESP_GAP_BLE_AUTH_CMPL_EVT=8;
constexpr int ESP_GATTC_DISCONNECT_EVT=2;
struct esp_ble_gap_cb_param_t { struct { struct { uint8_t bd_addr[6]; bool success; int fail_reason; } auth_cmpl; } ble_security; };
struct esp_ble_bond_dev_t { uint8_t bd_addr[6]; };
struct esp_ble_gattc_cb_param_t {
  struct { int status; uint8_t remote_bda[6]; } open;
  struct { uint8_t remote_bda[6]; int reason; } disconnect;
};
inline int bond_count=0, list_error=0, requests=0, lists=0, request_error=0;
inline uint8_t saved_address[6]={1,2,3,4,5,6};
inline int esp_ble_get_bond_device_num() { return bond_count; }
inline int esp_ble_get_bond_device_list(int *count, esp_ble_bond_dev_t *out) {
  ++lists;
  if (list_error) return list_error;
  *count=1; std::memcpy(out[0].bd_addr,saved_address,6); return 0;
}
inline int esp_ble_set_encryption(uint8_t *address,int mode) {
  if (std::memcmp(address,saved_address,6) || mode!=ESP_BLE_SEC_ENCRYPT) __builtin_abort();
  ++requests; return request_error;
}
namespace esphome { class Component {}; }
namespace esphome::text_sensor { class TextSensor {
 public: std::string state; void publish_state(const std::string &value) { state=value; }
}; }
#define ESP_LOGW(...) ((void)0)
'''
TEST = r'''
#include <cassert>
#include "known_bond_security.h"
int main() {
  esphome::known_bond_security::KnownBondSecurity component;
  esphome::text_sensor::TextSensor diagnostic;
  component.set_diagnostic(&diagnostic);
  esp_ble_gattc_cb_param_t event{};
  std::memcpy(event.open.remote_bda,saved_address,6);
  auto open=[&]() { component.gattc_event_handler(ESP_GATTC_OPEN_EVT,0,&event); };
  // Never create security state with no bonds, failed reads or another peer.
  open(); assert(requests==0 && lists==0);
  assert(diagnostic.state=="bond_count:0");
  bond_count=-1; open(); assert(requests==0 && lists==0);
  bond_count=33; open(); assert(requests==0 && lists==0);
  bond_count=1; list_error=1; open(); assert(requests==0);
  assert(diagnostic.state=="bond_list_failed");
  list_error=0; event.open.remote_bda[0]=7; open(); assert(requests==0);
  assert(diagnostic.state=="peer_not_bonded");
  event.open.remote_bda[0]=1;
  event.open.status=5; open(); assert(requests==0);
  assert(diagnostic.state=="open_failed:5");
  event.open.status=0; component.gattc_event_handler(9,0,&event); assert(requests==0);
  // A valid connection to the stored peer makes exactly one encryption request.
  open(); assert(requests==1);
  assert(diagnostic.state=="encryption_requested");
  esp_ble_gap_cb_param_t auth{};
  std::memcpy(auth.ble_security.auth_cmpl.bd_addr,saved_address,6);
  auth.ble_security.auth_cmpl.success=true;
  component.gap_event_handler(9,&auth);
  assert(diagnostic.state=="encryption_requested");
  auth.ble_security.auth_cmpl.bd_addr[0]=7;
  component.gap_event_handler(ESP_GAP_BLE_AUTH_CMPL_EVT,&auth);
  assert(diagnostic.state=="encryption_requested");
  auth.ble_security.auth_cmpl.bd_addr[0]=1;
  component.gap_event_handler(ESP_GAP_BLE_AUTH_CMPL_EVT,&auth);
  assert(diagnostic.state=="authenticated" && requests==1);
  auth.ble_security.auth_cmpl.success=false;
  auth.ble_security.auth_cmpl.fail_reason=5;
  component.gap_event_handler(ESP_GAP_BLE_AUTH_CMPL_EVT,&auth);
  assert(diagnostic.state=="auth_failed:5" && requests==1);
  request_error=7; open();
  assert(diagnostic.state=="request_failed:7" && requests==2);
  bond_count=0; open();
  component.gap_event_handler(ESP_GAP_BLE_AUTH_CMPL_EVT,&auth);
  // First-time explicit pairing is observable but never initiated here.
  assert(diagnostic.state=="auth_failed:5" && requests==2);
  auth.ble_security.auth_cmpl.success=true;
  component.gap_event_handler(ESP_GAP_BLE_AUTH_CMPL_EVT,&auth);
  assert(diagnostic.state=="authenticated" && requests==2);
  std::memcpy(event.disconnect.remote_bda,saved_address,6);
  event.disconnect.reason=19;event.disconnect.remote_bda[0]=7;
  component.gattc_event_handler(ESP_GATTC_DISCONNECT_EVT,0,&event);
  assert(diagnostic.state=="authenticated");
  event.disconnect.remote_bda[0]=1;
  component.gattc_event_handler(ESP_GATTC_DISCONNECT_EVT,0,&event);
  assert(diagnostic.state=="authenticated;disconnected:19");
  component.gap_event_handler(ESP_GAP_BLE_AUTH_CMPL_EVT,&auth);
  assert(diagnostic.state=="authenticated;disconnected:19" && requests==2);
}
'''

with tempfile.TemporaryDirectory(prefix='m5go-bond-test-') as directory:
    path = Path(directory)
    (path / 'stub.h').write_text(STUB)
    for name in ['esp_gap_ble_api.h', 'esp_gattc_api.h',
                 'esphome/core/component.h', 'esphome/core/log.h',
                 'esphome/components/text_sensor/text_sensor.h']:
        header = path / name
        header.parent.mkdir(parents=True, exist_ok=True)
        header.write_text('#include "stub.h"\n')
    (path / 'test.cpp').write_text(TEST)
    subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    '-I', str(path), '-I', str(ROOT / 'firmware/m5go/components/known_bond_security'),
                    str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
print('Known-bond security boundary PASS')

"""Compile the real component against fake IDF calls; test its security boundary."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
STUB = r'''
#pragma once
#include <cstdint>
#include <cstring>
using esp_gattc_cb_event_t = int;
using esp_gatt_if_t = int;
constexpr int ESP_GATTC_OPEN_EVT=1, ESP_GATT_OK=0, ESP_OK=0, ESP_BD_ADDR_LEN=6, ESP_BLE_SEC_ENCRYPT=1;
struct esp_ble_bond_dev_t { uint8_t bd_addr[6]; };
struct esp_ble_gattc_cb_param_t { struct { int status; uint8_t remote_bda[6]; } open; };
inline int bond_count=0, list_error=0, requests=0, lists=0;
inline uint8_t saved_address[6]={1,2,3,4,5,6};
inline int esp_ble_get_bond_device_num() { return bond_count; }
inline int esp_ble_get_bond_device_list(int *count, esp_ble_bond_dev_t *out) {
  ++lists;
  if (list_error) return list_error;
  *count=1; std::memcpy(out[0].bd_addr,saved_address,6); return 0;
}
inline int esp_ble_set_encryption(uint8_t *address,int mode) {
  if (std::memcmp(address,saved_address,6) || mode!=ESP_BLE_SEC_ENCRYPT) __builtin_abort();
  ++requests; return 0;
}
namespace esphome { class Component {}; }
#define ESP_LOGW(...) ((void)0)
'''
TEST = r'''
#include <cassert>
#include "known_bond_security.h"
int main() {
  esphome::known_bond_security::KnownBondSecurity component;
  esp_ble_gattc_cb_param_t event{};
  std::memcpy(event.open.remote_bda,saved_address,6);
  auto open=[&]() { component.gattc_event_handler(ESP_GATTC_OPEN_EVT,0,&event); };
  // Never create security state with no bonds, failed reads or another peer.
  open(); assert(requests==0 && lists==0);
  bond_count=-1; open(); assert(requests==0 && lists==0);
  bond_count=33; open(); assert(requests==0 && lists==0);
  bond_count=1; list_error=1; open(); assert(requests==0);
  list_error=0; event.open.remote_bda[0]=7; open(); assert(requests==0);
  event.open.remote_bda[0]=1;
  event.open.status=5; open(); assert(requests==0);
  event.open.status=0; component.gattc_event_handler(9,0,&event); assert(requests==0);
  // A valid connection to the stored peer makes exactly one encryption request.
  open(); assert(requests==1);
}
'''

with tempfile.TemporaryDirectory(prefix='m5go-bond-test-') as directory:
    path = Path(directory)
    (path / 'stub.h').write_text(STUB)
    for name in ['esp_gap_ble_api.h', 'esp_gattc_api.h',
                 'esphome/core/component.h', 'esphome/core/log.h']:
        header = path / name
        header.parent.mkdir(parents=True, exist_ok=True)
        header.write_text('#include "stub.h"\n')
    (path / 'test.cpp').write_text(TEST)
    subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    '-I', str(path), '-I', str(ROOT / 'firmware/m5go/components/known_bond_security'),
                    str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
print('Known-bond security boundary PASS')

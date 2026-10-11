"""Verify the actual link wrapper, unchanged forwarding and bounded SPSC metadata."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
COMPONENT = ROOT / 'firmware/m5go/components/known_bond_security'
DRIVER = r'''
#include <cassert>
#include <atomic>
#include <thread>
#include "controller_status.h"
using namespace esphome::known_bond_security::controller_status;
extern "C" void btm_sec_encrypt_change(uint16_t,uint8_t,uint8_t);
extern int calls;
extern uint16_t last_handle;
extern uint8_t last_status,last_enabled;
int main() {
 Event event{};
 btm_sec_encrypt_change(123,6,0);
 assert(calls==1 && last_handle==123 && last_status==6 && last_enabled==0);
 assert(!pop(event));
 begin(7);btm_sec_encrypt_change(456,5,1);
 assert(calls==2 && last_handle==456 && last_status==5 && last_enabled==1);
 assert(pop(event) && event.sequence==7 && event.at==100 && event.status==5 && event.enabled==1);
 assert(!pop(event));
 for(int i=0;i<10;++i) btm_sec_encrypt_change(i,i,0);
 assert(calls==12 && lost==2);
 for(int i=0;i<8;++i) { assert(pop(event));assert(event.status==i && event.sequence==7); }
 assert(!pop(event));end();btm_sec_encrypt_change(65535,255,255);
 assert(calls==13 && last_handle==65535 && last_status==255 && last_enabled==255 && !pop(event));
 // Wraparound must not corrupt full/empty accounting.
 written=0xfffffffc;read=0xfffffffc;begin(8);
 for(int i=0;i<8;++i) capture(i,i,1);
 for(int i=0;i<8;++i) {assert(pop(event));assert(event.at==static_cast<unsigned>(i));}
 assert(!pop(event));
 // The observer cannot stall the producer; every lost event is accounted for.
 written=0;read=0;lost=0;begin(9);
 constexpr uint32_t count=100000;
 std::atomic<bool> finished{false};
 std::thread producer([&]() {
  for(uint32_t i=0;i<count;++i) capture(i,i%255,i%2);
  finished.store(true,std::memory_order_release);
 });
 uint32_t received=0;
 do {
  while(pop(event)) {
   assert(event.sequence==9 && event.status==event.at%255 && event.enabled==event.at%2);
   ++received;
  }
 } while(!finished.load(std::memory_order_acquire) || read.load()!=written.load());
 producer.join();assert(received+lost.load()==count);end();
}
'''
REAL = r'''
#include <cstdint>
int calls=0;uint16_t last_handle=0;uint8_t last_status=0,last_enabled=0;
extern "C" void btm_sec_encrypt_change(uint16_t handle,uint8_t status,uint8_t enabled) {
 ++calls;last_handle=handle;last_status=status;last_enabled=enabled;
}
'''
with tempfile.TemporaryDirectory(prefix='m5go-controller-') as directory:
    path = Path(directory)
    (path / 'esphome/core').mkdir(parents=True)
    (path / 'esphome/core/hal.h').write_text('#include <cstdint>\nnamespace esphome { inline uint32_t millis() { return 100; } }\n')
    version = path / 'esp_idf_version.h'
    prefix = '#define ESP_IDF_VERSION_VAL(a,b,c) ((a)*10000+(b)*100+(c))\n'
    version.write_text(prefix + '#define ESP_IDF_VERSION 50505\n')
    (path / 'driver.cpp').write_text(DRIVER)
    (path / 'real.cpp').write_text(REAL)
    args = ['c++','-std=c++17','-O2','-pthread','-Wall','-Wextra','-Werror',
            '-I',str(path),'-I',str(COMPONENT),str(path/'driver.cpp'),str(path/'real.cpp'),
            str(COMPONENT/'controller_status.cpp'),'-Wl,--wrap=btm_sec_encrypt_change','-o',str(path/'test')]
    subprocess.run(args, check=True)
    subprocess.run([str(path/'test')], check=True)
    version.write_text(prefix + '#define ESP_IDF_VERSION 50506\n')
    result = subprocess.run(args, capture_output=True, text=True)
    assert result.returncode != 0 and 'audited ESP-IDF 5.5.5 ABI' in result.stderr
print('Controller observation forwarding, overflow, concurrency and ABI guard PASS')

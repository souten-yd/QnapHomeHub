#pragma once

#include <atomic>
#include <cstdint>

namespace esphome::known_bond_security::controller_status {

// One producer (Bluedroid BTU task), one consumer (ESPHome main loop).
// Neither addresses, handles, keys nor packet contents enter this queue.
struct Event {
  uint32_t sequence;
  uint32_t at;
  uint8_t status;
  uint8_t enabled;
};

inline constexpr uint32_t CAPACITY = 8;
inline Event queue[CAPACITY];
inline std::atomic<uint32_t> active{0}, written{0}, read{0}, lost{0};
static_assert(std::atomic<uint32_t>::is_always_lock_free, "Controller observer must not lock the Bluetooth task");

inline void begin(uint32_t sequence) { active.store(sequence, std::memory_order_release); }
inline void end() { active.store(0, std::memory_order_release); }
inline void capture(uint32_t at, uint8_t status, uint8_t enabled) {
  uint32_t sequence = active.load(std::memory_order_acquire);
  if (sequence == 0) return;
  uint32_t write = written.load(std::memory_order_relaxed);
  if (write - read.load(std::memory_order_acquire) >= CAPACITY) {
    lost.fetch_add(1, std::memory_order_relaxed);
    return;
  }
  queue[write % CAPACITY] = {sequence, at, status, enabled};
  written.store(write + 1, std::memory_order_release);
}
inline bool pop(Event &event) {
  uint32_t index = read.load(std::memory_order_relaxed);
  if (index == written.load(std::memory_order_acquire)) return false;
  event = queue[index % CAPACITY];
  read.store(index + 1, std::memory_order_release);
  return true;
}

}  // namespace esphome::known_bond_security::controller_status

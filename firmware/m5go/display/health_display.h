#pragma once
#include <array>
#include <cmath>
#include <string>
#include <vector>
#include "esphome/components/display/display.h"
#include "esphome/components/font/font.h"
#include "esphome/components/json/json_util.h"
#include "esphome/core/helpers.h"

namespace health_display {
struct Profile {
  std::string label, measured;
  float weight=NAN, fat=NAN, delta=NAN;
  std::array<std::string, 7> days;
  std::array<float, 7> weights{}, fats{};
};

class Dashboard {
 public:
  bool accept(const std::string &payload) {
    if (payload.size() > 4096) return false;
    std::vector<Profile> next;
    int active=-1;
    bool valid = esphome::json::parse_json(payload, [&](JsonObject root) -> bool {
      if (!root["schema"].is<int>() || root["schema"].as<int>() != 1 || !root["profiles"].is<JsonArray>()) return false;
      auto rows = root["profiles"].as<JsonArray>();
      if (rows.size() < 1 || rows.size() > 4) return false;
      if (root.containsKey("active_profile")) {
        if (!root["active_profile"].is<int>()) return false;
        active=root["active_profile"].as<int>();
        if (active < 0 || active >= static_cast<int>(rows.size())) return false;
      }
      for (JsonObject row : rows) {
        Profile p;
        if (!text(row["label"], p.label, 16, false) || !text(row["measured"], p.measured, 16, true)) return false;
        for (char c : p.label) if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == ' ' || c == '.' || c == '_' || c == '-')) return false;
        if (!p.measured.empty() && p.measured.size() != 16) return false;
        if (!number(row["weight"], p.weight, 1, 400) || !number(row["fat"], p.fat, 0, 100) ||
            !number(row["delta"], p.delta, -399, 399)) return false;
        for (auto key : {"weight", "fat", "delta", "days", "weights", "fats"})
          if (!row.containsKey(key)) return false;
        if (!row["days"].is<JsonArray>() || !row["weights"].is<JsonArray>() || !row["fats"].is<JsonArray>() ||
            row["days"].size() != 7 || row["weights"].size() != 7 || row["fats"].size() != 7) return false;
        for (int i=0; i<7; i++) {
          if (!text(row["days"][i], p.days[i], 5, false) || p.days[i].size() != 5 ||
              !number(row["weights"][i], p.weights[i], 1, 400) || !number(row["fats"][i], p.fats[i], 0, 100)) return false;
        }
        next.push_back(p);
      }
      return true;
    });
    if (!valid) return false; // Atomic: malformed input never replaces the last good display.
    profiles_ = std::move(next);
    if (active >= 0) selected_=active;
    received_=active >= 0;
    if (selected_ >= profiles_.size()) selected_=0;
    updated_ = esphome::millis();
    return true;
  }
  void latest() { page_=0; }
  void graph() { page_=page_ == 1 ? 2 : 1; }
  void next_user() { if (!profiles_.empty()) selected_=(selected_+1)%profiles_.size(); }

  void draw(esphome::display::Display &d, esphome::font::Font *small,
            esphome::font::Font *medium, esphome::font::Font *large) {
    const esphome::Color white(230,237,242), gray(135,151,163), cyan(70,215,204), amber(255,194,95);
    d.fill(esphome::Color(10,18,25));
    if (profiles_.empty()) {
      d.print(16,65,medium,white,"測定結果の受信待ち");
      d.print(16,102,small,gray,"QNAPの保存済みデータを表示");
      return;
    }
    auto &p=profiles_[selected_];
    bool stale = static_cast<uint32_t>(esphome::millis()-updated_) > 25UL * 60 * 60 * 1000;
    d.print(12,6,small,cyan,p.label.c_str());
    d.print(238,6,small,stale ? amber : gray,stale ? "更新停止" : (received_ ? "最新結果" : "保存履歴"));
    d.print(12,28,small,gray,p.measured.empty() ? "測定なし" : p.measured.c_str());
    if (page_ == 0) {
      d.print(12,56,small,gray,"体重 kg");
      d.print(190,56,small,gray,"体脂肪率 %");
      if (std::isfinite(p.weight)) d.printf(12,76,large,white,"%.2f",p.weight);
      else d.print(12,76,large,white,"--");
      if (std::isfinite(p.fat)) d.printf(190,82,medium,white,"%.1f",p.fat);
      else d.print(190,82,medium,white,"--");
      if (std::isfinite(p.delta)) d.printf(12,128,small,white,"前回比  %+.2f kg",p.delta);
      else d.print(12,128,small,gray,"前回比  --");
      stats(d,small,p.weights,"kg",157,white,gray);
    } else {
      bool fat=page_ == 2;
      auto &values=fat ? p.fats : p.weights;
      d.print(190,28,small,cyan,fat ? "体脂肪率 %" : "体重 kg");
      float lo=INFINITY, hi=-INFINITY;
      int count=0;
      for (float v : values) if (std::isfinite(v)) { lo=std::min(lo,v); hi=std::max(hi,v); count++; }
      if (!count) d.print(65,103,medium,gray,"7日間の測定なし");
      else {
        float pad=std::max(0.2f,(hi-lo)*0.15f); lo-=pad; hi+=pad;
        d.printf(4,53,small,gray,"%.1f",hi);
        d.printf(4,150,small,gray,"%.1f",lo);
        d.line(55,61,55,161,gray); d.line(55,161,302,161,gray);
        int last_y=0; bool previous=false;
        for (int i=0; i<7; i++) {
          if (!std::isfinite(values[i])) { previous=false; continue; }
          int x=58+i*40, y=161-static_cast<int>((values[i]-lo)/(hi-lo)*100);
          if (previous) d.line(x-40,last_y,x,y,cyan);
          d.filled_circle(x,y,3,cyan); previous=true; last_y=y;
        }
      }
      d.print(55,165,small,gray,p.days[0].c_str());
      d.print(259,165,small,gray,p.days[6].c_str());
      stats(d,small,values,fat ? "pt" : "kg",188,white,gray);
    }
    d.line(0,215,319,215,gray);
    d.print(16,219,small,gray,"A 最新");
    d.print(111,219,small,gray,"B 7日間");
    d.print(222,219,small,gray,"C 利用者");
  }
 private:
  static bool text(JsonVariant v, std::string &out, size_t max, bool empty) {
    if (!v.is<const char *>()) return false;
    out=v.as<const char *>();
    return out.size() <= max && (empty || !out.empty());
  }
  static bool number(JsonVariant v, float &out, float lo, float hi) {
    if (v.isNull()) { out=NAN; return true; }
    if (v.is<bool>() || !v.is<float>()) return false;
    out=v.as<float>(); return std::isfinite(out) && out >= lo && out <= hi;
  }
  static void stats(esphome::display::Display &d, esphome::font::Font *font,
                    const std::array<float,7> &values, const char *unit, int y,
                    esphome::Color white, esphome::Color gray) {
    float first=NAN,last=NAN,sum=0; int n=0;
    for (float v : values) if (std::isfinite(v)) { if (!n) first=v; last=v; sum+=v; n++; }
    if (!n) { d.print(12,y,font,gray,"7日間の記録なし"); return; }
    if (n >= 2) d.printf(12,y,font,white,"7日間差 %+.2f %s",last-first,unit);
    else d.print(12,y,font,gray,"7日間差 --");
    // Daily-last means; do not imply a 7-day average when days are missing.
    d.printf(182,y,font,gray,"平均 %.1f (%d日)",sum/n,n);
  }
  std::vector<Profile> profiles_;
  size_t selected_=0;
  int page_=0;
  uint32_t updated_=0;
  bool received_=false;
};
inline Dashboard dashboard;
}  // namespace health_display

"""Exercise the real firmware parser/renderer with ArduinoJson and a recording LCD.

Optionally render synthetic-data previews using Pillow; never read health data.
"""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
STUB = r'''
#pragma once
#include <ArduinoJson.h>
#include <cstdarg>
#include <cstdio>
#include <functional>
#include <string>
namespace esphome {
inline uint32_t clock_ms=1;
inline uint32_t millis() { return clock_ms; }
struct Color { int r,g,b; Color(int r,int g,int b):r(r),g(g),b(b) {} };
namespace font { struct Font { int size; }; }
namespace json {
inline bool parse_json(const std::string &s, const std::function<bool(JsonObject)> &f) {
  JsonDocument doc; if (deserializeJson(doc,s)) return false;
  if (!doc.is<JsonObject>()) return false;
  return f(doc.as<JsonObject>());
}}
namespace display {
struct Display {
  JsonDocument log;
  Display() { log.to<JsonArray>(); }
  void fill(Color c) { log.to<JsonArray>(); auto a=log.as<JsonArray>().add<JsonArray>(); a.add("fill"); a.add(c.r); a.add(c.g); a.add(c.b); }
  void print(int x,int y,font::Font *f,Color c,const char *s) {
    auto a=log.as<JsonArray>().add<JsonArray>(); a.add("text"); a.add(x);a.add(y);a.add(f->size);a.add(c.r);a.add(c.g);a.add(c.b);a.add(std::string(s));
  }
  void printf(int x,int y,font::Font *f,Color c,const char *fmt,...) {
    char buf[256]; va_list args; va_start(args,fmt); vsnprintf(buf,sizeof(buf),fmt,args);va_end(args); print(x,y,f,c,buf);
  }
  void line(int x,int y,int xx,int yy,Color c) {
    auto a=log.as<JsonArray>().add<JsonArray>(); a.add("line");a.add(x);a.add(y);a.add(xx);a.add(yy);a.add(c.r);a.add(c.g);a.add(c.b);
  }
  void filled_circle(int x,int y,int radius,Color c) {
    auto a=log.as<JsonArray>().add<JsonArray>(); a.add("circle");a.add(x);a.add(y);a.add(radius);a.add(c.r);a.add(c.g);a.add(c.b);
  }
};
}}
'''

TEST = r'''
#include <cassert>
#include <iostream>
#include "health_display.h"
int main() {
  std::string input; std::getline(std::cin,input);
  JsonDocument doc; assert(!deserializeJson(doc,input));
  auto &dashboard=health_display::dashboard;
  esphome::display::Display lcd;
  esphome::font::Font small{14},medium{22},large{38};
  auto draw=[&]() { dashboard.draw(lcd,&small,&medium,&large); std::string s; serializeJson(lcd.log,s);return s; };
  assert(draw().find("受信待ち") != std::string::npos);
  assert(dashboard.accept(input));
  auto original=draw();
  assert(original.find("68.40") != std::string::npos);
  for (std::string bad : std::vector<std::string>{"{}", "[]", "null", "{broken", std::string(4097,'x')}) {
    assert(!dashboard.accept(bad)); assert(draw()==original);
  }
  for (int i=0;i<6;i++) {
    JsonDocument bad; bad.set(doc);
    if(i==0) bad["profiles"][0]["weight"]=true;
    if(i==1) bad["profiles"][0].remove("fat");
    if(i==2) bad["profiles"][0]["weights"].as<JsonArray>().remove(0);
    if(i==3) bad["profiles"][0]["weight"]=401;
    if(i==4) bad["profiles"][0]["label"]="too long for a profile label";
    if(i==5) bad["profiles"]=nullptr;
    std::string s; serializeJson(bad,s);assert(!dashboard.accept(s));assert(draw()==original);
  }
  std::cout<<original<<"\n";
  dashboard.graph(); auto graph=draw();
  int points=0,joins=0;
  for(JsonArray op:lcd.log.as<JsonArray>()) {
    if(op[0]=="circle") points++;
    if(op[0]=="line" && op[5]==70) joins++;
  }
  assert(points==5 && joins==2); // No lines bridging missing days.
  std::cout<<graph<<"\n";
  dashboard.graph();std::cout<<draw()<<"\n";
  dashboard.next_user();assert(draw().find("USER 2") != std::string::npos);
  dashboard.next_user();assert(draw().find("USER 1") != std::string::npos);
  esphome::clock_ms=180002;assert(draw().find("更新停止") == std::string::npos);
  esphome::clock_ms=24UL*3600000+1;assert(draw().find("更新停止") == std::string::npos);
  esphome::clock_ms=25UL*3600000+2;assert(draw().find("更新停止") != std::string::npos);
  assert(dashboard.accept(input));assert(draw().find("更新停止") == std::string::npos);
  esphome::clock_ms=0xfffffff0;assert(dashboard.accept(input));
  esphome::clock_ms=20;assert(draw().find("更新停止") == std::string::npos);
  doc["profiles"][0]["weights"][0]=nullptr;
  doc["profiles"][0]["weights"][1]=nullptr;
  for(int i=2;i<7;i++) doc["profiles"][0]["weights"][i]=nullptr;
  std::string empty;serializeJson(doc,empty);assert(dashboard.accept(empty));
  dashboard.latest();dashboard.graph();assert(draw().find("7日間の測定なし") != std::string::npos);
}
'''


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--arduinojson', required=True, help='ArduinoJson 7.4.3 src directory from ESPHome build')
    parser.add_argument('--preview-dir')
    args=parser.parse_args()
    profile={'label':'USER 1','measured':'2026/10/12 08:15','weight':68.4,'fat':23.1,'delta':-0.2,
             'days':['10/06','10/07','10/08','10/09','10/10','10/11','10/12'],
             'weights':[69.0,68.8,None,68.7,None,68.6,68.4],
             'fats':[23.8,23.6,None,23.5,None,23.2,23.1]}
    with tempfile.TemporaryDirectory() as temp:
        work=Path(temp)
        (work/'stub.h').write_text(STUB)
        for header in ('components/display/display.h','components/font/font.h','components/json/json_util.h','core/helpers.h'):
            path=work/'esphome'/header;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('#include "stub.h"\n')
        (work/'test.cpp').write_text(TEST)
        subprocess.run(['g++','-std=c++17','-Wno-deprecated-declarations','-I',str(work),'-I',args.arduinojson,
                        '-I',str(ROOT/'firmware/m5go/display'),str(work/'test.cpp'),'-o',str(work/'test')],check=True)
        result=subprocess.run([str(work/'test')],input=json.dumps({'schema':1,'profiles':[profile,profile|{'label':'USER 2'}]}),
                              text=True,capture_output=True,check=True)
    frames=[json.loads(line) for line in result.stdout.splitlines()]
    if args.preview_dir:
        from PIL import Image, ImageDraw, ImageFont
        out=Path(args.preview_dir);out.mkdir(parents=True,exist_ok=True)
        fontfile=str(ROOT/'firmware/m5go/display/HealthDisplaySubset.otf')
        for name,ops in zip(('latest','weight-week','fat-week'),frames):
            image=Image.new('RGB',(320,240));draw=ImageDraw.Draw(image)
            for op in ops:
                if op[0]=='fill': draw.rectangle((0,0,319,239),fill=tuple(op[1:]))
                elif op[0]=='text':
                    _,x,y,size,r,g,b,text=op
                    font=ImageFont.truetype(fontfile,size)
                    # ESPHome's TOP_LEFT uses the font's complete line ascent.
                    draw.text((x,y),text,font=font,fill=(r,g,b),anchor='lt')
                    assert x+draw.textlength(text,font=font)<=320, (name,text,'horizontal overflow')
                elif op[0]=='line': draw.line(tuple(op[1:5]),fill=tuple(op[5:]),width=1)
                elif op[0]=='circle':
                    _,x,y,radius,*color=op;draw.ellipse((x-radius,y-radius,x+radius,y+radius),fill=tuple(color))
            image.save(out/(name+'.png'))
    print('display parser, atomic validation, gaps, navigation and stale state: PASS')


if __name__=='__main__': main()

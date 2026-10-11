# M5GO初代 — 体組成計用の近距離BLE/Wi-Fiプロキシ（段階導入）

## 適用範囲と現在の状態

対象は初代M5GO / M5Stack Core ESP32。旧ファームウェアの上書きを許可された場合にのみUSB書き込みを行います。
本リポジトリの `firmware/m5go/ble-proxy.yaml` はESPHomeの **active Bluetooth proxy** です。
画面・内蔵ボタンは使わずBLE中継専用とします（画面が表示されなくても異常ではありません）。
常時運用ではUSB給電が必要です。2.4GHz Wi-Fiが必要で、5GHz専用SSIDは使えません。

**第1段階** はファームウェアと読み取り専用のBLE経路診断です。
**現行HomeHub/SelfCareの通常同期は引き続きUSBドングル経由**で動きます。
この段階ではM5GOによる測定履歴の自動同期・ペアリング・認証は実装していません。
HBF-228TがM5GOを通じて広告・GATTに到達できることを確認した後、専用の後続PRで
既存Omron `Session` と連携する遠隔BLE経路、watch、手動同期、切り戻し機能を追加します。
実機未確認の経路へ自動的に切り替えないでください。

ESPHome Bluetooth Proxy: https://esphome.io/components/bluetooth_proxy/
Python client: https://bleak-esphome.readthedocs.io/en/latest/usage.html
M5GO仕様: https://docs.m5stack.com/ja/core/m5go
M5Stack Core ESP32ボード: https://docs.platformio.org/en/stable/boards/espressif32/m5stack-core-esp32.html

## USB初回書き込み

初回書き込みはM5GOをUSBで接続できるPCで行います。インストール済みの旧ソフトウェアは上書きされます。
1. `firmware/m5go/secrets.example.yaml` を同じフォルダの `secrets.yaml` にコピー（gitignore対象）。
2. `wifi_ssid` と `wifi_password` を2.4GHz Wi-Fiの設定に置き換えます。
3. `api_encryption_key` に32ランダムバイトのbase64文字列を入力します。生成例:
   `python -c "import secrets,base64;print(base64.b64encode(secrets.token_bytes(32)).decode())"`
4. Linux PC等で `python3 -m venv .venv-m5go`、`.venv-m5go/bin/pip install -r firmware/m5go/requirements.txt` を実行して ESPHome 2026.9.1 を導入します。仮想環境を有効化し、`esphome config firmware/m5go/ble-proxy.yaml` で検証。
5. USBシリアル接続先を指定し `esphome run firmware/m5go/ble-proxy.yaml --device /dev/ttyUSB0` で書き込み。
   USBポート名は実機に合わせること。Windowsから操作する場合は対応するCOMポートを指定。
6. シリアルログ/ルーターで `qnap-m5go-proxy` のLAN IPを確認する。
   Wi-Fi/LANアクセス不可ならUSBで再書き込み。データ消去やQNAP設定変更は不要。

ESPHomeの初回インストールにはESP-IDFツールチェーンとUSBシリアルアクセスが必要です。
作業PCがWindowsでコンパイルに失敗する場合はLinux環境でビルドしたfactory imageを
https://web.esphome.io/ からUSB書き込みする方法もあります。
API暗号鍵はQNAPとM5GOの間で一致させます。秘密鍵とWi-Fiパスワード、個人健康記録はGitHubへコミットしないでください。

## QNAP上の非侵襲的通信チェック（M5GOが書き込み・起動済みの場合のみ）

HomeHubの新しいDocker `radio` コンテナには、従来のBleak 0.22を触らずに
別の仮想環境 `/opt/ble-proxy` に `bleak-esphome==4.1.0` が入ります。
既存のBlueZ、USBのOmron同期、SwitchBot処理と分離しています。
M5GOのLANアドレスとHBF-228TのMACを確認した上で、次の診断を1回実行できます:

```sh
# 管理者SSH。鍵をシェル履歴やGitリポジトリへ直接書かない。
# API鍵はQNAP側で秘密として取り扱い、例では入力プロンプトから渡す。
read -r -s -p "ESPHome API key: " HOMEHUB_M5GO_NOISE_PSK; echo
export HOMEHUB_M5GO_NOISE_PSK
docker exec -e HOMEHUB_M5GO_NOISE_PSK="$HOMEHUB_M5GO_NOISE_PSK" qnaphomehub-radio \
  /opt/ble-proxy/bin/python /app/ble/esp_proxy_probe.py \
  --host 192.168.1.28 --target AA:BB:CC:11:22:33 --scan-seconds 15
unset HOMEHUB_M5GO_NOISE_PSK
```

ホストIP/MACは例です。まず `api_connected` と `advertisement_seen` を確認し、
測定器のBluetoothボタンを短く押して広告が届くか調べます。
広告が届いたら必要に応じ `--connect` を追加し、Omron GATTサービスが見えるか確認します。
`--connect` も読み取り専用で、ペアリング/キー送信/測定履歴読取/EEPROM書込みは一切しません。

- `api_connected=false`: M5GO側のWi-Fi、IP、API暗号鍵、TCP 6053を確認。
- `advertisement_seen=false`: M5GOと体組成計の距離・通信モード・BLE広告を確認。
- `gatt_connected=false`: BLE接続状態、OS bonding要件、ESPHome connection slot、再試行タイミングを確認。
- `omron_service_found=false`: 機種・アドレス・GATTサービス互換性を再確認。

実機確認が済むまでBluetooth経路・ペアリング情報・USBドングルの設定は変更しません。
低ディスクI/O対策（QTSホスト側BlueZの二重起動抑制）も維持してください。

## 次PRへの合格条件

1. 遠隔ESPHome APIの認証・BLE広告検出・GATTサービス確認が成功する。
2. HBF-228Tのユーザースロットと既存のペアリングキーで遠隔認証できるか非破壊で検証する。
3. HomeHubだけを変更して既存SelfCare Unix socket `/run` と `/watch` を維持する。
4. USB/遠隔経路は明示切替とし、遠隔失敗時に無制限再試行や自動再ペアリングをしない。
5. 血圧計・SwitchBot・QNAPの低I/O・既存データを保護する。


## ファームウェアのビルド・OTA・診断（2026.9.1）

公式の [BLE設定](https://esphome.io/components/esp32_ble/) と
[Bluetooth Proxy](https://esphome.io/components/bluetooth_proxy/) に合わせ、ESP-IDF、
BLE接続1枠、継続スキャン、Wi-Fi省電力無効で構成しています。
Wi-Fi切断時は再接続し、15分復旧しなければESP32を再起動します。
QNAP APIクライアントが不在の場合は再起動せず、OTAを受け付けます。
LCD、LED、Webサーバー、Home Assistantは不要です。
Native APIでWi-Fi RSSI、uptime、free heap、API接続状態、IPを取得できます。
診断センサーは60秒周期です。センサーを有効にしただけではQNAPディスクにログを保存しません。
Wi-Fi/API設定はファームウェアに保持され、通常の電源再投入で消えません。

ローカル検証（ダミー資格情報のみ、実機へ書き込まない）:

```sh
. .venv-m5go/bin/activate
sh scripts/check-m5go-firmware.sh --compile
```

このスクリプトと専用CIは一時ディレクトリでコンパイルし、生成物を削除します。
実運用の `secrets.yaml` は読みません。CIからバイナリを公開しません。
`firmware/` はDockerビルドコンテキストからも除外しています。

実運用ビルドと初回USB書込み（ポートが対象M5GOであることを確認）:

```sh
chmod 600 firmware/m5go/secrets.yaml
esphome config firmware/m5go/ble-proxy.yaml
esphome compile firmware/m5go/ble-proxy.yaml
esphome upload firmware/m5go/ble-proxy.yaml --device /dev/ttyUSB0
```

**実運用バイナリにはWi-FiパスワードとAPI鍵が含まれます。** `.esphome/` の生成物、
factory/OTAイメージをGitHub Release、Issue、CI artifact等にアップロードしないでください。
設定検証の出力も秘密として扱い、ログを公開しないでください。

OTA更新は同じ設定・鍵を維持してビルドした後、次を実行します:

```sh
esphome upload firmware/m5go/ble-proxy.yaml --device 192.168.1.28
```

ESPHome 2026.9.1の暗号化OTAを必須とし、API鍵で認証します。
古いアップローダーでは更新できません。API鍵変更時やWi-Fiが復旧しない場合はUSBから
再書込みします。全消去（erase-flash）はBLE bondも失うため通常復旧では実行しません。
USB電源を安定させ、OTA中は電源を抜かないでください。

## BLE bondingとOmron認証の区別

[bleak-esphomeの機能フラグ](https://bleak-esphome.readthedocs.io/en/latest/usage.html)では
`pair()` に `PAIRING` が必要です。ESPHome 2026.9.1のESP32/Bluedroid実装には対応があります。
ただし、**BlueZのbondとM5GOのbondは別物**で、BlueZのペアリングファイルをそのまま
転用する仕組みはありません。Omronアプリケーションの16バイト認証キーとも別です。
既存キーでのunlockは再利用できますが、異なるBLE centralをHBF-228Tが許容するかは実機検証が必要です。
`PAIRING`の存在、GATT接続成功、アプリ認証成功、履歴返却成功を個別に確認します。
自動的なbond削除、Omronキー再発行、測定EEPROM書込みは行いません。
現段階の診断ツールはbondを作成しません。

## 実機受入（未実施）

ビルド成功だけでは同期成功にしません。次を通常の設置場所で記録する必要があります。

- Wi-Fi断・API断後の再接続、電源再投入後の設定維持、OTA後の起動。
- 測定後の広告・RSSI、GATT通知購読、既存キー認証、全対象ユーザーの履歴取得。
- Docker再起動後の広告待受復帰とSelfCareへの新規測定の自動保存。
- USBへの切り戻し、HEM-6232T、SwitchBotの正常動作。

遠隔同期経路とWeb設定は後続PRで追加予定です。


## 遠隔GATTワーカー（0.3.21、Web/自動経路の接続は後続PR）

`server/ble/esp_proxy_worker.py` は `/opt/ble-proxy` 専用です。
Native API接続と広告購読を行い、GATTには `bleak-esphome==4.1.0` の明示バックエンドを
使います。HAの汎用Bluetoothマネージャーを起動せず、ローカルHCIへフォールバックしません。
既存 `ble_worker.Session` と `sync_session` を使い、通知購読、既存キーunlock、通信開始、
指定ユーザースロットの履歴読取、通信終了を実行します。USBワーカーも同じ履歴関数を使います。

ワーカーの `sync` はHBF-228Tのみ。`pair`（Omronキー書込み）は受け付けません。
明示的な `bond` はESPHomeのPAIRING能力を確認したうえでBLEリンク暗号化を要求します。
既存のBlueZ bondやOmronキーは削除・変更しません。末端機器が別centralとのbondを
許容することは未検証のため、運用でのbond実行前に実機を操作できる状態で確認します。
自動同期ではbondを作成しません。GATT診断もbond/キーを書き込みません。

1要求は最大180秒、API接続20秒、GATT接続20秒、履歴要求は既存の有限タイムアウトを使います。
API切断時は接続枠とクライアントを無効化し、終了時に通知とAPIを解放します。
USBと共通のプロセスロックを取り、単独診断も同時GATT接続を避けます。
watch広告はUSBと同じfingerprint/advertisement形式で5秒に1回まで返し、健康記録は読みません。

検証: 模擬HBFのGATT通知から実際の認証・履歴デコードを通し、ユーザー1/4の測定値と
USBの返却結果一致を確認。接続/通知/認証/履歴/チェックサム異常、cancel、API断、PAIRING欠落を
検査します。Docker CIは実依存ライブラリのバックエンド生成とAPI解放のテストも実行します。
**これらはモック/契約テストであり、実機の無線・認証・同期成功を示しません。**

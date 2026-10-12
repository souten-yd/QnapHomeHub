# M5GOとUSBの登録処理の比較評価

2026-10-12。対象はHomeHub v0.3.29（main `f80421f`）、M5GO実験firmware `02f85bf`、ESPHome 2026.9.1 / ESP-IDF 5.5.5。実機の最新結果は[受入記録](M5GO-ACCEPTANCE.md)を参照。

## v0.3.30の実装への更新

比較後、ユーザーの「進めて」を受け、USBの基底 `Session` を使う1回限りのアプリ登録をPR #43で実装し、main `a5728ae`へ統合した。[実装・操作・SelfCareとの契約](M5GO-APPLICATION-REGISTRATION.md)を参照。既存キーの値を使用し、登録と履歴同期の結果を分離する。47件のPython試験・38件のTypeScript試験・PR/main CI・Docker公開が成功。実機の登録保持とUSB共存は未検証。以下の比較表・未実装という記述はv0.3.29時点の評価である。

## 結論

**USBと同じOmron登録処理をM5GOで実行する実装は可能。ただし現状は同等ではなく、同じ登録を行って既存USB接続も保持できるかは未検証。**

USB登録の `Session.pair()` はOmronキー登録と通信開始・終了を行う。M5GOの `client.pair()` はBLE暗号化・pairingの要求であり、同名でも役割が異なる。M5GOの「登録付き同期」も既存キーの認証opcode 1を追加しただけで、Omron登録opcode 2/0は実行しない。既存キーを保護するための制約だったが、これをUSBと同等の登録と扱ってはならない。

この差は実装から確認できる。登録の不足がHBF側のbond保持失敗を引き起こすという因果関係は、まだ仮説である。別のキー値が必要なのか、同じ値を接続元ごとに登録すればよいのか、そもそもUSBとM5GOの登録を同時に維持できるのかも未確定。

## 比較表

| 項目 | USB経路 | 現在のM5GO経路 | 評価 |
|---|---|---|---|
| 通信構成 | QNAP Python → Bleak → BlueZ/Linux → USB BT | QNAP Python → bleak-esphome → Native API → ESPHome/Bluedroid → ESP32 BT | GATT処理は共用できる。BlueZ本体の単純移植ではない |
| 入出力能力 | 対象限定agent、`NoInputNoOutput` | ESPHome既定 `io_capability: none` | 同等。PIN入力の有無は今回の差ではない |
| BLE登録呼出し | ワーカーは `connect()` と通知設定を行う。明示 `BleakClient.pair()` は呼ばず、下位層のセキュリティ処理に任せる | 明示登録では通知設定後に `client.pair()`。ESPHome内では `esp_ble_set_encryption(...ESP_BLE_SEC_ENCRYPT)` | API名の一致は手順の一致を意味しない。USBのSMP開始契機・交渉値は未取得 |
| BLE認証要求 | 実機のSMP要求・応答値は未取得 | `auth_req_mode`未指定。使用IDFの既定はSC+MITM+BOND（0x0d） | M5GOが非bond設定という説明は誤り。要求値と交渉成立値は別 |
| BLE鍵交換・保存 | BlueZが自身の登録を保持 | IDF既定の送受信key maskはENC+ID+SIGN（0x07、Classic BT無効）。NVS bond保存有効、最大15件 | 実測のpeer bond mask 3は交渉結果の保存情報。既定mask 7との違いだけで欠陥とは言えない |
| 接続元識別 | USBアダプターのBluetooth識別情報 | M5GOのBluetooth識別情報。ビルドはRPA無効 | MACやBLE鍵を複製して同一機器に見せる案は採用しない。USB側の実際のアドレス種別は未比較 |
| 通知設定 | RX0〜3 → 750 ms → unlock → 750 ms | RX0 → 750 ms → unlock → 750 ms。暗号化後RX1〜3 OFF、認証後unlock OFF・RX1〜3 ON | USBの `Session.subscribe()` を共用可能。ただし全RXを先に有効にしたv0.3.27でもPの `8101` は発生 |
| Omronキーの出所 | SelfCareから要求に含まれるキー | 同じ要求のキーを変更せず使用 | 経路別キー保管なし。BLE bond鍵とは別物 |
| Omron初回登録 | unlock `02 + zeros` → `8200`、`00 + key` → `8000` | 実行禁止。BLEのみ、またはunlock `01 + existing key` → `8100` を期待 | 最も大きい確定差。M5GO専用Omron登録は一度も実行していない |
| 登録の終了 | 1秒待機 → メモリセッション開始opcode 0 → 終了opcode 15 | BLEのみ操作はそのまま切断。登録付き同期は `8101` で開始前に停止 | USB相当の開始・正常終了をM5GOで完了した証拠はない |
| 通常同期 | unlock opcode 1、開始、履歴、終了 | `sync_session()` と解析は共通、通知設定・暗号化ガードは専用 | 最新USBは `8100` で成功。最新M5GOはキー送信前HCI6/GAP97 |

ESPHomeがbondを保存する設定でも、相手機器が次回その鍵を受け入れる保証にはならない。BlueZの `Paired` / `Bonded` も、それぞれ鍵交換完了・永続保存の状態であり、Omronのアプリ登録を表すものではない。

## 実コードのオフライン比較

`python3 scripts/compare-m5go-registration.py` で、実際の `Session` と `esp_proxy_worker.operate()` に既存テストの模擬機器を接続する。固定ダミーキーのみを使用し、ネットワーク・BlueZ・実機・secretsには接続しない。固定待機だけを省略し、フレーム解析は実コードを通す。

| ケース | unlockのopcode列 | メモリコマンド数 | 結果 |
|---|---|---:|---|
| USB登録 | 2, 0 | 2（開始・終了） | 模擬完了 |
| USB通常同期 | 1 | 62 | 模擬完了 |
| M5GO BLEのみ登録 | なし | 0 | 模擬BLE完了 |
| M5GO登録付き同期、認証許可 | 1 | 62 | 模擬完了 |
| M5GO登録付き同期、認証拒否 | 1 | 0 | 停止、新規登録へ移行しない |
| M5GO登録付き同期、暗号化失敗 | なし | 0 | キー未送信で停止 |

6ケースの比較条件・解放確認は成功。62コマンドは模擬データのユーザー2枠での値であり、全構成共通ではない。模擬機器は任意の正しい応答を返すため、登録を受け入れる条件やMACとの紐付け、bond保持、実機の正常動作を証明しない。USBの下位SMP手順も模擬していない。

## USBに合わせる具体案

第一候補は、M5GOの**初回登録専用**の処理で既存USBの `Session` をそのまま使うこと。通常同期への自動フォールバックに混ぜない。

1. HomeHubの排他制御下でHBFの自動同期を停止し、対象機器・期限・1回限りの登録操作を予約する。SelfCareの通常sync要求が渡す既存キーを使用し、新規キーを生成せず、要求側のフラグだけで登録を許可しない。
2. M5GOへ接続し、USBと同じ `Session.subscribe()` で通知を設定。今回の接続のBLE暗号化成功を確認する。暗号化できなければOmron登録へ進まない。保存bondの自動削除はしない。
3. `Session.pair(existing_key, 'HBF-228T')` を使い、`8200` → `8000` → 開始応答 → 終了応答を確認する。HBFでは登録直後のopcode 1を追加せず、USB実装と一致させる。HEM専用の追加認証や他機種のEEPROM書込みは移植しない。
4. 切断後、USB介入なしの通常モードでM5GO再接続・`8100`・履歴取得・終了を確認する。その後USBでも**再登録せず**既存キーの通常同期を確認する。片方だけの成功では互換と判定しない。
5. 両経路の確認後に、M5GO再起動後の復帰・通常設置で新規測定の自動保存へ進む。

現在の `HbfProxySession` は登録opcodeを拒否するので、単に `pair()` を呼び足す変更は動かない。専用操作で基底 `Session` を使い、通常同期の禁止条件を残す設計が必要。既存キーを得るためにSelfCareの「pair」ジョブを呼ぶ方式も採用しない。新規キー生成・保存につながるためである。

この案のコード共用は可能だが、**キーの値が同じでも登録コマンドは体組成計の状態変更**であり、USBの接続元登録を保持するとは保証できない。元の依頼にある「既存Omronキー・USB動作を保護」との関係で、実機実行前に影響範囲を明示した確認が必要。今回の比較依頼を登録上書きの許可とは扱わず、製品コードへの登録経路追加・実機再登録・OTAは行っていない。単に経路をUSBへ戻すことと、体組成計内の登録を復元することは別である。

Bluetooth設定を合わせる案は第二候補。USBで実際に交渉したIO capability、AuthReq、最大鍵長、initiator/responder key distribution、暗号化開始契機を取得してから差分を判断する。現段階で `auth_req_mode: bond` やIRK無効化を追加しても「USBに合わせた」とは言えない。鍵本体を含むHCI/SMPダンプを公開せず、必要なメタデータのみ扱う。

## 根拠

- ローカル実装: [USB Sessionと登録](../server/ble/ble_worker.py)、[M5GO worker](../server/ble/esp_proxy_worker.py)、[経路切替](../server/src/shared-radio.ts)、[firmware設定](../firmware/m5go/ble-proxy.yaml)。
- [ESPHome 2026.9.1 BLEClientBase](https://github.com/esphome/esphome/blob/2026.9.1/esphome/components/esp32_ble_client/ble_client_base.cpp): `pair()` は暗号化要求。
- [ESPHome BLE設定](https://esphome.io/components/esp32_ble/): IO capabilityと任意の認証設定。使用版のローカルソースでも確認。
- [ESP-IDF 5.5.5 security defaults](https://github.com/espressif/esp-idf/blob/v5.5.5/components/bt/host/bluedroid/bta/dm/bta_dm_co.c)、[key mask定義](https://github.com/espressif/esp-idf/blob/v5.5.5/components/bt/host/bluedroid/stack/include/stack/btm_api.h): 使用ビルドのローカルソースとsdkconfigでも照合。
- [BlueZ Agent API](https://bluez.readthedocs.io/en/latest/agent-api/)、[Device API](https://github.com/bluez/bluez/blob/master/doc/org.bluez.Device.rst): agent能力とBLE登録状態の意味。実機のSMP値の代用にはしない。
- [openScale OmronWlcHandler](https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/OmronWlcHandler.kt): HBF-228Tを対象に含むOmron登録・通常認証の実装。別ホストで同じキーを登録してUSBも保持できることの証拠ではない。

状態: **比較・オフライン検証完了。USB同等のM5GO登録経路は未実装・未適用。実機解決は未確認。**

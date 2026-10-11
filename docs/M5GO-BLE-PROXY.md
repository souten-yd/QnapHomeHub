# M5GO初代 — 体組成計用の近距離BLE/Wi-Fiプロキシ（段階導入）

## 適用範囲と現在の状態

対象は初代M5GO / M5Stack Core ESP32。旧ファームウェアの上書きを許可された場合にのみUSB書き込みを行います。
本リポジトリの `firmware/m5go/ble-proxy.yaml` はESPHomeの **active Bluetooth proxy** です。
画面・内蔵ボタンは使わずBLE中継専用とします（画面が表示されなくても異常ではありません）。
常時運用ではUSB給電が必要です。2.4GHz Wi-Fiが必要で、5GHz専用SSIDは使えません。

v0.3.22では既存Omron認証・履歴読取を再利用する遠隔GATTワーカー、広告待受、
Unixソケットの経路選択、Web管理を実装しています。**初期経路はUSB**です。
管理画面で対象HBF-228Tを指定して切り替えた場合のみM5GOを使います。
**実機の自動保存は未検証**です。モック/CI成功と実機同期成功は分けて扱います。
最新の検証状況は [受入記録](M5GO-ACCEPTANCE.md) を参照してください。

**運用にはv0.3.23以降を使用してください。** v0.3.22の広告購読は旧形式のみで、
ESPHome 2026.9.1のRAW広告を受信できませんでした。v0.3.23は機能フラグに応じて
RAW形式を購読・解析し、既存の広告／GATT処理へ渡します。

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

## 運用受入条件

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

遠隔同期経路とWeb設定は0.3.22で追加しています。通常設置での実機受入は未実施です。


## 遠隔GATTワーカー（0.3.21以降）

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


## QNAPのWeb設定（0.3.23以降）

1. HomeHubの通常更新で `homehub` / `radio` を0.3.23以降へ更新し、管理画面にログインします。
   管理パスワード未設定ではM5GO設定APIを利用できません。
2. 「M5GO Bluetooth Proxy」でLAN IP/ホスト名、ファームウェアと一致するNative API鍵、
   SelfCareに登録済みのHBF-228T MACを入力します。同期経路はまず **USB** のまま保存します。
   API鍵はブラウザーから送信後に入力欄を消し、API応答/診断ログには返しません。
   信頼できるLANまたはTLSリバースプロキシ経由で設定してください。
3. 「API / 広告を検査」を押し、測定器のBluetoothボタンを短く押して広告を出します。
   RSSIと広告検出を確認します。「GATT接続を検査」でOmronサービスを確認します。
   この診断は履歴の読取やbondの作成をしません。
4. SelfCareでHBF-228Tの既存ペアリングキー・対象ユーザー・自動同期が設定済みであることを確認します。
   HomeHubで「HBF-228Tの同期経路」を **M5GO** に変更して保存します。
   HEM-6232TとSwitchBot、他MACの機器はUSBを使い続けます。
5. 通常の設置場所で新しく測定します。HomeHubの最終同期結果（返却件数）と、
   **SelfCareの対象ユーザーに新しい測定日時/値が保存されたこと**を確認します。
   HomeHubの「返却」はSelfCareのDB保存完了を意味しません。

SelfCareのHBF待受には、最後の待受同期成功から1時間は次の広告を同期対象にしない既存制限があります。
移行直前にUSBで待受同期が成功していた場合も適用されます。受入測定はこの間隔の後に行ってください。
SelfCareの設定は通信経路 `homehub`、自動同期ON、同期モード「待ち受け」を使用します。
これは既存 `collectors.py` の契約を読み取り確認したもので、SelfCareコードやDBは変更していません。

設定は `data/radio/m5go.json`（0600）に保存され、コンテナ再起動後も維持します。
このファイルにはAPI鍵が含まれるため、公開・Git管理しないでください。
最終同期結果と診断はRAM内です。再起動すると表示はリセットされ、継続的なHDD書込みを増やしません。
M5GO診断表示は約60秒間隔のセンサー値なので、接続直後は空欄の場合があります。

### 接続断と切り戻し

API断では未接続/エラーを表示します。広告/API待受だけを間隔を空けて再接続し、
認証や履歴取得をタイマーで再試行しません。SelfCareからの次の要求を待ちます。
`/watch` のアドレス、fingerprint、RSSI、広告形式と `/run` の records/invalid_records/diagnostic は維持します。
M5GO経路への切替中もSelfCareは従来どおり同じHCIアダプター番号を指定してください。
HomeHub内部でMACと機種に応じて経路を選択します。

- API未接続: 2.4GHz Wi-Fi、LAN到達性、TCP 6053、鍵の一致、M5GO電源を確認。
- 広告なし: 対象MAC、距離、機器の通信モードを確認。API診断だけでは広告検出を保証しません。
- GATT失敗: 同じ機器に接続中のスマートフォン等を確認。診断中は他のESPHomeクライアントを接続しないでください。
- 通知/認証失敗: Omron既存キーの一致とBLEリンクの暗号化要件を切り分けます。
  管理画面の「BLE bondingの診断」から、対象確認をチェックした場合のみBLE bondを作成できます。
  PAIRING非対応の場合は失敗として表示します。自動bondや既存キーの上書きはしません。
  HBFが別centralとのbondを許容するかは未検証です。失敗時にbond削除やHCIリセットをしないでください。
- 切り戻し: 「USBへ切り戻す」を押します。進行中の処理が終了してから設定が適用されます。
  次の同期は保存済みBlueZ/Omronキーを使います。遠隔失敗時の自動USB切替は行いません。
- radio再起動: 既存の管理画面からradioを再起動します。設定は維持されます。
  SelfCareが `/watch` を再登録すると広告イベント返却を再開します。

設定・診断・同期を共通キューで直列化します。CLIワーカーもUSBと共通のファイルロックを使います。
QNAPのホストBlueZ設定、radioのtmpfs/ログ無効化、既存bond保管先は変更しません。

### 登録した接続で既存キーを使う限定診断（v0.3.27）

通常利用で毎回BLE登録を行う機能ではありません。BLE登録後の再接続で暗号化に失敗する場合に、
登録した同じ接続で既存キー認証・履歴読取り・正常終了まで進む条件を調べるための明示操作です。
HBF-228Tの再接続問題を解決したとはまだ確認していません。管理画面の従来の「BLE bondingの診断」は、
引き続きBLE登録だけを行います。

1. HBFの自動同期を一時OFFにし、他のHBFジョブがないことを確認してからM5GO経路へ切り替えます。
2. 体重計を登録モードにして、認証済みのHomeHub管理API `POST /api/m5go` に
   `{"action":"prepare-bond-session","confirm":"bond-session-hbf-228t"}` を送ります。
3. 120秒以内にSelfCareから対象HBFの手動同期を1回実行します。HomeHubはこの要求に含まれる
   既存キーをそのまま使います。SelfCareのコード・キー保管先・DBスキーマの変更は不要です。
4. `diagnostic.explicit_bond_session`、認証応答、通信終了と履歴結果を確認します。
   この成功だけでは保存bondによる通常再接続・新規測定の自動保存を確認したことにはなりません。
5. 試験終了・中止時は `{"action":"cancel-bond-session"}` を送り、USBと元の自動同期設定へ戻します。

予約はRAM内だけで、対象M5GO同期のワーカー起動前に1回で消費します。失敗後の通常同期は再登録しません。
120秒経過、設定変更、従来の明示BLE登録、解除、radio再起動でも失効します。
同じ予約を再送して有効期限を延長することはできません。別MACやHEMのUSB同期は予約を使用しません。
予約中は対象の**次の同期**に適用されるため、試験では手動同期を送るまで自動同期を停止してください。
状態応答の `bondSession` は予約有無と残秒だけを返し、キーを含めません。

この診断には、現在の接続の暗号化成功を確認でき、明示登録予約APIを持つ実験firmwareが必要です。
未対応firmwareではGATT接続前に停止します。アプリキーの再発行、登録モード用opcodeへの切替、
機器の設定/測定EEPROM書込み、bond削除、HCIリセットは行いません。

### HBFの通知順序（v0.3.28）

M5GO経由のHBF通信は、認証前にRX0とunlockの通知だけを有効にします。既存キーの認証応答
`8100`を確認した後、unlock通知を解除し、RX1・RX2・RX3の順に有効にして履歴通信を開始します。
認証拒否では追加の通知を有効にせず終了します。通知の切替に失敗した場合も通信開始要求は送りません。
既存USB処理、認証キー、履歴の解析方法は維持します。
保存された通知設定が残る場合に備え、BLE認証後・アプリキー送信前にRX1〜3の通知設定を明示的にOFFへ
書き込みます。unlock通知の解除も体重計側の設定書込み応答を待ちます。ESPHomeのローカル通知転送を
解除するだけでは、体重計側の通知設定が変わった証拠にならないためです。

根拠は[hass-omronのHBF系調査記録](https://github.com/eigger/hass-omron/blob/315530315bc09652c4e28f930364f0c8eb21490d/docs/body-composition-scales-notes.md)
にあるHBF-222Tの実測です。HBF-228Tで同じ通知順序が必要であることや、今回の`8101`を解消することは
未検証です。USBでの成功結果と機種の違いもあるため、解決済みとは扱いません。既存キーを再登録する
フォールバックは加えていません。明示登録付き同期と通常同期の両方で、この通知順序を使用します。

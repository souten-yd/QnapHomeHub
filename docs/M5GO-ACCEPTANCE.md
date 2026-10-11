# M5GO自動同期の受入記録

更新日: 2026-10-11。最終条件は通常設置で測定したHBF-228TのデータがM5GO経由でSelfCareに自動保存されること。
**全体は未完了。実機同期成功とは判定していません。**

## 実装・リリース

- PR #32: firmware/OTA/診断、v0.3.20。PRとmainのCI/firmwareビルド成功、Docker Release公開済み。
- PR #33: 遠隔GATTワーカー、v0.3.21。PRとmainのCI/Dockerビルド成功、Docker Release公開済み。
- Web/Unix socket経路管理: v0.3.22。ソース実装済み。CIの最終結果は [Actions](https://github.com/souten-yd/QnapHomeHub/actions)、公開状況は [v0.3.22 Release](https://github.com/souten-yd/QnapHomeHub/releases/tag/v0.3.22) を確認。
- v0.3.23: RAW広告購読の修正。v0.3.22はAPI接続が成功してもESPHome 2026.9.1の広告を受信できなかった。実機調査で旧形式0台／RAW形式15台を確認。公開・CI状況はActionsを参照。

## 要求ごとの証拠と境界

| 要求 | 証拠 | 判定 |
|---|---|---|
| 最新mainから小PRで実装、QnapSelfCareを変更しない | HomeHubのPR #32/#33、SelfCareへの変更なし | 実施済み |
| ESPHome最新公式仕様・初代ESP32・接続1枠・暗号化API/OTA・診断 | firmware/m5go/ble-proxy.yaml、2026.9.1設定検証とfirmware CI | ビルド成功、実機未検証 |
| 資格情報を公開しない | ローカルsecrets ignore、ダミー専用build script、artifact uploadなし、Dockerからfirmware除外 | 実装済み |
| QNAP Dockerイメージ | PR/mainのCIおよびPublish Docker images (linux/amd64) | v0.3.20/21成功、22はCI結果を参照 |
| 既存認証・通知・履歴・ユーザー別解析と返却 | test_esp_proxy_worker: 実Sessionに模擬GATT通知、ユーザー1/4、USB結果一致 | モック成功、実機未検証 |
| 接続失敗・認証失敗・破損応答・cancelで解放 | Python worker/transportテスト | モック成功 |
| BLE bondと既存BlueZ鍵の区別 | PAIRING能力チェック、明示bond専用操作、キー再発行/削除なし | 実装済み、HBF互換性未検証 |
| /watch広告、/run同期、/health互換 | proxy-radio.test.tsのUnix socket、共有広告整形 | モック成功 |
| 初期USB、対象HBFのみ切替、二重接続防止 | proxy-config/proxy-radio/radio-arbiter、共通ファイルロック | モック成功 |
| Wi-Fi/API断からの復帰 | proxy-watch.test.tsで断・バックオフ・再接続、transportで切断待ち解除 | APIモック成功、実Wi-Fi断未検証 |
| Web登録・キー秘匿・診断・RSSI・切り戻し | scripts/check-m5go-ui.mjs、desktop1280/mobile360ブラウザ検証 | 模擬API成功、実サービスはCIで検査 |
| Docker再起動後の設定維持、USB切り戻し | scripts/check-m5go-radio.mjsをDocker CIで実行 | CI結果を参照（実機復旧とは別） |
| 血圧計/SwitchBot/USBと低I/O保護 | USB経路回帰テスト、既存compose/entrypoint変更なし | ソフトウェア回帰成功、実機未検証 |
| 日本語USB/OTA/Web/復旧手順 | M5GO-BLE-PROXY.md | 作成済み |
| 通常設置HBF測定→M5GO→SelfCare DB保存 | 実測日時・ユーザー・値の保存確認が必要 | **NOT TESTED** |

## 実機確認と残る工程

上表の自動試験とは別に、2026-10-11に次を確認した。資格情報・LAN情報・健康記録は公開しない。

- ユーザーが対象USB機器を確認。実運用ファームウェアのローカルビルド、USB書込み、暗号化OTA成功。
- QNAPをv0.3.22へ更新。低I/O設定を維持し、Native API接続・診断表示・Webログインを確認。
- radio停止／起動後の設定維持、API再接続、SelfCare待ち受け復帰を確認。
- 通常設置で経路変更後にAPI再接続エラーを観測。M5GO起動ログを確認した後、API復帰。長期安定性は未判定。
- BLE広告未受信の原因をRAW形式との不一致と特定。RAW購読で周辺機器を受信。HBF自体の広告・認証・履歴・自動保存は未確認。
- 修正版のローカルtransportでも周辺13台を受信。USBへ切り戻した間にSelfCareのHBF待ち受け同期が成功し、1件追加・29件重複。これはUSBの証拠でありM5GO同期成功ではない。
- v0.3.23をQNAPへ適用し、M5GO経由のHBF広告、GATT接続、Omronサービスを実機確認。既存キーのunlockは通常モードで`8101`を返し失敗。
- P表示で明示的なBLE bondingは成功。P表示中のunlockは`8104`、通常モードへ戻すと`8101`。Omronアプリキーは再発行・書込みしていない。
- その後USBへ戻すと既存キーでunlock `8100`、30件の履歴返却（全件重複）が成功。既存USB同期を確認。
- 接続時に保存済みbondのある相手だけへ暗号化を要求するfirmware候補を実ビルドし、暗号化OTAで適用。未知の相手／bond読込失敗には要求しない境界テストは成功。
- 同候補で21:28 JSTの自動同期がGATT接続からunlockまで到達したが、`8104`／`8101`で失敗。**暗号化要求の追加だけでは既存キー認証の成功を確認できず、PR #36はdraftのまま。** USB経路へ切り戻した。
- 切り分け用に、既知bondの有無・暗号化要求の結果・対象相手のBLE認証結果だけをNative APIで読める診断を候補へ追加。鍵・相手アドレス・健康記録は含めない。要求成功と認証完了を区別し、他の相手の認証イベントは無視する。
- 21:33 JSTの1回の診断で、保存済みbondを検出後に`auth_failed:97`（ESP-IDFの`ESP_AUTH_SMP_ENC_FAIL`）、unlock `8104`を取得。ユーザーはP表示だったと確認。その後、電源OFFから通常転送表示へ切り替えた21:37の診断は`bond_count:0`、unlock `8101`。各診断後にUSBへ戻した。
- ESP-IDF 5.5.5の`bta_dm_act.c`は`BTM_LE_COMPLT_EVT`のSMP失敗時にsecurity device entryを削除する。自作componentに鍵削除処理はないが、プラットフォームによるM5GO内のbond削除があり得る。既存USBのBlueZ鍵／Omronアプリキーの削除は行っていない。暗号化失敗の根本原因は未確定。
- 21:40 JST、P表示を確認して明示BLE登録を1回実行したが`BleakError`で失敗し、USBへ戻した。初回登録の認証結果・接続失敗コード・切断理由も観測できるよう診断を拡張。未知の相手への暗号化開始は引き続き行わない。

PR #36の実験firmware（未リリース）では、保存済みbondの暗号化再開を要求しても`auth_failed:97`、unlock `8104`／`8101`となった。21:54 JSTにBLE再登録成功を確認した直後も、21:55の通常転送で同じ暗号化失敗を再現。同期を1回で止め、USBへ戻した。BLE登録成功を履歴取得成功とは扱わない。

v0.3.24では明示BLE登録時も既存USB Sessionと同じ通知購読を先に行う。Omronキー書込み・unlock・履歴読取りを登録処理へ追加しない。QNAP診断では実験firmwareの`BLE Security`状態だけを許可リストで受け取り、任意のテキスト診断は公開しない。通知購読失敗時の中止・解放、登録前の購読、キー書込みなし、診断テキストの選別は自動試験で確認。**変更後の実機再接続・認証は未検証。**

残る工程は登録手順の実機再検証、HBF既存キー認証/ユーザー別履歴、通常設置での新規測定の自動保存。
実Wi-Fi断、切り戻し後のHBF・HEM・SwitchBot実動作も未検証。BLE bondが必要なら明示操作で検証し、既存bondやOmronキーを消去しない。

## ローカル再検証

```sh
npm install --prefix server --no-audit --no-fund
npm run typecheck --prefix server
npm test --prefix server
python3 -m unittest discover -s server/ble -p 'test_*.py'
# 専用環境にrequirements-esphome-proxy.txtをインストールするとtransportテストも実行。
# 任意: playwrightを別環境へ導入し、モジュールパスを指定して模擬UI確認。
PLAYWRIGHT_MODULE=/tmp/qhh-browser/node_modules/playwright/index.mjs node scripts/check-m5go-ui.mjs
```

Python専用環境はRAWバッチの実protobuf/実パーサー契約を含む17テスト成功。
TypeScriptは32テスト成功。ブラウザ模擬APIテスト成功。これらは実機証拠に代用しません。

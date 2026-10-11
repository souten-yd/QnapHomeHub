# M5GO自動同期の受入記録

更新日: 2026-10-11。最終条件は通常設置で測定したHBF-228TのデータがM5GO経由でSelfCareに自動保存されること。
**全体は未完了。実機同期成功とは判定していません。**

## 実装・リリース

- PR #32: firmware/OTA/診断、v0.3.20。PRとmainのCI/firmwareビルド成功、Docker Release公開済み。
- PR #33: 遠隔GATTワーカー、v0.3.21。PRとmainのCI/Dockerビルド成功、Docker Release公開済み。
- Web/Unix socket経路管理: v0.3.22。ソース実装済み。CIの最終結果は [Actions](https://github.com/souten-yd/QnapHomeHub/actions)、公開状況は [v0.3.22 Release](https://github.com/souten-yd/QnapHomeHub/releases/tag/v0.3.22) を確認。

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

## 実機工程に必要な操作

1. 対象M5GOのUSBポートを確認する。作業PCでは `/dev/ttyUSB0` にCP2104（serial末尾01DB704F）が見えるが、対象機器という確認はまだない。未書込み。
2. `firmware/m5go/secrets.yaml` に2.4GHz Wi-FiのSSID/パスワードとNative API鍵をローカルで設定する（0600）。秘密情報をGitHubやチャットに貼らない。
3. ドキュメントの実運用ビルド・USB書込みを実施。M5GOのLAN IPを確認し、QNAPの管理画面で登録する。
4. API/広告/GATT診断と、既存Omronキーによる認証・ユーザー別履歴同期を確認する。BLE bondが必要なら明示操作で検証し、既存bondやOmronキーを消去しない。
5. 通常設置場所で新規測定し、SelfCareの対象ユーザーへ測定日時/値が自動保存されたことを確認する。
6. Wi-Fi/API断・M5GO再起動・暗号化OTA・Docker再起動からの復旧、USB切り戻し、HEM-6232T/SwitchBot動作を実機で確認する。

QNAPの管理接続先、HBFのMACとSelfCareの実機検証環境も必要です。
現時点では接続先/運用資格情報を与えられていないため、既存DB・キー・実機構成にはアクセス/変更していません。

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

Python通常環境は依存不要の11テスト成功、専用環境は14テスト成功。
TypeScriptは32テスト成功。ブラウザ模擬APIテスト成功。これらは実機証拠に代用しません。

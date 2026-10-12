# M5GO作業の引継ぎ（2026-10-12 JST 再開後）

## 画面表示の準備（2026-10-12）

ユーザーの「画面表示機能を準備して」に対応し、別worktree `/data1tb/QnapHomeHub-display`、branch `feat/m5go-health-display`、draft [PR #44](https://github.com/souten-yd/QnapHomeHub/pull/44)で表示機能を準備した。最新値・前回比・7日間の体重/体脂肪率グラフ、A/B/C操作、利用者分離、欠測・更新停止表示。詳細と仮データの画面は同worktreeの `docs/M5GO-DISPLAY.md`。

本体に適用済みの認証処理をそのまま含むprivate候補を `secrets/m5go-display-candidate/dashboard.yaml` からビルドした。OTA binaryは同フォルダの `.esphome/build/qnap-m5go-proxy/build/firmware.ota.bin`。認証情報を含むので公開しない。`secrets/m5go-display-preparation.json` にhash/試験結果/未検証項目を記録。登録利用者が1名のため、その方を `USER 1` とする `secrets/m5go-display-config.json` を準備し、保存履歴の読み取りのみで表示用集計を検証した。

**OTA・表示bridgeの起動・本番設定変更はしていない。** 通常同期は下記のM5GO固定待ち受けを維持。画面付き候補の実機画面/ボタン、同期中の空きメモリ、再起動bond保持、新規測定自動保存は未検証。表示は体組成計へ再接続せず、SelfCare保存履歴を約60秒周期で読む別サービス。PR #36の実験firmwareをmainの古いbaseへ置き換えないこと。

## 現在の状態

**同期試験の直近指示:** 「直ぐに試せないので、待ち受け同期も準備しておいて」。再起動後の手動試験監視を中止・終了し、その復帰処理が終わった後、HBFをM5GO経路・自動同期ON・listenモードに設定した。M5GO API接続、SelfCare listener ready/busy false/errorなし、登録予約pending falseを実機APIで確認済み。現在は常設サービスの待ち受け状態で、手動監視・期限付きのUSB自動復帰は動いていない。

M5GOのUSB共通登録（接続8）と再登録なしの通常同期（接続9）は成功。履歴30件を返し、追加0件・重複30件・不正0件。その後USBも再登録なしで8100・履歴30件・正常終了に成功し、既存USB登録の保持を確認した。**M5GO再起動後の保持と新規測定の自動保存は未検証。** 再起動試験はユーザー都合で延期しただけで、成功扱いしない。

直近のHBF同期成功は2026-10-12 09:14:48 JST。SelfCareの既存1時間待ち受け抑制を維持し、余裕を含め**10:16 JST以降**の通常測定で新規自動保存を確認する。成功時刻DBを変更しない。ユーザーはすぐ試せないため、追加のボタン操作を待つ処理を起動しない。P登録・キー書込み・bond解除は追加しない。

PR #43のUSB共通Omron登録はv0.3.30として公開・QNAPへ反映済み。main `a5728ae`、PR CI `38185106336`、main CI `38185254171`、Docker公開 `38185254187` は成功。47件のPython試験と38件のTypeScript試験・型検査・ビルドが成功。実験firmwareは `02f85bf`、PR #36はdraft・次候補版v0.3.31。実機成功を踏まえたfirmwareの正式昇格は未実施。

待ち受け設定の証拠：`secrets/v0330-automatic-wait-proxy.json`、`secrets/v0330-automatic-wait-listener.json`、`secrets/v0330-automatic-wait-device.json`、`secrets/v0330-automatic-wait-timing.json`。現在地は `secrets/m5go-hardware-acceptance.json`。

## 再開後の実測

- 接続番号4：保存bondありからHCI6/GAP97で失敗。アプリキー未送信、終了時bond数0。
- 接続番号5：保存bondなしからBLE登録成功。その後Bleak 3がCCCD直接書込みを拒否しValueError。アプリキー未送信。v0.3.29でこのソフトウェア不備を修正。
- ユーザーの「解除して進めて」でM5GO内のHBF試験bond解除を1回実行。応答は広告購読中のQNAP接続へ送られ操作側ではタイムアウトしたが、次のOPENのbond数0で解除の効果を確認。この1回の承認は消費済み。
- 接続番号6（v0.3.29、P表示）：BLE登録・暗号化成功、RX1〜3 CCCD OFF応答成功後も既存アプリキー応答 `8101`。履歴未取得。
- 続くUSB通常同期：既存アプリキーで `8100`、履歴処理・正常終了成功。
- 接続番号7（v0.3.29、通常短押し）：HCI6/GAP97、アプリキー未送信。USB・元の自動同期へ復帰。

## 次の操作と確認境界

ユーザーが後日測定したら、まず現在のroute/auto_sync/API/listenerとHBFジョブを読み取り確認する。新しい**自動**ジョブがM5GO経由で完了し、新規測定がSelfCareへ追加された証拠を確認する。手動syncや既存30件の重複取得を自動保存成功と扱わない。

M5GO再起動後の登録保持は別途未確認。再開する場合は新しいユーザー操作と実際のuptime低下等を確認してから試験する。中止済み `secrets/watch-v0330-restart-normal.py` の過去コマンド・結果を再使用しない。同じP登録やbond解除は不要。

登録・通常同期の証拠は `secrets/m5go-usb-registration-isolated-result.json`、USB保持は `secrets/v0330-usb-coexistence-result.json`。実装は [USB共通登録](M5GO-APPLICATION-REGISTRATION.md)、経緯は [受入記録](M5GO-ACCEPTANCE.md)。以下は過去の中断記録で、現在の運用状態には上記を使う。

---

# M5GO作業の中断記録（2026-10-12 JST）

ユーザーの「今日は一旦やめるから、記録とって停止して」により中断。M5GO経由の履歴取得・通常再接続・新規測定の自動保存は未達。

## 停止時の状態

- QNAP HomeHub v0.3.28を反映済み。PR #41、main CI、Docker公開は成功。
- M5GOの実験firmwareは `02f85bf`。作業ブランチは `fix/m5go-known-bond-encryption`、中断記録前のHEADは `d36191d`。PR #36はdraft、次候補版はv0.3.29。
- 最新の通知順序候補の実機試験は **NOT TESTED**。待機監視を登録ジョブ投入前に中止し、`operator_aborted`で終了した。新たな登録・同期は行っていない。
- 停止後の実機APIでUSB経路、HBF自動同期ON、登録予約pending false、M5GO API接続を確認。SelfCare listenerはready true、busy false、errorなし。復帰エラーなし。

## 最後の実測と未解決点

v0.3.27では同一接続のBLE登録・暗号化に成功したが、既存Omronキーによる認証応答が `8101` で停止し、履歴に到達しなかった。それ以前の通常再接続ではコントローラーの `0x06`（PIN or Key Missing）を確認した。両者を混同しない。USB経路では既存キーによる `8100` と履歴取得の成功証拠がある。

v0.3.28はM5GO専用の通知順序を変更し、既存キー送信前に不要なRX通知のCCCDをOFF、`8100`確認後に履歴用通知へ切り替える候補。38件のPython試験とCIは成功しているが、HBF-228Tでの改善は未確認。詳細・研究根拠・過去の訂正は [受入記録](M5GO-ACCEPTANCE.md) を参照。

## 次回の再開手順

1. ブランチ・差分・PR状態とQNAPの版、USB経路、自動同期、listener、登録予約を読み取り確認する。記録済みの試験を再生成しない。
2. 非公開の `secrets/m5go-hardware-acceptance.json` と `secrets/m5go-staged-notify-isolated-result.json` を読む。最新結果は試験前の中止記録なので、過去の失敗結果と区別する。
3. 再開が指示されたら、中止記録を時刻付きの別名で保存し、証拠を上書きせず新しい限定監視を開始する。監視スクリプトは `secrets/watch-staged-notify-isolated.py`。既存結果があると起動を拒否する仕様。古いコマンド・過去の「出た」を再使用しない。
4. 新しいP表示の確認後に、同じfirmwareでv0.3.28の登録付き同期を1回だけ実行する。暗号化成功・`8100`・履歴処理完了・正常終了・予約消費を確認した場合だけ通常再接続の比較へ進む。失敗時は停止しUSBと元の自動同期へ戻す。

毎回ペアリングする運用にはしない。既存アプリキーの再発行、BlueZ bond削除、他型番のEEPROM書込み、SelfCareのソース・スキーマ変更は行わない。資格情報・キー・測定値・秘密を含むfirmwareは公開しない。

非公開証拠：`secrets/m5go-controller-isolated-result.json`、`secrets/m5go-bond-session-isolated-result.json`、`secrets/m5go-staged-notify-isolated-result.json`。停止後確認：`secrets/pause-m5go-status.json`、`secrets/pause-listener.json`、`secrets/pause-devices.json`。

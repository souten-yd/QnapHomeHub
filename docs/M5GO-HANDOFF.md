# M5GO作業の引継ぎ（2026-10-12 JST 再開後）

## 現在の状態

M5GO経由の履歴取得・通常再接続・新規測定の自動保存は未達。v0.3.30反映後、USB経路・元のHBF自動同期、SelfCare listener ready/busy false/errorなし、登録予約pending falseを確認済み。現在はUSB共通のOmron登録を1回試す限定監視が新しいP表示の確認待ち。実行時点の待機・復帰状態は非公開checkpointと監視結果を優先する。同じ登録・解除の反復は行わない。

**最新の対照試験:** M5GO登録試験後のUSB通常同期は、再登録・アプリキー書込みなしで `state:done`、既存キー応答 `8100`、履歴通知93件、終了opcode 15、`stage:completed`。93測定という意味ではない。その後、新しい短押し確認でM5GO通常同期を1回実行したが、接続番号7は保存bondありからHCI status 6（PIN or Key Missing）/ GAP97で失敗。アプリキー送信前・履歴通知0件で停止した。USB同期が介在したため、この試験単独では無介入のbond保持失敗と扱わない。

**キーの区別と未検証の前提:** ユーザーから「MACが違うのでM5GOとUSBは別キーでは」と指摘あり。現行実装はSelfCareから渡される同じOmronアプリ認証キーを両経路の `sync_session` で使い、M5GO専用アプリキーを発行・登録していない。一方、BLE bondはUSB側BlueZとM5GO側で別々に作成・保持し、USBのbond鍵をM5GOへコピーしていない。既存アプリキーを別の接続元でも利用できることはHBF-228Tで未確認。接続元への登録・紐付け不足は候補だが、キー値を別にすれば解決することも未確認。USBでの成功が証明するのはUSB経路でのキー有効性まで。

**モードの交絡:** USBの `8100` は通常通信、M5GOの `8101` はP（登録）モード。経路だけを変えた比較ではなく、Pでの拒否からキー失効やMAC紐付けを断定しない。最新の通常M5GO失敗はBLE暗号化段階であり、アプリ認証とは区別する。

PR #43のUSB共通Omron登録をv0.3.30として公開・QNAPへ反映済み。mainは `a5728ae`。PR CI `38185106336`、main CI `38185254171`、Docker公開 `38185254187` は成功。47件のPython試験と38件のTypeScript試験・型検査・ビルドが成功。QNAP updater success/busy false、health 0.3.30、radio available/running/lowIo trueを確認。firmwareは `02f85bf`、実験PR #36はdraft・次候補版v0.3.31。

## 再開後の実測

- 接続番号4：保存bondありからHCI6/GAP97で失敗。アプリキー未送信、終了時bond数0。
- 接続番号5：保存bondなしからBLE登録成功。その後Bleak 3がCCCD直接書込みを拒否しValueError。アプリキー未送信。v0.3.29でこのソフトウェア不備を修正。
- ユーザーの「解除して進めて」でM5GO内のHBF試験bond解除を1回実行。応答は広告購読中のQNAP接続へ送られ操作側ではタイムアウトしたが、次のOPENのbond数0で解除の効果を確認。この1回の承認は消費済み。
- 接続番号6（v0.3.29、P表示）：BLE登録・暗号化成功、RX1〜3 CCCD OFF応答成功後も既存アプリキー応答 `8101`。履歴未取得。
- 続くUSB通常同期：既存アプリキーで `8100`、履歴処理・正常終了成功。
- 接続番号7（v0.3.29、通常短押し）：HCI6/GAP97、アプリキー未送信。USB・元の自動同期へ復帰。

## 次の操作と確認境界

ユーザーの比較後の「進めて」を受け、[USB共通の登録](M5GO-APPLICATION-REGISTRATION.md)を実装・公開・反映した。既存キーの値を使用するが、体組成計内のUSB接続元登録を保持することは未検証。新規キー生成や追加のbond解除は許可・実施していない。

次は新しいP表示を確認し、`secrets/watch-usb-registration-isolated.py` のコマンドファイル `secrets/m5go-usb-registration-isolated-command.txt` に `bond` を1回投入する。登録はUSBの基底Sessionを使い、8200→8000→通信開始・正常終了を確認する。成功時のみ新しい通常短押し確認を待ち、`sync` を1回投入する。終了・失敗・期限切れでUSBと元の自動同期へ復帰。予約は新しい `prepare-application-registration` で、従来のBLE-only許可と区別する。過去のP表示・解除承認は再利用しない。

SelfCare上は登録要求もsyncジョブのため、登録成功は0件追加・待ち受け成功時刻更新となる。登録を履歴取得成功と混同しない。直後のM5GO通常通信とUSB保持確認は手動sync。自動保存試験は既存の1時間の抑制期間後に行い、時刻DBを変更しない。限定監視の11件の模擬試験は成功。実機の新しい登録・再接続・USB共存は未検証。

非公開証拠：`secrets/m5go-cccd-backend-isolated-result.json`、`secrets/v0329-usb-key-validity-trial.json`、`secrets/m5go-v0329-normal-only-result.json`。復帰確認：`secrets/v0329-normal-restored-listener.json`。非公開の現在地は `secrets/m5go-hardware-acceptance.json`、詳しい結果は [受入記録](M5GO-ACCEPTANCE.md)。以下は中断時点の履歴であり、現在の版・次操作には上記を使う。

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

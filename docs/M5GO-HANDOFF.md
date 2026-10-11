# M5GO作業の引継ぎ（2026-10-12 JST 再開後）

## 現在の状態

PR #42のCCCD通知停止修正をv0.3.29として公開・QNAPへ反映済み。mainは `f80421f`。PR CI `38180323995`、main CI `38180494313`、Docker公開 `38180494333` は成功。実Bleakを通す回帰を含む41件のPython試験が成功し、旧処理のValueErrorも再現した。firmwareは `02f85bf` のまま、実験PR #36はdraft・次候補版v0.3.30。

反映後はupdater success/busy false、radio available/running/lowIo true、USB経路、M5GO API接続、登録予約pending false、HBF自動同期ON、SelfCare listener ready/busy false/errorなしを確認。体組成計との認証・履歴取得・自動保存は未達。

## 再開後の実測

- 接続番号4：保存bondありからコントローラーstatus 6/GAP97で失敗。アプリキー未送信、終了時bond数0。証拠は `secrets/m5go-staged-notify-isolated-result-preauth-failed-*.json`。
- 接続番号5：保存bondなしからBLE登録・暗号化成功。その後、Bleak 3がCCCD直接書込みを拒否し `prepare_unlock_notifications` でValueError。アプリキー未送信。切断直前にはbondが残存。証拠は `secrets/m5go-staged-notify-isolated-result.json`。v0.3.29はこのソフトウェア不備を修正したが、修正後の実機試験は未実施。

## 次の操作と確認境界

同じ保存bondの前提でP試験を繰り返さない。M5GO内のHBF向け試験用BLE登録だけを1回解除して初回登録から検証する案を準備した。元の依頼はペアリング削除の自動実行を禁止しているため、**明示承認を得るまで解除しない**。QNAP BlueZの登録・Omronアプリキー・健康記録は変更しない。解除・再試験とも未実行。

承認後は現在の状態と稼働ジョブを確認し、対象を限定してM5GOのNative APIによる解除を1回だけ行う。新しいP表示を確認後、v0.3.29で登録付き同期1回、成功条件をすべて満たした場合だけ通常再接続へ進む。限定監視 `secrets/watch-cccd-backend-isolated.py` は作成済み・未起動。結果ファイルは `secrets/m5go-cccd-backend-isolated-result.json` を使用する。過去の「出た」は再利用しない。失敗・期限切れ時は予約解除、USB・元の自動同期へ復帰する。

詳しい結果は [受入記録](M5GO-ACCEPTANCE.md)、非公開の現在地は `secrets/m5go-hardware-acceptance.json`。以下は中断時点の履歴であり、現在の版・次操作には上記を使う。

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

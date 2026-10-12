# M5GO作業の引継ぎ（2026-10-12 JST 再開後）

## v0.3.34の公開範囲と確認結果

ユーザーの「マージしてリリースもしておいて」により、実機で使用中の既知bond暗号化処理・明示登録予約・限定診断をPR #36からmainへ統合し、v0.3.34として公開する。表示機能はPR #44〜#46 / v0.3.31〜0.3.33で公開済み。現在の実機firmwareと今回収録するBLE base・componentは同一で、今回の公開のために追加OTAや再登録を行う必要はない。公開結果は [v0.3.34 Release](https://github.com/souten-yd/QnapHomeHub/releases/tag/v0.3.34) と [PR #36](https://github.com/souten-yd/QnapHomeHub/pull/36) を参照。

2026-10-12 16:08 JST、ユーザーの「一回だけデータ更新して」により保存済み履歴を1回だけ取得し、M5GOの`health_display_update` ACKを確認。その後「バッチリでした」と表示動作の確認を受けた。表示のユーザー確認は済み。定期設定は毎日0時のまま維持し、常設workerの表示ACK時刻はPCからの単発送信を表さない点に注意する。

**残る実機確認:** 0時の定期実行、最後のOTA後の体組成計認証、新規測定の自動保存と表示、BLE同期中のheap。画面の確認やリリース成功を、これらの完了証拠として扱わない。同期試験を追加実行せず、現在の待ち受け設定を維持する。

単発更新の証拠は `secrets/m5go-manual-display-refresh-20261012T070856Z.json`。以下の各節は配備時点の履歴で、draft・未回答等の記述はこの節の確認結果を優先する。

## 現行: 日次取得・受信値表示・5秒点灯（v0.3.33）

ユーザー指示によりQNAP履歴の60秒取得を停止し、毎日0:00（Asia/Tokyo）に1回だけ取得する運用へ変更した。起動時の追加取得は行わず、実行日を先に保存して同日の失敗・再起動による再試行を防ぐ。0時の最初の1分を逃した場合は翌日まで待つ。画面の更新停止判定は25時間。次の実機予定は2026-10-13 00:00 JST。

追加指示の「左右逆」「ボタンまたは体組成計データ受信時だけ5秒ON」「受信値を最新とする」も反映。ILI9342のmirror_xをfalseにし、起動時は消灯。A/B/C操作または正常な測定データの受信で5秒点灯し、再トリガーで5秒を数え直す。0時の履歴更新では点灯しない。

正常なHBF同期の戻り値から、設定利用者の測定日時・体重・体脂肪率だけを表示workerへstdin経由でコピーする。表示ACKを待たずSelfCareへ結果を返し、QNAP保存は同期完了時に即時実行する。表示失敗は保存を妨げない。受信時に履歴HTTP取得は行わない。RAM内の各日最終値と最新2件を更新し、受信利用者の最新画面を表示する。古い履歴・重複では最新値を巻き戻さない。NodeのstdinはLinux上ではsocketpairのため、FIFOだけでなくsocketも扱う。実経路の合成データ確認済み（Native APIは模擬）。

[PR #45](https://github.com/souten-yd/QnapHomeHub/pull/45) の日次化はmain `62ea689` / v0.3.32、[PR #46](https://github.com/souten-yd/QnapHomeHub/pull/46) の受信表示・消灯・反転修正はmain `f80ed77` / v0.3.33。QNAPにはv0.3.31からv0.3.33を直接反映した。64 Python / 47 TypeScript試験、型検査・ビルド、native描画試験、既存認証baseと組み合わせたESP32ビルド成功。PR CI `38213389656` / firmware `38213389647`、main CI `38213893521` / firmware `38213893463`、公開 `38213893491` は成功。タグv0.3.33はmainの同一commitを確認。

M5GOには暗号化OTAを1回実行し再接続成功。`health_display_measurement` と既存表示・prepare/cancel actionsが共存。idle free heap 92,296 bytes。認証baseと鍵のファイルは初回表示firmwareと同一。配備前にSocketAPIErrorで一時切断していたが、書き込み前に直接APIとQNAP接続が回復し、書き込みは接続復帰後だけ実行した。OTA・QNAP更新時の短い自動同期停止は各finallyで元のONへ復帰済み。再登録・bond解除・キー変更なし。

現在の表示serviceはenabled/running、schedule=midnight、timezone=Asia/Tokyo、intervalSeconds=null。約111秒の観察中に表示ACKの更新はなく、日中の不要な取得を行わず待機している。最新値は次の正常な体組成計同期、保存履歴は次の0時で入る。route=m5go、自動同期ON/listen、既存1時間ゲートを維持。

**NOT TESTED:** 実機0時実行、反転修正後の物理LCD・5秒消灯、今回の再起動後の体組成計認証、新規測定の自動保存と最新表示。物理画面の確認はユーザーへ依頼中で、未回答を成功扱いしない。PR #36はdraft、次候補v0.3.34。旧mainのBLE baseを現在の実験firmwareへ上書きしない。

証拠: `secrets/m5go-midnight-preparation.json`、`secrets/m5go-midnight-install-result.json`、`secrets/m5go-midnight-after-ota.json`、`secrets/m5go-midnight-service-install.json`、`secrets/m5go-midnight-observation-start.json`、`secrets/m5go-midnight-final-status.json`。private firmwareは `secrets/m5go-midnight-candidate/`。健康値・鍵・実資格情報入りfirmwareは公開禁止。

## 画面表示の初回導入（v0.3.31・旧60秒更新）

ユーザーの「書き込んでおいて」により、画面付きfirmwareを暗号化OTAで適用した。旧認証base `02f85bf` のコードと準備済み表示packageを保持。再接続、`health_display_update` の受信ACK、従来のprepare/cancel bond actionsを確認。再登録・キー変更はしていない。約6分後もuptimeが増加し、idle free heapは89,420 bytesだった。見た目・ボタンの実操作・Bluetooth同期中のheapは未確認。

[PR #44](https://github.com/souten-yd/QnapHomeHub/pull/44) はmain `d0f4292` に統合しv0.3.31として公開、QNAPへ反映した。55 Python/44 TypeScript試験、型検査・ビルド、PR CI `38209057580`、PR firmware `38209057549`、main CI `38209574169`、main firmware `38209574085`、Docker公開 `38209574072` が成功。別worktree `/data1tb/QnapHomeHub-display` は実装/画面資料を保持する。

QNAPのradioサービス内で表示専用プロセスを管理し、`display-config` 管理APIから利用者1名を `USER 1` として有効化した。約60秒ごとにSelfCare保存履歴を読み、暗号化APIで表示データを送る。Bluetooth広告の購読・GATT・同期ジョブ投入は行わず、1時間の同期抑止は維持。PCの常駐処理やSSHは不要。管理API `display-status` でrunning/lastAcceptedAt/stale/errorを確認できる。実際に受信ACK時刻が60,454 ms進み、PCからの送信なしで次の周期も更新された。無効化は `display-config` のpatch `{"enabled":false}`。

OTAとQNAP更新時のみHBF自動同期を短時間OFFにし、各処理のfinallyで元のONへ復帰済み。route=m5go、API接続、listener ready/busy false/errorなしを確認。画面表示の成功を、新規測定の自動保存や再起動後の体組成計認証成功とは扱わない。

証拠は `secrets/m5go-display-install-result.json`、`secrets/m5go-display-initial-ack.json`、`secrets/m5go-display-after-ota.json`、`secrets/m5go-display-service-install.json`、`secrets/m5go-display-periodic-status.json`、`secrets/v0331-updater-final.json`。private OTA artifactは `secrets/m5go-display-candidate/.esphome/build/qnap-m5go-proxy/build/firmware.ota.bin`。認証情報を含むため公開禁止。hashは `secrets/m5go-display-preparation.json`。PR #36はdraft・次候補v0.3.32で、mainの古いBLE baseをこの実験firmwareへ上書きしないこと。

## 現在の状態

**同期試験の直近指示:** 「直ぐに試せないので、待ち受け同期も準備しておいて」。再起動後の手動試験監視を中止・終了し、その復帰処理が終わった後、HBFをM5GO経路・自動同期ON・listenモードに設定した。M5GO API接続、SelfCare listener ready/busy false/errorなし、登録予約pending falseを実機APIで確認済み。現在は常設サービスの待ち受け状態で、手動監視・期限付きのUSB自動復帰は動いていない。

M5GOのUSB共通登録（接続8）と再登録なしの通常同期（接続9）は成功。履歴30件を返し、追加0件・重複30件・不正0件。その後USBも再登録なしで8100・履歴30件・正常終了に成功し、既存USB登録の保持を確認した。**M5GO再起動後の保持と新規測定の自動保存は未検証。** 再起動試験はユーザー都合で延期しただけで、成功扱いしない。

直近のHBF同期成功は2026-10-12 09:14:48 JST。SelfCareの既存1時間待ち受け抑制を維持し、余裕を含め**10:16 JST以降**の通常測定で新規自動保存を確認する。成功時刻DBを変更しない。ユーザーはすぐ試せないため、追加のボタン操作を待つ処理を起動しない。P登録・キー書込み・bond解除は追加しない。

PR #43のUSB共通Omron登録はv0.3.30として公開・QNAPへ反映済み。main `a5728ae`、PR CI `38185106336`、main CI `38185254171`、Docker公開 `38185254187` は成功。47件のPython試験と38件のTypeScript試験・型検査・ビルドが成功。上記OTA前の認証baseは `02f85bf`。現行firmwareとQNAP v0.3.33は冒頭参照。PR #36はdraft・次候補版v0.3.34。実機成功を踏まえたfirmwareの正式昇格は未実施。

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

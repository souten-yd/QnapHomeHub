# M5GO / HBF-228T 再接続失敗の調査

調査日: 2026-10-11。初回の文献調査では実機操作を追加せず、その後ユーザーの操作確認に合わせて限定試験を行った。実測の時系列は[M5GO-ACCEPTANCE.md](M5GO-ACCEPTANCE.md)を参照。

## 調査の結論

現時点で原因は未確定。初回BLE認証成功と、保存したbondを使う再接続成功は別の条件である。同じP表示→通常転送を繰り返すだけでは原因を区別できない。以前の調査は公式ソースと一部のGitHub事例に偏り、機種の違い、仮説の反証、次の試験で得る証拠の設計が不足していた。

従来の実測は「M5GOで広告・GATT・P表示のBLE認証は成功、通常再接続ではGAP認証97、Omron unlock 8104、履歴取得失敗」。USBで同じOmronアプリキーの履歴読取りは成功している。USB成功は、M5GOのBLE bondが正しいことや、キーが別のBLEホストでも使えることまで証明しない。

追加診断では登録成功後と切断直前の保存bondを確認できた。key mask 3、鍵長16、publicアドレス、IRK/EDIV/RAND非ゼロで、全ゼロIRK説の前提とは一致しない。続く23:04 JSTの通常転送は広告検出後のOPENで133（一般的なGATTエラー）となり、認証へ到達しなかった。認証97の再現でも解消確認でもない。RSSI -84 dBmは観測値として残すが、電波が原因と断定しない。USB経路と自動同期を復帰済み。

その後、QNAPで成功している認証内容を操作履歴・実装から再確認した。22:59:47開始のUSB同期は既存キーの認証`8100`と履歴読取りに成功。M5GO登録と23:04の再接続との間にこのUSB同期が介在していたことを確認した。待機監視の時間切れ復帰によるもので、前回の無介入条件は成立していない。詳細と次回の隔離条件は[M5GO-ACCEPTANCE.md](M5GO-ACCEPTANCE.md)を参照。介入が失敗原因であるとは断定しない。

v0.3.26と明示登録予約対応firmwareで再評価した。P表示の登録は成功し、HBF自動同期を連続して停止した状態の23:42 JSTの通常再接続でも、暗号化要求から約98 ms後に認証97を記録した。保存bondのメタデータは接続時に存在し、CCCD・Omronキー送信前に失敗している。したがってUSB同期の介入は、この失敗が起きるための必要条件ではない。登録処理への自動暗号化の先回りを分離しても、通常再接続の失敗は残る。

実ビルドで使用したESP-IDF 5.5.5ソースも照合した。`btm_sec_encrypt_change`にはHCIのstatus/encr_enableが渡る一方、`smp_enc_cmpl`/`smp_check_auth_req`は暗号化の成否から共通の`SMP_ENC_FAIL`を生成する。`bta_dm_act.c`はSMP失敗時にセキュリティDBの機器エントリーを削除する経路を持つ。観測した認証97とその後のbond数0だけでは、コントローラーが返した詳細な原因コードを復元できない。次は鍵・パケット本文を出力せず、その下位ステータスを記録する方法を用意する。SDK内部フックや詳細ログはまだ適用しておらず、追加の実機接続も行っていない。

## 公式資料

- [OMRON HBF-227T/228T/230T共通取扱説明書](https://store.healthcare.omron.co.jp/support/download/manual/pdf/6602384-7D_HBF-230T-SW.pdf): HBF-228Tを対象に含む。初期登録、通常通信、通信設定の削除は別操作。ボタン表示の確認には使えるが、ESP32向けGATT/SMPの実装仕様ではない。
- [ESP-IDF 5.5.5 GAP API](https://docs.espressif.com/projects/esp-idf/en/v5.5.5/esp32/api-reference/bluetooth/esp_gap_ble.html): `ESP_AUTH_SMP_ENC_FAIL`はコントローラーが暗号化を開始できなかった状態。エラー番号だけでIRK、保存鍵、機器側登録、処理順序のどれが原因かは決まらない。
- [Espressif SMP解説](https://docs.espressif.com/projects/esp-idf/en/stable/esp32h2/api-guides/ble/smp.html): 初回pairingと鍵交換・保存を行うbonding、保存鍵での再接続を区別している。これは一般的なBLEの説明であり、ESP32-H2の実装を初代ESP32へそのまま適用しない。
- [ESPHome BLE設定](https://esphome.io/components/esp32_ble/): `auth_req_mode`は省略時にESP-IDF既定値。`bond`等の選択肢があるが、設定変更だけでHBFが直るという資料ではない。
- [ESPHome Bluetooth Proxy](https://esphome.io/components/bluetooth_proxy/): active GATT接続の機能を確認。広告の受信やPAIRING能力の有無だけではHBFの認証互換性を確認できない。

## 機種を区別した一次資料

| 資料 | 得られる証拠 | 今回への適用限界 |
|---|---|---|
| [openScale対応表](https://github.com/oliexdev/openScale/wiki/Supported-scales-in-openScale) / [OmronWlcHandler](https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/OmronWlcHandler.kt) | HBF-228Tを明記。通知購読後に既存アプリキーでunlockする実装がある | AndroidのBLE処理。M5GOの保存bondによる再接続成功を証明しない。キー不一致時の新規キー書込みは今回の要件に反するため採用しない |
| [ESPHome #17104](https://github.com/esphome/esphome/issues/17104) | OMRON血圧計で初回成功、再接続97/102、Android/BlueZ成功という類似報告 | 投稿者自身が全ゼロIRK説を未検証の仮説と記載。対象はstatic randomアドレスの血圧計。HBF-228Tではない。issueのclosed表示は修正済みの証拠ではない |
| [hass-omron #67、7月15日の作者コメント](https://github.com/eigger/hass-omron/issues/67#issuecomment-4979543288) | IRKを避けるkey-mask候補について、別の試験者でも効果が乏しいと作者が報告 | LTKのみへの変更を実証済み解決策として扱えない。Web本文取得はタイムアウトしたためGitHub APIで全49コメントを取得して確認 |
| [hass-omron PR #175](https://github.com/eigger/hass-omron/pull/175) | BP5465/HEM-7382T1-AZAZで初回登録後の再接続がHCI 0x06。機器内の登録確定書込みを加え、再接続・複数回取込・電源再投入成功を報告。2026-09-13 merge | WLD3.0系血圧計であり、HBF-228Tへの適用証拠なし。別機種のEEPROMアドレス・カウンター書込みを移植しない |
| [dzikus/esphome-omron](https://github.com/dzikus/esphome-omron) / [connection gate](https://github.com/dzikus/esphome-omron/blob/main/components/omron/omron_connection_gate.cpp) | bondを必要とするprofileでは認証完了を待ってからGATT discoveryへ進む実装。READMEは実機確認済みprofileを1件と区別 | 血圧計向けでHBF-228T実証ではない。多型番の列挙を全機種の実機互換性とみなさない |

## Redditの確認範囲

- [作者によるhass-omron紹介、2026-04-11](https://www.reddit.com/r/homeassistant/comments/1sic1om/omron_ble_bpm_hem7142t2_custom_integration/): 投稿時の実機対象はHEM-7142T2。他型番で登録だけ成功したとの報告もあり、Omron製品全体の互換性は示さない。
- [ble-scale-sync作者の説明、2026-04](https://www.reddit.com/r/homeassistant/comments/1so93sn/followup_ble_scale_sync_is_now_a_home_assistant/): ESPHome Native APIによるGATT transportは技術的に可能という説明。Omron対応の質問があるが、この投稿にHBF-228T+ESPHomeの成功証拠はない。
- `HBF-228T ESP32`、`HBF-228T pairing`、`Omron proxy site:reddit.com`等も検索した。今回確認した資料からは、初代M5GO+HBF-228Tの通常再接続成功例は見つからなかった。「存在しない」とは断定しない。

## 調査開始時のローカルコードとの照合（v0.3.24）

- `known_bond_security.h`は保存bondに一致した相手へ暗号化開始を要求するが、成功通知を履歴ワーカーの実行条件にはしていない。
- `esp_proxy_worker.py`の通常同期はGATT接続→`Session.subscribe()`→`sync_session()`。`Session.subscribe()`の待機は固定時間であり、対象接続のGAP認証完了を待つ条件ではない。したがって、開始要求を受け付けたことと暗号化完了を分ける必要がある。ただし、この不足が今回の97を生むと確定したわけではない。
- 既存`Session.unlock()`は非成功応答を一般的なキー不一致文言へまとめる。`8104`とGAP97が同時に出た試験で、その文言だけを理由にOmronキーを再発行してはいけない。
- bleak-esphome 4.1.0の通常`disconnect()`は切断してローカル通知コールバックを解放する。明示`stop_notify()`とは別であり、他機種の「終了時にCCCDを無効化するとbondを失う」という事例を今回の原因とは扱わない。

## 次の試験を行う条件

物理操作を再依頼する前に、次を用意する。1と2の診断はPR #36の実験firmwareへ実装・ビルド・暗号化OTA済み。登録時のメタデータと通常再接続時のOPEN失敗を観測できた。通常再接続の認証段階は未評価。履歴認証前のガードはPR #38 / v0.3.25で公開し、24件のPython試験とPR/main CIを通過した。

1. 対象接続の順序を記録する限定診断: OPEN、暗号化要求、認証完了/失敗、CCCD完了、unlock送信、切断。鍵・健康データを記録せず、過去接続の認証状態を再利用しない。
2. 保存bondの存在だけでなく、鍵の種類・長さ・アドレス種別などのメタデータを検証する。鍵本体は出力しない。IRK説を試すのはHBF側でその前提が成立する証拠を得てから。
3. 仮説と判定条件を先に決める。認証がunlockより前に失敗するなら待機延長だけの再試験は行わない。保存状態の不整合なら保存/鍵交換を調べ、機器側の鍵拒否が確認できたらHBF固有の登録要件を調べる。
4. 変更は一つずつ、試験は1回で停止しUSBへ復帰。同じ結果なら同じボタン操作を追加依頼せず仮説を更新する。

調査後の変更はイベント順序と鍵メタデータの診断、および認証失敗時の停止に限る。IRK/key-mask設定や機器固有の登録書込みは変更していない。通常運用はUSB経路を維持し、PR #36はdraft。履歴取得・新規測定の自動保存は未達。次の限定試験はHBFだけ自動同期を一時OFFにして競合を防ぎ、終了・時間切れ・中止で元の自動同期設定とUSB経路へ戻す。

# M5GO自動同期の受入記録

更新日: 2026-10-12。最終条件は通常設置で測定したHBF-228TのデータがM5GO経由でSelfCareに自動保存されること。
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

v0.3.24では明示BLE登録時も既存USB Sessionと同じ通知購読を先に行う。Omronキー書込み・unlock・履歴読取りを登録処理へ追加しない。QNAP診断では実験firmwareの`BLE Security`状態だけを許可リストで受け取り、任意のテキスト診断は公開しない。通知購読失敗時の中止・解放、登録前の購読、キー書込みなし、診断テキストの選別は自動試験で確認。

v0.3.24をQNAPへ反映後、22:16 JSTのP表示で明示BLE登録に成功（`bonded:true`、`application_key_changed:false`、`authenticated`）。電源OFF・15秒待機・Bluetooth短押しの通常転送では、22:20 JSTの1回の履歴同期が`auth_failed:97;disconnected:22`、unlock `8104`、履歴通知0件で失敗した。**通知購読順序の修正後も再接続時の暗号化失敗を再現し、履歴取得・自動保存は未達。** 接続を解放してUSB経路へ戻した。追加の再試行は起動していない。切断理由22はローカル切断であり、体組成計側による切断とは断定しない。PR #36はdraftを維持する。

残る工程は再接続時のBLE暗号化失敗の原因特定と修正、HBF既存キー認証/ユーザー別履歴、通常設置での新規測定の自動保存。同じ登録・転送操作の反復だけで成功とは判定しない。
実Wi-Fi断、切り戻し後のHBF・HEM・SwitchBot実動作も未検証。BLE bondが必要なら明示操作で検証し、既存bondやOmronキーを消去しない。

## v0.3.25と累積診断firmwareによる実測

2026-10-11の明示BLE登録では、接続番号1で`auth_ok`を記録した。保存bondはkey mask 3（ENC/ID）、暗号鍵長16、publicアドレス。IRK・EDIV・RANDはいずれも非ゼロで、切断直前にも同じメタデータを保持していた。Omronアプリキーは変更していない。これは「全ゼロIRK」という仮説の前提に合致しないが、鍵本体の一致や機器側の登録確定を証明するものではない。

23:04 JSTの通常転送を1回だけ実行。広告をRSSI -84 dBmで検出したが、接続番号2の記録は`[["open",0,133]]`のみで、接続開始に失敗した。暗号化要求・認証・CCCD・unlockには到達せず、履歴通知0件。133（0x85）は[ESP-IDFの一般的なGATTエラー](https://docs.espressif.com/projects/esp-idf/en/v5.5.5/esp32/api-reference/bluetooth/esp_gatt_defs.html)であり、このコードだけから電波・鍵・相手機器のどれが原因かは判断できない。以前の認証97を再現した試験とは扱わず、今回のガード下での認証結果は未評価とする。

試験終了後、USB経路とHBFの元の自動同期設定へ復帰。SelfCare listenerはready、errorなし、busyなしを確認した。M5GOでの履歴取得・新規測定の自動保存は未達。自動再試行は起動せず、PR #36はdraftを維持する。次は接続成立前の失敗要因と通信条件を調べ、再登録やIRK設定変更を繰り返さない。

### 成功しているQNAP USB経路との照合

ユーザーの指摘を受け、SelfCareの現在の操作履歴とHomeHub v0.3.25のソースを照合した。22:59:47〜23:00:01 JSTのUSB同期は`completed`、Omron認証応答`8100`、履歴通知93件で成功している。これは93測定を意味しない。BlueZキャッシュには`paired:true`、`bonded:true`、publicアドレスがあり、接続は4474 msで成立した。`trusted:false`でも成功しており、Trustedを必須条件とはしない。

USBは対象機器に限定した`NoInputNoOutput` Agentを登録し、BlueZ接続後にRX通知4本、0.75秒待機、unlock通知、0.75秒待機、既存アプリキーでopcode 1の認証を行う。応答`8100`の後に通信開始・履歴読取り・通信終了へ進む。M5GOは同じ`Session.subscribe()`と`sync_session()`を使用し、HomeHubはSelfCareから受けた既存キーを変更せず渡す。差は下位のBluetooth接続・bond管理（BlueZ対ESP-IDF/ESPHome）と、M5GO診断firmwareに対する認証完了ガードにある。USBのアプリ認証・読取りコードを新たに移植する必要はない。

**試験の隔離に関する訂正:** 22:57:45のM5GO登録後、待機監視が22:59:44に時間切れでUSB/自動同期を復帰し、その直後に上記USB同期が実行されていた。23:04:54のM5GO再接続までの間に別ホストの接続が介在している。したがって、前回の試験を「M5GO登録後に他ホストを一度も接続させず再接続した結果」とは扱えない。この介入が133や以前の97の原因かは未確定。次回の比較では登録から再接続までHBF自動同期の抑止を連続して保持し、時間切れ後は試験を終了扱いにする。他のHBFジョブが介在した場合も無介入の試験とは判定しない。今回の確認では新しい接続・再登録・キー変更は行っていない。

### 無介入で比較するための監視修正

ローカルの限定試験監視を修正した。登録前15分と登録成功後15分を別の待機枠にし、HBFの自動同期OFFとM5GO経路を両段階で連続保持する。5秒ごとと各操作直前に設定・操作履歴を確認し、対象外のHBFジョブや設定変更を検出した場合は中止する。登録1回・履歴同期1回に制限し、時間切れ後の継続・重複コマンドを拒否する。終了時はUSB経路と元の自動同期設定を復帰し、復帰失敗を成功表示しない。血圧計等の別機器ジョブは中止条件にしない。

待機時間の更新、期限切れ、別HBFジョブの介入、設定変更、自分の同期ジョブ・別機器の許容、重複操作、準備失敗時の復帰を含む8件の模擬試験が成功。これは監視の試験であり、M5GO認証の成功証拠ではない。比較ではfirmware・認証方式を変更せず、USB同期の介入を防ぐ条件だけを変更する。資格情報を含む監視設定と実測結果は非公開領域に置く。

その後のP表示の登録試験は`LinkSecurityError`で停止。接続番号3の累積記録はOPEN成功、3 msで保存bond確認（mask 3、鍵長16、各ゼロ判定false）、4 msで暗号化要求、147 msで認証97、870 msでbond数0、871 msでローカル切断22だった。CCCD・Omronキー送信・明示pair呼出しには到達していない。自作の既存bond暗号化再開処理がP表示での登録操作にも先回りすることを確認した。USB経路と元の自動同期へ復帰済み。この試験は登録段階で止まっており、無介入での通常再接続試験は未実施。

この経路を分離する候補として、暗号化Native APIの応答付きactionで明示登録を予約する。対象アドレス・次のOPEN試行1回・30秒以内に限って自作の自動暗号化を待たせ、通知購読と明示pairへ進める。失敗・別機器へのOPENでも予約を消費し、通常同期の暗号化再開は維持する。鍵を消去・再発行する処理は加えていない。期限・再利用・別機器・不正アドレス・稼働中接続・時計の周回を含むC++境界試験と実ESP32ビルドが成功。HomeHubの連携はPR #39で分離する。通常再接続の97を修正済みとは判定しない。

PR #39を統合し、27件のPython試験、PR/main CI、Docker publishが成功。v0.3.26をQNAPへ反映し、healthの版・radio稼働・低I/O設定・SelfCare listener readyを確認した。firmware候補`c86bf58`の暗号化OTAと、実機Native APIの登録準備・解除の応答確認が成功。このAPI確認では体組成計へ接続していない。修正後の明示登録と通常再接続は引き続き未検証。

### v0.3.26での連続した登録・通常再接続

23:41 JSTの明示登録は`bonded:true`、`application_key_changed:false`で成功。HBF自動同期OFFとM5GO経路を維持したまま、ユーザーの電源OFF・15秒待機・短押し確認後、23:42:38〜23:42:45 JSTに通常同期を1回だけ実行した。監視は登録から同期終了まで別HBFジョブや設定変更を検出せず、`isolation_verified:true`を記録した。

結果は`authentication_failed`。接続番号2の記録はOPEN成功（1 ms）、保存bond確認（3 ms、mask 3・鍵長16・public・IRK/EDIV/RAND非ゼロ）、暗号化要求（4 ms）、認証97（102 ms）、bond数0（753 ms）、ローカル切断22（754 ms）。RSSIは-76 dBm。CCCD・Omronキー送信・履歴読取りに到達せず、履歴通知0件。**USB同期が途中に入らなくても、保存bondを使う暗号化再開の失敗を再現した。** 全ゼロIRKや単純なキー未保存の前提にも合わないが、保存鍵の内容が相手の保持鍵と一致することまでは検証していない。

USB経路と元のHBF自動同期に復帰し、SelfCare listener ready・busyなし・errorなしを確認した。以後の接続・登録・同期を予約していない。M5GOでの履歴取得と新規測定の自動保存は未達。次の観測には認証97へ変換される前のコントローラー側ステータスが必要で、同じ操作を同じ診断のまま繰り返さない。

### コントローラー側ステータスの限定観測

候補firmwareに`BLE Controller`診断を追加した。ESP-IDF 5.5.5の`btm_sec_encrypt_change`呼出しをリンク時に観測し、元の関数を元の引数で必ず1回呼ぶ。記録するのは接続番号・時刻・status・encr_enableだけで、handle・アドレス・鍵・パケット本文をキューへ渡さない。Bluetoothタスクでは確保・ログ出力・待機を行わず、8枠のlock-freeキューへ保存し、ESPHomeのmain loopから累積テキスト診断を更新する。あふれは明示し、接続番号が異なる記録は捨てる。通常の`BLE Session`形式と認証ガードは変更しない。

これはSDK内部関数への観測なので、コンパイル時にESP-IDF 5.5.5へ限定した。SDKを変える場合は再検証が必要。元関数への引数・呼出回数、無効時、上限超過、カウンター周回、別タスクからの10万回の記録、SDK版不一致の拒否をネイティブ試験で確認。実ESP32ビルドが成功し、ELF内のHCIイベント処理から観測関数、観測関数から元関数への呼出しも確認した。実ビルドはRAM 54.8%、flash 63.3%。これはコントローラーの実エラーを取得した証拠ではなく、OTAと実機診断は別に評価する。

候補`02f85bf`を暗号化OTAで反映し、実機から`BLE Session`と`BLE Controller`の初期状態（ともに接続番号0・イベントなし）を受信した。QNAPはv0.3.26を維持する。限定試験監視は登録成功後と通常同期後に両診断を暗号化APIから回収し、接続番号を照合する。登録時にコントローラーの暗号化成功イベントを確認できなければ、通常再接続へ進まず復帰する。まだ新診断で体組成計の接続・失敗原因を観測したとは判定しない。

### コントローラー診断による暗号化失敗の特定（2026-10-12 JST）

候補`02f85bf`の同一firmwareで、登録と通常再接続を各1回実行した。登録時は接続番号1、コントローラー記録`[[828,0,1]]`で暗号化成功を確認し、GAP認証成功・保存bondありで切断。Omronアプリキーは変更していない。

HBF自動同期OFFとM5GO経路を連続して保持し、00:02:46〜00:02:58 JSTに通常同期を1回実行。別HBFジョブの介入なし、診断の接続番号一致、overflowなしを確認した。接続番号2ではOPEN 1 ms、保存bond確認3 ms（mask 3、鍵長16、public、IRK/EDIV/RAND非ゼロ）、暗号化要求4 ms、**コントローラーstatus 6・暗号化無効58 ms**、GAP認証97 78 ms、bond数0 2204 ms、切断22 2205 ms。RSSI -65 dBm。CCCD・Omronキー送信・履歴読取り前に失敗し、履歴通知0件だった。

`0x06`は[Bluetooth公式仕様のPIN or Key Missing](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-54/out/en/architecture%2C-mixing%2C-and-conventions/controller-error-codes.html)。実SDK 5.5.5の`hcidefs.h`も`HCI_ERR_KEY_MISSING`と定義する。これで従来のGAP97より下位のエラーを確認できた。ただし、体重計が対応鍵を保持していない原因や、ESP32が再開時に使う鍵・識別情報の正しさまでは確定していない。BLEの暗号鍵と既存Omronアプリキーを混同しない。

通常利用で毎回のペアリングを要求する仕様にはしない。今回の反復は暗号化失敗後にESP-IDF側のbondが消える異常経路の診断であり、解決策ではない。監視終了時にUSBと元のHBF自動同期ONへ復帰し、SelfCare listener ready・busyなし・errorなしを確認した。非公開証拠は`secrets/m5go-controller-isolated-result.json`と`secrets/controller-trial-restored-listener.json`。PR #36はdraftを維持し、通常再接続・履歴取得・自動保存は未達。

次の候補は、BLE登録直後に切断する現在の処理と、同一接続で既存キーによるunlock・通信開始・正常終了まで行う処理の差である。HBF対応openScaleでは登録後にアプリ通信へ進むが、今回の条件でそれがbond保持に必要という証拠はまだない。実験する場合は既存キーのみ、認証成功後のみ、開始/終了の応答を確認して1回で停止する。キー再発行や他型番のEEPROM書込みは行わない。未実装・未検証であり、同じ登録操作の再依頼はまだ行わない。

### 同一接続で登録と既存キー認証を行う候補

PR #40は、管理APIで対象の次のM5GO同期1回だけBLE登録を許可する操作を追加する。予約は120秒で失効し、ワーカー開始前に消費する。失敗後の同期、予約のない通常同期は登録しない。SelfCareが同期要求に含める既存キーを使用し、同じGATT接続でBLE認証→アプリ認証→履歴読取り→正常終了まで進む。SelfCareのコードやキー保管方式は変更しない。現在の接続の暗号化を確認できないfirmwareではGATT接続前に停止する。

32件のPython試験とNode 24での36件のTypeScript試験・型検査が成功。キー再発行なし、暗号化成功前のキー送信なし、通信終了失敗を成功扱いしないこと、期限・1回消費・設定変更/解除・別機器・要求側からの登録フラグ偽装を試験した。PR CI/Docker実行`38150260370`が成功し、main `d0dc28d`へ統合した。この候補での実機登録セッション・通常再接続はまだ未検証。firmware候補`02f85bf`を維持してQNAP側の処理だけを比較する。PR #36の次候補版はv0.3.28へ移し、draftを維持する。

ローカルの限定監視も、登録時のSelfCareジョブが完了し、既存キー応答`8100`、同一接続の暗号化成功、通信終了opcode 15、予約消費を確認した場合だけ次の通常再接続へ進むよう更新した。登録と通常同期の間はHBF自動同期OFFを保持し、他HBFジョブ・設定変更・期限切れで中止する。終了時に予約解除・USB・元の自動同期を復帰する。監視の10件の試験は成功。これは実機同期成功の証拠ではない。

main CI `38150455024`とDocker公開`38150455019`が成功。タグv0.3.27が検証したmain `d0dc28d`を指すことを照合し、QNAPへ反映した。updaterはversion 0.3.27・success・busy false。health ok、radio available/running/lowIo true、USB経路、API接続、予約pending false、SelfCare listener ready・busyなし・errorなしを確認。設定・診断の稼働確認であり、体重計との登録セッションはまだ開始していない。

### v0.3.27の同一接続での登録・履歴試験結果

2026-10-12 00:22:03〜00:22:10 JST、ユーザーの新しいP表示確認後に登録付き同期を1回だけ実行した。HBF自動同期OFF・M5GO経路を維持し、別HBFジョブの介入なし。接続番号3のコントローラー記録は`[[834,0,1]]`で、GAP認証成功983 ms、保存bond確認987 ms、既存キーのcharacteristic書込み3898 msを記録した。診断は`explicit_bond_session:true`、`link_security:authenticated`、`stage:unlock`、**応答`8101`**。履歴通知0件、通信開始・履歴読取り・通信終了には到達しなかった。

これにより、この条件では「BLE登録した同じ暗号化接続で既存キーのopcode 1認証を行えば履歴へ進める」という仮説は成立しなかった。以前の暗号化失敗`0x06`とは異なり、暗号化成功後のアプリ認証拒否を確認した。キー本体を出力せず、キー再発行・登録opcodeへのフォールバック・設定EEPROM書込みは行っていない。切断直前にもbondメタデータは存在した。通常再接続の追加試験は開始していない。

予約解除、USB、元の自動同期ONへ復帰し、予約pending false、API接続、SelfCare listener ready・busyなし・errorなしを確認。非公開証拠は`secrets/m5go-bond-session-isolated-result.json`と`secrets/v0327-after-registration-listener.json`。監視プロセスは終了している。同じP表示試験は繰り返さない。次はHBF固有のアプリキーと接続元の登録条件を調べる。USBで有効なキーがM5GOでも使えること、同じ値の再登録で既存USB接続を保持できることのいずれも未証明。M5GO履歴取得・通常再接続・新規測定自動保存は未達。

### v0.3.28のHBF通知順序候補

PR #41でM5GO専用のHBF Sessionを追加。認証前はRX0とunlockを購読し、BLE認証後にRX1〜3の残存CCCDをOFFへ揃えてから既存キーを送る。`8100`を確認した場合だけunlockのCCCDをOFFへ書き、ローカル通知転送を解除、RX1〜3を順に有効にして履歴へ進む。各記述子の書込み応答を待つ。認証拒否やCCCD書込み失敗では履歴を開始しない。USB Session・キー・履歴解析・SelfCareは変更しない。

HBF-222Tの実測報告が根拠で、HBF-228Tの`8101`を解消する証拠ではない。使用中のESPHome/bleak-esphomeソースでは通知転送の解除だけでは体重計のCCCDが変わらないため、明示的な記述子書込みを用いる。38件のPython試験、PR CI/Docker `38151752116`、main CI `38151966714`、Docker公開`38151966738`が成功。タグv0.3.28は検証済みmain `dccc4f0`と一致。firmware `02f85bf`は維持する。次の隔離試験はこの通知順序だけを比較し、同じ認証拒否なら停止する。実機履歴取得・通常再接続・新規測定自動保存は未達。PR #36の次候補版はv0.3.29、draftを維持する。

QNAPへのv0.3.28適用が完了し、updater success・busy false、health ok、radio available/running/lowIo true、USB経路、予約pending false、API接続、SelfCare listener ready・busyなし・errorなしを確認した。次の限定監視は`secrets/watch-staged-notify-isolated.py`。v0.3.27の監視から変更したのは版確認と証拠ファイル名だけで、登録付き同期1回・成功時のみ通常同期1回・期限・他ジョブ監視・復帰条件を維持する。新しいP表示のユーザー確認前には登録・履歴処理を実行しない。

### v0.3.28実機結果と通知停止APIの修正

2026-10-12 JSTの再開試験では、保存bondがある接続番号4は通知設定中にコントローラーstatus 6、GAP認証97で失敗し、Omronキーを送信していない。終了時はbond数0。新しいP表示確認後の接続番号5では保存bondなしからBLE登録・暗号化に成功（controller status 0、encryption enabled 1）したが、`prepare_unlock_notifications`段階で`ValueError`となった。キー送信・履歴取得は未実施。各試験終了後にUSB・元の自動同期ONへ復帰した。

原因は、[Bleak 3の公開API](https://bleak.readthedocs.io/en/latest/api/client.html#bleak.BleakClient.write_gatt_descriptor)がCCCD直接書込みを禁止すること。v0.3.28の模擬機器テストはこの制約を再現しておらず、検証不足だった。v0.3.29は公開`stop_notify()`を使い、ESPHome専用backendで機器側CCCDのOFF書込み応答を待ってから通知転送を解除する。未購読のRXでも残存CCCDをOFFにし、応答失敗時は後続のキー送信・履歴処理を進めない。USB backendやOmronキーの扱いは変更しない。

回帰試験は実Bleak 3.0.2・bleak-esphome 4.1.0・実サービス/記述子モデルを通し、v0.3.28の処理が同じCCCD `ValueError`で失敗することを再現。修正後は既存キー送信前後のCCCD順序、書込み応答待ち、失敗時の通知転送保持、未購読・記述子欠落・切断状態を確認した。全41件のPython試験が成功。Bluetooth通信自体は模擬APIなので、HBF-228Tの認証・履歴取得・自動保存成功とは判定しない。

### v0.3.29の実機試験と通常通信での対照確認

ユーザーの「解除して進めて」を受け、M5GO内のHBF試験bondへの解除要求を1回送信した。別のNative API接続から送ったため、広告購読先のQNAPへ応答を送るESPHome実装により操作側はタイムアウトした。再送せず、次のOPENのbond数0で解除状態を確認した。QNAP BlueZの登録やOmronアプリキーは変更していない。

新しいP表示で接続番号6の登録付き同期を1回実行。BLE暗号化はcontroller status 0/enabled 1、GAP認証成功。v0.3.29のRX1〜3 CCCD OFF書込みも全て応答成功。その後の既存キーopcode 1は`8101`で拒否され、履歴通知0件。したがって通知順序の修正だけでは、このPモードでの拒否を解消しなかった。

ユーザーの指摘により、Pモードと通常通信モードの比較条件を改めた。Pモードの`8101`だけでアプリキーの失効や接続元との紐付けを断定しない。新しい短押し確認後、USB通常同期1回が`done`、`8100`、履歴通知93件、正常終了opcode 15、`stage:completed`で成功。これは93測定という意味ではない。最後のM5GO登録後もUSBで既存キーが有効であることを確認した。

続く新しい短押し確認後、M5GO通常同期を再ペアリングなしで1回実行。接続番号7ではOPEN 1 ms、保存bondあり3 ms、暗号化要求4 ms、controller status 6/enabled 0が53 ms、GAP97が69 ms。通知設定・Omronキー送信・履歴読取り前に失敗した。USB同期がM5GO登録後に介在しているため、今回を無介入のbond保持試験とは扱わない。ただし通常モードでも失敗すること、アプリキーの拒否より前のBLE暗号化が失敗段階であることは確認した。

各試験終了後はUSB経路と元の自動同期ONへ復帰し、最後にAPI接続・予約pending false・SelfCare listener ready/busy false/errorなしを確認。次の物理試験や解除は予約していない。非公開証拠は`secrets/m5go-cccd-backend-isolated-result.json`、`secrets/v0329-usb-key-validity-trial.json`、`secrets/m5go-v0329-normal-only-result.json`。

なおローカルの試験監視に、SelfCareの成功ジョブ状態を`completed`と誤認する不備も見つかった。実APIの成功値`done`へ修正し、成功時のみ次段階へ進むこと、`8101`拒否時の停止・復帰を含む11件の模擬試験が成功。今回の実機ジョブは実際に`failed`であり、この監視不備が認証失敗の原因ではない。

## ローカル再検証

v0.3.26は診断firmwareへの明示BLE登録前に、応答確認付きの`prepare_ble_bond` API actionを呼ぶ。firmware側は対象機器・次のOPEN試行1回・30秒以内に限り、自作コンポーネントの接続直後の暗号化要求を待たせる。これによりP表示で既存bondの再開が登録処理へ先回りする経路を分離する。通常同期はこのactionを呼ばず、暗号化成功ガードを維持する。actionの欠落・不正な定義・拒否・応答タイムアウトではGATT接続前に停止する。API終了時に予約を解除し、通信断時も時間と接続回数で失効する。Omronキー再発行、bond削除、EEPROM書込みは追加しない。実験firmwareは引き続き別のdraft PRで管理し、この変更だけでHBF再接続・履歴取得成功とは判定しない。

v0.3.25では、`BLE Session`診断を持つ実験firmwareに限り、履歴読取り前に今回の接続の暗号化成功を確認する。接続前の診断番号を基準に次の接続だけを受け付け、古い成功状態、認証失敗、切断、診断の欠損・逆行、タイムアウトではOmronキーを送らず終了する。診断のない既存firmwareは従来動作を維持し、`journal_unavailable`を記録する。このガードは暗号化失敗そのものの修正でも、実機同期成功の証拠でもない。

診断には接続・CCCD・認証の順序とbondの種類・長さ等のメタデータだけを含める。鍵本体・MACアドレス・測定値を含めない。初期接続数1とradio共通排他を前提に、別接続が割り込んだ場合は番号不一致で停止する。BLE登録は引き続き明示操作のみ。

PR #36候補に接続ごとの`BLE Session`累積診断（最大24イベント）を追加。APIの状態更新がまとめられても過去イベントを保持する。GATT OPEN、保存bondのkey mask/長さ/アドレス種別とゼロ値判定、暗号化要求、認証結果、CCCD書込み結果、最初のcharacteristic書込み結果、切断を記録する。鍵・アドレス・GATT payloadは出力しない。C++境界試験、実firmwareビルド、暗号化OTAが成功し、実機から`seq:0`の初期診断を受信。RAMはビルド時54.5%、flashは62.9%。これは再接続成功の証拠ではない。QNAP側ガードはPR #38で分離し、v0.3.25として公開。実験firmwareの次候補版はv0.3.27、PR #36はdraftのまま。

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

## v0.3.30：USB共通のOmron登録処理

ユーザーのUSB比較・継続指示を受け、PR #43でアプリ登録専用の1回予約を追加。既存キーの値を使い、USBの `Session.subscribe()` / `Session.pair()` を共用する。登録モードでは全RX購読、現在のBLE暗号化、8200、8000、通信開始・正常終了まで確認し、履歴は読み取らない。通常syncへの自動フォールバック・キー新規生成・bond削除は追加していない。

SelfCareのsync要求を使って既存キーを渡すため、登録成功時は空の履歴配列を返す。HomeHubは `lastRegistration` と `lastSync` を分離。SelfCare側は0件追加の成功ジョブとなり、待ち受け成功時刻を更新する。直後の通常再接続・USB比較は手動syncで行い、自動保存試験は既存の1時間の抑制期間後に行う。コード・スキーマ・抑制時刻DBは変更しない。

47件のPython試験、38件のTypeScript試験、Node 24型検査・ビルドが成功。USBとM5GOの登録送信バイト列・通知順序の完全一致、認証拒否・不確実なキー書込み・キャンセル・暗号化失敗・終了失敗での停止、予約期限・消費・偽装フラグ無効化・結果の区別を確認した。PR CI `38185106336`、main CI `38185254171`、Docker公開 `38185254187` は成功。タグv0.3.30はmain `a5728ae6c6842a75ba56e5ac4aa7e28f2c686b12` と一致する。実験firmwareは `02f85bf` のまま。

実機登録・通常再接続・USB登録の保持は未検証。限定監視 `secrets/watch-usb-registration-isolated.py` とその11件の模擬試験を準備済み。新しいP表示確認までOmron登録を行わない。登録成功を履歴取得成功とは扱わず、8200/8000/開始・終了と暗号化・予約消費が確認できた場合だけ次の通常転送へ進む。

QNAP v0.3.30反映後、updater success/busy false、health ok/version 0.3.30、radio available/running/lowIo true、USB経路、M5GO API接続、予約pending false、SelfCare listener ready/busy false/errorなしを確認。これは実機の体組成計登録成功ではない。

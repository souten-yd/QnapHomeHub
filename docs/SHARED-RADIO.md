# USB BluetoothとQnapHomeHubの共用

## 方針

Web画面・ポート・記録DBは分離し、Bluetoothの制御だけを共通の `qnaphomehub-radio` コンテナへ集約します。ESP32・Home Assistantは不要です。QNAPのUSBドングルを使用します。

SelfCareの利用頻度が高いため、通常はコンテナ内の新しいBlueZを維持します。HomeHub操作ではBlueZの終了を待ち、既存のSwitchBotManagerを専用子プロセスで実行します。操作後にそのプロセスを終了し、BlueZを再開します。進行中の測定同期を強制中断しません。依頼は直列化し、待機が60秒を超えた操作は実行せず失敗させます。古いSwitchBot押下が後から実行されることを避けます。

両Webサービスが停止しても、もう一方はradioを利用できます。radio停止中は両方のBLE操作が失敗しますが、Webと保存済みデータは利用できます。共通化はこれら2アプリ間の競合を防ぐもので、別のホストBluetoothサービスを自動停止するものではありません。

| 項目 | 設定 |
| --- | --- |
| SelfCare Web | `http://NAS:17863/` |
| HomeHub Web | `http://NAS:8787/` |
| radioソケット | `/share/Container/QnapHomeHub/data/radio/ble.sock`（所有者のみアクセス） |
| adapter | HomeHubのHCI番号とSelfCareの `hci0` 等を一致させる |
| BlueZのキー | HomeHubの `data/bluetooth/` で永続化 |
| SelfCare側キー | SelfCare DB・`config/`（API/JSONバックアップへは出さない） |

## HomeHub 0.2.xから初回移行

これは新しいComposeサービスの追加を伴うため、既存のWeb更新でイメージを更新するだけでは完了しません。NASのSSHで実施します。既存の `data/`・`secrets/` と現在の `compose.yaml` をバックアップしてください。

1. `cd /share/Container/QnapHomeHub` で旧HomeHubを停止します。

   ```sh
   docker compose stop homehub
   ```

2. Git導入なら `git pull --ff-only`、ZIP導入なら0.3.0のリリースZIPを別の場所に展開し、新しい `compose.yaml` と `docker/`・`scripts/` を配置します。既存の `data/` と `secrets/` は保持します。カスタムCompose設定がある場合は新旧を比較して反映します。
3. イメージを取得して起動します。

   ```sh
   docker compose pull
   docker compose up -d radio homehub updater
   docker compose ps
   docker compose logs --tail=80 radio
   ```

4. HomeHub管理画面のBluetooth状態に共通サービスが表示されることを確認し、既存Botの状態取得・押下を確認します。次にSelfCareを導入・更新します。

旧Nobleを動かしたままradioを先に使用しないでください。同じドングルを使用する旧SelfCare専用Bluetoothコンテナや他のBLEスキャンも停止します。QNAPホストのBluetoothデーモンが同じドングルで処理している場合も競合対象です。既存のNASサービスを無条件に停止する処理は含めていません。

ロールバックするときはSelfCareの自動同期をOFFにして `docker compose stop radio homehub`、退避した旧Composeを戻し、旧バージョンのserverイメージを指定してHomeHubを再起動します。`data/bluetooth/` やSelfCare DBは削除しません。

## Omron登録

1. SelfCareの設定で利用者を追加します。
2. 機器側のペアリング操作を行い、SelfCareで「共通Bluetoothサービス」を選んでスキャンします。スマートフォンの同時接続は避けます。
3. 型番、MACアドレス、HCI、機器内の利用者番号とSelfCare利用者の対応を保存します。日本時間の機器時計は時差540分です。
4. 機器をペアリングモード（HEMの「-P-」表示）にして「ペアリング」を実行します。
5. 通信可能な状態で「履歴を同期」し、実際の測定日時・値・利用者を比較します。
6. 確認後に自動同期をONにします。HomeHub操作後に次の測定も保存されることを確認します。

既存アプリとのペアリングを変更するので、移行前に必要な履歴を保存してください。初回読取、両機種の全利用者スロット、二重取得の重複排除、再起動後の鍵維持、SwitchBot復帰はNASでの最終確認項目です。実機接続成功はまだ報告されていません。

## HomeHubを使わない場合

同梱の専用BLEコンテナを使う場合:

```sh
cd "$(/sbin/getcfg QnapSelfCare Install_Path -f /etc/config/qpkg.conf)"
docker compose -f bluetooth/compose.yaml up -d --build
```

SelfCareで「直接接続」を選び、ドングルを専用に使う確認をONにします。BlueZ対応USBドングルとContainer Stationが必要です。共通radioと専用コンテナを同時起動しません。BlueZは複数のHCIを認識するため、別ドングルでもBlueZデーモンの二重起動は避けます。QPKGを更新した場合は上記コマンドで専用コンテナも再ビルドします。

NAS本体に対応するBlueZ/D-Busがある場合は `sh scripts/install-ble.sh` でPython依存だけを追加し、ネイティブ直接接続を使えます。古いQNAPのBlueZ 4.xはこの経路の対象外です。共通radio/専用コンテナは新しいユーザー空間BlueZを同梱しますが、NASカーネルの対応も必要です。

## 診断

SelfCareの「設定・バックアップ → 診断」と操作履歴、HomeHubのBluetooth状態、`docker compose logs --tail=100 radio` を確認します。スキャンは完了するがOmronが出ない場合は機器の通信モードを確認します。`SelfCare adapter must match...` はHCI設定の不一致です。ソケット未検出はComposeサービス未起動またはパス相違です。

HomeHubの配置を変更した場合、SelfCare起動時の環境変数 `SELFCARE_HOMEHUB_SOCKET` で実際のソケットを指定します。既定QPKG起動では標準配置を使います。radioの状態応答はサービスの生存確認であり、実機接続の成功を示すものではありません。

## SelfCareの診断付きペアリング・同期（HomeHub 0.3.2以降）

SelfCare 0.3.7から診断を指定した手動ペアリング・同期ではradio内のPythonワーカーが接続・ペアリングモード・キー設定・履歴読取の段階と、各利用者番号の有効・空・無効件数を返します。0.3.2から直近8件のコマンド応答と、受信途中で時間切れになった断片も返します。応答の生データには測定値が含まれ得ます。キーやBluetoothのbond情報は含めません。通常の自動同期に診断用データは付けません。SelfCareの更新だけではradioイメージは更新されないため、機器応答の表示にはHomeHub側のradioも0.3.2へ更新してください。


### 通信開始の修正（HomeHub 0.3.4 / SelfCare 0.3.11）

HEM-6232Tのキー登録後に同じキーで認証してから通信開始し、開始は8バイトの短い応答または24バイトの機器情報付き応答、終了は8バイトの応答として検証します。0.3.3の開始応答を8バイトだけに制限していた問題を修正しました。RX通知を先に購読して待ち時間を設け、TXはGATTの書込み属性に合わせます。接続中かつ受信断片がない通信開始の時間切れだけを1回再試行します。診断には `protocol_revision: 3`、送信方式、RX通知数、時間切れ時の接続状態を返します。キー登録や履歴読取の再試行、測定EEPROMの書込みは追加しません。実機での結果は更新後にSelfCareの診断付きペアリングで確認してください。

### 広告待ち受け（HomeHub 0.3.5 / SelfCare 0.3.14）
SelfCareの機器設定で待ち受け／周期検索を個別に選択します。共通接続の初期値は待ち受けです。radioの `/watch` はUnixソケット限定で、アダプターと最大32件の登録アドレスを受け取り、受信イベントを返します。常駐Pythonリスナーは対象アドレスの広告のみ通知し、接続・ペアリング・健康データ読取りは行いません。

raw HomeHub操作と通常のSelfCare処理の前にリスナー終了を待ち、idle時のみ再開します。例外としてHomeHub 0.3.10以降は、待ち受け広告を契機にしたHBF-228T同期（`action=sync`、`advert_at`あり）だけ同じBlueZ上の広告リスナーを維持して接続します。HCIの所有権やBlueZ daemonを増やすものではなく、HEM-6232T・手動同期・ペアリング・HomeHub操作は従来どおり排他的です。設定更新は60秒のリースで、SelfCare停止時にはリスナーも止まります。`/health` のwatchSupported/watchReady/watchErrorで状態を確認できます。NAS起動状態と広告が届く電波環境が必要で、Bot処理中の検知空白はあります。SelfCare側で既存の最短間隔とジョブ排他を維持します。

### 登録済み機器への直接接続（HomeHub 0.3.6 / SelfCare 0.3.23、HomeHub 0.3.9 / SelfCare 0.3.25改善、HomeHub 0.3.10 handoff修正）
履歴同期では、ペアリング済みでBlueZに登録されている機器を最大20秒の検索で探し直しません。そのD-Busオブジェクトへ直接接続します。BlueZは次の接続可能な広告で接続するため、リスナーが検知した広告の直後に検索で1回、接続でもう1回広告を待つ必要がありません。BlueZに機器がない場合、または新規ペアリングでは従来どおり検索します。直接接続で接続可能状態にならなければ未検出として扱います（`stage: connection`）。SelfCare待ち受け由来のHBF-228Tは8秒で区切り、次の新しい広告をSelfCare側の再試行契機にします。0.3.10ではその広告を検知したwatcherを接続開始前に停止せず、同じBlueZ discovery sessionを維持したままworkerへ引き継ぎます。手動同期・ペアリング・HEM-6232Tは従来どおり20秒です。

SelfCareは待ち受け同期の依頼にradioの広告受信時刻 `advert_at`（ミリ秒）を添えます。診断には次の値を返します。

- `elapsed_since_advert_ms`：広告受信から接続処理を始めるまでの時間
- `discovery_method`：`bluez_cache` または `scan`
- `discovery_ms`、`connect_ms`、`discovery_timeout_s`：検索・接続に要した時間と上限
- `connection_timeout_s`、`connect_error`：接続待ち上限と失敗種別
- `watch_preserved_for_connect`：待ち受け由来HBF同期で広告watcherを接続中も維持したか
- `bluez_cached`：BlueZ object path、AddressType、Connectable、RSSI、Paired/Bonded/Trusted、Connected、ServicesResolved等

HomeHub 0.3.11以降は `/watch` の各イベントに、RSSIに影響されない広告fingerprint、RSSI、広告payloadの診断情報を返します。fingerprintは manufacturer data・service data・service UUID・local name・tx power から生成し、新しい測定の確定判定には使いません。SelfCare側で実機比較と広告バースト抑制の診断に利用します。測定値や鍵は追加しません。

### NAS再起動後のBluetooth復旧（HomeHub 0.3.12）

QNAP起動直後はUSB HCIのカーネル初期化とContainer Stationのradio起動順が前後する場合があります。radioはBlueZを起動する前に選択した `hciN` が `/sys/class/bluetooth` に現れ、`hciconfig hciN up` が成功するまで最大30秒待ちます。待ち受け自体が動作していてもHBF-228Tの接続だけが `TimeoutError` を連続する場合は、同じradioプロセス内で2回連続したHBF connection timeoutを復旧条件とし、watcher停止 → コンテナ内BlueZ停止 → HCI down/up → BlueZ再起動を1回実行します。これはホストQTSのBluetoothサービスを停止する処理ではありません。

復旧はHBF-228Tの待ち受け同期に限定し、HEM-6232T・手動同期・正常な接続・read/session失敗には適用しません。radio `/health` の `radioRecoveryCount`、`lastRadioRecoveryAt`、`consecutiveHbfConnectionTimeouts` で復旧発生を確認できます。


### HomeHub 0.3.13: 自動HCIリセット停止
HBF-228Tの接続タイムアウトだけではHCI/BlueZを再起動しません。接続失敗は `radio_failure_category` と `automatic_hci_reset: false` に記録します。起動時のHCI readiness確認・watcher維持・通常のradio排他は維持します。v0.3.12の自動復旧説明は履歴であり、0.3.13では無効です。

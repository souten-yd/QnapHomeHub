# QNAP新規導入・再インストール時のBluetooth競合／HDD低I/O確認手順

> **対象**: QTS 5.x + USB Bluetoothドングル + **Docker版QnapHomeHub（専用BlueZ / `bluezMode: private`）** + QnapSelfCare QPKG の共通radio構成。
> **目的**: SelfCareの血圧・体組成のSQLite永続保存とSwitchBot BLE操作を維持し、**QNAPホスト側の不要な`bluetoothd`による連続ディスク書き込みを抑える**。
> **2026-10-11実機確認済み**: 一台のQNAPで、永続設定変更後のNAS再起動、Docker専用BlueZの起動、radio待ち受け、低Write IOPSを確認。**ほかのQTS版／機種での成功は未保証**。

## まず読む：判断と禁止事項

- **QNAP標準BlueZを削除しない。** `/etc/init.d/bluetooth.sh uninstall`はBluetooth保存データを消去し、`btusb`等のカーネルモジュールを取り外し得る。DockerもホストのBluetoothカーネルドライバーを共有する。
- **`/etc/init.d/bluetooth.sh stop`を実行しない。** 対象QTSの実装は`pidof bluetoothd`でPIDを集めて`kill -9`するため、**Docker内の`bluetoothd`まで巻き込むおそれがある**。
- `killall bluetoothd`、`pkill bluetoothd`、`rmmod bluetooth`、`rmmod btusb`、`rm -r /var/lib/bluetooth`、`rm -r .system/bluetooth`も使わない。
- **NASがQNAP側Bluetoothを別用途（キーボード／HID／オーディオ／QTS連携など）で利用する場合は設定を変えない。**「Bluetooth HID」というアプリ名だけからホスト`bluetoothd`と同一とは断定しない。
- ホストBlueZ共用の実験モード（`compose.host-bluez.yaml`）は本手順の対象外。通常運用は**Docker内の専用BlueZ**。HomeHubのQPKGプレビュー版も対象外。
- `radio`が停止するとSwitchBot操作とSelfCare Bluetooth同期は一時停止するが、**SelfCareの測定履歴・DBは削除しない**。永続化する`data/bluetooth/`（ペアリング鍵）とSelfCareのDB／バックアップは保持する。

## 1. 初回の構成・起動確認（**変更なし**）

1. QTS／Container StationとUSBドングルの認識を確認。HomeHub Docker Webを起動し、SelfCareが`qnaphomehub-radio`の共有ソケットを使う構成にする。
2. QNAP SSHで以下を実行。QNAPの`ps`はBusyBox版の場合があるため`ps -p ... -o ...`は使わない。

```sh
echo '=== CONFIG ==='
/sbin/getcfg Bluetooth Enable -u -d TRUE
/sbin/getcfg Bluetooth Enable -u -d UNSET -f /etc/config/uLinux.conf
/sbin/getcfg MultimediaStation Bluetooth -d UNSET -f /var/.application.conf
/sbin/getcfg Bluetooth Enable -u -d UNSET -f /etc/config/qpkg.conf

echo '=== PROCESSES ==='
ps | grep '[b]luetoothd'

echo '=== DOCKER ==='
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep qnaphomehub

echo '=== RADIO REAL CONFIG ==='
docker inspect -f 'running={{.State.Running}} log={{.HostConfig.LogConfig.Type}} tmpfs={{json .HostConfig.Tmpfs}}' qnaphomehub-radio
```

3. `/usr/libexec/bluetooth/bluetoothd --nodetach`は**HomeHub radio側候補**。`/usr/sbin/bluetoothd`は**QNAPホスト側候補**。PIDを決め打ちしない。判別が必要なら各PIDについて`sudo readlink /proc/PID/exe`と`sudo cat /proc/PID/cgroup`で所属を確認する。実機のQNAPバイナリ実体は`/mnt/ext/opt/bluetooth/usr/sbin/bluetoothd`で、ホスト側cgroupは`/`、Docker側は`/docker/...`だった。ほかのNASでは異なる可能性あり。
4. Web管理画面の**Bluetooth radio 管理**で稼働中・`Docker log: none`・`D-Bus RAM / TMP RAM`を確認。未適用の場合は**省書き込み起動**（既存radio停止確認後に**radioだけ**再作成）。`/var/lib/bluetooth`は永続データのためRAMへ移さない。Web切替が`Not found`なら古いupdaterが残っている可能性がある。[Web radioの更新／復旧](WEB-RADIO-LOW-IO.md)参照。
5. HomeHub管理画面で**「15秒テストしてログ生成」**を実行。これはNAS**全体**の物理ディスクカウンタであり、Bluetoothプロセス単独の書き込みではない。RAID1の`sda`／`sdb`は**各HDDを別々に評価し合算しない**。できれば安定時に複数回測定する。

### 初回の判断

| 状態 | 判断と次の行動 |
| --- | --- |
| `bluetoothd`がDocker側1個だけでWrite IOPSも低い | **設定変更不要**。手順3へ |
| QNAP側とDocker側の2個が同時起動し、アイドルでもWrite IOPSが高い | 機器動作・QTS依存関係を確認して手順2へ |
| Write IOPSが高いがホスト側`bluetoothd`がいない | 原因は未特定。HomeHub診断・DiskInspectorでプロセスを再調査。QNAP BlueZ設定を無条件に変えない |
| QNAP標準BluetoothをほかのアプリやHIDが利用 | **停止しない**。ドングル分離・必要機能の見直しを優先 |
| `hci0`が存在しない／radio自体が起動しない | USB・カーネルドライバー・起動順を調査。QNAPドライバーをアンインストールしない |

## 2. QNAPホスト側BlueZの永続的な起動抑制（**対象機で必要な場合だけ**）

対象QTSの`/etc/init.d/bluetooth.sh`の`start()`では、`MultimediaStation Bluetooth`に加え、`getcfg Bluetooth Enable -u -d TRUE`が起動判定に用いられていた。`Bluetooth Enable`が**未設定**だと`-d TRUE`により有効と扱われる。以前試した`/var/.application.conf`の`MultimediaStation Bluetooth=FALSE`は、NAS再起動時に`TRUE`へ戻った。

**対象機で実証済みの対処は、`/etc/config/uLinux.conf`に`Bluetooth Enable=FALSE`を明示すること。**これはQTSの起動可否判定を抑制するもので、コンテナのBlueZ／USBドライバーは削除しない。

```sh
# 変更前を控える（標準の /etc/config/uLinux.conf を読む）
/sbin/getcfg Bluetooth Enable -u -d UNSET -f /etc/config/uLinux.conf

# 対象NASがホスト側Bluetooth不要と確認した場合だけ実行
sudo /sbin/setcfg Bluetooth Enable FALSE -f /etc/config/uLinux.conf

# すぐ検証
/sbin/getcfg Bluetooth Enable -u -d TRUE
/sbin/getcfg Bluetooth Enable -u -d UNSET -f /etc/config/uLinux.conf
```

両方とも**`FALSE`**であること。`-u`は大文字化、`-d`はキー未登録時のデフォルト指定。`getcfg Bluetooth Enable -u -d FALSE -f /etc/config/qpkg.conf`が`FALSE`と返しても、QPKG設定が実際に無効化された証拠にはならない（キー`UNSET`でもデフォルト値`FALSE`を返す）。

**この設定だけでは今動作中のホスト`bluetoothd`は終了しない。** 安全な通常運用ではQTS画面からNASを通常再起動して反映する。設定が拒否された／QTS起動スクリプトが異なる場合はここで中止し、先にそのNASの起動条件を調べる。別経路の`btstart`等で強制起動される環境には効果がない場合がある。

## 3. NAS再起動後の合格条件

以下を再実行する。

```sh
echo '=== PERSISTENT BLUETOOTH ==='
/sbin/getcfg Bluetooth Enable -u -d TRUE
/sbin/getcfg Bluetooth Enable -u -d UNSET -f /etc/config/uLinux.conf
echo '=== BLUETOOTHD ==='
ps | grep '[b]luetoothd'
echo '=== HOMEHUB CONTAINERS ==='
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep qnaphomehub
echo '=== RADIO LOW-I/O ==='
docker inspect -f 'running={{.State.Running}} log={{.HostConfig.LogConfig.Type}} tmpfs={{json .HostConfig.Tmpfs}}' qnaphomehub-radio
```

- [ ] 両`Bluetooth Enable`確認値が`FALSE`のまま。
- [ ] **QNAP側**`/usr/sbin/bluetoothd`は不在（`ps`にDocker側`/usr/libexec/... --nodetach`だけ）。
- [ ] `qnaphomehub-radio`・`qnaphomehub`が稼働。radio診断は`bluezMode=private`、`watchReady=true`、`pending=0`等。これは待ち受け準備であり**実機接続の成功証明ではない**。
- [ ] `radio`のDockerログドライバーが`none`、`/run/dbus`と`/tmp`がtmpfs。※Docker Composeの変更は既存コンテナを**再作成するまで**反映されない。
- [ ] Webの15秒ディスク診断でアイドル時Write IOPSが大幅に減っている。QTSディスク監視とともに複数回確認。
- [ ] HomeHub WebでSwitchBotの実際の操作が成功。
- [ ] SelfCareでHEM（血圧計）とHBF（体組成計）を**手動同期**し、実際の測定日時・値がSelfCareのSQLite履歴に記録されたことを確認。保存済み履歴は削除しない。自動待ち受けも必要に応じて再確認。
- [ ] 数日運用・QTSアップデート後も、ホストBlueZの復活／HDD書き込み再増加がない。

## 4. 実機事例：2026-10-11（診断の根拠）

一台のQNAP QTS 5.x、RAID1、同じUSB BluetoothドングルとSelfCare共通radioで観測（**他機種への値の保証ではない**）。

| 比較条件 | 各HDDのWrite IOPS | 各HDDのWrite MB/s |
| --- | ---: | ---: |
| QNAP標準`bluetoothd`とDocker専用BlueZの二重稼働 | 約83.84 | 約1.781 |
| QNAP標準`bluetoothd`を10秒だけ`SIGSTOP`、Docker側は稼働 | **約2.70** | **約0.025** |
| ホスト`bluetoothd`を終了後 | 約5.64 | 約0.055 |
| 永続設定`FALSE` → NAS再起動後（HomeHub v0.3.17） | **約2.533** | **約0.016** |

- プロセス別ランキングではQNAPホストの`bluetoothd`が約1,618 KB/sを記録。その実行ファイルは`/mnt/ext/opt/bluetooth/usr/sbin/bluetoothd`。
- ホスト側`bluetoothd`の`/share/CACHEDEV1_DATA/.system/bluetooth/<adapter>/lastseen`は約305KBで毎秒更新。10秒の測定で`bluetoothd`の書き込み約1,242 KB/s／`lastseen`更新10回を観測。**全書き込みがこのファイルに向かったことまでは証明していない**。
- ログ無効化／D-BusとTMPのRAM化**だけ**では、ホスト側`bluetoothd`による約75〜85 IOPSは改善せず。Docker radioを停止すると約3.3 IOPS、ホスト側だけを一時停止すると約2.7 IOPSへ低下したため、ホスト側`bluetoothd`が主要因と判断。
- QNAP側を一時停止中、SwitchBot操作とSelfCare同期は実機成功。**NAS再起動後はradio待ち受け・Web診断の稼働と低IOPSを確認**。再起動後の機器別手動同期は別途確認すること。

## 5. 障害時・戻し方

| 症状 | 対処 |
| --- | --- |
| NAS再起動後に`Bluetooth Enable=TRUE`へ戻る | `/etc/config/uLinux.conf`の実値と起動スクリプトの条件を読み直す。**`/var/.application.conf`だけの変更では不十分だった実例あり** |
| 設定は`FALSE`なのにホスト側`bluetoothd`が再起動 | QTS管理側の別起動経路を調べる。HomeHubから汎用killやホストDockerソケット操作を安易に追加しない |
| `docker logs qnaphomehub-radio`が空 | 省書き込み構成では**正常**。WebのBLE／15秒診断とSelfCareの診断を使う |
| Webのradio切替が`Not found` | Web本体と`qnaphomehub-updater`の世代ずれを確認し、[updater移行手順](WEB-RADIO-LOW-IO.md)へ |
| QNAP側を無効化した結果、別のQTS Bluetooth機能が必要になった | 以下の**ロールバック**後、QTS通常再起動でホスト側を復帰。SelfCareとHomeHubの構成は消さない |
| Write IOPSだけ増えたが`bluetoothd`は不在 | NAS全体のI/Oなので、DiskInspector等で実際の書き込み元を確認。無関係なQTSプロセスを停止しない |

**設定を戻す**（QTSホスト側Bluetoothが本当に必要な場合）:

```sh
sudo /sbin/setcfg Bluetooth Enable TRUE -f /etc/config/uLinux.conf
/sbin/getcfg Bluetooth Enable -u -d TRUE
```

`TRUE`を確認し、QTSから通常再起動してQNAP標準Bluetoothが復帰するか検証する。変更前が`UNSET`の場合は、元の未設定状態へ戻すにはそのQTSに合った設定削除手順を別途確認すること（無闇にファイル全体を削除しない）。BlueZの永続鍵、SelfCare DB、測定履歴、QPKGは保持。

## 6. 新規環境で記録する項目（秘密情報不要）

`QTS版 / NAS機種 / HomeHub版 / SelfCare版 / USB HCI(hci0等) / ホストbluetoothdの有無 / Docker radioモード・ログ・tmpfs / 設定値変更前後 / RAID1各ディスクのWrite IOPS・MB/s / 再起動前後 / SwitchBot成功 / HEM・HBF同期・SQLite保存成功`。

MACアドレス、Bluetooth鍵、健康データの数値、`/etc/config`全文はレポートに含めない。必要なときだけ取り扱いに注意しながら確認する。

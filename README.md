# QnapHomeHub

> **0.3.15: Docker版に一本化しました。** Native QPKG（0.3.15-qpkg-preview.1）は開発中止です。QTS App Centerから**QnapHomeHub** QPKGだけを停止・削除し、同じWebポート8787を使うDocker版に戻してください。**QnapSelfCare QPKGや健康記録、HomeHubの `data/`・`secrets/` は削除しません。**
>
> Bluetooth radioの無駄なディスク書き込みを削減するため、Docker radioログを無効化し、BlueZの一時D-BusファイルをRAMへ移動しました。管理画面の **「15秒テストしてログ生成」** からHDD別Write IOPSとradio状態をコピー・TXT出力できます。**2026-10-11のQTS 5.x実機ではホスト側`bluetoothd`の競合を特定し、永続起動設定の無効化でNAS再起動後も約83.84→2.53 Write IOPS/HDDを確認**しました。今後の新規セットアップでは必ず[QNAP標準Bluetooth競合の初期確認・対策・ロールバック](docs/QNAP-HOST-BLUEZ-LOW-IO-RUNBOOK.md)を参照してください（QTSの機種差に注意）。[Docker低I/O診断](docs/DOCKER-LOW-IO.md)。


QNAP NASを **SwitchBotのローカルBluetoothゲートウェイ**にし、Web UIとMatter/Alexaの両方から操作するDockerプロジェクトです。

主対象は **QNAP TS-253Be / x86_64 + USB Bluetoothドングル + Container Station** です。

## 主な機能

**0.3.23（M5GO広告受信修正）:** ESPHomeのRAW広告に対応し、API接続できてもBLE広告が届かない不具合を修正しました。HBF-228Tだけの経路切替・USBへの切り戻しと、既存SelfCareのUnixソケットを維持します。初期経路はUSBです。**実機の自動保存は未検証**です。[設定手順](docs/M5GO-BLE-PROXY.md) / [受入記録](docs/M5GO-ACCEPTANCE.md)。

**0.3.20（M5GOファームウェア検証）:** ESPHome 2026.9.1、暗号化OTA、接続1枠と診断センサーを追加。専用CIはダミー資格情報で実ビルドし、バイナリを公開しません。遠隔履歴同期は後続実装、実機同期は未検証です。

**0.3.19（M5GO検証基盤）:** 初代M5GO用のESPHomeアクティブBLEプロキシ設定と、QNAPから広告・GATT到達を確認する読み取り専用診断を追加しました。現在のUSB/BlueZ環境は変更せず、ESPHome用Pythonを独立した仮想環境で利用します。**遠隔M5GOでの自動同期は未有効で、実機で接続を検証後に段階導入します。** [設定と診断方法](docs/M5GO-BLE-PROXY.md)。


**0.3.18:** HBF-228Tの広告待ち受けによる自動同期で、BLE接続待ちを8秒から20秒に延長しました。電波が弱めの設置環境で次の接続可能な広告を待つ余裕を増やします。手動同期・ペアリング・HEM-6232Tは従来の20秒のままです。自動HCIリセットや再ペアリング、無制限の再試行は追加していません。新しい動作はHomeHubのradioコンテナを更新後に有効になります。


- USB Bluetoothを独立したradioサービスで管理。SwitchBotは既存の `node-switchbot` + Noble、SelfCareのOmronはBlueZ/Bleakで制御
- NASの古いBlueZに依存せず、コンテナ内に新しいBlueZを同梱。SelfCare待機を維持し、Bot操作時だけ一時切替
- Web UIからBLEスキャン、Bot登録、Press / ON / OFF / 状態取得
- コマンド操作時に **送信中 / 成功 / 失敗** をカード上へ表示
- Web UI内の **Webデバッグ** から、API到達、BLE実行、Matterbridge heartbeat、HCI診断を追跡
- UIテーマは **Black** / **Cyber** を切替可能。Blackが既定
- 登録したBotをMatterbridge経由でAlexaへ公開
- Alexa互換性を優先し、BotのMatter型は既定で **Outlet**
- `press` / `switch` モード、表示名、Matter Outlet/Lightをデバイス単位で変更
- Matter公開ON/OFFや設定変更をMatterbridgeへ自動反映
- HomeHub管理ユーザー名 / パスワード、内部API token、SwitchBot API token/secret、Bot BLE passwordはDocker secretsで管理
- Matterbridge Web UIのパスワードもHomeHubのDocker secretから同期
- GitHub ActionsでTypeScript / test / Docker amd64 build / 実コンテナsmoke test
- `main`更新時にGHCRへ`server` / `matterbridge`イメージを公開

## 構成

| サービス | 待ち受け・役割 |
| --- | --- |
| homehub | 8787 / Web・認証・SwitchBot設定・Matter内部API |
| radio | TCPなし / USB HCIの単一管理、Unixソケット `/radio/ble.sock` |
| QnapSelfCare（別QPKG） | 17863 / 健康記録、利用者、Omron同期依頼 |
| matterbridge | 8283 / Matter・Alexa公開 |
| updater | loopback 8788 / イメージ更新 |

0.3.14ではQTSホストBlueZの実験的共有モードを追加します。既定の専用BlueZ方式はそのままです。QTSのD-Busソケットが利用可能な場合に限り、`compose.host-bluez.yaml` を重ねることでコンテナ内bluetoothdの起動を停止し、ホスト側BlueZを使ってSelfCareの待ち受けを検証できます。ホスト所有HCIとの競合を避けるためこの試験モードではSwitchBotのraw HCI操作は無効です。**通常運用では有効にしないでください。** 実機でBLE接続・再起動・HDD IOPSを確認後に評価します。0.3.13ではHBF-228T接続失敗時の自動HCI down/up・BlueZ再起動を廃止します。広告watcherの維持と起動時HCI ready待ちは継続し、失敗種別を診断へ残します。0.3.12ではNAS再起動後のUSB Bluetooth初期化を強化します。radioはBlueZ起動前に選択HCIがsysfsへ現れ、`hciconfig up`できるまで最大30秒待機します。待ち受け由来HBF-228Tでconnection TimeoutErrorが2回連続した場合に限り、watcherとコンテナ内BlueZを停止してHCIをdown/upし、BlueZを1回復旧して次の広告へ備えます。復旧回数・時刻・連続timeout数をradio healthへ追加します。HEM-6232Tや正常通信時にはこの復旧を実行しません。0.3.11ではSelfCareの待ち受け最適化向けに、対象機器の広告からRSSIを除外したfingerprintを生成し、manufacturer data・service data・service UUID・local name・tx powerの変化を診断できるようにします。広告だけで新規測定と断定はせず、SelfCare側の広告バースト抑制と実機比較のための診断情報として返します。0.3.10ではHBF-228Tの待ち受け同期で、広告を検知したリスナーを接続開始前に停止していた問題を修正します。待ち受け由来のHBF-228T同期だけは同じBlueZ上の広告リスナーを維持したまま接続し、HEM-6232T、手動同期、ペアリング、HomeHub/SwitchBot操作は従来どおり排他的にリスナーを停止します。診断に `watch_preserved_for_connect` を追加します。0.3.9ではSelfCare 0.3.25向けに、待ち受け由来のHBF-228T接続を8秒で区切り、接続失敗を次の新しい広告で再試行できるようにします。BlueZ診断にAddressType、Connectable、RSSI、ServicesResolved、接続エラーを追加します。HEM-6232Tの接続待ち・プロトコル動作は変更しません。0.3.8ではiPhoneの「ホーム画面に追加」用180×180アイコンとWebアプリ用manifestを追加します。既に追加したホーム画面アイコンは更新後に削除して追加し直してください。0.3.7ではQnapHomeHub WebUIに専用faviconを追加し、操作画面・管理画面のブラウザタブで共通アイコンを表示します。0.3.6ではSelfCare 0.3.23向けに、ペアリング済みでBlueZに登録済みの機器へ再検索せず直接接続します。HBF-228Tの測定後の短い広告を、検索のやり直しで使い切らないためです。BlueZに機器がなければ従来の検索に戻ります。診断に広告受信からの経過時間、検索・接続時間、接続方式を追加しました。0.3.5ではSelfCare 0.3.14向けの常駐広告リスナーを追加します。機器ごとの待ち受け設定に対応し、Bot操作・同期の前にリスナーを停止して処理後に再開します。Web管理ポートは変更しません。0.3.4では実機で確認された24バイトの通信開始応答（機器情報付き）に対応します。0.3.3ではHEM-6232Tのキー登録後の認証・通信開始応答の検査を修正し、通知待ち時間と送信方式を調整します。0.3.2では診断付き操作の直近8件の機器応答とタイムアウト時の受信断片を返します。0.3.1ではSelfCareの手動診断付きペアリング・同期に対応し、測定データの限定サンプル・読取段階をradioからSelfCareへ返します。平常の同期結果・Bot操作は変わりません。診断値はSelfCareの履歴に保存されるため共有前に確認してください。

0.3.0以降の標準Composeでは、Bluetooth権限を持つのは **radioだけ**です。HomeHub・SelfCareは共通ソケットへ依頼し、実行中の処理の終了を待って切り替えます。Webポートとデータは分離します。既存のSwitchBotManagerとSerialQueueを再利用します。ESP32は使いません。

**0.2.xからの初回移行は新しいComposeが必要です。** 旧HomeHubを停止してからradioを起動してください。[共通Bluetoothの移行・復旧手順](docs/SHARED-RADIO.md)を先に確認してください。新しいBLE共用とOmron同期は実機検証が必要です。

---

# 今回のQNAP実機導入手順

以下は実際にTS-253Be上で進めた手順をベースにしています。QNAPでは`sudo`や`systemctl`を前提にしません。

## 1. Container Station / Dockerを確認

QTSで **Container Station** をインストール・起動しておきます。

SSHで:

```sh
uname -a
docker version
docker compose version
```

主対象は`x86_64`です。

Container StationはDockerのGUI管理画面として利用できます。初期導入はSSHでComposeを起動し、その後の停止・起動・ログ確認はContainer Stationから行って構いません。

---

## 2. USB Bluetoothドングルを確認

USB Bluetoothドングルを挿し、次を実行します。

```sh
echo '=== Kernel ==='
uname -a

echo '=== USB ==='
lsusb 2>/dev/null

echo '=== HCI sysfs ==='
ls -la /sys/class/bluetooth 2>/dev/null

echo '=== HCI detail ==='
hciconfig -a 2>/dev/null

echo '=== Bluetooth modules ==='
lsmod | grep -E 'bluetooth|btusb|btrtl|btintel|btbcm|btmtk'

echo '=== bluetoothd (reference only) ==='
bluetoothd -v 2>/dev/null || /usr/sbin/bluetoothd -v 2>/dev/null || true
```

今回の実機では次の状態まで確認できました。

```text
USB: 0a12:0001 Cambridge Silicon Radio Bluetooth Dongle
/sys/class/bluetooth/hci0
hci0: UP RUNNING
HCI Version: 4.0
btusb loaded
bluetoothd 4.101
```

`bluetoothd`が古くても、QnapHomeHubの主経路はBlueZ D-BusではなくNoble / raw HCIです。

---

## 3. QnapHomeHubを取得

### 推奨: Gitを使える場合

```sh
cd /share/Container
git clone https://github.com/souten-yd/QnapHomeHub.git
cd QnapHomeHub
```

### QNAPに`git`が無い場合

今回の実機では`git: command not found`だったため、**ZIP取得で導入できます**。

```sh
cd /share/Container

wget -O QnapHomeHub.zip \
  https://github.com/souten-yd/QnapHomeHub/archive/refs/heads/main.zip

unzip QnapHomeHub.zip
mv QnapHomeHub-main QnapHomeHub
rm QnapHomeHub.zip
cd QnapHomeHub
```

`wget`が無ければ:

```sh
curl -L \
  https://github.com/souten-yd/QnapHomeHub/archive/refs/heads/main.zip \
  -o QnapHomeHub.zip
```

### Entwareの`opkg`について

`/opt/bin/opkg`が存在していても、一般ユーザーには`/opt`への書き込み権限が無い場合があります。

```sh
ls -l /opt/bin/opkg
```

`opkg update`や`opkg install git`で`Permission denied`になる場合は、Git導入にこだわらず上記ZIP方式を使うのが最短です。

---

## 4. Secretsを作成

```sh
cd /share/Container/QnapHomeHub
chmod +x scripts/*.sh
./scripts/bootstrap-secrets.sh
```

作成後:

```text
Secrets are ready under ./secrets
```

となればOKです。

作成されるファイル:

```text
secrets/
├── homehub_admin_username.txt
├── homehub_admin_password.txt
├── homehub_internal_token.txt
├── switchbot_token.txt
├── switchbot_secret.txt
└── switchbot_bot_passwords.json
```

Matterbridge Web UIはユーザー名ではなくパスワードのみを使用します。HomeHubの`homehub_admin_password.txt`をMatterbridge側にも同期します。

SwitchBot OpenAPIを使わずBLEだけで使う場合、`switchbot_token.txt` / `switchbot_secret.txt`は空で構いません。

Bot本体に4文字BLEパスワードを設定している場合のみ、`switchbot_bot_passwords.json`へ設定します。

```json
{
  "AABBCCDDEEFF": "A1b2"
}
```

---

## 5. QNAP診断スクリプトを実行

```sh
./scripts/qnap-diagnose.sh
```

確認ポイント:

- USB Bluetoothドングルが見える
- `/sys/class/bluetooth/hci0` または`hci1`がある
- `hciconfig`で`UP RUNNING`
- `btusb`等がロード済み
- Dockerが起動している

今回の実機ではここまで正常でした。

---

## 6. Dockerイメージを取得して起動

```sh
docker compose pull
docker compose up -d
```

今回の実機ではGHCRから`homehub` / `matterbridge`の両イメージを正常にpullできました。

状態確認:

```sh
docker compose ps
```

正常例:

```text
qnaphomehub               Up
qnaphomehub-radio         Up
qnaphomehub-matterbridge  Up (healthy)
```

初期ログ:

```sh
docker compose logs --tail=100 homehub
docker compose logs --tail=200 matterbridge
```

GHCR pullが使えない場合:

```sh
docker compose build --no-cache
docker compose up -d
```

---

## 7. HomeHubを開く

ブラウザ:

```text
http://QNAP-IP:8787
```

`bootstrap-secrets.sh`で設定したユーザー名・パスワードでログインします。

画面右上でテーマを選べます。

```text
BLACK  ← 既定。暗い黒/グラファイトUI
CYBER  ← シアン/マゼンタのサイバーUI
```

---

## 8. SwitchBotをスキャン・登録

1. **Bluetoothをスキャン**
2. SwitchBot Botが表示されるのを確認
3. 名前を設定
4. `Press` または`Switch`を選択
5. **登録**
6. 登録済みカードから **押す / ON / OFF / 状態** を試す

推奨:

### 物理ボタンを押す用途

```text
Mode       = Press
Matter     = ON
MatterType = Outlet
```

### ON/OFFを保持する用途

```text
Mode       = Switch
Matter     = ON
MatterType = Outlet
```

---

# コマンドボタンの確認方法

登録済みカードで`押す`等を押すと、現在はカード上に必ず状態を表示します。

```text
待機中
  ↓
押す をHomeHubへ送信中…
  ↓
押す 完了 · BLE
```

失敗時:

```text
失敗: <BLEエラー理由>
```

さらにJSON結果もカード内に表示します。

**重要:** ボタン押下は`POST /api/devices/:id/:action`へ接続されています。WebデバッグではHTTPリクエスト到達とBLEコマンド実行を別イベントとして確認できます。

---

# Webデバッグ

HomeHubのメイン画面に **Webデバッグ** パネルがあります。SSHで`docker compose logs -f`を開かなくても主要な問題を追跡できます。

表示内容:

- HomeHub online状態
- HCI番号 (`hci0`等)
- BLE検出台数
- 登録デバイス数
- Matterbridge HTTP到達状態
- Matterbridge QnapHomeHub plugin heartbeat
- Matterbridgeへ公開済みデバイス数
- `hciconfig -a`
- `uname -a`
- 直近のスキャンイベント
- WebからのコマンドHTTP到達
- BLEコマンド開始 / 成功 / 失敗
- Matterbridgeからのコマンド到達
- 設定変更 / 再起動イベント

既定では2秒ごとに自動更新します。

### ボタンが本当にAPIへ届いているか

`押す`を押した直後にWebデバッグへ次が出れば、ブラウザ→HomeHub APIは接続されています。

```text
api.web        Command HTTP request received
command        Device command requested
command        Executing device command
```

成功なら:

```text
command        Device command succeeded
api.web        Command HTTP request completed
```

失敗なら:

```text
command        Device command failed
api.web        Command HTTP request completed with failure
```

このため「ボタンが未接続」なのか「BLE処理で失敗」なのかをWebだけで判別できます。

---

# Matterbridge / Alexa

Matterbridge:

```text
http://QNAP-IP:8283
```

Matterbridge Web UIのパスワードはHomeHubと同じです。

## QnapHomeHub pluginが表示されない場合

Matterbridge 3.10.6は、プラグインのランタイム`package.json`に`matterbridge`自身がdependencies/devDependenciesとして含まれているとプラグインを拒否します。

QnapHomeHubのDocker buildではビルド後にdevDependenciesを削除した**runtime用package.json**だけをMatterbridgeイメージへ入れます。

またMatterbridge起動時の:

```text
matterbridge --add ...
matterbridge --enable ...
```

の出力を隠さないため、登録エラーはMatterbridgeログへそのまま表示されます。

```sh
docker compose logs --tail=300 matterbridge
```

HomeHubの **Webデバッグ** でも次を確認できます。

```text
MATTERBRIDGE
HTTP OK · ready · 2 devices
```

`HTTP OK · not-seen`なら、Matterbridge本体は起動しているがQnapHomeHub pluginがロードされていません。

`ready`になればMatterbridge pluginからHomeHubへheartbeatが届いています。

## Alexaへ追加

1. QnapHomeHubで対象BotのMatterをON
2. MatterbridgeでQnapHomeHub pluginとデバイスを確認
3. Matterbridgeのcommissioning QRを表示
4. Alexaアプリ → デバイス追加 → Matter
5. QRを読み取る
6. Alexaから操作

Matter/mDNSのため、QNAPとEcho/Alexaコントローラは同一LANから相互到達できる構成を推奨します。

---

# 詳細設定

通常は初期値で構いません。

## HCIアダプター番号

```text
0 = hci0
1 = hci1
```

共有モードでは次の操作からHCI設定を読み直します。SelfCare側も同じHCIへ変更してください。旧直接モードではHomeHubの再起動が必要です。

```sh
docker compose restart homehub
```

## BLEスキャン時間

既定:

```text
10000 ms
```

検出が不安定なら15～30秒程度へ増やします。

## SwitchBot API fallback

既定OFFです。BLEローカル運用ではOFF推奨です。

---

# Container Stationでの運用

`docker compose up -d`で作成したコンテナはContainer Stationから確認できます。

```text
qnaphomehub
qnaphomehub-matterbridge
```

Container Stationから以下を行えます。

- 起動
- 停止
- 再起動
- コンテナログ確認
- CPU/RAM確認

0.3.0以降の標準構成ではradioだけが `privileged: true` を使用します。WebのHomeHubとMatterbridgeはBluetoothを直接利用しません。

---

# 更新手順

Matter/Fabric情報を保持するため、`data/matterbridge`と`secrets`を削除しないでください。

## Git cloneで導入した場合

```sh
cd /share/Container/QnapHomeHub
git pull --ff-only
docker compose pull
docker compose up -d --remove-orphans
```

## ZIPで導入した場合

Dockerイメージだけの更新であれば:

```sh
cd /share/Container/QnapHomeHub
docker compose pull
docker compose up -d --remove-orphans
```

`compose.yaml`やscripts自体が変更されたリリースでは、新しいZIPを別フォルダへ展開し、既存の`secrets/`と`data/`を保持して移行してください。

Web UIの更新機能は導入済みです。新しいComposeへの初回移行後はradioもserverと同じイメージへ更新し、共通ソケットの生存確認を行います。Compose自体の追加・変更は自動適用しません。

---

# 停止 / 再起動

```sh
# 停止
docker compose down

# 起動
docker compose up -d

# 全体再起動
docker compose restart

# HomeHubのみ
docker compose restart homehub

# Matterbridgeのみ
docker compose restart matterbridge
```

---

# バックアップ対象

```text
data/homehub/
data/matterbridge/
secrets/
```

Matterペアリング済みの場合、`data/matterbridge/`を削除すると再commissioningが必要になる可能性があります。

---

# CLIトラブルシューティング

Webデバッグで足りない場合のみSSHログを使います。

```sh
docker compose ps
docker compose logs --tail=300 homehub
docker compose logs --tail=300 matterbridge
```

リアルタイム:

```sh
docker compose logs -f homehub matterbridge
```

HomeHub health:

```sh
curl http://127.0.0.1:8787/api/health
```

Matterbridge health:

```sh
curl http://127.0.0.1:8283/health
```

Bluetooth:

```sh
./scripts/qnap-diagnose.sh
ls -la /sys/class/bluetooth
hciconfig -a 2>/dev/null
ps | grep '[b]luetoothd'
```

---

# GitHub Actions / GHCR

CIでは以下を検証します。

- Web UI JavaScript構文
- shell script構文
- `docker compose config`
- server typecheck / test / build
- Matterbridge plugin typecheck / build
- server Docker amd64 build
- `node-switchbot` native import
- HomeHub実コンテナ `/api/health`
- Matterbridge Docker amd64 build
- Matterbridge `/health`
- Matterbridge Web password同期/login

mainへマージすると次を公開します。

```text
ghcr.io/souten-yd/qnaphomehub:server
ghcr.io/souten-yd/qnaphomehub:matterbridge
```

SecretsはDocker imageへ埋め込みません。`.dockerignore`でも`secrets/`と`data/`を除外しています。

---

# セキュリティ境界

- HomeHub Web API: `homehub_admin_username` + `homehub_admin_password`
- Matterbridge Web UI: `homehub_admin_password`を起動時に同期
- Matterbridge → HomeHub内部API: ランダム`homehub_internal_token`
- SwitchBot Token / Secret: Docker secretから読み込み、Web APIへ値を返さない
- Bot BLE password: secret JSONから読み込み、Web APIへ値を返さない
- Webデバッグ: HomeHubログイン後のみ閲覧可能。secret本体は記録しない

## License

QnapHomeHub本体はMIT Licenseです。別プロセスのOmron読取プログラム `server/ble/` はGPL-3.0-or-laterです。同ディレクトリのソース、THIRD_PARTY.md、ライセンスをイメージにも同梱します。Matterbridge / node-switchbot等は各プロジェクトのライセンスに従います。

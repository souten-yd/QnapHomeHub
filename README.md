# QnapHomeHub

QNAP NASを **SwitchBotのローカルBluetoothゲートウェイ**にし、Web UIとMatter/Alexaの両方から操作するDockerプロジェクトです。

主対象は **QNAP TS-253Be / x86_64 + USB Bluetoothドングル + Container Station** です。

## 主な機能

- USB BluetoothドングルをLinux HCI経由で直接利用 (`node-switchbot` + Noble)
- QNAPの古いBlueZ D-Bus APIに依存せずSwitchBot BLEを操作
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

```text
SwitchBot Bot
     │ BLE
     ▼
USB Bluetooth dongle → Linux hci0/hci1
     │
     ▼
┌──────────────────────────────┐
│ qnaphomehub :8787            │
│ Web UI / Web Debug           │
│ node-switchbot / Noble       │
│ BLE serial command queue     │
└──────────────┬───────────────┘
               │ localhost + internal token
               ▼
┌──────────────────────────────┐
│ Matterbridge :8283           │
│ matterbridge-qnaphomehub     │
└──────────────┬───────────────┘
               │ Matter / mDNS
               ▼
          Echo / Alexa
```

Bluetooth/HCIを所有するのは **HomeHubだけ**です。MatterbridgeはBluetoothを直接開かず、HomeHub内部REST APIを通して同じBLEコマンドキューを利用します。

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

HCI番号を変えた場合はHomeHub再起動が必要です。

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

初期版ではQNAP上のraw HCI差異を吸収するためHomeHubは`privileged: true`を使用します。MatterbridgeはBluetoothを直接利用しません。

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

将来的にはHomeHub Web UIからGHCRイメージ更新とrollbackを行うワンクリック更新を追加予定です。

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

QnapHomeHub自体はMIT Licenseです。Matterbridge / node-switchbot等は各プロジェクトのライセンスに従います。

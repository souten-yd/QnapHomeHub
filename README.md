# QnapHomeHub

QNAP NAS を **SwitchBot のローカル Bluetooth ゲートウェイ**にし、Web UI と Matter/Alexa の両方から操作する Docker プロジェクトです。

主対象は **QNAP TS-253Be (x86_64)** + USB Bluetooth ドングルです。

## できること

- USB Bluetooth ドングルを Linux HCI 経由で直接利用 (`node-switchbot` + Noble)
- QNAP の BlueZ D-Bus API に依存せず SwitchBot BLE を操作
- Web UI から BLE スキャン、Bot 登録、Press / ON / OFF / 状態取得
- 複数の同型 Bot が同じ名前で検出されても `Bot`, `Bot 2`, `Bot 3` のように自動で一意化
- 登録した Bot を Matterbridge 経由で Alexa に公開
- Alexa 互換性を優先し、Bot の Matter 型は既定で **Outlet**
- `press` / `switch` モード、表示名、Matter Outlet/Light をデバイス単位で変更
- Matter公開ON/OFFやデバイス設定変更を Matterbridge 側へ自動追従
- HCI アダプター番号、スキャン時間、API fallback などは「詳細設定」に収納
- SwitchBot OpenAPI Token / Secret は Docker secrets 対応
- HomeHub 管理ユーザー名 / パスワード、内部APIトークン、Bot BLEパスワードも Docker secrets 対応
- Matterbridge Web UI のパスワードも Docker secret から起動時に同期
- Matter の QR、Fabric、commissioning、Matterbridge設定は Matterbridge Web UI から管理
- GitHub Actions で TypeScript / test / Docker amd64 build / native module / 実コンテナ smoke test
- `main` 更新時に GHCR へ `server` / `matterbridge` イメージを公開

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
│                              │
│ Web UI                       │
│ node-switchbot / Noble       │
│ BLE serial command queue     │
└──────────────┬───────────────┘
               │ localhost + internal token
               ▼
┌──────────────────────────────┐
│ Matterbridge :8283           │
│ QnapHomeHub plugin           │
└──────────────┬───────────────┘
               │ Matter / mDNS
               ▼
          Echo / Alexa
```

Bluetooth を所有するのは **HomeHub サービスだけ**です。Matterbridge プラグインは Bluetooth を直接開かず、内部 REST API を通して同じ BLE コマンドキューへ処理を依頼します。

Web操作とAlexa操作が同時に発生しても、BLE処理は1本のシリアルキューを通ります。

詳細: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

# 最短導入手順（QNAP / SSH）

以下は QNAP に SSH で入って作業する想定です。`sudo` / `systemctl` は使いません。

## 0. 前提

QNAP 側で次を用意してください。

- Container Station / Docker
- USB Bluetooth ドングル
- Git（リポジトリ取得用。なければQNAP/Entware等で導入）
- Alexaアプリ
- Matter対応Alexa/Echo（AlexaへMatterブリッジを登録する場合）

まず確認します。

```sh
uname -m
docker version
docker compose version
git --version
```

TS-253Be では通常 `uname -m` は次です。

```text
x86_64
```

Docker Compose v2 が利用できれば、そのまま以下の手順で進められます。

---

## 1. USB Bluetooth / HCI を確認

ドングルを挿した状態で実行します。

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

最低条件は、LinuxカーネルがUSBドングルを認識し、例えば次が存在することです。

```text
/sys/class/bluetooth/hci0
```

または2本目なら:

```text
/sys/class/bluetooth/hci1
```

QNAP 標準 `bluetoothd` が古くても、このプロジェクトの主経路は BlueZ D-Bus ではなく **Noble / HCI直接アクセス**です。

ただし次の場合は動きません。

- QNAPカーネルがUSBドングルを認識していない
- 必要な `btusb` / firmware が無い
- QTSの別プロセスが同じHCIアダプターを排他的に使用している

QTS側Bluetoothと競合する場合は、専用USBドングルを `hci1` として追加し、HomeHubの詳細設定で `HCIアダプター番号 = 1` にする方法を推奨します。

---

## 2. QnapHomeHub を取得

保存先は任意です。例として `/share/Container` が存在する場合:

```sh
cd /share/Container
git clone https://github.com/souten-yd/QnapHomeHub.git
cd QnapHomeHub
```

`/share/Container` が無ければ、自分の共有フォルダ配下など書き込み可能な場所で構いません。

既にclone済みなら:

```sh
cd /path/to/QnapHomeHub
git pull --ff-only
```

---

## 3. Secrets を作る

```sh
chmod +x scripts/*.sh
./scripts/bootstrap-secrets.sh
```

初回のみ次を聞かれます。

```text
HomeHub admin username [admin]:
HomeHub admin password:
```

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

役割:

| Secret | 用途 |
|---|---|
| `homehub_admin_username.txt` | HomeHub Web UIユーザー名。既定 `admin` |
| `homehub_admin_password.txt` | HomeHub Web UIパスワード。Matterbridge Web UIにも同期 |
| `homehub_internal_token.txt` | HomeHub ↔ Matterbridge 内部API認証。自動生成 |
| `switchbot_token.txt` | SwitchBot OpenAPI fallback用。BLEのみなら空で可 |
| `switchbot_secret.txt` | SwitchBot OpenAPI fallback用。BLEのみなら空で可 |
| `switchbot_bot_passwords.json` | Bot本体にBLEパスワードを設定している場合のみ |

### Matterbridge のログインについて

Matterbridge公式Web UIは **ユーザー名を持たずパスワードのみ**です。

QnapHomeHubでは起動時に:

```text
secrets/homehub_admin_password.txt
```

をMatterbridge公式ストレージへ同期するため、Matterbridge Web UI (`:8283`) には **HomeHubと同じパスワード**でログインできます。

### SwitchBot OpenAPIを使わない場合

BLE直結だけなら次は空のままで構いません。

```sh
: > secrets/switchbot_token.txt
: > secrets/switchbot_secret.txt
```

Web UIの **SwitchBot API fallback** もOFFのまま使ってください。

### SwitchBot OpenAPI fallbackを使う場合

SwitchBot側で取得したToken / Secretをそれぞれ1行で保存します。

```sh
printf '%s\n' 'YOUR_SWITCHBOT_TOKEN' > secrets/switchbot_token.txt
printf '%s\n' 'YOUR_SWITCHBOT_SECRET' > secrets/switchbot_secret.txt
chmod 600 secrets/switchbot_token.txt secrets/switchbot_secret.txt
```

値をGitHub Actions secretsへ入れる必要はありません。QNAP実行時のDocker secretsとしてのみ使用します。

### Bot本体にBLEパスワードを設定している場合

`secrets/switchbot_bot_passwords.json`:

```json
{
  "AABBCCDDEEFF": "A1b2"
}
```

キーにはDevice ID、またはコロンを除いたMACを指定できます。

パスワードなしなら:

```json
{}
```

---

## 4. 診断を先に実行（推奨）

```sh
./scripts/qnap-diagnose.sh
```

ここで少なくとも以下を確認します。

- Dockerが起動している
- USBドングルが見える
- `/sys/class/bluetooth/hci0` または `hci1` が存在
- Bluetooth kernel moduleが読み込まれている

---

## 5. Dockerを起動

### 推奨: GitHub Actionsでビルド済みのGHCRイメージを使用

```sh
docker compose pull
docker compose up -d
```

状態確認:

```sh
docker compose ps
```

ログ:

```sh
docker compose logs --tail=100 homehub
docker compose logs --tail=100 matterbridge
```

リアルタイムログ:

```sh
docker compose logs -f homehub matterbridge
```

### GHCR pull が拒否される場合

初回パッケージ公開設定等でGHCRを匿名pullできない場合は、ソースからローカルビルドできます。

```sh
docker compose build --no-cache
docker compose up -d
```

この場合もアプリ設定やMatterデータの配置は同じです。

> `homehub` はQNAPのBluetooth/HCI差異を吸収するため、初期版では `privileged: true` です。実機検証後に必要capabilityへ縮小可能です。

---

## 6. HomeHub Web UI を開く

ブラウザから:

```text
http://QNAP-IP:8787
```

例:

```text
http://192.168.68.57:8787
```

ログインには `bootstrap-secrets.sh` で設定した:

```text
ユーザー名: homehub_admin_username.txt
パスワード: homehub_admin_password.txt
```

を使用します。

---

## 7. SwitchBot をBluetooth登録

通常は以下だけです。

1. **Bluetoothをスキャン**
2. SwitchBot Botが表示されるのを待つ
3. 必要なら名前を変更
4. `Press` または `Switch` を選ぶ
5. **登録**
6. **押す / ON / OFF / 状態** でWebから実機確認

推奨設定:

### 物理ボタンを1回押す用途

```text
Mode       = Press
Matter     = ON
MatterType = Outlet
```

### ON/OFF状態を保持する用途

```text
Mode       = Switch
Matter     = ON
MatterType = Outlet
```

Alexa互換性を優先して **Outletが既定かつ推奨**です。

同名Botを複数登録した場合は `Bot`, `Bot 2`, `Bot 3` のように自動で一意化します。

---

## 8. Matterbridge / Alexa を設定

HomeHub Web UIの **Matter設定を開く**、または直接:

```text
http://QNAP-IP:8283
```

を開きます。

Matterbridge Web UIのログインパスワードは:

```text
secrets/homehub_admin_password.txt
```

と同じです。

Matterbridge側で以下を確認できます。

- Matter commissioning
- QR pairing code
- manual pairing code
- Fabric / session
- Fabric削除
- Matterbridge設定
- Matter / Matterbridgeログ

### Alexaアプリへ追加

1. Matterbridge Web UIでペアリングQRを表示
2. Alexaアプリを開く
3. デバイス追加を選択
4. Matterデバイスとして追加
5. MatterbridgeのQRコードを読み取る
6. QnapHomeHubでMatter公開ONになっているBotがAlexa側へ出ることを確認
7. Alexaアプリまたは音声で操作

Matter/mDNSのため、QNAPとEcho/Alexaコントローラは同一LANから相互到達できる構成を推奨します。VLANやmDNS遮断がある場合はペアリング/検出に失敗することがあります。

---

# Web UIの使い方

## Press モード

Matter の ON を受けると:

```text
Alexa ON
  ↓
Matter Outlet ON
  ↓
HomeHub press()
  ↓
Matter状態をOFFへ戻す
```

モーメンタリボタンとして扱います。

## Switch モード

```text
Alexa ON  → SwitchBot turnOn()
Alexa OFF → SwitchBot turnOff()
```

## デバイス設定

登録済みデバイスの **デバイス設定** を開いた場合だけ変更できます。

- 表示名
- Press / Switch
- Matter Outlet / Light

Matter公開のON/OFFや設定変更はMatterbridgeへ自動追従します。

---

# 詳細設定

通常は変更不要です。

## HCI アダプター

既定:

```text
0 → hci0
```

例えばQNAP側が内蔵/既存Bluetoothを `hci0` として使用し、追加USBドングルが `hci1` の場合:

```text
HCIアダプター番号 = 1
```

この値はNoble初期化前に `NOBLE_HCI_DEVICE_ID` へ反映されるため、変更後は **HomeHubコンテナ再起動** が必要です。

Web UIの再起動ボタン、またはSSH:

```sh
docker compose restart homehub
```

## BLE スキャン時間

既定:

```text
10000 ms
```

変更範囲:

```text
3000 - 60000 ms
```

検出が不安定なら15～30秒程度へ増やしてください。

## SwitchBot API fallback

既定は **OFF**。

ONにすると、BLE操作失敗時にToken / Secretが設定済みの場合だけOpenAPI fallbackを利用します。

ローカルBLE優先で使う場合はOFF推奨です。

---

# Secretを変更する

例: 管理パスワード変更

```sh
printf '%s\n' 'NEW_PASSWORD' > secrets/homehub_admin_password.txt
chmod 600 secrets/homehub_admin_password.txt
```

Secretはプロセス起動時に読み込むため、変更後は再作成します。

```sh
docker compose up -d --force-recreate
```

Matterbridgeも起動時に同じパスワードを公式ストレージへ再同期します。

---

# 更新手順

Matter/Fabric情報を保持するため、`data/matterbridge` を削除しないでください。

まず任意でバックアップ:

```sh
cp -a data "data.backup.$(date +%Y%m%d-%H%M%S)"
```

更新:

```sh
git pull --ff-only
docker compose pull
docker compose up -d --remove-orphans
```

ローカルビルド運用の場合:

```sh
git pull --ff-only
docker compose build --pull
docker compose up -d --remove-orphans
```

状態確認:

```sh
docker compose ps
docker compose logs --tail=100 homehub matterbridge
```

---

# 停止 / 再起動

停止:

```sh
docker compose down
```

起動:

```sh
docker compose up -d
```

再起動:

```sh
docker compose restart
```

HomeHubだけ:

```sh
docker compose restart homehub
```

Matterbridgeだけ:

```sh
docker compose restart matterbridge
```

---

# バックアップ対象

必須:

```text
data/homehub/
data/matterbridge/
secrets/
```

特にMatterペアリング済みの場合、次を消すと再ペアリングが必要になる可能性があります。

```text
data/matterbridge/
```

---

# トラブルシューティング

## Web UIが開かない

```sh
docker compose ps
docker compose logs --tail=200 homehub
curl http://127.0.0.1:8787/api/health
```

正常例:

```json
{"status":"ok"}
```

## Matterbridge Web UIが開かない

```sh
docker compose logs --tail=200 matterbridge
curl http://127.0.0.1:8283/health
```

## SwitchBotを検出しない

```sh
./scripts/qnap-diagnose.sh
ls -la /sys/class/bluetooth
hciconfig -a 2>/dev/null
ps | grep '[b]luetoothd'
```

確認ポイント:

1. USBドングルがQNAPカーネルに認識されているか
2. `hci0` / `hci1` の番号がWeb設定と一致しているか
3. QTSの`bluetoothd`等が同じHCIを使用していないか
4. SwitchBotとの距離が遠すぎないか
5. BotにBLEパスワードがある場合 `switchbot_bot_passwords.json` が正しいか

QTS側と競合する場合は、専用USBドングルを追加し別HCI番号をHomeHub専用にするのが推奨です。

詳細: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

---

# Docker Compose を既存プロジェクトへ組み込む

QnapHomeHub は2サービス構成なので、既存Composeにも組み込めます。

重要条件:

- `homehub` / `matterbridge` ともMatter/mDNSのため基本は `network_mode: host`
- HCIを使用するのは `homehub` だけ
- `homehub_internal_token` secretを両サービスへ渡す
- `homehub_admin_password` secretをMatterbridgeにも渡す
- `data/homehub` と `data/matterbridge` を永続化
- Matterbridge pluginはHomeHub内部REST APIのみを利用し、Bluetoothには直接アクセスさせない

---

# GitHub Actions

## CI

`.github/workflows/ci.yml`

以下を検証します。

- Web UI JavaScript構文
- Matterbridge bootstrap JavaScript構文
- shell script構文
- `docker compose config`
- server typecheck / test / build
- Matterbridge plugin typecheck / build
- server Docker `linux/amd64` build
- Docker内で `node-switchbot` native moduleを実import
- HomeHub実コンテナ起動 + `/api/health`
- Matterbridge Docker `linux/amd64` build
- HomeHub + Matterbridge同一Dockerネットワークでの統合起動
- Matterbridge `/health`
- Docker secret相当のパスワード同期後 `/api/login` 成功

## GHCR

`.github/workflows/docker-publish.yml`

`main`へマージすると:

```text
ghcr.io/souten-yd/qnaphomehub:server
ghcr.io/souten-yd/qnaphomehub:matterbridge
```

を `linux/amd64` で公開します。

GitHub ActionsへSwitchBot Token / Secret、HomeHubアカウント、パスワードを登録する必要はありません。これらは **QNAP実行時のみ Docker secretsとして読み込み、Docker imageへ埋め込みません**。

`.dockerignore` で `secrets/` と `data/` をDocker build contextからも除外しています。

---

# セキュリティ境界

- HomeHub Web API: `homehub_admin_username` + `homehub_admin_password`
- Matterbridge Web UI: `homehub_admin_password` を起動時に同期
- Matterbridge → HomeHub内部API: ランダム `homehub_internal_token`
- SwitchBot Token / Secret: Docker secretから読み込み、Web APIへ値を返さない
- Bot BLE password: secret JSONから読み込み、Web APIへ値を返さない
- Secrets: Git管理対象外 + Docker build context対象外

## ライセンス

QnapHomeHub自体はMIT Licenseです。依存するMatterbridge / node-switchbot等は各プロジェクトのライセンスに従います。

# QnapHomeHub

QNAP NAS を **SwitchBot のローカル Bluetooth ゲートウェイ**にし、Web UI と Matter/Alexa の両方から操作する Docker プロジェクトです。

主対象は **QNAP TS-253Be (x86_64)** + USB Bluetooth ドングルです。

## できること

- USB Bluetooth ドングルを Linux HCI 経由で直接利用 (`node-switchbot` + Noble)
- QNAP の BlueZ D-Bus API に依存せず SwitchBot BLE を操作
- Web UI から BLE スキャン、Bot 登録、Press / ON / OFF / 状態取得
- 登録した Bot を Matterbridge 経由で Alexa に公開
- Alexa 互換性を優先し、Bot の Matter 型は既定で **Outlet**
- `press` / `switch` モードをデバイス単位で設定
- HCI アダプター番号、スキャン時間、API fallback などは「詳細設定」に収納
- SwitchBot OpenAPI Token / Secret は Docker secrets 対応
- HomeHub 管理パスワード、内部APIトークン、Bot BLEパスワードも Docker secrets 対応
- Matter の QR、Fabric、commissioning は Matterbridge Web UI から管理
- GitHub Actions で TypeScript / test / Docker amd64 build
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

詳細: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## QNAP でのセットアップ

### 1. USB Bluetooth を確認

SSH で実行します。

```sh
uname -a
lsusb
ls -la /sys/class/bluetooth 2>/dev/null
hciconfig -a 2>/dev/null
lsmod | grep -E 'bluetooth|btusb|btrtl|btintel|btbcm|btmtk'
```

最低条件は Linux カーネルがドングルを認識し、次のような HCI デバイスが存在することです。

```text
/sys/class/bluetooth/hci0
```

QNAP の `bluetoothd -v` が古くても、このプロジェクトの主経路は BlueZ D-Bus ではなく Noble/HCI です。ただし、**カーネルがドングルを認識できない場合は動作しません**。

### 2. リポジトリ取得

```sh
git clone https://github.com/souten-yd/QnapHomeHub.git
cd QnapHomeHub
```

### 3. Secrets 作成

```sh
./scripts/bootstrap-secrets.sh
```

作成されます。

```text
secrets/
├── homehub_admin_password.txt
├── homehub_internal_token.txt
├── switchbot_token.txt
├── switchbot_secret.txt
└── switchbot_bot_passwords.json
```

`homehub_admin_password.txt` は Web UI のログインパスワードです。

`homehub_internal_token.txt` は HomeHub と Matterbridge 間だけで使うランダムトークンです。スクリプトが自動生成します。

SwitchBot OpenAPI を使わない場合、以下は空で構いません。

```text
switchbot_token.txt
switchbot_secret.txt
```

OpenAPI fallback を使用する場合だけ、SwitchBot 開発者設定で取得した Token / Secret を記入します。

Bot 本体に4文字BLEパスワードを設定している場合は `switchbot_bot_passwords.json` を次の形式にします。

```json
{
  "AABBCCDDEEFF": "A1b2"
}
```

キーには Device ID またはコロンを除いた MAC を使用できます。パスワードなしなら:

```json
{}
```

### 4. 起動

GHCR イメージを使用する場合:

```sh
docker compose pull
docker compose up -d
```

ソースからビルドする場合:

```sh
docker compose build --no-cache
docker compose up -d
```

確認:

```sh
docker compose ps
docker compose logs -f homehub
docker compose logs -f matterbridge
```

> 初期検証では Bluetooth/HCI の QNAP 固有差を吸収するため `homehub` に `privileged: true` を設定しています。実機で HCI access が確認できた後、必要に応じて `NET_RAW` / `NET_ADMIN` などへ絞り込めます。

---

## Web UI

```text
http://QNAP-IP:8787
```

例:

```text
http://192.168.68.57:8787
```

通常は次だけで使えます。

1. **Bluetoothをスキャン**
2. 検出した SwitchBot に名前を付けて **登録**
3. Web UI の **押す / ON / OFF / 状態** で動作確認
4. **Matter設定を開く** から Alexa ペアリング

### Press モード

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

### Switch モード

```text
Alexa ON  → SwitchBot turnOn()
Alexa OFF → SwitchBot turnOff()
```

---

## Matter / Alexa

Matterbridge Web UI:

```text
http://QNAP-IP:8283
```

HomeHub UI の **Matter設定を開く** から同じ画面を開けます。

ここで以下を管理できます。

- Matter commissioning 開始/停止
- QR pairing code
- manual pairing code
- Fabric / session
- Fabric 削除
- Matterbridge 設定・ログ

Alexa アプリで Matter デバイスを追加し、表示された QR を読み取ります。

Matterbridge の永続データは:

```text
data/matterbridge/
```

に保存されます。コンテナ更新時にこのディレクトリを消さないでください。

---

## 詳細設定

HomeHub Web UI の **詳細設定** から変更できます。

### HCI アダプター

既定値:

```text
0 → hci0
```

2本目の USB Bluetooth が `hci1` なら `1` に変更します。

この値は Noble 初期化前に `NOBLE_HCI_DEVICE_ID` へ反映されるため、変更後は **コンテナ再起動** が必要です。Web UI から再起動できます。

### BLE スキャン時間

既定:

```text
10000 ms
```

範囲:

```text
3000 - 60000 ms
```

### SwitchBot API fallback

既定は OFF です。

ON にすると Token / Secret が設定済みの場合だけ、BLE を主経路として API fallback を有効化します。

---

## QNAP 診断

```sh
./scripts/qnap-diagnose.sh
```

または Web UI → **詳細設定 → 診断**。

主な確認対象:

- kernel
- USB Bluetooth
- `/sys/class/bluetooth/hci*`
- `hciconfig`
- Bluetooth kernel modules
- `bluetoothd` version (参考値)
- Docker

トラブルシューティング: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

---

## Docker Compose を既存プロジェクトへ組み込む

QnapHomeHub は2サービス構成なので、既存 Compose に `homehub` と `matterbridge` を追加して利用できます。

重要条件:

- 両方 `network_mode: host`
- HCI を渡すのは `homehub` だけ
- `homehub_internal_token` secret を両方へ渡す
- `data/homehub` と `data/matterbridge` は永続化

Matterbridge plugin は `http://127.0.0.1:8787` の内部APIだけを使用し、Bluetoothには直接アクセスしません。

---

## GitHub Actions

### CI

`.github/workflows/ci.yml`

- Node 24
- server typecheck / test / build
- Matterbridge plugin typecheck / build
- server Docker amd64 build
- Matterbridge Docker amd64 build

### GHCR

`.github/workflows/docker-publish.yml`

`main` へマージすると:

```text
ghcr.io/souten-yd/qnaphomehub:server
ghcr.io/souten-yd/qnaphomehub:matterbridge
```

を `linux/amd64` で公開します。

GitHub Actions に SwitchBot の Token / Secret を登録する必要はありません。これらは **QNAP実行時のみ Docker secrets として読み込みます**。

---

## セキュリティ上の境界

- HomeHub Web API: `homehub_admin_password` で保護
- Matterbridge → HomeHub 内部 API: ランダム `homehub_internal_token` で保護
- SwitchBot Token / Secret: ファイル secret から読み込み、Web APIから値を返さない
- Bot BLE password: secret JSON から読み込み、Web APIから値を返さない
- Secrets は Git 管理対象外

## ライセンス

QnapHomeHub 自体は MIT License です。依存する Matterbridge / node-switchbot 等は各プロジェクトのライセンスに従います。

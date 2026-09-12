# Reusable GitHub Release / GHCR Updater Integration Guide

この文書は、QnapHomeHub で実装した **GitHub Releases + GHCR + Docker sidecar updater** の仕組みを、別のWebアプリ / Dockerアプリへ再利用するための設計・実装手順です。

目的は、毎回SSHや手作業でファイルを差し替えず、次の流れを共通化することです。

```text
mainへマージ
  ↓
CI / integration test
  ↓
GHCRへ current + version固定imageをpublish
  ↓
GitHub stable Releaseを作成
  ↓
実機updaterがReleaseを検出
  ↓
Webから手動更新 または 自動更新
  ↓
health check
  ├─ OK → 更新確定
  └─ NG → 旧imageへrollback
```

---

## 1. 設計原則

### Docker socketをWebアプリ本体へ渡さない

Docker管理権限は専用の updater sidecar だけに持たせます。

```text
Browser
  ↓ authenticated Web API
Application
  ↓ localhost + internal token
Updater sidecar
  ↓ /var/run/docker.sock
Docker Engine
```

アプリ本体へ `/var/run/docker.sock` をmountしてはいけません。

### updaterはloopbackにbindする

既定:

```text
127.0.0.1:8788
```

外部LANへ直接公開せず、アプリ側の認証済みAPIをproxyとして使います。

### 更新対象はstable Releaseだけ

Release tagは次の形式に固定します。

```text
vMAJOR.MINOR.PATCH
```

例:

```text
v1.4.2
```

`draft=true` / `prerelease=true` は自動更新対象にしません。

### current tagだけで更新しない

rollbackと再現性のため、必ずversion固定tagもpublishします。

例:

```text
ghcr.io/OWNER/APP:server
ghcr.io/OWNER/APP:server-v1.4.2

ghcr.io/OWNER/APP:worker
ghcr.io/OWNER/APP:worker-v1.4.2

ghcr.io/OWNER/APP:updater
ghcr.io/OWNER/APP:updater-v1.4.2
```

---

## 2. QnapHomeHubで参照する実装

主要ファイル:

```text
updater/app.mjs
server/src/index.ts
server/public/update.js
server/public/index.html
compose.yaml
docker/updater.Dockerfile
.github/workflows/docker-publish.yml
.github/workflows/ci.yml
```

役割:

| ファイル | 役割 |
| --- | --- |
| `updater/app.mjs` | Release確認、pull、tag切替、compose再作成、health check、rollback |
| `server/src/index.ts` | 認証済みWeb APIからupdaterへproxy |
| `server/public/update.js` | 更新確認 / 適用 / 自動更新UI |
| `compose.yaml` | updater sidecar、Docker socket、project path mount |
| `docker/updater.Dockerfile` | updater実行環境 |
| `docker-publish.yml` | current/version固定imageとGitHub Releaseのpublish |
| `ci.yml` | 実コンテナのintegration smoke test |

---

## 3. アプリ側で必須のversion情報

単一の信頼できるversion sourceを決めます。

QnapHomeHubでは:

```text
server/package.json -> version
```

をsource of truthとしています。

例:

```json
{
  "name": "my-app",
  "version": "1.4.2"
}
```

CI、Docker build、Release tag、health APIが同じversionを参照するようにします。

health API例:

```json
GET /api/health
{
  "status": "ok",
  "version": "1.4.2"
}
```

Dockerfileではbuild argからversionを注入します。

```Dockerfile
ARG APP_VERSION=0.0.0
ENV APP_VERSION=${APP_VERSION}
```

---

## 4. updater HTTP contract

QnapHomeHub updaterは以下の最小APIを持ちます。

### GET /status

現在状態を返します。

```json
{
  "phase": "idle",
  "currentVersion": "1.4.1",
  "latestVersion": "1.4.2",
  "latestTag": "v1.4.2",
  "updateAvailable": true,
  "autoUpdate": false,
  "busy": false,
  "lastCheckedAt": "...",
  "lastAppliedAt": "...",
  "lastError": null
}
```

### POST /check

GitHub Releasesと必要な配布imageを確認します。

### PATCH /config

```json
{
  "autoUpdate": true
}
```

### POST /apply

```json
{
  "tag": "v1.4.2"
}
```

返却は処理完了ではなく、更新開始受付を示す `202 Accepted` が推奨です。

更新中の進捗は `/status` をpollします。

---

## 5. updater認証

アプリとupdater間には十分長いinternal tokenを使います。

Docker secret推奨:

```yaml
secrets:
  app_internal_token:
    file: ./secrets/app_internal_token.txt
```

アプリ -> updater:

```http
x-homehub-internal-token: <secret>
```

別アプリへ移植するときはheader名を一般化して構いません。

例:

```http
x-app-internal-token: <secret>
```

ブラウザからinternal tokenを直接送信してはいけません。

---

## 6. Compose sidecar pattern

QNAPのようにDocker daemonがhost pathを解決する環境では、**project directoryをhostとcontainerで同じ絶対pathに見せる**ことが重要です。

例:

```yaml
services:
  updater:
    image: ghcr.io/OWNER/APP:updater
    container_name: my-app-updater
    network_mode: host
    restart: unless-stopped
    environment:
      UPDATER_BIND: 127.0.0.1
      UPDATER_PORT: "8788"
      PROJECT_DIR: ${APP_PROJECT_DIR:-/share/Container/MyApp}
      COMPOSE_PROJECT_NAME: my-app
      GITHUB_REPOSITORY: OWNER/APP
      GHCR_IMAGE: ghcr.io/OWNER/APP
      APP_INTERNAL_TOKEN_FILE: /run/secrets/app_internal_token
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./:${APP_PROJECT_DIR:-/share/Container/MyApp}:ro
      - ./data/updater:/data
    secrets:
      - app_internal_token
```

次のようにcontainer内部だけ `/project` へmountして、そのpathをDocker daemonへ渡す実装は避けます。

```text
/project/data
```

Docker daemonはhost側にも `/project/data` があると解釈するため、bind mount先を誤る可能性があります。

---

## 7. 更新処理

基本アルゴリズム:

```text
1. busy lock
2. 現在containerのimage IDを保存
3. version固定imageをpull
4. 固定imageをcurrent tagへtag
5. docker compose up -d --force-recreate
6. health check
7. 成功ならstateをsuccessへ
8. 失敗なら保存したimage IDをcurrent tagへ戻す
9. docker compose up -d --force-recreate
10. rollback後のhealth check
```

旧imageはtag名ではなく **image ID** を保存します。

```sh
docker inspect --format '{{.Image}}' container-name
```

current tagは更新時に上書きされるため、rollback sourceとして信用しないでください。

---

## 8. health check

更新成功判定は「containerがrunning」だけでは不十分です。

最低限:

```text
HTTP health = 200
reported version = target version
依存service health = OK
```

QnapHomeHubではHomeHubとMatterbridgeの両方を確認します。

アプリごとに以下も追加できます。

```text
DB migration完了
plugin heartbeat
queue worker ready
外部依存へ接続済み
```

health timeout後は自動rollbackします。

---

## 9. GitHub Actions publish pattern

mainへマージしたversionを取得します。

```sh
PACKAGE_VERSION="$(node -p "require('./server/package.json').version")"
RELEASE_TAG="v${PACKAGE_VERSION}"
```

各componentについて最低3tagをpublishします。

```text
component
component-<commit SHA>
component-vX.Y.Z
```

例:

```text
server
server-ddef5ddcc18...
server-v0.2.1
```

commit SHA imageはデバッグとrollback調査にも有用です。

全image publish成功後にのみGitHub Releaseを作ります。

```sh
gh release create "v${PACKAGE_VERSION}" \
  --verify-tag \
  --generate-notes \
  --title "MyApp v${PACKAGE_VERSION}"
```

---

## 10. CIで必ず行うこと

release updaterを導入するアプリは、少なくとも以下をCIで検証します。

```text
syntax / typecheck
unit tests
Docker image build
main service health
認証
plugin/worker heartbeat
updater /status
rollbackに必要なDocker CLIの存在
compose config
```

versionをCIにhardcodeしないでください。

QnapHomeHubではpackage versionをstep outputとして取得し、Docker buildとhealth testの両方へ渡します。

---

## 11. optional: upstream component track

Matterbridgeのように、アプリ本体とは独立して頻繁に更新されるcomponentには別trackを作れます。

QnapHomeHubでは:

```text
upstream latest stable
   ↓
GitHub Actionsで取得
   ↓
QnapHomeHub pluginとのintegration test
   ↓ pass only
matterbridge-tested
   ↓
QNAP updaterがimage ID比較
   ↓
manual/auto update
```

重要なのは、upstream最新版をそのまま本番へ流さず、**自分のアプリとの結合テストを通ったimageだけをtested tagへ昇格すること**です。

---

## 12. Web UI実装

Web側では次を表示します。

```text
CURRENT
LATEST
STATUS
UPDATE AVAILABLE
LAST ERROR
AUTO UPDATE ON/OFF
```

操作:

```text
更新を確認
最新版へ更新
自動更新 ON/OFF
```

更新開始後は2秒程度で `/status` をpollし、`busy=false` かつ `phase=success/error` になるまで追跡します。

---

## 13. phase model

推奨phase:

```text
idle
checking
preparing
pulling
recreating
verifying
success
rollback
error
```

Web UIとログの両方で同じphase名を使うと運用しやすくなります。

---

## 14. データ互換性

Docker imageだけrollbackしても、永続data schemaが非互換に更新されると復旧できません。

そのため大きなmigrationでは次のいずれかを実装します。

```text
backward compatible migration
migration versioning
更新前data backup
rollback migration
```

自動更新対象のstable Releaseでは、可能な限り後方互換を保ちます。

---

## 15. 初回bootstrap問題

updater sidecar導入前の古いinstallationは、自分自身で新しいCompose serviceを追加できません。

したがって初回だけ:

```text
新compose.yaml取得
↓
updater image pull
↓
compose up
```

が必要です。

**updater導入後はCompose構造を頻繁に変えない**ことを推奨します。

Compose自体を将来自動更新する場合は、updaterがRelease artifactとして新Composeを取得し、検証・atomic replace・rollbackできる仕組みを追加してください。

---

## 16. 新規アプリ導入チェックリスト

- [ ] version sourceを1つに決めた
- [ ] `/api/health` がversionを返す
- [ ] current + version固定GHCR tagをpublishする
- [ ] stable Releaseだけを対象にする
- [ ] updaterを別containerにした
- [ ] Docker socketはupdaterだけにmountした
- [ ] updaterはloopback bind
- [ ] internal tokenで保護
- [ ] Web APIは既存ログイン認証の後ろに置いた
- [ ] old image IDを保存する
- [ ] health失敗時rollbackする
- [ ] persistent dataを消さない
- [ ] integration CIを通したものだけReleaseする
- [ ] auto updateの既定値を意図的に決めた
- [ ] updaterのstate/logを永続化した
- [ ] READMEに初回bootstrap手順を書いた

---

## 17. QnapHomeHubをテンプレートとして使う場合

別アプリへ移植するときは、まず以下を置換します。

```text
souten-yd/QnapHomeHub        -> OWNER/APP
qnaphomehub                  -> compose project name
ghcr.io/souten-yd/qnaphomehub -> new GHCR namespace
/share/Container/QnapHomeHub -> target project directory
8788                         -> updater loopback port
HOMEHUB_INTERNAL_TOKEN       -> APP_INTERNAL_TOKEN
```

その後、`updater/app.mjs` の以下を対象アプリに合わせます。

```text
currentVersion()
container names
release component names
composeUp() services
waitForHealthy()
```

更新エンジンの基本ロジック、state model、rollback設計はそのまま再利用できます。

---

## 18. セキュリティ上の禁止事項

以下は禁止します。

```text
Webアプリ本体へdocker.sockをmount
updaterを0.0.0.0で認証なし公開
ブラウザへinternal tokenを返す
latest/current tagだけでrollback
CI未検証imageを自動更新
persistent dataをupdate時に削除
```

この原則を維持すれば、QnapHomeHubと同じ更新方式を他のDockerアプリへ安全に展開できます。

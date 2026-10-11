# Web管理画面からradio停止・省書き込み起動

> **重要**: Dockerのradioログ無効化とtmpfs設定だけでは、QNAPホストの`bluetoothd`による大量書き込みは止まりません。2026-10-11の実機検証に基づく[QNAP標準Bluetooth二重起動の検出・永続起動抑制・再起動後検証・ロールバック](QNAP-HOST-BLUEZ-LOW-IO-RUNBOOK.md)を先に確認してください。HomeHubはQNAPホストのプロセスを自動停止しません。

QnapHomeHub Docker v0.3.16から、管理画面に **Bluetooth radio 管理** を追加。
操作は認証済みWeb→内部トークン付きupdater（127.0.0.1:8788）→Docker APIに限定する。
WebコンテナにDockerソケットは渡さない。

## 3種類の選択

- **radioを停止**: `docker update --restart=no qnaphomehub-radio` の後
  `docker stop -t 15 qnaphomehub-radio` で明示停止。停止が確認できなければ失敗扱い。
- **既存構成で起動**: 既存のradioコンテナを `docker start`。
  起動後に `restart=unless-stopped` を復帰させる。
  **低IO構成を解除する操作ではない**。コンテナの既存設定を保つ。
- **省書き込み起動**: QNAPのCompose構成を検証した上で、
  既存radioの自動再起動を無効化し**停止完了を確認してから**
  `docker compose -f compose.yaml -f /app/compose.radio-low-io.yaml
  up -d --no-deps --force-recreate radio` でradioを1台だけ再作成。
  stopped状態のradioからも実行可能。実際の
  `LogConfig.Type=none`、`HostConfig.Tmpfs[/run/dbus,/tmp]` をDocker inspectで検証。

## SelfCareとデータの保護

操作対象は `qnaphomehub-radio` のみ。Compose service/project名、
ネットワーク、永続バインドを毎回照合する。Matterbridge、updater、Web、
QnapSelfCare QPKG、QTSホスト`bluetoothd`は操作しない。
停止中・再作成中は血圧計/体組成計の自動同期、SwitchBot操作が使えなくなる。
保存済み測定値とペアリングキーは消さない。
`/var/lib/bluetooth` は元の永続バインドのまま維持し、RAMに置くのは
`/run/dbus`と`/tmp`のみ。既存の自動更新中はモード変更を拒否する。

## 実機テスト

1. まず旧Docker版Webがv0.3.16になっていること、
   `qnaphomehub-updater`もv0.3.16の新コンテナであることを確認。
   **Webだけ新しくても旧updaterのままでは切り替えボタンは使えない。**
2. 管理画面で状態を確認→「radioを停止」。停止したまま15秒のI/O診断。
3. 「省書き込み起動」。radioが1つだけ稼働し、ログ=none/D-BusとTMP=RAMを確認。
4. 同条件で15秒I/O診断、血圧計/体組成計の手動同期、SwitchBot操作を検証。
5. 停止したradioが再起動しないか、NAS再起動後の挙動も検証。
   **比較結果が出るまでIOPS改善・ホスト`bluetoothd`の原因は未確定。**

### エラー時

省書き込み起動の構成検証、既存radioの停止、再作成、
設定確認のいずれかが失敗した場合はエラーをWebへ返す。
途中停止時はSelfCareに接続できなくなるが、データとペアリングキーは削除しない。
他サービスを勝手に起動したり、QTSのBluetoothデーモンをkillしたりしない。
Webの状態確認で、Dockerが認識している実状態を再取得する。

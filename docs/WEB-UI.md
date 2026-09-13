# Web UI

QnapHomeHubのWeb UIは、日常操作と管理作業を分離します。

## 操作ページ（既定）

```text
http://QNAP-IP:8787/
```

日常の装置操作専用です。登録済みデバイスだけを大きなカードで表示し、設定・更新・診断・Matter設定は表示しません。

表示する操作:

- PC電源プロファイル: `起動` / `強制終了`
- Pressデバイス: `押す`
- Switchデバイス: `ON` / `OFF`

強制終了は確認ダイアログを表示してから実行します。

## 管理ページ

```text
http://QNAP-IP:8787/manage.html
```

従来の管理UIです。以下をまとめて扱います。

- GitHub Release / Matterbridge更新
- Bluetoothスキャン
- デバイス登録・削除・設定
- Matter公開設定
- Webデバッグ
- HCI / API詳細設定
- HomeHub再起動

## 画面切替

両ページ上部の `操作` / `管理` から相互に切り替えます。

テーマ設定（BLACK / CYBER）は両ページで共通のlocalStorageを利用するため、片方で変更するともう片方にも反映されます。

# M5GOでUSBと同じOmron登録を行う限定操作

v0.3.30の候補。HBF-228Tのみ。実機での登録保持・履歴・自動保存は未検証。

USBの `Session.subscribe()` と `Session.pair(existing_key, 'HBF-228T')` をそのまま使用する。順序は全RXとunlock購読、現在のBLE暗号化成功確認、Omron `02+zeros` / `8200`、`00+existing_key` / `8000`、1秒待機、通信開始、正常終了。キーはSelfCareが通常syncで渡す既存値のみ。新規生成、SelfCareのpair呼出し、キーのDB更新はしない。

同じキー値でも体組成計内の接続元登録が変更される可能性はある。既存USBが維持されることは未確認であり、通常の同期失敗時に自動実行する操作ではない。BLE登録だけを許可する従来操作とは別に予約する。

## 操作と結果

1. HBFの自動同期を停止し、進行中のHBFジョブがないことを確認。M5GO経路へ切り替える。
2. 新しいP表示を確認してから、認証済み管理API `/api/m5go` に `{"action":"prepare-application-registration","confirm":"register-existing-key-hbf-228t"}` を送る。
3. 同じ対象の通常syncを1回だけ要求する。SelfCareのpairは要求しない。HomeHub内の予約が次の要求を登録専用へ切り替える。
4. `bondSession.mode: application` の予約は120秒・1回限り。ワーカー起動前に消費し、失敗後の通常要求は登録を繰り返さない。キーや予約フラグを要求に追加するだけでは許可できない。経路・設定変更、再起動、`cancel-bond-session`で失効する。
5. 登録専用の応答は `registration_only: true`、空の `records`、`diagnostic.stage: registration_completed`、`application_key_value_reused: true`、`history_read: false`。SelfCareの既存syncレスポンス形式を維持するため空配列を返すが、測定取得成功を意味しない。HomeHubは `lastRegistration` を更新し、`lastSync` は更新しない。
6. 失敗なら停止。BLE bond削除・再登録・キー変更へ自動で進まない。USB経路と元の自動同期設定に復帰する。経路復帰だけで体組成計内の登録が復元されたとは判定しない。

## 実機試験の判定

登録時は暗号化成功、8200、8000、通信開始・終了の正常応答、予約消費を確認する。履歴0件は意図した結果。成功後はUSBによるHBF接続を挟まずに、短押しによるM5GO通常同期を1回行い、暗号化・8100・履歴・終了を確認する。その後、USBへ戻し、再登録なしの既存キー同期を確認する。M5GOだけ成功してUSBが使えなくなった場合は互換性達成としない。

通常再接続・USB保持を確認した後も、M5GO再起動後の復帰と新しい測定の自動保存が最終条件として残る。

## 自動検証

- PythonはUSBとM5GO登録の全送信バイト列・通知順序を比較し、既存キーの一致、履歴未読取り、正常終了を確認。
- キー登録の拒否・応答不明の切断・キャンセル・暗号化失敗・診断欠落では停止し、キー登録を再送しない。終了失敗を成功扱いしない。
- 管理層はBLEのみの許可との区別、偽装フラグ無効化、期限・1回消費、他機種のUSB経路維持、設定変更時の取消、登録結果と履歴結果の分離を検証。
- 既存USB Session、解析、SelfCareソース・スキーマ、firmwareの変更なし。実機結果は受入記録へ別途記載する。

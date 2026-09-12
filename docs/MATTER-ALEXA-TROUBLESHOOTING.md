# Matterbridge / Alexa commissioning troubleshooting

QnapHomeHubはMatterbridgeをbridge modeで起動し、SwitchBot Botをbridged endpointとしてAlexaへ公開します。

## 「認証されていない」警告について

Matterbridgeは一般のCSA認証済み量産製品ではないため、Alexaのcommissioning中に未認証/非互換の警告が出る場合があります。

この警告だけでQnapHomeHub pluginの異常とは判断しません。

Alexa側に「それでも設定する」「続行」相当の選択肢が表示される場合は、続行してcommissioningを進めます。

## 正常なcommissioningの大まかな流れ

```text
PASE session
  ↓
armFailSafe
  ↓
setRegulatoryConfig
  ↓
certificateChainRequest
  ↓
attestationRequest
  ↓
csrRequest
  ↓
addTrustedRootCertificate
  ↓
addNoc
  ↓
commissioningComplete
```

QnapHomeHubで過去に確認した失敗例では、AlexaからMatterbridgeへ

```text
certificateChainRequest
attestationRequest
```

までは到達していました。

この場合、QRコード認識、Matterbridge discovery、PASE開始までは成立しています。

## 失敗点の確認

Alexaで追加を実行した直後に:

```sh
cd /share/Container/QnapHomeHub

docker compose logs --since=5m matterbridge | \
  grep -Ei 'PASE|armFailSafe|regulatory|certificateChain|attestation|csr|trustedRoot|addNoc|commission|failsafe|validation|error|warn|status'
```

### attestationRequestの直後に止まる

```text
attestationRequest
<response>
...
Failsafe timer expired
```

の場合、commissioner側がattestation後に処理を中断しています。

QnapHomeHub pluginのBLE操作経路より前のMatter commissioning層の問題です。

### setRegulatoryConfigでValidation error

countryCodeが空の場合などはcontroller側commissioning情報の問題です。

### addNocまで進んで失敗

Fabric/NOC登録側の問題として扱います。

## 必須確認

- AlexaアプリとMatter対応Echo/eeroを同じAmazonアカウントで使用する
- Echo/eeroとQNAPを同じ家庭LANから相互到達可能にする
- commissioning中はiPhone/AndroidのVPN/Tailscaleを一時OFFにして切り分ける
- QNAPのUDP 5353 (mDNS) と Matter port UDP 5540 をLAN内で遮断しない
- MatterbridgeのMatter loggerをDebugにする
- 失敗直後のMatterbridgeログを確認する

## 既に別Fabricへ登録済みの場合

新しいcontrollerへ追加する場合はMatterbridge frontendからpairing modeを開き、新しいcommissioning codeを使います。

永続データを不用意に削除しないでください。

```text
data/matterbridge/
```

にはMatter Fabric情報が含まれます。

factory resetはログで失敗点を確認してから実施します。

## QnapHomeHub endpointについて

Alexa互換性を優先し、標準デバイスはMatter OutletまたはLightとして公開します。

PC電源プロファイルではMatter公開ON時に:

```text
<表示名>             -> 短押し（起動）
<表示名> 強制終了    -> 設定秒数の長押し
```

の2 endpointを公開します。

強制終了endpointはONコマンドを受けると長押しを実行し、その後Matter上の状態をOFFへ戻すmomentary動作です。

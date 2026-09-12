# Matterbridge / Alexa commissioning troubleshooting

QnapHomeHubはMatterbridgeをbridge modeで起動し、SwitchBot Botをbridged endpointとしてAlexaへ公開します。

## 推奨ネットワーク構成: split network

QNAPの管理通信とMatter通信は分離して考えます。

```text
管理アクセス
PC / iPhone -> Tailscale -> QNAP Web UI / SSH

Matter通信
Echo / Alexa -> 家庭LAN (IPv6 + mDNS) -> Matterbridge UDP 5540
```

QNAPのデフォルトルートがTailscale/VPN/Exit Node側でも構いません。MatterbridgeのmDNSだけはEchoと同じ家庭LAN interfaceへ固定します。

QnapHomeHubはMatterbridge起動時に次の順でmDNS interfaceを選びます。

1. `MATTERBRIDGE_MDNS_INTERFACE` が指定されていればそれを使用
2. `10.x.x.x` / `172.16-31.x.x` / `192.168.x.x` のRFC1918 IPv4を持つ実LAN interfaceを優先
3. `docker*`, `veth*`, `br-*`, `tailscale*`, `tun*`, `tap*`, `wg*`, `zt*`, `virbr*` は除外
4. それでも見つからない場合のみ非トンネルdefault routeをfallbackとして検討

QNAP実機ではdefault routeが`tun2001`を向く場合があるため、default routeだけでMatter LANを判定してはいけません。

### IPv6はMatter LAN側で必須

Matter commissioningにはLAN内IPv6が必要です。インターネット側でIPv6接続を使う必要はありませんが、QNAPとEchoが接続されている実LAN interfaceには少なくともlink-local IPv6 (`fe80::/64`) が必要です。

確認:

```sh
cat /proc/net/if_inet6
ip -6 addr show
```

`lo`しか出ない場合はMatter LANのIPv6が無効です。QNAPのNetwork & Virtual Switchで、`192.168.x.x`を持つ実LAN interfaceのIPv6を有効にしてください。

実LAN interfaceの確認例:

```sh
ip -o -4 addr show | grep '192\.168\.'
```

必要ならComposeまたは環境変数で明示指定できます。

```text
MATTERBRIDGE_MDNS_INTERFACE=<実LAN IF名>
```

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

リアルタイム確認:

```sh
docker compose logs -f matterbridge | \
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
- QNAPのMatter LAN interfaceにIPv6 link-localが存在する
- MatterbridgeのmDNS interfaceがTailscale/VPNではなく実LANを向いている
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

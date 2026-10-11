# SPDX-License-Identifier: GPL-3.0-or-later
"""Bounded M5GO operations, JSON stdin/stdout. Never programs Omron keys."""
import asyncio
import base64
import fcntl
import json
import os
import re
import signal
import sys

from ble_worker import Session, sync_session
import ble_protocol as protocol
from esp_proxy_probe import normalize_mac, masked_mac
from esp_proxy_transport import ProxyConnection


class ProxyInputError(ValueError):
    """Operator-safe messages from our own validation; never raw dependency errors."""


class HbfProxySession(Session):
    """Stage HBF notifications around existing-key auth; leave USB Session intact.

    HBF-222T observations document RX0+unlock before auth, then unlock off and
    RX1..3 on before memory transfer. HBF-228T hardware acceptance is separate.
    """

    async def subscribe(self):
        await self.client.start_notify(protocol.RX[0], lambda _, data: self.notify(0, bytes(data)))
        await asyncio.sleep(0.75)
        await self.client.start_notify(protocol.UNLOCK, lambda _, data: self.unlocks.put_nowait(bytes(data)))
        await asyncio.sleep(0.75)

    async def unlock(self, opcode, key, expected):
        if opcode != 1 or expected != 0x81:
            raise ProxyInputError('M5GO HBF sessions only authenticate an existing key')
        await super().unlock(opcode, key, expected)
        if self.trace is not None:
            self.trace['stage'] = 'subscribe_history'
        # Only a successful 8100 response permits the notification transition.
        # Do not send the memory-start command if any CCCD operation fails.
        await self.client.stop_notify(protocol.UNLOCK)
        for index in range(1, len(protocol.RX)):
            await self.client.start_notify(protocol.RX[index], lambda _, data, i=index: self.notify(i, bytes(data)))


def validate(request):
    if request.get('action') not in ('probe', 'sync', 'bond', 'watch'):
        raise ProxyInputError('Unsupported M5GO operation')
    if 'bond_session' in request and (type(request['bond_session']) is not bool or request['action'] != 'sync'):
        raise ProxyInputError('Registration session requires an explicit sync operation')
    proxy = request['proxy']
    host = proxy.get('host', '')
    if not isinstance(host, str) or not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,253}', host):
        raise ProxyInputError('Invalid proxy host')
    psk = proxy.get('noise_psk', '')
    try:
        if len(base64.b64decode(psk, validate=True)) != 32:
            raise ProxyInputError()
    except Exception:
        raise ProxyInputError('Invalid proxy encryption key') from None
    if request['action'] in ('sync', 'bond'):
        device = request['device']
        if device.get('model') != 'HBF-228T':
            raise ProxyInputError('M5GO route only supports HBF-228T')
        normalize_mac(device['address'])
        if request['action'] == 'sync':
            if not re.fullmatch(r'[0-9a-fA-F]{32}', request.get('key', '')):
                raise ProxyInputError('Existing Omron application key is required')
            bindings = device.get('bindings', {})
            if not bindings or any(str(k) not in ('1', '2', '3', '4') for k in bindings):
                raise ProxyInputError('Invalid HBF user slots')
    if request.get('target'):
        normalize_mac(request['target'])
    seconds = request.get('scan_seconds', 12)
    if type(seconds) is not int or not 2 <= seconds <= 30:
        raise ProxyInputError('Scan time must be 2..30 seconds')


async def operate(request, trace=None, connection_factory=ProxyConnection):
    validate(request)
    proxy = request['proxy']
    if trace is not None:
        trace.update(stage='proxy_connection', transport='m5go', automatic_hci_reset=False)
    async with connection_factory(proxy['host'], proxy['noise_psk']) as remote:
        pairing = remote.pairing_supported
        if trace is not None:
            trace.update(api_connected=True, pairing_supported=pairing, stage='discovery')
        action = request['action']
        bond_session = action == 'sync' and request.get('bond_session') is True
        explicit_bond = action == 'bond' or bond_session
        target = request.get('target') if action == 'probe' else request['device']['address']
        output = {'schema': 1, 'mode': 'read-only', 'api_connected': True,
                  'pairing_supported': pairing, 'advertisement_seen': False,
                  'gatt_connected': False, 'omron_service_found': False,
                  'target': masked_mac(target) if target else None}
        if not target:
            # Preserve the original CLI's untargeted advertisement count.
            try:
                await asyncio.wait_for(remote.disconnected.wait(), request.get('scan_seconds', 12))
            except TimeoutError:
                output['devices_seen'] = len(remote.observations)
                return output
            raise ConnectionError('M5GO API disconnected')
        target = normalize_mac(target)
        try:
            adv = await remote.find(target, request.get('scan_seconds', 12) if action == 'probe' else 20)
        except TimeoutError:
            if action == 'probe':
                return output
            raise ProxyInputError('M5GOで対象機器の広告を検出できません') from None
        output.update(advertisement_seen=True, rssi=adv.rssi)
        if action == 'probe' and not request.get('connect'):
            return output
        if trace is not None:
            trace.update(stage='connection', rssi=adv.rssi, connection_timeout_s=20)
        client = remote.client(target, adv)
        try:
            security = await remote.prepare_security(trace) if action in ('sync', 'bond') else None
            if bond_session and not security:
                raise ProxyInputError('Registration session requires current-connection security diagnostics')
            if explicit_bond and security:
                if not pairing:
                    raise ProxyInputError('M5GO firmware does not advertise PAIRING support')
                await remote.prepare_bond(target)
                security.mark('explicit_bond_prepared')
            await asyncio.wait_for(client.connect(), 25)
            if security:
                await security.connected(require_bond=action == 'sync' and not bond_session)
            output.update(gatt_connected=bool(client.is_connected),
                          omron_service_found=client.services.get_service(protocol.SERVICE) is not None)
            if action == 'probe':
                return output
            if not output['omron_service_found']:
                raise ProxyInputError('対応するOmronサービスがありません')
            if explicit_bond:
                # Explicit operator action only. This is BLE security, NOT Session.pair().
                if not pairing:
                    raise ProxyInputError('M5GO firmware does not advertise PAIRING support')
                # Stage HBF authentication notifications before BLE pairing;
                # add the remaining data channels only after application auth.
                if trace is not None:
                    trace['stage'] = 'subscribe'
                if security:
                    security.mark('notifications_requested')
                session = HbfProxySession(client, trace)
                await session.subscribe()
                if security:
                    security.mark('notifications_ready')
                if trace is not None:
                    trace['stage'] = 'bond'
                await asyncio.wait_for(client.pair(), 30)
                if security:
                    await security.authenticated()
                if bond_session:
                    security.mark('unlock_allowed')
                    if trace is not None:
                        trace['explicit_bond_session'] = True
                    # Never call Session.pair(): reuse SelfCare's existing key,
                    # read history and check normal close on this connection.
                    # Reconnect persistence still needs a separate acceptance.
                    return await sync_session(session, request, trace)
                return {'bonded': True, 'application_key_changed': False}
            if trace is not None:
                trace['stage'] = 'subscribe'
            session = HbfProxySession(client, trace)
            if security:
                security.mark('notifications_requested')
            await session.subscribe()
            if security:
                security.mark('notifications_ready')
                if trace is not None:
                    trace['stage'] = 'link_security'
                await security.authenticated()
                security.mark('unlock_allowed')
            return await sync_session(session, request, trace)
        finally:
            await asyncio.wait_for(client.disconnect(), 8)


async def watch(request, emit, connection_factory=ProxyConnection):
    validate(request)
    from ble_advertisement import AdvertisementEvents
    events = AdvertisementEvents(request['addresses'], emit)
    def advertisement(address, adv):
        from types import SimpleNamespace
        events.detected(SimpleNamespace(address=address), SimpleNamespace(
            local_name=adv.name or None, manufacturer_data=adv.manufacturer_data,
            service_data=adv.service_data, service_uuids=adv.service_uuids,
            tx_power=None, rssi=adv.rssi))
    proxy = request['proxy']
    async with connection_factory(proxy['host'], proxy['noise_psk'], advertisement) as remote:
        emit({'ready': True, 'api_connected': True,
              'pairing_supported': remote.pairing_supported})
        await remote.subscribe_diagnostics(lambda values: emit({'diagnostics': values}))
        await remote.disconnected.wait()
        emit({'ready': False, 'api_connected': False, 'error': 'M5GO API disconnected'})


def main():
    trace = None
    def emit(value):
        print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)
    async def run(request):
        task = asyncio.current_task()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, task.cancel)
        if request.get('action') == 'watch':
            await watch(request, emit)
        else:
            result = await asyncio.wait_for(operate(request, trace), 180)
            emit(result)
    try:
        request = json.loads(sys.stdin.readline(65536))
        if request.get('diagnostic') is True:
            trace = {'stage': 'starting', 'slots': [], 'protocol_revision': 4, 'rx_notifications': 0}
        # Same lock as the USB worker. Watch does not open a GATT connection.
        if request.get('action') != 'watch':
            lock = os.open(os.environ.get('SELFCARE_BLE_LOCK', '/tmp/qnapselfcare-ble.lock'),
                           os.O_WRONLY | os.O_CREAT, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        asyncio.run(run(request))
        return 0
    except asyncio.CancelledError:
        return 0
    except Exception as error:
        # Library exceptions may embed addresses/credentials. Return type and stage only.
        emit({'error': str(error) if isinstance(error, ProxyInputError) else 'M5GO operation failed: ' + type(error).__name__,
              **({'diagnostic': trace} if trace is not None else {})})
        return 1


if __name__ == '__main__':
    sys.exit(main())

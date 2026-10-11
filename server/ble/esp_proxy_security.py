"""Bounded, payload-free firmware journal and a current-connection security gate."""
import asyncio
import json
import time


class LinkSecurityError(ValueError):
    pass


FIELDS = {'open': 1, 'encrypt': 1, 'auth_ok': 4, 'auth_fail': 4,
          'bond_open': 6, 'bond_auth': 6, 'bond_close': 6,
          'bond_count': 1, 'bond_list_failed': 0, 'peer_not_bonded': 0,
          'cccd': 2, 'write': 2, 'disconnect': 1}


def parse_session(raw):
    if not isinstance(raw, str) or len(raw) > 3072:
        raise ValueError('Invalid BLE session journal')
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {'v', 'seq', 'overflow', 'events'} or
            type(value['v']) is not int or value['v'] != 1 or
            type(value['seq']) is not int or not 0 <= value['seq'] <= 0xffffffff or
            type(value['overflow']) is not bool or not isinstance(value['events'], list) or
            len(value['events']) > 24):
        raise ValueError('Invalid BLE session journal')
    previous = 0
    for event in value['events']:
        if (not isinstance(event, list) or len(event) < 2 or not isinstance(event[0], str) or
                event[0] not in FIELDS or len(event) != 2 + FIELDS[event[0]] or
                any(type(n) is not int for n in event[1:]) or
                not previous <= event[1] <= 0xffffffff or
                any(not -1 <= n <= 65535 for n in event[2:])):
            raise ValueError('Invalid BLE session event')
        previous = event[1]
    return value


class SessionSecurity:
    def __init__(self, disconnected, trace=None):
        self.disconnected = disconnected
        self.trace = trace
        self.changed = asyncio.Event()
        self.snapshot = None
        self.baseline = None
        self.current = None
        self.error = None
        self.started = time.monotonic()

    def mark(self, name):
        if self.trace is not None:
            self.trace.setdefault('ble_steps', []).append(
                [name, int((time.monotonic() - self.started) * 1000)])

    def update(self, raw):
        try:
            value = parse_session(raw)
            self.snapshot = value
            if self.baseline is not None:
                if value['seq'] == self.baseline and self.current is None:
                    return  # Initial-state retransmission is never current proof.
                if value['seq'] != (self.baseline + 1) & 0xffffffff:
                    self.error = 'unexpected_connection'
                elif self.current and value['events'][:len(self.current['events'])] != self.current['events']:
                    self.error = 'journal_regressed'
                else:
                    self.current = value
                    if self.trace is not None:
                        self.trace['ble_session'] = value
        except (ValueError, TypeError, RecursionError):
            self.error = 'invalid_journal'
        finally:
            self.changed.set()

    def _check(self):
        if self.disconnected.is_set():
            self.error = 'api_disconnected'
        if self.current:
            events = self.current['events']
            if self.current['overflow']:
                self.error = 'journal_overflow'
            elif not events or events[0][0] != 'open' or events[0][2] != 0:
                self.error = 'open_failed'
            elif any(e[0] == 'auth_fail' for e in events):
                self.error = 'authentication_failed'
            elif any(e[0] == 'encrypt' and e[2] != 0 for e in events):
                self.error = 'encryption_request_failed'
            elif any(e[0] == 'disconnect' for e in events):
                self.error = 'ble_disconnected'
        if self.error:
            if self.trace is not None:
                self.trace['link_security'] = self.error
            raise LinkSecurityError(self.error)

    async def _wait(self, predicate, timeout):
        try:
            async with asyncio.timeout(timeout):
                while True:
                    self.changed.clear()
                    self._check()
                    if predicate():
                        return
                    await self.changed.wait()
        except TimeoutError:
            self.error = 'security_timeout'
            self._check()

    async def arm(self, timeout=10):
        await self._wait(lambda: self.snapshot is not None, timeout)
        # The arbiter owns the only BLE slot; require exactly the next OPEN.
        self.baseline = self.snapshot['seq']
        if self.trace is not None:
            self.trace['link_security'] = 'waiting_for_current_connection'
        self.mark('connect_requested')

    async def connected(self, require_bond, timeout=5):
        await self._wait(lambda: self.current is not None, timeout)
        if require_bond:
            def bonded():
                events = self.current['events']
                if any(e[0] in ('bond_count', 'bond_list_failed', 'peer_not_bonded') for e in events):
                    self.error = 'stored_bond_unavailable'
                    self._check()
                return any(e[0] == 'bond_open' and e[2] & 1 and 7 <= e[3] <= 16 for e in events)
            await self._wait(bonded, timeout)
        self.mark('gatt_connected')

    async def authenticated(self, timeout=10):
        await self._wait(lambda: self.current is not None and
                         any(e[0] == 'auth_ok' and e[2] == 0 for e in self.current['events']), timeout)
        if self.trace is not None:
            self.trace['link_security'] = 'authenticated'
        self.mark('authentication_confirmed')

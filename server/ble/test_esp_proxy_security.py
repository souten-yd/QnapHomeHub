import asyncio
import json
import unittest

from esp_proxy_security import LinkSecurityError, SessionSecurity, parse_session


def journal(seq, *events, overflow=False):
    return json.dumps({'v': 1, 'seq': seq, 'overflow': overflow, 'events': events})


OPEN = ['open', 0, 0]
BOND = ['bond_open', 1, 3, 16, 0, 1, 0, 0]
AUTH = ['auth_ok', 5, 0, 1, 0, 1]
FAIL = ['auth_fail', 5, 97, 1, 0, 0]


class SecurityTests(unittest.IsolatedAsyncioTestCase):
    async def prepared(self):
        trace = {}
        gate = SessionSecurity(asyncio.Event(), trace)
        gate.update(journal(7, OPEN, AUTH, ['disconnect', 6, 22]))
        await gate.arm(.1)
        return gate, trace

    async def test_stale_authentication_never_unblocks_new_connection(self):
        gate, trace = await self.prepared()
        waiting = asyncio.create_task(gate.authenticated(.2))
        await asyncio.sleep(0)
        self.assertFalse(waiting.done())
        gate.update(journal(8, OPEN, BOND))
        await gate.connected(True, .1)
        await asyncio.sleep(0)
        self.assertFalse(waiting.done())
        # Coalesced publication retains all events in the firmware journal.
        gate.update(journal(8, OPEN, BOND, ['encrypt', 2, 0], AUTH))
        await waiting
        self.assertEqual(trace['link_security'], 'authenticated')
        self.assertEqual(trace['ble_session']['seq'], 8)

    async def test_failures_and_unknown_bond_never_allow_authentication(self):
        cases = [([OPEN, BOND, FAIL], 'authentication_failed'),
                 ([OPEN, ['bond_count', 1, 0]], 'stored_bond_unavailable'),
                 ([OPEN, BOND, ['encrypt', 2, 5]], 'encryption_request_failed'),
                 ([OPEN, BOND, AUTH, ['disconnect', 6, 22]], 'ble_disconnected')]
        for events, error in cases:
            gate, trace = await self.prepared()
            gate.update(journal(8, *events))
            with self.assertRaisesRegex(LinkSecurityError, error):
                await gate.connected(True, .1)
            self.assertEqual(trace['link_security'], error)

    async def test_timeout_disconnect_cancel_and_sequence_corruption(self):
        gate, _ = await self.prepared()
        gate.update(journal(8, OPEN, BOND))
        with self.assertRaisesRegex(LinkSecurityError, 'security_timeout'):
            await gate.authenticated(.01)
        gate, _ = await self.prepared()
        waiting = asyncio.create_task(gate.authenticated(1))
        await asyncio.sleep(0)
        gate.disconnected.set(); gate.changed.set()
        with self.assertRaisesRegex(LinkSecurityError, 'api_disconnected'):
            await waiting
        gate, _ = await self.prepared()
        waiting = asyncio.create_task(gate.authenticated(1))
        await asyncio.sleep(0); waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        for value, error in [(journal(9, OPEN, AUTH), 'unexpected_connection'),
                             (journal(8, OPEN, AUTH, overflow=True), 'journal_overflow')]:
            gate, _ = await self.prepared(); gate.update(value)
            with self.assertRaisesRegex(LinkSecurityError, error):
                await gate.authenticated(.1)
        gate, _ = await self.prepared()
        gate.update(journal(8, OPEN, BOND))
        gate.update(journal(8, OPEN, AUTH))
        with self.assertRaisesRegex(LinkSecurityError, 'journal_regressed'):
            await gate.authenticated(.1)

    def test_parser_rejects_unbounded_arbitrary_text_and_extra_fields(self):
        for value in ('x' * 3073, '{}', journal(1, ['private key', 0]),
                      journal(1, ['auth_ok', 0, True, 1, 0, 1]),
                      journal(1, OPEN, ['encrypt', -1, 0]), journal(1, *([OPEN] * 25)),
                      journal(1, ['bond_open', 0, 3, 16, 0, 'secret', 0, 0]),
                      json.dumps({'v': 1, 'seq': 1, 'overflow': False, 'events': [], 'key': 'secret'})):
            with self.subTest(value=value[:80]), self.assertRaises(ValueError):
                parse_session(value)

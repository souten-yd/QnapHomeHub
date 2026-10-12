import asyncio
import json
from types import SimpleNamespace
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch, AsyncMock
from urllib.parse import parse_qs, urlsplit
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from esp_display_bridge import build_snapshot, profile_snapshot, push_snapshot, stamp, validate_config, midnight_slot, claim_day, run

NOW = stamp('2026-10-12T03:00:00+00:00')
PROFILE = {'user_id': 'alice', 'label': 'USER 1'}
CONFIG = {'selfcare_url': 'http://selfcare:17863', 'profiles': [PROFILE]}


def row(at, weight, fat=25, user='alice', identifier='r1'):
    return {'id': identifier, 'user_id': user, 'kind': 'body_composition',
            'measured_at': at, 'values': {'weight': weight, 'body_fat': fat}}


class SummaryTest(unittest.TestCase):
    def test_daily_last_japan_midnight_missing_days_and_previous(self):
        history = [row('2026-10-05T14:59:00Z', 99),  # outside week
                   row('2026-10-05T15:00:00Z', 70),  # Oct 6 JST
                   row('2026-10-11T23:00:00Z', 68),
                   row('2026-10-12T02:00:00Z', 67, None),
                   row('2026-10-12T04:00:00Z', 88)]  # future
        result = profile_snapshot(PROFILE, history[2:], history, NOW, ZoneInfo('Asia/Tokyo'))
        self.assertEqual(result['weights'], [70, None, None, None, None, None, 67])
        self.assertEqual(result['days'], ['10/06','10/07','10/08','10/09','10/10','10/11','10/12'])
        self.assertEqual(result['delta'], -1)
        self.assertIsNone(result['fat'])
        self.assertIsNone(result['fats'][-1])  # do not substitute an earlier day's fat
        self.assertEqual(result['measured'], '2026/10/12 11:00')

    def test_no_history_and_single_point_are_not_zero(self):
        empty = profile_snapshot(PROFILE, [], [], NOW, ZoneInfo('Asia/Tokyo'))
        self.assertEqual(empty['weights'], [None]*7)
        self.assertIsNone(empty['weight'])
        one = row('2026-10-12T02:00:00Z', 67)
        self.assertIsNone(profile_snapshot(PROFILE, [one], [one], NOW, ZoneInfo('Asia/Tokyo'))['delta'])

    def test_other_user_wrong_kind_bad_metrics_and_naive_date_rejected(self):
        bad = [row('2026-10-12T02:00:00Z', 65, user='bob'),
               row('2026-10-12T02:00:00Z', float('nan')),
               row('2026-10-12T02:00:00Z', True),
               row('2026-10-12T02:00:00', 65),
               row('2026-10-12T02:00:00Z', 65) | {'kind':'blood_pressure'}]
        for record in bad:
            with self.subTest(record=record), self.assertRaises(ValueError):
                profile_snapshot(PROFILE, [record], [record], NOW, ZoneInfo('Asia/Tokyo'))

    def test_get_only_filters_profiles_and_latest_outside_week(self):
        urls = []
        old = row('2026-09-30T02:00:00Z', 70)
        def get(url):
            urls.append(url)
            if url.endswith('/api/users'):
                return [{'id':'alice'}]
            query = parse_qs(urlsplit(url).query)
            self.assertEqual(query['user_id'], ['alice'])
            self.assertEqual(query['kind'], ['body_composition'])
            self.assertIn('until', query)
            return {'records':[],'total':0} if 'since' in query else {'records':[old], 'total':1}
        data = json.loads(build_snapshot(CONFIG, NOW, get))
        self.assertEqual(data['profiles'][0]['weight'], 70)
        self.assertEqual(data['profiles'][0]['weights'], [None]*7)
        self.assertEqual(len(urls), 3)
        self.assertNotIn('alice', json.dumps(data)) # do not transmit database IDs or names

    def test_pagination_change_and_truncation_fail_closed(self):
        item = row('2026-10-12T02:00:00Z', 70)
        for changing in (True, False):
            def get(url):
                if url.endswith('/api/users'): return [{'id':'alice'}]
                q = parse_qs(urlsplit(url).query)
                if 'since' not in q: return {'records':[item], 'total':10000}
                offset = int(q['offset'][0])
                return {'records':[item]*2000,'total':10000 + (1 if changing and offset else 0)}
            with self.assertRaises(ValueError): build_snapshot(CONFIG, NOW, get)

    def test_multiple_profiles_remain_separate(self):
        config = CONFIG | {'profiles':[PROFILE, {'user_id':'bob', 'label':'USER 2'}]}
        def get(url):
            if url.endswith('/api/users'): return [{'id':'alice'}, {'id':'bob'}]
            q=parse_qs(urlsplit(url).query); user=q['user_id'][0]
            return {'records':[row('2026-10-12T02:00:00Z', 60 if user=='alice' else 80,user=user)],'total':1}
        data=json.loads(build_snapshot(config,NOW,get))
        self.assertEqual([p['weight'] for p in data['profiles']], [60,80])

    def test_unknown_user_and_invalid_config_rejected(self):
        with self.assertRaises(ValueError): build_snapshot(CONFIG, NOW, lambda _: [])
        for patch in ({'profiles':[]}, {'schedule':'every-minute'}, {'profiles':[PROFILE,PROFILE]},
                      {'profiles':[PROFILE | {'label':'X'*17}]}, {'selfcare_url':'file:///tmp/db'}):
            with self.assertRaises(ValueError): validate_config(CONFIG | patch)


class PushTest(unittest.IsolatedAsyncioTestCase):
    async def test_display_ack_only_no_bluetooth_and_always_disconnect(self):
        for mode in ('ok','missing','reject','timeout'):
            events=[]
            class Client:
                def __init__(self, host, port, password, **kw):
                    self_test.assertEqual(port,6053); self_test.assertIn('noise_psk',kw)
                async def connect(self, **kw): events.append('connect')
                async def list_entities_services(self):
                    return [], [] if mode=='missing' else [SimpleNamespace(name='health_display_update',
                        args=[SimpleNamespace(name='payload',type=3)])]
                async def execute_service(self, service, data, **kw):
                    events.append('display'); self_test.assertTrue(kw['return_response'])
                    if mode=='timeout': raise TimeoutError()
                    return SimpleNamespace(success=mode!='reject')
                async def disconnect(self): events.append('disconnect')
            self_test=self
            proxy={'host':'test.local','noisePsk':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='}
            if mode=='ok': await push_snapshot(proxy,'{}',Client)
            else:
                with self.assertRaises((ValueError,TimeoutError)): await push_snapshot(proxy,'{}',Client)
            self.assertEqual(events[-1],'disconnect')
            self.assertNotIn('display',events) if mode=='missing' else self.assertIn('display',events)


class ScheduleTest(unittest.IsolatedAsyncioTestCase):
    def test_jst_boundary_and_missed_slot(self):
        zone = ZoneInfo('Asia/Tokyo')
        for at, expected in (
            ('2026-10-12T14:59:59Z', '2026-10-13T00:00:00+09:00'),
            ('2026-10-12T15:00:00Z', '2026-10-13T00:00:00+09:00'),
            ('2026-10-12T15:00:59Z', '2026-10-13T00:00:00+09:00'),
            ('2026-10-12T15:01:00Z', '2026-10-14T00:00:00+09:00')):
            self.assertEqual(midnight_slot(stamp(at), zone).isoformat(), expected)

    def test_durable_claim_restart_rollback_and_corrupt_state(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp) / 'state.json'
            self.assertTrue(claim_day(state, '2026-10-13'))
            self.assertFalse(claim_day(state, '2026-10-13'))
            self.assertFalse(claim_day(state, '2026-10-12'))
            self.assertTrue(claim_day(state, '2026-10-14'))
            self.assertEqual(state.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(state.read_text()), {'last_attempt_day':'2026-10-14'})
            state.write_text('{bad')
            with self.assertRaises(ValueError): claim_day(state, '2026-10-15')

    async def test_no_startup_or_sixty_second_fetch_one_failed_attempt_and_restart(self):
        class StopClock(Exception): pass
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / 'config.json'
            # Old installed configuration must also use midnight, never its interval.
            config.write_text(json.dumps(CONFIG | {'interval_seconds':60}))
            current = NOW
            sleeps = 0
            async def sleep(seconds):
                nonlocal current, sleeps
                current += timedelta(seconds=seconds)
                sleeps += 1
                if sleeps == 5: raise StopClock()
            with patch('esp_display_bridge.update', new_callable=AsyncMock, return_value=1) as update:
                async def simulate(at):
                    nonlocal current, sleeps
                    current, sleeps = stamp(at), 0
                    with self.assertRaises(StopClock):
                        await run(config, 'unused', now=lambda:current, sleep=sleep)
                await simulate('2026-10-12T03:00:00Z')
                update.assert_not_called()  # startup and five local clock checks
                await simulate('2026-10-12T14:59:59Z')
                self.assertEqual(update.await_count, 1)
                await simulate('2026-10-12T15:00:20Z')  # restart during the same minute
                self.assertEqual(update.await_count, 1)
                await simulate('2026-10-13T15:00:00Z')
                self.assertEqual(update.await_count, 2)

    async def test_suspended_process_skips_missed_midnight(self):
        class StopClock(Exception): pass
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / 'config.json'
            config.write_text(json.dumps(CONFIG))
            current = stamp('2026-10-12T14:59:59Z')
            sleeps = 0
            async def sleep(seconds):
                nonlocal current, sleeps
                sleeps += 1
                if sleeps == 2: raise StopClock()
                current += timedelta(minutes=5)
            with patch('esp_display_bridge.update', new_callable=AsyncMock) as update:
                with self.assertRaises(StopClock):
                    await run(config, 'unused', now=lambda:current, sleep=sleep)
                update.assert_not_called()


if __name__ == '__main__':
    unittest.main()

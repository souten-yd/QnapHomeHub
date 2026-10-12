import asyncio
import json
from types import SimpleNamespace
import unittest
from urllib.parse import parse_qs, urlsplit
from datetime import datetime
from zoneinfo import ZoneInfo
from esp_display_bridge import build_snapshot, profile_snapshot, push_snapshot, stamp, validate_config

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
        for patch in ({'profiles':[]}, {'interval_seconds':1}, {'profiles':[PROFILE,PROFILE]},
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


if __name__ == '__main__':
    unittest.main()

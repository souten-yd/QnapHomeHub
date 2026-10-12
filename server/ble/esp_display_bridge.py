"""Read saved SelfCare records and push a small display snapshot over encrypted API.

No Bluetooth discovery, connection, pairing, sync job, database write or disk cache.
Run separately from the radio worker; failures cannot start a measurement sync.
"""
import argparse
import asyncio
import base64
from datetime import datetime, time, timedelta, timezone
import json
import math
from pathlib import Path
import re
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

MAX_RESPONSE = 4 * 1024 * 1024
MAX_PAYLOAD = 4096


def metric(record, key):
    value = record.get('values', {}).get(key)
    upper = 400 if key == 'weight' else 100
    lower = 1 if key == 'weight' else 0
    if value is None:
        return None
    if type(value) not in (int, float) or not math.isfinite(value) or not lower <= value <= upper:
        raise ValueError('Invalid measurement metric')
    return round(value, 2)


def stamp(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Measurement timestamp must include timezone')
    return result


def profile_snapshot(profile, latest, week, now, zone):
    """Each day uses its last measurement; missing days remain gaps, never zeros."""
    start = now.astimezone(zone).date() - timedelta(days=6)
    days = [start + timedelta(days=i) for i in range(7)]
    all_records = latest + week
    if any(r.get('user_id') != profile['user_id'] or r.get('kind') != 'body_composition'
           for r in all_records):
        raise ValueError('Unexpected user or measurement kind')
    recent = sorted((r for r in latest if stamp(r['measured_at']) <= now),
                    key=lambda r: (stamp(r['measured_at']), r['id']), reverse=True)
    daily = {}
    for row in sorted(week, key=lambda r: (stamp(r['measured_at']), r['id'])):
        at = stamp(row['measured_at'])
        day = at.astimezone(zone).date()
        if day in days and at <= now:
            daily[day] = row
    current = recent[0] if recent else {}
    weight = metric(current, 'weight')
    fat = metric(current, 'body_fat')
    previous = metric(recent[1], 'weight') if len(recent) > 1 else None
    return {
        'label': profile['label'],
        'measured': stamp(current['measured_at']).astimezone(zone).strftime('%Y/%m/%d %H:%M') if current else '',
        'weight': weight, 'fat': fat,
        'delta': round(weight - previous, 2) if weight is not None and previous is not None else None,
        'days': [d.strftime('%m/%d') for d in days],
        'weights': [metric(daily.get(d, {}), 'weight') for d in days],
        'fats': [metric(daily.get(d, {}), 'body_fat') for d in days],
    }


def read_json(url):
    # Disable environment HTTP proxies: health data stays on the configured LAN.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(urllib.request.Request(url, headers={'Accept': 'application/json'}), timeout=10) as response:
        data = response.read(MAX_RESPONSE + 1)
    if len(data) > MAX_RESPONSE:
        raise ValueError('SelfCare response too large')
    return json.loads(data)


def validate_config(config):
    url = urllib.parse.urlsplit(config['selfcare_url'])
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('Invalid SelfCare URL')
    profiles = config['profiles']
    if not isinstance(profiles, list) or not 1 <= len(profiles) <= 4:
        raise ValueError('Configure one to four display profiles')
    seen = set()
    for p in profiles:
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', p['user_id']) or p['user_id'] in seen:
            raise ValueError('Invalid or duplicate user')
        if not re.fullmatch(r'[A-Za-z0-9 ._-]{1,16}', p['label']):
            raise ValueError('Display label must be 1..16 ASCII letters, numbers or spaces')
        seen.add(p['user_id'])
    ZoneInfo(config.get('timezone', 'Asia/Tokyo'))
    interval = config.get('interval_seconds', 60)
    if type(interval) is not int or not 60 <= interval <= 120:
        raise ValueError('Display interval must be 60..120 seconds')
    return config


def build_snapshot(config, now=None, get=read_json):
    validate_config(config)
    now = now or datetime.now(timezone.utc)
    zone = ZoneInfo(config.get('timezone', 'Asia/Tokyo'))
    first_day = now.astimezone(zone).date() - timedelta(days=6)
    since = datetime.combine(first_day, time.min, zone).isoformat()
    users = get(config['selfcare_url'].rstrip('/') + '/api/users')
    existing = {u['id'] for u in users}
    profiles = []
    for p in config['profiles']:
        if p['user_id'] not in existing:
            raise ValueError('Configured user is absent')
        filters = {'user_id': p['user_id'], 'kind': 'body_composition', 'until': now.isoformat()}

        def fetch(**extra):
            url = config['selfcare_url'].rstrip('/') + '/api/records?' + urllib.parse.urlencode(filters | extra)
            result = get(url)
            if not isinstance(result.get('records'), list) or type(result.get('total')) is not int or result['total'] < 0:
                raise ValueError('Invalid SelfCare response')
            return result

        latest = fetch(limit=2)['records']
        week = []
        total = None
        for offset in range(0, 8000, 2000):
            page = fetch(since=since, limit=2000, offset=offset)
            if total is not None and total != page['total']:
                raise ValueError('History changed during pagination; retry next poll')
            total = page['total']
            week.extend(page['records'])
            if len(week) == total:
                break
            if not page['records'] or len(week) > total:
                raise ValueError('Incomplete SelfCare history')
        else:
            raise ValueError('Weekly history exceeds display limit')
        profiles.append(profile_snapshot(p, latest, week, now, zone))
    payload = json.dumps({'schema': 1, 'profiles': profiles}, ensure_ascii=True, allow_nan=False, separators=(',', ':'))
    if len(payload.encode()) > MAX_PAYLOAD:
        raise ValueError('Display payload too large')
    return payload


async def push_snapshot(proxy, payload, client_factory=None):
    if client_factory is None:
        from aioesphomeapi import APIClient
        client_factory = APIClient
    if len(base64.b64decode(proxy['noisePsk'], validate=True)) != 32:
        raise ValueError('Invalid encryption key')
    client = client_factory(proxy['host'], 6053, None, noise_psk=proxy['noisePsk'],
                            client_info='QnapHomeHub display')
    try:
        await client.connect(login=True)
        _, services = await client.list_entities_services()
        service = next((s for s in services if s.name == 'health_display_update'), None)
        if service is None:
            raise ValueError('Display firmware is not installed')
        if len(service.args) != 1 or service.args[0].name != 'payload' or int(service.args[0].type) != 3:
            raise ValueError('Incompatible display action')
        response = await client.execute_service(service, {'payload': payload}, return_response=True, timeout=10)
        if response is None or not response.success:
            raise ValueError('Display rejected snapshot')
    finally:
        await client.disconnect()


async def run(config_path, proxy_path, once=False, check=False):
    while True:
        interval = 60
        try:
            config = validate_config(json.loads(Path(config_path).read_text()))
            interval = config.get('interval_seconds', 60)
            payload = await asyncio.to_thread(build_snapshot, config)
            if not check:
                proxy = json.loads(Path(proxy_path).read_text())
                async with asyncio.timeout(40):
                    await push_snapshot(proxy, payload)
            # No names, IDs, health values, host addresses or keys in logs.
            print('display: snapshot validated' if check else 'display: snapshot accepted', flush=True)
        except Exception:
            print('display: update unavailable; previous screen will become stale', flush=True)
            if once or check:
                return 1
        if once or check:
            return 0
        await asyncio.sleep(interval)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--proxy-config', default='/radio/m5go.json')
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--check', action='store_true', help='Read and validate saved data only; no M5GO connection')
    args = parser.parse_args()
    raise SystemExit(asyncio.run(run(args.config, args.proxy_config, args.once, args.check)))

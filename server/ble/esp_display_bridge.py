"""Read saved SelfCare records and push a small display snapshot over encrypted API.

No Bluetooth discovery, connection, pairing, sync job or measurement disk cache.
Run separately from the radio worker; failures cannot start a measurement sync.
"""
import argparse
import asyncio
import base64
import fcntl
from datetime import datetime, time, timedelta, timezone
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
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
    if config.get('schedule', 'midnight') != 'midnight':
        raise ValueError('Display schedule must be midnight')
    # Ignore legacy interval_seconds: old installations also stop polling.
    return config


def compact_history(records, now, zone):
    """RAM only: keep daily-last points and two latest distinct measurements."""
    normalized = {}
    for record in records:
        at = stamp(record['measured_at']).astimezone(timezone.utc)
        if at > now:
            continue
        key = at.isoformat()
        normalized[key] = {'id': key, 'user_id': record['user_id'], 'kind': 'body_composition',
                           'measured_at': key, 'values': {'weight': metric(record, 'weight'),
                                                        'body_fat': metric(record, 'body_fat')}}
    ordered = sorted(normalized.values(), key=lambda r: r['measured_at'])
    start = now.astimezone(zone).date() - timedelta(days=6)
    daily = {}
    for record in ordered:
        day = stamp(record['measured_at']).astimezone(zone).date()
        if day >= start:
            daily[day] = record
    keep = {r['id']: r for r in list(daily.values()) + ordered[-2:]}
    return list(keep.values())


def encode_snapshot(profiles, active=None):
    value = {'schema': 1, 'profiles': profiles}
    if active is not None:
        value['active_profile'] = active
    payload = json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':'))
    if len(payload.encode()) > MAX_PAYLOAD:
        raise ValueError('Display payload too large')
    return payload


def measurement_snapshot(config, records, history, now=None):
    """Use the completed sync result directly: never query SelfCare here."""
    if not isinstance(records, list) or len(records) > 128:
        raise ValueError('Invalid measurement event')
    now = now or datetime.now(timezone.utc)
    zone = ZoneInfo(config.get('timezone', 'Asia/Tokyo'))
    users = {p['user_id'] for p in config['profiles']}
    received = [r for r in records if r.get('user_id') in users and r.get('kind') == 'body_composition'
                and stamp(r['measured_at']) <= now]
    if not received:
        return None
    next_history = {}
    for user in users:
        next_history[user] = compact_history(history.get(user, []) + [r for r in received if r['user_id'] == user], now, zone)
    active_user = max(received, key=lambda r: stamp(r['measured_at']))['user_id']
    profiles = [profile_snapshot(p, next_history[p['user_id']], next_history[p['user_id']], now, zone)
                for p in config['profiles']]
    active = next(i for i, p in enumerate(config['profiles']) if p['user_id'] == active_user)
    payload = encode_snapshot(profiles, active)
    history.clear(); history.update(next_history)
    return payload


def build_snapshot(config, now=None, get=read_json, history=None):
    validate_config(config)
    now = now or datetime.now(timezone.utc)
    zone = ZoneInfo(config.get('timezone', 'Asia/Tokyo'))
    first_day = now.astimezone(zone).date() - timedelta(days=6)
    since = datetime.combine(first_day, time.min, zone).isoformat()
    users = get(config['selfcare_url'].rstrip('/') + '/api/users')
    existing = {u['id'] for u in users}
    profiles = []
    next_history = {}
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
                raise ValueError('History changed during pagination; wait for next midnight')
            total = page['total']
            week.extend(page['records'])
            if len(week) == total:
                break
            if not page['records'] or len(week) > total:
                raise ValueError('Incomplete SelfCare history')
        else:
            raise ValueError('Weekly history exceeds display limit')
        profiles.append(profile_snapshot(p, latest, week, now, zone))
        next_history[p['user_id']] = compact_history(latest + week, now, zone)
    payload = encode_snapshot(profiles)
    if history is not None:
        history.clear(); history.update(next_history)
    return payload


async def push_snapshot(proxy, payload, client_factory=None, measurement=False):
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
        action = 'health_display_measurement' if measurement else 'health_display_update'
        service = next((s for s in services if s.name == action), None)
        if service is None:
            raise ValueError('Display firmware is not installed')
        if len(service.args) != 1 or service.args[0].name != 'payload' or int(service.args[0].type) != 3:
            raise ValueError('Incompatible display action')
        response = await client.execute_service(service, {'payload': payload}, return_response=True, timeout=10)
        if response is None or not response.success:
            raise ValueError('Display rejected snapshot')
    finally:
        await client.disconnect()


def midnight_slot(now, zone):
    """Allow dispatch during 00:00; never catch up a missed midnight later."""
    local = now.astimezone(zone)
    today = datetime.combine(local.date(), time.min, zone)
    if local < today + timedelta(minutes=1):
        return today
    return datetime.combine(local.date() + timedelta(days=1), time.min, zone)


def claim_day(state_path, day):
    """Persist BEFORE the read: failure, restart or a lost ACK cannot retry today.

    Only the attempted calendar date is stored, never measurements. Locking also
    prevents two workers sharing a state file from dispatching the same date.
    A corrupt/unwritable state fails closed instead of risking duplicate reads.
    """
    state = Path(state_path)
    with os.fdopen(os.open(str(state) + '.lock', os.O_CREAT | os.O_RDWR, 0o600), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if state.exists():
            saved = json.loads(state.read_text())['last_attempt_day']
            if datetime.strptime(saved, '%Y-%m-%d').strftime('%Y-%m-%d') != saved:
                raise ValueError('Invalid schedule state')
            if saved >= day:
                return False
        temp = str(state) + '.tmp'
        with os.fdopen(os.open(temp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600), 'w') as out:
            json.dump({'last_attempt_day': day}, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, state)
        return True


async def update(config, proxy_path, check=False, history=None):
    try:
        payload = await asyncio.to_thread(build_snapshot, config, history=history)
        if not check:
            proxy = json.loads(Path(proxy_path).read_text())
            async with asyncio.timeout(40):
                await push_snapshot(proxy, payload)
        # No names, IDs, health values, host addresses or keys in logs.
        print('display: snapshot validated' if check else 'display: snapshot accepted', flush=True)
        return 0
    except Exception:
        print('display: update unavailable; previous screen will become stale', flush=True)
        return 1


async def receive_measurements(reader, config, proxy_path, history, lock):
    while True:
        line = await reader.readline()
        if not line:
            return
        try:
            event = json.loads(line)
            if event.get('event') != 'measurement':
                raise ValueError('Unknown display event')
            async with lock:
                payload = measurement_snapshot(config, event.get('records'), history)
                if payload is None:
                    continue
                proxy = json.loads(Path(proxy_path).read_text())
                async with asyncio.timeout(40):
                    await push_snapshot(proxy, payload, measurement=True)
            print('display: measurement accepted', flush=True)
        except Exception:
            # Best effort, no retry and no effect on SelfCare saving the sync result.
            print('display: measurement unavailable', flush=True)


async def run(config_path, proxy_path, once=False, check=False, state_path=None,
              now=lambda: datetime.now(timezone.utc), sleep=asyncio.sleep, reader=None):
    config = validate_config(json.loads(Path(config_path).read_text()))
    if once or check:  # Explicit maintenance only; never used by the managed service.
        return await update(config, proxy_path, check)
    zone = ZoneInfo(config.get('timezone', 'Asia/Tokyo'))
    state_path = state_path or str(config_path) + '.schedule.json'
    due = midnight_slot(now(), zone)
    history, lock = {}, asyncio.Lock()
    listener = asyncio.create_task(receive_measurements(reader, config, proxy_path, history, lock)) if reader else None
    print('display: midnight schedule ready', flush=True)
    try:
        while True:
            current = now()
            if current >= due:
                if current < due + timedelta(minutes=1) and claim_day(state_path, due.date().isoformat()):
                    async with lock:
                        await update(config, proxy_path, history=history)
                # No retry, even after failure. A suspended process skips missed slots.
                due = midnight_slot(max(now(), due + timedelta(minutes=1)), zone)
            # Clock checks are local only: no HTTP, Native API, BLE or disk polling.
            await sleep(max(0.01, min(60, (due - now()).total_seconds())))
    finally:
        if listener:
            listener.cancel()
            await asyncio.gather(listener, return_exceptions=True)


async def main(args):
    reader, transport = None, None
    if not (args.once or args.check) and stat.S_ISFIFO(os.fstat(sys.stdin.fileno()).st_mode):
        reader = asyncio.StreamReader(limit=65536)
        transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    try:
        return await run(args.config, args.proxy_config, args.once, args.check, args.state, reader=reader)
    finally:
        if transport:
            transport.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--proxy-config', default='/radio/m5go.json')
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--state', help='Persistent schedule state (attempted date only)')
    parser.add_argument('--check', action='store_true', help='Read and validate saved data only; no M5GO connection')
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(args)))

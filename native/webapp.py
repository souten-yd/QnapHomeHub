#!/usr/bin/env python3
"""Lightweight QNAP-native HomeHub Web/API frontend for the existing shared radio.

No raw HCI, DBus mutations, Docker controls, or disk writes during idle polling.
SelfCare keeps owning its measurement DB and uses the *same* radio Unix socket.
"""
import argparse
from collections import deque
from datetime import datetime, timezone
from http import HTTPStatus
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import hmac
import json
import mimetypes
import os
from pathlib import Path
import socket
import threading
import urllib.parse

DEFAULT_RADIO = '/share/Container/QnapHomeHub/data/radio/ble.sock'
DEFAULT_DATA = '/share/Container/QnapHomeHub/data/homehub'
DEFAULT_SECRETS = '/share/Container/QnapHomeHub/secrets'
CONFIG_DEFAULTS = dict(hciDeviceId=0, scanTimeoutMs=10000, apiFallback=False, scanOnStartup=False, devices=[])
COOKIE = 'homehub_session'
MAX_BODY = 128 * 1024
ACTIONS = {'press', 'on', 'off', 'status', 'power', 'forceOff'}
DEFAULT_WEBROOT = Path(__file__).resolve().parent / 'public'


class UnixHttp(HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__('localhost', timeout=timeout)
        self.unix_path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.unix_path)


def radio_request(sock, route='/health', payload=None):
    conn = UnixHttp(sock, 240 if payload is not None else 3)
    try:
        body = json.dumps(payload).encode() if payload is not None else None
        conn.request('POST' if body is not None else 'GET', route, body=body,
                     headers={'content-type': 'application/json'} if body is not None else {})
        response = conn.getresponse()
        if response.length is not None and response.length > 4 * 1024 * 1024:
            raise ValueError('Bluetooth response too large')
        output = response.read(4 * 1024 * 1024 + 1)
        if len(output) > 4 * 1024 * 1024:
            raise ValueError('Bluetooth response too large')
        data = json.loads(output)
        if response.status != 200:
            raise ValueError(str(data.get('error', 'Bluetooth radio request failed')))
        return data
    finally:
        conn.close()


def read_secret(folder, filename):
    try:
        return (folder / filename).read_text(encoding='utf-8').strip()
    except FileNotFoundError:
        return ''


class AppState:
    def __init__(self, data, secrets, radio, version, public):
        self.data = Path(data)
        self.secrets = Path(secrets)
        self.radio = str(radio)
        self.version = version
        self.public = Path(public).resolve()
        self.config_path = self.data / 'settings.json'
        self.lock = threading.RLock()
        self.events = deque(maxlen=250)
        self.seq = 0
        self.discovered = []
        # Preserve Docker authentication. Missing/unreadable password files
        # must never silently turn a previously protected NAS service public.
        for filename in ('homehub_admin_username.txt', 'homehub_admin_password.txt'):
            source = self.secrets / filename
            if not source.is_file():
                raise ValueError(f'Missing HomeHub authentication secret: {filename}')
        self.username = read_secret(self.secrets, 'homehub_admin_username.txt') or 'admin'
        self.password = read_secret(self.secrets, 'homehub_admin_password.txt')
        self.required = bool(self.password)
        self.session = hmac.new((self.password or 'qnaphomehub-no-auth').encode(),
                                ('qnaphomehub-session-v1:' + self.username).encode(),
                                hashlib.sha256).hexdigest()
        self.data.mkdir(parents=True, exist_ok=True)
        if self.config_path.exists():
            self.config = self.normalize(json.loads(self.config_path.read_text()))
        else:
            self.config = self.normalize(CONFIG_DEFAULTS)
            self.persist()
        # Runs without Docker, BlueZ or any persistent access log.
        from qpkg_update import Updater
        self.updater = Updater(self.data.parent, Path(__file__).resolve().parent, self.version)
        self.updater.start_scheduler()
        self.event('info', 'system', 'Native QPKG HomeHub initialized')

    @staticmethod
    def normalize(value):
        if not isinstance(value, dict):
            raise ValueError('Invalid HomeHub settings')
        result = dict(CONFIG_DEFAULTS)
        result.update(value)
        hci = result.get('hciDeviceId')
        result['hciDeviceId'] = hci if type(hci) is int and 0 <= hci <= 99 else 0
        try:
            timeout = int(result.get('scanTimeoutMs', 10000))
        except (ValueError, TypeError):
            timeout = 10000
        result['scanTimeoutMs'] = max(3000, min(timeout, 60000))
        result['apiFallback'] = bool(result.get('apiFallback', False))
        result['scanOnStartup'] = bool(result.get('scanOnStartup', False))
        if not isinstance(result.get('devices'), list):
            result['devices'] = []
        return result

    def persist(self):
        tmp = self.config_path.with_suffix('.json.tmp')
        fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as out:
                json.dump(self.config, out, ensure_ascii=False, indent=2)
                out.write('\n')
                out.flush()
                os.fsync(out.fileno())
            os.replace(tmp, self.config_path)
        finally:
            if tmp.exists():
                tmp.unlink()

    def update(self, new_value):
        with self.lock:
            next_value = self.normalize(new_value)
            if next_value != self.config:
                self.config = next_value
                self.persist()
            return json.loads(json.dumps(self.config))

    def event(self, level, source, message, details=None):
        with self.lock:
            self.seq += 1
            value = dict(seq=self.seq, at=datetime.now(timezone.utc).isoformat(),
                         level=level, source=source, message=message)
            if details is not None:
                value['details'] = details
            self.events.append(value)

    def get_devices(self):
        with self.lock:
            return json.loads(json.dumps(self.config['devices']))

    def get_discovered(self):
        with self.lock:
            return json.loads(json.dumps(self.discovered))


def selected_paths(url):
    parsed = urllib.parse.urlsplit(url)
    return parsed.path, urllib.parse.parse_qs(parsed.query)


class Handler(BaseHTTPRequestHandler):
    server_version = 'HomeHub-QPKG'
    sys_version = ''

    @property
    def app(self):
        return self.server.app

    def log_message(self, fmt, *args):
        # Do not write an access-log line to a NAS HDD for every UI poll.
        pass

    def send_json(self, code, data, cookie=None):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.send_header('cache-control', 'no-store')
        self.send_header('x-content-type-options', 'nosniff')
        if cookie is not None:
            self.send_header('set-cookie', cookie)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get('content-length', '-1'))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            raise ValueError('Invalid JSON request length')
        data = json.loads(self.rfile.read(length))
        if not isinstance(data, dict):
            raise ValueError('JSON object required')
        return data

    def authenticated(self):
        if not self.app.required:
            return True
        from http.cookies import SimpleCookie
        try:
            cookie = SimpleCookie()
            cookie.load(self.headers.get('cookie', ''))
            token = cookie.get(COOKIE)
            return bool(token and hmac.compare_digest(token.value, self.app.session))
        except Exception:
            return False

    def do_GET(self):
        self.dispatch('GET')

    def do_POST(self):
        self.dispatch('POST')

    def do_PATCH(self):
        self.dispatch('PATCH')

    def do_DELETE(self):
        self.dispatch('DELETE')

    def dispatch(self, method):
        route, qs = selected_paths(self.path)
        try:
            if not route.startswith('/api/'):
                return self.static(method, route)
            if route == '/api/health' and method == 'GET':
                try:
                    radio_request(self.app.radio)
                    available = True
                except (OSError, ValueError, TimeoutError, json.JSONDecodeError):
                    available = False
                return self.send_json(200, dict(status='ok', authRequired=self.app.required,
                                                version=self.app.version, nativeQpkg=True,
                                                radio=dict(shared=True, available=available)))
            if route == '/api/auth/login' and method == 'POST':
                data = self.read_json()
                good = (not self.app.required or
                        hmac.compare_digest(str(data.get('username', '')), self.app.username) and
                        hmac.compare_digest(str(data.get('password', '')), self.app.password))
                if not good:
                    return self.send_json(401, dict(error='Invalid username or password'))
                return self.send_json(200, dict(ok=True), cookie=(
                    f'{COOKIE}={self.app.session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000'))
            if route == '/api/auth/logout' and method == 'POST':
                return self.send_json(200, dict(ok=True), cookie=(
                    f'{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'))
            if not self.authenticated():
                return self.send_json(401, dict(error='Authentication required'))
            return self.api(method, route, qs)
        except (ValueError, OSError, TimeoutError, json.JSONDecodeError, KeyError) as error:
            self.app.event('error', 'api', 'Request rejected', dict(route=route, message=str(error)[:300]))
            return self.send_json(400, dict(error=str(error)[:500]))
        except Exception:
            self.app.event('error', 'api', 'Unexpected request error', dict(route=route))
            return self.send_json(500, dict(error='Internal HomeHub error'))

    def api(self, method, route, qs):
        a = self.app
        if route == '/api/radio' and method == 'GET':
            return self.send_json(200, radio_request(a.radio))
        if route == '/api/migration/status' and method == 'GET':
            # Read-only check. Requires existing HomeHub session, never changes Docker.
            try:
                import migration
                return self.send_json(200, migration.check())
            except (RuntimeError, OSError, ValueError, KeyError) as error:
                return self.send_json(200, dict(ok=False, error=str(error)[:400],
                    radio_required=True, needs_manual_review=True))
        if route == '/api/config':
            if method == 'GET':
                with a.lock:
                    data = json.loads(json.dumps(a.config))
                data['credentials'] = dict(switchbotApi=bool(
                    read_secret(a.secrets, 'switchbot_token.txt') and
                    read_secret(a.secrets, 'switchbot_secret.txt')), internalToken=False)
                return self.send_json(200, data)
            if method == 'PATCH':
                payload = self.read_json()
                with a.lock:
                    previous = dict(a.config)
                    updated = a.update({**a.config, **{
                        k: payload[k] for k in ('hciDeviceId', 'scanTimeoutMs', 'apiFallback', 'scanOnStartup')
                        if k in payload
                    }})
                updated['restartRequired'] = updated['hciDeviceId'] != previous['hciDeviceId']
                a.event('info', 'config', 'Native settings saved')
                return self.send_json(200, updated)
        if route == '/api/devices' and method == 'GET':
            return self.send_json(200, dict(devices=a.get_devices()))
        if route == '/api/discovered' and method == 'GET':
            return self.send_json(200, dict(devices=a.get_discovered()))
        if route == '/api/scan' and method == 'POST':
            devices = radio_request(a.radio, '/homehub', dict(action='scan'))
            if not isinstance(devices, list):
                raise ValueError('Invalid radio scan response')
            with a.lock:
                a.discovered = devices
            a.event('info', 'ble.scan', 'BLE scan completed', dict(count=len(devices)))
            return self.send_json(200, dict(devices=devices))
        if route == '/api/devices' and method == 'POST':
            data = self.read_json()
            with a.lock:
                dev = next((item for item in a.discovered if item.get('id') == data.get('id')), None)
                if dev is None:
                    return self.send_json(400, dict(error='Device is not in latest scan'))
                if any(d.get('id') == dev.get('id') for d in a.config['devices']):
                    return self.send_json(409, dict(error='Device already registered'))
                name = str(data.get('name') or dev.get('name') or 'SwitchBot')[:100]
                names = {d.get('name') for d in a.config['devices']}
                base = name
                n = 2
                while name in names:
                    name = f'{base} ({n})'
                    n += 1
                profile = 'pc-power' if data.get('controlProfile') == 'pc-power' else 'standard'
                device = dict(id=dev['id'], name=name, deviceType=dev.get('deviceType', 'Bot'),
                              mac=dev.get('mac'), mode='press' if profile == 'pc-power' else (
                                  'switch' if data.get('mode') == 'switch' else 'press'),
                              controlProfile=profile, forceHoldSeconds=10,
                              exposeMatter=False, matterType='outlet',
                              createdAt=datetime.now(timezone.utc).isoformat())
                a.update({**a.config, 'devices': a.config['devices'] + [device]})
            a.event('info', 'device', 'Device registered', dict(id=device['id']))
            return self.send_json(201, device)
        if route.startswith('/api/devices/'):
            parts = route.split('/')
            if len(parts) not in (4, 5):
                return self.send_json(404, dict(error='Unknown endpoint'))
            device_id = urllib.parse.unquote(parts[3])
            with a.lock:
                device = next((d for d in a.config['devices'] if d.get('id') == device_id), None)
            if device is None:
                return self.send_json(404, dict(error='Device not found'))
            if len(parts) == 5 and method == 'POST':
                action = parts[4]
                if action not in ACTIONS:
                    return self.send_json(400, dict(error='Unknown action'))
                if action in ('power', 'forceOff') and device.get('controlProfile') != 'pc-power':
                    return self.send_json(400, dict(error='PC power profile required'))
                passwords = {}
                try:
                    passwords = json.loads(read_secret(a.secrets, 'switchbot_bot_passwords.json') or '{}')
                except ValueError:
                    pass
                password = passwords.get(device_id) or passwords.get(
                    str(device.get('mac') or '').replace(':', '').upper())
                a.event('info', 'command', 'SwitchBot command started', dict(id=device_id, action=action))
                result = radio_request(a.radio, '/homehub', dict(
                    action='command', deviceId=device_id, command=action, password=password,
                    holdSeconds=max(3, min(30, int(device.get('forceHoldSeconds') or 10)))))
                a.event('info' if result.get('success', True) else 'error', 'command',
                        'SwitchBot command finished', dict(id=device_id, action=action,
                                                           success=result.get('success', True)))
                return self.send_json(200, result)
            if len(parts) == 4 and method == 'DELETE':
                with a.lock:
                    a.update({**a.config, 'devices': [
                        d for d in a.config['devices'] if d.get('id') != device_id]})
                a.event('info', 'device', 'Device removed', dict(id=device_id))
                return self.send_json(204, {})
            if len(parts) == 4 and method == 'PATCH':
                patch = self.read_json()
                with a.lock:
                    next_device = dict(device)
                    if 'name' in patch:
                        next_device['name'] = str(patch['name'])[:100]
                    if patch.get('controlProfile') in ('standard', 'pc-power'):
                        next_device['controlProfile'] = patch['controlProfile']
                    if patch.get('mode') in ('switch', 'press'):
                        next_device['mode'] = patch['mode']
                    if next_device.get('controlProfile') == 'pc-power':
                        next_device['mode'] = 'press'
                    if 'forceHoldSeconds' in patch:
                        next_device['forceHoldSeconds'] = max(3, min(30, int(patch['forceHoldSeconds'])))
                    devices = [next_device if d['id'] == device_id else d for d in a.config['devices']]
                    a.update({**a.config, 'devices': devices})
                a.event('info', 'device', 'Device changed', dict(id=device_id))
                return self.send_json(200, next_device)
        if route == '/api/diagnostics' and method == 'GET':
            try:
                hci = os.listdir('/sys/class/bluetooth')
            except OSError:
                hci = []
            return self.send_json(200, dict(platform=os.uname().sysname, arch=os.uname().machine,
                                            hci=hci, radioSocketPresent=Path(a.radio).is_socket(),
                                            nativeQpkg=True, selfCareBridge='shared-radio'))
        if route == '/api/debug/status' and method == 'GET':
            with a.lock:
                events = list(a.events)
                config = json.loads(json.dumps(a.config))
            try:
                radio = radio_request(a.radio)
            except (OSError, ValueError, json.JSONDecodeError):
                radio = dict(error='Radio unavailable')
            limit = min(250, max(10, int(qs.get('limit', [120])[0])))
            return self.send_json(200, dict(at=datetime.now(timezone.utc).isoformat(),
                homehub=dict(version=a.version, hciDeviceId=config['hciDeviceId'],
                             discoveredCount=len(a.get_discovered()), registeredCount=len(config['devices']),
                             discovered=a.get_discovered()),
                matterbridge=dict(state='disabled-native-qpkg', http=dict(reachable=False)),
                system=dict(platform=os.uname().sysname, arch=os.uname().machine,
                            hci=list(filter(lambda s: s.startswith('hci'), os.listdir('/sys/class/bluetooth')))
                            if Path('/sys/class/bluetooth').exists() else [], radio=radio),
                events=events[-limit:]))
        if route == '/api/debug/clear' and method == 'POST':
            with a.lock:
                a.events.clear()
            return self.send_json(204, {})
        if route.startswith('/api/update/'):
            try:
                if route == '/api/update/status' and method == 'GET':
                    return self.send_json(200, a.updater.status())
                if route == '/api/update/check' and method == 'POST':
                    if self.read_json():
                        raise ValueError('Update check takes no arguments')
                    return self.send_json(200, a.updater.check())
                if route == '/api/update/config' and method == 'PATCH':
                    return self.send_json(200, a.updater.configure(self.read_json()))
                if route == '/api/update/apply' and method == 'POST':
                    payload = self.read_json()
                    if set(payload) != {'tag'}:
                        raise ValueError('Only the verified release tag is accepted')
                    return self.send_json(202, a.updater.apply(payload['tag']))
            except (ValueError, OSError) as error:
                return self.send_json(409, dict(error=str(error)[:400]))
            return self.send_json(404, dict(error='Unknown QPKG updater endpoint'))
        if route == '/api/system/restart' and method == 'POST':
            return self.send_json(409, dict(error='QPKGの再起動はQTS App Centerから実行してください'))
        return self.send_json(404, dict(error='Unknown endpoint'))

    def static(self, method, route):
        if method != 'GET':
            return self.send_json(405, dict(error='Method not allowed'))
        path = '/index.html' if route == '/' else route
        candidate = (self.app.public / path.lstrip('/')).resolve()
        if not candidate.is_relative_to(self.app.public):
            return self.send_json(404, dict(error='Unknown resource'))
        if not candidate.is_file():
            candidate = self.app.public / 'index.html'
        contents = candidate.read_bytes()
        self.send_response(200)
        self.send_header('content-type', mimetypes.guess_type(candidate.name)[0] or 'application/octet-stream')
        self.send_header('content-length', str(len(contents)))
        self.send_header('cache-control', 'public, max-age=1800' if candidate.suffix in ('.css', '.png', '.ico') else 'no-cache')
        self.send_header('x-content-type-options', 'nosniff')
        self.end_headers()
        self.wfile.write(contents)


class NativeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, state):
        self.app = state
        super().__init__(address, Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--data-dir', default=DEFAULT_DATA)
    parser.add_argument('--secrets-dir', default=DEFAULT_SECRETS)
    parser.add_argument('--radio-socket', default=DEFAULT_RADIO)
    parser.add_argument('--public-dir', default=str(DEFAULT_WEBROOT))
    parser.add_argument('--version', default='0.3.16')
    args = parser.parse_args()
    os.umask(0o077)
    state = AppState(args.data_dir, args.secrets_dir, args.radio_socket, args.version, args.public_dir)
    with NativeServer(('0.0.0.0', args.port), state) as server:
        server.serve_forever(poll_interval=0.5)


if __name__ == '__main__':
    main()

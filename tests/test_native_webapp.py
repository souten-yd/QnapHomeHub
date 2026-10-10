"""Native Web/API integration tests without a NAS or physical Bluetooth adapter."""
import http.client
import json
from pathlib import Path
import socket
import socketserver
import tempfile
import threading
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from webapp import AppState, NativeServer


class FakeRadio(socketserver.UnixStreamServer):
    allow_reuse_address = True

    def __init__(self, path):
        self.requests = []
        super().__init__(path, self.Handler)

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            line = self.rfile.readline().decode()
            while True:
                header = self.rfile.readline()
                if header in (b'\r\n', b'\n', b''):
                    break
                if header.lower().startswith(b'content-length:'):
                    length = int(header.split(b':', 1)[1].strip())
            if line.startswith('POST '):
                self.rfile.read(locals().get('length', 0))
            self.server.requests.append(line)
            if '/health' in line:
                data = {'bluezMode': 'private', 'watchReady': True, 'shared': True}
            elif '/homehub' in line:
                data = {'success': True, 'action': 'press'}
            else:
                data = {}
            response = json.dumps(data).encode()
            self.wfile.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' +
                             str(len(response)).encode() + b'\r\nConnection: close\r\n\r\n' + response)


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.data = root / 'data'
        self.data.mkdir()
        self.secrets = root / 'secrets'
        self.secrets.mkdir()
        (self.secrets / 'homehub_admin_username.txt').write_text('admin')
        (self.secrets / 'homehub_admin_password.txt').write_text('')
        self.public = root / 'public'
        self.public.mkdir()
        (self.public / 'index.html').write_text('HomeHub test index')
        self.radio_path = str(root / 'ble.sock')
        self.radio = FakeRadio(self.radio_path)
        self.radio_thread = threading.Thread(target=self.radio.serve_forever, daemon=True)
        self.radio_thread.start()
        (self.data / 'settings.json').write_text(json.dumps({
            'hciDeviceId': 0, 'devices': [{'id': 'BOT-1', 'name': 'Switch',
            'deviceType': 'Bot', 'mode': 'press', 'controlProfile': 'standard'}]}))
        self.state = AppState(self.data, self.secrets, self.radio_path, '0.3.15', self.public)
        self.server = NativeServer(('127.0.0.1', 0), self.state)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.radio.shutdown()
        self.radio.server_close()
        self.temp.cleanup()

    def request(self, method, path, payload=None, cookie=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=5)
        headers = {}
        if payload is not None:
            headers['content-type'] = 'application/json'
        if cookie:
            headers['cookie'] = cookie
        conn.request(method, path, body=json.dumps(payload) if payload is not None else None, headers=headers)
        response = conn.getresponse()
        body = response.read()
        code, headers = response.status, response.getheaders()
        conn.close()
        return code, json.loads(body) if body else {}, dict(headers)

    def test_status_polling_does_not_write_settings_or_selfcare_data(self):
        marker = self.data / 'settings.json'
        before = marker.stat().st_mtime_ns
        for _ in range(4):
            self.assertEqual(self.request('GET', '/api/health')[0], 200)
            self.assertEqual(self.request('GET', '/api/devices')[0], 200)
            self.assertEqual(self.request('GET', '/api/radio')[0], 200)
            self.assertEqual(self.request('GET', '/api/debug/status')[0], 200)
        self.assertEqual(marker.stat().st_mtime_ns, before)
        self.assertEqual({p.name for p in self.data.iterdir()}, {'settings.json'})

    def test_radio_stopped_still_serves_dashboard_without_writing_settings(self):
        from unittest.mock import patch
        marker = self.data / 'settings.json'
        before = marker.stat().st_mtime_ns
        with patch('webapp.radio_request', side_effect=ConnectionRefusedError('radio stopped')):
            status, health, _ = self.request('GET', '/api/health')
            self.assertEqual(status, 200)
            self.assertFalse(health['radio']['available'])
            self.assertTrue(health['nativeQpkg'])
            status, devices, _ = self.request('GET', '/api/devices')
            self.assertEqual(status, 200)
            self.assertEqual(devices['devices'][0]['id'], 'BOT-1')
        self.assertEqual(marker.stat().st_mtime_ns, before)

    def test_switchbot_uses_shared_radio(self):
        status, result, _ = self.request('POST', '/api/devices/BOT-1/press')
        self.assertEqual(status, 200)
        self.assertTrue(result['success'])
        self.assertTrue(any('POST /homehub' in req for req in self.radio.requests))

    def test_explicit_config_edit_persists(self):
        status, _, _ = self.request('PATCH', '/api/config', {'scanTimeoutMs': 12000})
        self.assertEqual(status, 200)
        saved = json.loads((self.data / 'settings.json').read_text())
        self.assertEqual(saved['scanTimeoutMs'], 12000)

    def test_authenticated_requests_still_use_homehub_session(self):
        self.state.password = 'sample-password'
        self.state.required = True
        import hashlib
        import hmac
        self.state.session = hmac.new(b'sample-password', b'qnaphomehub-session-v1:admin', hashlib.sha256).hexdigest()
        self.assertEqual(self.request('GET', '/api/devices')[0], 401)
        code, _, headers = self.request('POST', '/api/auth/login', {
            'username': 'admin', 'password': 'sample-password'})
        self.assertEqual(code, 200)
        cookie = headers['set-cookie'].split(';')[0]
        self.assertEqual(self.request('GET', '/api/devices', cookie=cookie)[0], 200)

    def test_no_matter_or_system_execution(self):
        self.assertEqual(self.request('POST', '/api/system/restart')[0], 409)
        self.assertEqual(self.request('POST', '/api/update/apply', {'tag': 'v0.3.16'})[0], 409)
        self.assertEqual(self.request('POST', '/api/internal/matter/status')[0], 404)


if __name__ == '__main__':
    unittest.main()

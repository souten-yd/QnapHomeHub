"""Opt-in QPKG takeover must never mutate SelfCare or shared radio."""
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import migration


class MigrationSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "data/homehub").mkdir(parents=True)
        (self.root / "data/radio").mkdir(parents=True)
        (self.root / "data/homehub/settings.json").write_text('{}')
        self.radio = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.radio.bind(str(self.root / "data/radio/ble.sock"))
        self.radio.listen(1)
        self.original = (migration.PROJECT, migration.SETTINGS, migration.RADIO, migration.STATE)
        migration.PROJECT = self.root
        migration.SETTINGS = self.root / "data/homehub/settings.json"
        migration.RADIO = self.root / "data/radio/ble.sock"
        migration.STATE = self.root / "data/native-migration/state.json"
        self.calls = []

    def tearDown(self):
        migration.PROJECT, migration.SETTINGS, migration.RADIO, migration.STATE = self.original
        self.radio.close()
        self.tmp.cleanup()

    def container(self, name):
        service = 'radio' if name == migration.RADIO_NAME else migration.NAMES[name]
        mounts = [{'Source': str(migration.RADIO.parent), 'Destination': '/radio'}] if service == 'radio' else (
            [{'Source': str(migration.SETTINGS.parent), 'Destination': '/data'}] if service == 'homehub' else [])
        return {
            'Name': '/' + name,
            'State': {'Running': True},
            'Config': {'Labels': {
                'com.docker.compose.project': 'qnaphomehub',
                'com.docker.compose.service': service,
                'com.docker.compose.project.working_dir': str(self.root),
                'com.docker.compose.project.config_files': str(self.root / 'compose.yaml'),
            }},
            'HostConfig': {'NetworkMode': 'host', 'RestartPolicy': {'Name': 'unless-stopped'}},
            'Mounts': mounts
        }

    def inspect(self, name):
        return self.container(name)

    def docker(self, *args):
        self.calls.append(args)
        return ''

    def test_readonly_preflight_never_modifies_docker(self):
        with patch.object(migration, 'inspect', side_effect=self.inspect):
            state = migration.check()
        self.assertTrue(state['radio_running'])
        self.assertEqual(self.calls, [])
        self.assertFalse(migration.STATE.exists())

    def test_apply_never_touches_radio_or_selfcare(self):
        with patch.object(migration, 'inspect', side_effect=self.inspect), \
             patch.object(migration, 'docker', side_effect=self.docker), \
             patch.object(migration, 'ensure_admin'):
            result = migration.apply()
        self.assertTrue(result['radio_preserved'])
        self.assertEqual(len(self.calls), 6)
        self.assertEqual([command[-1] for command in self.calls],
                         ['qnaphomehub-updater'] * 2 + ['qnaphomehub-matterbridge'] * 2 + ['qnaphomehub'] * 2)
        self.assertFalse(any('radio' in ' '.join(command) for command in self.calls))
        self.assertFalse(any('SelfCare' in ' '.join(command) for command in self.calls))
        self.assertTrue(migration.STATE.exists())
        self.assertEqual(json.loads(migration.STATE.read_text())['radio_running'], True)

    def test_failclosed_docker_owner_mismatch(self):
        def spoof(name):
            item = self.container(name)
            item['Config']['Labels']['com.docker.compose.project'] = 'unrelated'
            return item
        with patch.object(migration, 'inspect', side_effect=spoof):
            with self.assertRaisesRegex(RuntimeError, 'refusing modification'):
                migration.check()
        self.assertEqual(self.calls, [])

    def test_apply_requires_explicit_admin(self):
        with patch.object(migration, 'ensure_admin', side_effect=RuntimeError('admin required')):
            with self.assertRaisesRegex(RuntimeError, 'admin required'):
                migration.apply()
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()

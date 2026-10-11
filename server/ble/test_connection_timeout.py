# SPDX-License-Identifier: GPL-3.0-or-later
"""Static contract for the shared-radio BLE connection deadline."""
import ast
from pathlib import Path
import unittest


class ConnectionTimeoutTests(unittest.TestCase):
    def test_all_connection_paths_use_existing_bounded_twenty_seconds(self):
        source = Path(__file__).with_name("ble_worker.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        definitions = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "connection_timeout"
                    for target in node.targets)
        ]
        self.assertEqual(len(definitions), 1)
        self.assertIsInstance(definitions[0].value, ast.Constant)
        self.assertEqual(definitions[0].value.value, 20)

        clients = [node for node in ast.walk(tree)
                   if isinstance(node, ast.Call)
                   and isinstance(node.func, ast.Name)
                   and node.func.id == "BleakClient"]
        self.assertEqual(len(clients), 1)
        timeout = next((kw.value for kw in clients[0].keywords if kw.arg == "timeout"), None)
        self.assertIsInstance(timeout, ast.Name)
        self.assertEqual(timeout.id, "connection_timeout")
        self.assertFalse(any(isinstance(node, ast.Name) and node.id == "fresh_hbf_watch"
                             for node in ast.walk(tree)))


if __name__ == "__main__":
    unittest.main()

# SPDX-License-Identifier: GPL-3.0-or-later
import contextlib
import io
import unittest

from esp_proxy_probe import masked_mac, normalize_mac, parse_args


class ESPHomeProxyProbeTests(unittest.TestCase):
    def test_mac_normalization_and_redaction(self):
        self.assertEqual(normalize_mac("aa:bb:cc:11:22:33"), "AA:BB:CC:11:22:33")
        self.assertEqual(masked_mac("AA:BB:CC:11:22:33"), "XX:XX:XX:11:22:33")
        for bad in ("aa:bb", "aa:bb:cc:dd:ee:gg", "aa:bb:cc:dd:ee:ff/xyz"):
            with self.assertRaises(ValueError):
                normalize_mac(bad)

    def test_options_have_bounded_read_only_connect(self):
        args = parse_args(["--host", "192.168.1.28", "--target", "aa:bb:cc:11:22:33", "--connect"])
        self.assertEqual(args.target, "AA:BB:CC:11:22:33")
        self.assertEqual(args.scan_seconds, 12)
        for argv in (["--host", "remote/path"], ["--host", "a b"],
                     ["--host", "192.168.1.28", "--scan-seconds", "300"],
                     ["--host", "192.168.1.28", "--connect"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                parse_args(argv)


if __name__ == "__main__":
    unittest.main()

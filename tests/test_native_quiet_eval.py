"""Unit checks for read-only /proc/diskstats metrics and quiet shell command safety."""
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "native"))
from quiet_eval import measure, parse_diskstats


class QuietDiskstatsTests(unittest.TestCase):
    def test_parses_linux_diskstats(self):
        source = (
            "   8       0 sda 100 0 800 200 400 0 3200 450 0 550 600\n"
            "   8      16 sdb 10 0 100 10 50 0 400 30 0 40 55\n"
        )
        result = parse_diskstats(source)
        self.assertEqual(result["sda"]["write_ios"], 400)
        self.assertEqual(result["sdb"]["write_sectors"], 400)

    def test_rate_is_separate_for_raid_mirrors(self):
        before = parse_diskstats(
            "8 0 sda 100 0 800 10 400 0 3200 30 0 500 700\n"
            "8 16 sdb 100 0 800 10 400 0 3200 30 0 500 700")
        after = parse_diskstats(
            "8 0 sda 120 0 1200 20 700 0 6200 60 0 1520 1700\n"
            "8 16 sdb 120 0 1200 20 700 0 6200 60 0 1520 1700")
        values = measure(before, after, 10.0, ["sda", "sdb"])
        self.assertEqual(len(values), 2)
        self.assertEqual(values[0]["write_iops"], 30)
        self.assertEqual(values[1]["write_iops"], 30)
        self.assertAlmostEqual(values[0]["write_mb_s"], 0.1536)
        self.assertAlmostEqual(values[0]["busy_pct"], 10.2)

    def test_missing_device_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "absent"):
            measure({}, {}, 10, ["sda"])

    def test_reset_counter_fails_closed(self):
        before = {"sda": {"write_ios": 50}}
        after = {"sda": {"write_ios": 2}}
        with self.assertRaisesRegex(ValueError, "reset"):
            measure(before, after, 10, ["sda"])

    def test_quiet_shell_only_targets_homehub(self):
        script = (ROOT / "scripts/qnap-quiet-eval.sh").read_text()
        self.assertIn("docker stop", script)
        self.assertIn("--restart=no", script)
        for required in ("qnaphomehub-updater", "qnaphomehub-matterbridge",
                         "qnaphomehub", "qnaphomehub-radio"):
            self.assertIn(required, script)
        self.assertNotIn("docker compose down", script)
        self.assertNotIn("docker rm", script)
        self.assertNotIn("docker system prune", script)
        self.assertNotIn("docker volume rm", script)


if __name__ == "__main__":
    unittest.main()

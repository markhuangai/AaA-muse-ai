from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from media import MediaFlow


class ControlledMedia:
    sibling = "sibling"
    broker = "broker"
    media_fixture = "media"

    def __init__(self, stop_error=False, still_running=False):
        self.stop_error = stop_error
        self.still_running = still_running
        self.calls = []

    def docker(self, *args):
        self.calls.append(("docker", *args))
        if args[0] == "stop" and self.stop_error:
            raise RuntimeError("controlled stop failure")

    def inspect(self, container):
        self.calls.append(("inspect", container))
        return {"State": {"Running": self.still_running and container == self.broker}}


class MediaCleanupTest(unittest.TestCase):
    def test_permissions_restored_only_after_both_brokers_stop(self):
        harness = ControlledMedia()
        MediaFlow.restore_media_permissions(harness, "/media/job")
        self.assertEqual(harness.calls, [("docker", "stop", "-t", "2", "sibling", "broker"),
                                         ("inspect", "sibling"), ("inspect", "broker"),
                                         ("docker", "exec", "media", "chmod", "0700", "/media/job")])

    def test_failed_or_ineffective_stop_never_restores_permissions(self):
        for harness in (ControlledMedia(stop_error=True), ControlledMedia(still_running=True)):
            with self.subTest(stop_error=harness.stop_error):
                with self.assertRaises((RuntimeError, AssertionError)):
                    MediaFlow.restore_media_permissions(harness, "/media/job")
                self.assertFalse(any(call[:2] == ("docker", "exec") for call in harness.calls))


if __name__ == "__main__":
    unittest.main()

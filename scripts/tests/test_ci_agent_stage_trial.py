"""Disposable-only delay to observe cancellation between agent revisions."""
import time
import unittest


class AgentStageTrial(unittest.TestCase):
    def test_revision_can_be_superseded_while_process_checks_run(self):
        time.sleep(60)

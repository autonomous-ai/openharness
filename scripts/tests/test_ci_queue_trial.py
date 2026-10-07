import subprocess
import unittest

class MergeQueueTrial(unittest.TestCase):
    def test_incompatible_changes_are_rejected_together(self):
        def present(name):
            result = subprocess.run(['git', 'cat-file', '-e', 'HEAD:docs/ci-rollout-' + name + '.md'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return result.returncode == 0
        self.assertFalse(present('a') and present('b'), 'Intentional disposable-branch incompatibility: A and B may not merge together')

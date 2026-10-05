import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "watch-desktop-release.py"
spec = importlib.util.spec_from_file_location("watch_desktop", SCRIPT)
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)
TAG = "v1.2.3_desktop"
SHA = "a" * 40
RUN = dict(databaseId=123, headSha=SHA, headBranch=TAG, url="https://github.com/owner/repo/actions/runs/123")
DONE = dict(headSha=SHA, headBranch=TAG, status="completed", conclusion="success",
            jobs=[dict(name="verify", status="completed", conclusion="success")])


class ReleaseWatchTests(unittest.TestCase):
    def test_exact_tag_sha_lookup_and_verified_success(self):
        other = dict(RUN, headSha="b" * 40, databaseId=124)
        with patch.object(watch, "gh_json", side_effect=[[other, RUN], DONE]) as gh:
            self.assertEqual(watch.watch(TAG, SHA), RUN)
        args = gh.call_args_list[0].args[0]
        self.assertIn("release-desktop.yml", args)
        self.assertEqual(args[args.index("--branch") + 1], TAG)
        self.assertEqual(args[args.index("--commit") + 1], SHA)
        self.assertEqual(gh.call_args_list[1].args[0][2], "123")

    def test_failed_workflow_or_absent_verification_is_not_success(self):
        for result in (dict(DONE, conclusion="failure"), dict(DONE, jobs=[]), dict(DONE, headSha="b" * 40),
                       dict(DONE, jobs=[dict(name="verify", status="completed", conclusion="skipped")])):
            with self.subTest(result=result), patch.object(watch, "gh_json", side_effect=[[RUN], result]):
                with self.assertRaises(RuntimeError):
                    watch.watch(TAG, SHA)

    def test_appearance_wait_is_bounded(self):
        with patch.object(watch, "gh_json", return_value=[]), patch.object(watch.time, "monotonic", side_effect=[0, 1, 1, 181]):
            with self.assertRaisesRegex(TimeoutError, "no release-desktop.yml run appeared"):
                watch.watch(TAG, SHA)

    def test_verification_inside_publish_must_have_a_successful_step(self):
        for conclusion in ("success", "skipped", "failure"):
            result = dict(DONE, jobs=[dict(name="publish", status="completed", conclusion="success", steps=[
                dict(name="Verify all public artifacts as the updater", conclusion=conclusion)
            ])])
            with self.subTest(conclusion=conclusion), patch.object(watch, "gh_json", side_effect=[[RUN], result]):
                if conclusion == "success":
                    self.assertEqual(watch.watch(TAG, SHA), RUN)
                else:
                    with self.assertRaises(RuntimeError):
                        watch.watch(TAG, SHA)

    def test_in_progress_run_is_rechecked_without_another_validation(self):
        pending = dict(DONE, status="in_progress", conclusion="", jobs=[])
        with patch.object(watch, "gh_json", side_effect=[[RUN], pending, DONE]) as gh, patch.object(watch.time, "sleep"):
            self.assertEqual(watch.watch(TAG, SHA), RUN)
        self.assertEqual(len(gh.call_args_list), 3)

    def test_overall_deadline_is_bounded(self):
        with patch.object(watch.time, "monotonic", side_effect=[0, 2]):
            with self.assertRaisesRegex(TimeoutError, "within 1s"):
                watch.watch(TAG, SHA, timeout=1)


if __name__ == "__main__":
    unittest.main()

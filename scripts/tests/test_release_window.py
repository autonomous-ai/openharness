import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
ROOT = SCRIPTS.parent
spec = importlib.util.spec_from_file_location("release_window", SCRIPTS / "release-window.py")
rw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rw)

VN = timezone(timedelta(hours=7))
CONFIG = json.loads((SCRIPTS / "release-window.json").read_text())


def at(day, hour, minute=0):
    """A VN wall-clock time on 2026-11-<day>, as an aware datetime in UTC (what git and CI report)."""
    return datetime(2026, 11, day, hour, minute, tzinfo=VN).astimezone(timezone.utc)


def check(kind, now, last=None, urgent=None):
    return rw.check(kind, now, last, CONFIG, urgent)


class WindowTests(unittest.TestCase):
    def test_config_holds_the_numbers(self):
        self.assertEqual(CONFIG["timeZone"], "Asia/Ho_Chi_Minh")
        self.assertEqual((CONFIG["windowStart"], CONFIG["windowEnd"]), ("09:00", "18:00"))
        self.assertEqual(CONFIG["minMinutesBetween"], {"backend": 120})

    def test_inside_the_window_is_allowed_for_every_kind(self):
        for kind in ["backend", "cli", "desktop", "web"]:
            for hour, minute in [(9, 0), (12, 30), (17, 59)]:
                self.assertTrue(check(kind, at(5, hour, minute)).allowed, (kind, hour, minute))

    def test_before_the_window_is_refused_with_todays_opening(self):
        verdict = check("cli", at(5, 8, 59))
        self.assertFalse(verdict.allowed)
        self.assertEqual(verdict.next_allowed, at(5, 9, 0))

    def test_at_closing_time_and_after_is_refused_with_tomorrows_opening(self):
        for hour, minute in [(18, 0), (18, 1), (23, 30)]:
            verdict = check("desktop", at(5, hour, minute))
            self.assertFalse(verdict.allowed, (hour, minute))
            self.assertEqual(verdict.next_allowed, at(6, 9, 0))

    def test_after_midnight_before_nine_opens_the_same_day(self):
        verdict = check("web", at(6, 0, 30))
        self.assertEqual(verdict.next_allowed, at(6, 9, 0))

    def test_window_is_read_in_vietnam_time_not_utc(self):
        # 02:30 UTC is 09:30 in Ho Chi Minh City: inside. 11:30 UTC is 18:30 there: outside.
        self.assertTrue(check("cli", datetime(2026, 11, 5, 2, 30, tzinfo=timezone.utc)).allowed)
        self.assertFalse(check("cli", datetime(2026, 11, 5, 11, 30, tzinfo=timezone.utc)).allowed)

    def test_vietnam_has_no_daylight_shift(self):
        # The US fall-back (2026-11-01) and spring-forward (2026-03-08) move nothing here.
        for month, day in [(3, 7), (3, 9), (10, 31), (11, 2)]:
            inside = datetime(2026, month, day, 9, 0, tzinfo=VN).astimezone(timezone.utc)
            self.assertTrue(check("cli", inside).allowed, (month, day))
            outside = datetime(2026, month, day, 18, 0, tzinfo=VN).astimezone(timezone.utc)
            self.assertFalse(check("cli", outside).allowed, (month, day))

    def test_naive_time_is_rejected(self):
        with self.assertRaises(ValueError):
            check("cli", datetime(2026, 11, 5, 12, 0))


class PaceTests(unittest.TestCase):
    def test_backend_within_two_hours_is_refused_with_the_time_it_opens(self):
        verdict = check("backend", at(5, 12, 0), last=at(5, 10, 30))
        self.assertFalse(verdict.allowed)
        self.assertEqual(verdict.next_allowed, at(5, 12, 30))

    def test_backend_after_two_hours_is_allowed(self):
        self.assertTrue(check("backend", at(5, 12, 30), last=at(5, 10, 30)).allowed)
        self.assertTrue(check("backend", at(5, 15, 0), last=at(5, 10, 30)).allowed)

    def test_pace_that_ends_after_closing_moves_to_the_next_morning(self):
        verdict = check("backend", at(5, 17, 30), last=at(5, 17, 0))
        self.assertFalse(verdict.allowed)
        self.assertEqual(verdict.next_allowed, at(6, 9, 0))

    def test_night_and_pace_together_name_the_later_time(self):
        verdict = check("backend", at(5, 23, 0), last=at(5, 22, 0))
        self.assertEqual(verdict.next_allowed, at(6, 9, 0))

    def test_other_kinds_have_no_pace(self):
        for kind in ["cli", "desktop", "web"]:
            self.assertTrue(check(kind, at(5, 12, 0), last=at(5, 11, 55)).allowed, kind)

    def test_first_ever_backend_release_has_no_pace(self):
        self.assertTrue(check("backend", at(5, 12, 0), last=None).allowed)

    def test_unknown_kind_is_an_error_not_a_pass(self):
        with self.assertRaises(ValueError):
            check("firmware", at(5, 12, 0))

    def test_message_names_guard_next_time_and_next_step(self):
        text = check("backend", at(5, 12, 0), last=at(5, 11, 0)).message
        self.assertIn("RELEASE_WINDOW", text)
        self.assertIn("2026-11-05 13:00", text)
        self.assertIn("Asia/Ho_Chi_Minh", text)
        self.assertIn('--urgent "<reason>"', text)


class UrgentTests(unittest.TestCase):
    def test_urgent_without_a_reason_is_refused(self):
        for reason in ["", "   ", None]:
            verdict = check("backend", at(5, 23, 0), urgent="" if reason is None else reason)
            self.assertFalse(verdict.allowed, repr(reason))
            self.assertIn("needs a reason", verdict.message)

    def test_urgent_with_a_reason_allows_night_and_pace(self):
        verdict = check("backend", at(5, 23, 0), last=at(5, 22, 30), urgent="P0: sign-out loop")
        self.assertTrue(verdict.allowed)
        self.assertEqual(verdict.urgent_reason, "P0: sign-out loop")
        self.assertIn("P0: sign-out loop", verdict.chat_line)
        self.assertIn("2026-11-05 23:00", verdict.chat_line)
        self.assertIn("backend", verdict.chat_line)

    def test_urgent_inside_the_window_is_still_recorded(self):
        verdict = check("cli", at(5, 12, 0), urgent="P0: crash on start")
        self.assertTrue(verdict.allowed)
        self.assertEqual(verdict.urgent_reason, "P0: crash on start")

    def test_reason_is_one_line(self):
        verdict = check("cli", at(5, 23, 0), urgent="P0: first\nsecond")
        self.assertNotIn("\n", verdict.chat_line)


def git(repo, *args, env=None):
    subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                        "GIT_COMMITTER_EMAIL": "t@t", **(env or {})})


class GitAndCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = self.tmp.name
        git(self.repo, "init", "-q")
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "c")

    def tag(self, name, when, message="release"):
        stamp = when.isoformat()
        git(self.repo, "tag", "-a", name, "-m", message, env={"GIT_COMMITTER_DATE": stamp})

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = rw.main(["--repo", self.repo, *args])
        return code, out.getvalue(), err.getvalue()

    def test_last_release_is_the_newest_tag_of_the_kind(self):
        self.tag("v1.0.1_backend", at(5, 9, 0))
        self.tag("v1.0.2_backend", at(5, 10, 30))
        self.tag("v9.0.1_cli", at(5, 11, 55))
        self.assertEqual(rw.last_release_time(self.repo, "backend"), at(5, 10, 30))

    def test_no_tag_means_no_last_release(self):
        self.assertIsNone(rw.last_release_time(self.repo, "backend"))

    def test_cli_refuses_a_backend_release_within_two_hours_with_exit_2(self):
        self.tag("v1.0.1_backend", at(5, 10, 30))
        code, _, err = self.run_cli("--kind", "backend", "--now", at(5, 12, 0).isoformat())
        self.assertEqual(code, 2)
        self.assertIn("RELEASE_WINDOW", err)
        self.assertIn("2026-11-05 12:30", err)

    def test_cli_allows_a_backend_release_after_two_hours(self):
        self.tag("v1.0.1_backend", at(5, 10, 30))
        code, _, _ = self.run_cli("--kind", "backend", "--now", at(5, 12, 30).isoformat())
        self.assertEqual(code, 0)

    def test_the_tag_being_built_is_not_the_last_release(self):
        self.tag("v1.0.1_backend", at(5, 9, 0))
        self.tag("v1.0.2_backend", at(5, 12, 0))
        code, _, err = self.run_cli("--kind", "backend", "--now", at(5, 12, 1).isoformat(),
                                    "--exclude-tag", "v1.0.2_backend")
        self.assertEqual(code, 0, err)

    def test_cli_urgent_without_reason_is_refused_and_with_reason_prints_the_chat_line(self):
        now = at(5, 23, 0).isoformat()
        code, _, err = self.run_cli("--kind", "cli", "--now", now, "--urgent", "")
        self.assertEqual(code, 2)
        self.assertIn("needs a reason", err)
        code, out, _ = self.run_cli("--kind", "cli", "--now", now, "--urgent", "P0: crash on start")
        self.assertEqual(code, 0)
        self.assertIn("Urgent cli release", out)
        self.assertIn("P0: crash on start", out)

    def test_tag_message_urgent_line_is_honored_by_the_workflow_check(self):
        self.tag("v1.0.3_backend", at(5, 23, 0), message="backend release\n\nRelease-Urgent: P0: sign-out loop")
        code, out, err = self.run_cli("--kind", "backend", "--now", at(5, 23, 1).isoformat(),
                                      "--from-tag", "v1.0.3_backend", "--exclude-tag", "v1.0.3_backend")
        self.assertEqual(code, 0, err)
        self.assertIn("P0: sign-out loop", out)

    def test_tag_without_urgent_line_is_refused_at_night(self):
        self.tag("v1.0.3_backend", at(5, 23, 0))
        code, _, err = self.run_cli("--kind", "backend", "--now", at(5, 23, 1).isoformat(),
                                    "--from-tag", "v1.0.3_backend", "--exclude-tag", "v1.0.3_backend")
        self.assertEqual(code, 2)
        self.assertIn("RELEASE_WINDOW", err)

    def test_advisory_reports_but_does_not_fail(self):
        code, _, err = self.run_cli("--kind", "cli", "--now", at(5, 23, 0).isoformat(), "--advisory")
        self.assertEqual(code, 0)
        self.assertIn("RELEASE_WINDOW", err)


if __name__ == "__main__":
    unittest.main()

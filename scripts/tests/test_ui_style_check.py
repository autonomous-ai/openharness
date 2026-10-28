import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("check_ui_style", Path(__file__).resolve().parents[1] / "check-ui-style.py")
style = importlib.util.module_from_spec(spec)
spec.loader.exec_module(style)

DESKTOP = "desktop/lib/super_tabs"
MOBILE = "mobile/lib/swarm"


class Repo:
    """A scratch checkout holding only the files a test writes."""

    def __init__(self):
        self._dir = tempfile.TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.allowlist = self.root / "scripts" / "ui-style-allowlist.json"

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def allow(self, entries):
        self.allowlist.parent.mkdir(parents=True, exist_ok=True)
        self.allowlist.write_text(json.dumps(entries))

    def run(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = style.main(["--root", str(self.root), *args])
        return code, out.getvalue() + err.getvalue()

    def close(self):
        self._dir.cleanup()


class StyleCheckTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo()
        self.addCleanup(self.repo.close)

    def counts(self, text, path=f"{DESKTOP}/a.dart"):
        self.repo.write(path, text)
        return style.scan(self.repo.root, [DESKTOP, MOBILE])

    def test_each_hard_coded_style_is_counted_under_its_rule(self):
        counts = self.counts(
            "final a = Color(0xFF112233);\n"
            "final b = Colors.red;\n"
            "final c = Colors.white70.withAlpha(3);\n"
            "final d = TextStyle(fontSize: 13);\n"
            "final e = TextStyle(fontSize: 12.5 * scale);\n"
            "final f = EdgeInsets.all(8);\n"
            "final g = EdgeInsetsDirectional.only(start: 4);\n"
            "final h = BorderRadius.circular(10);\n"
        )
        self.assertEqual(counts, {f"{DESKTOP}/a.dart": {
            "hex-color": 1, "material-color": 2, "font-size": 2, "edge-insets": 2, "border-radius": 1}})

    def test_named_roles_transparent_and_zero_are_allowed(self):
        counts = self.counts(
            "final a = Colors.transparent;\n"
            "final b = TextStyle(fontSize: AppType.bodySize);\n"
            "final c = EdgeInsets.all(AppDesktop.groupGap * 2);\n"
            "final d = EdgeInsets.only(top: 0, left: AppDesktop.controlGap);\n"
            "final e = EdgeInsets.zero;\n"
            "final f = BorderRadius.circular(AppDesktop.rowRadius);\n"
            "final g = BorderRadius.circular(0);\n"
            "final h = AppPalette.accent;\n"
        )
        self.assertEqual(counts, {})

    def test_a_multi_line_edge_insets_with_one_number_counts_once(self):
        counts = self.counts(
            "const p = EdgeInsets.symmetric(\n"
            "  horizontal: AppDesktop.controlGap,\n"
            "  vertical: 6,\n"
            ");\n"
            "const q = EdgeInsets.fromLTRB(4, 2, 8, 2);\n"
        )
        self.assertEqual(counts, {f"{DESKTOP}/a.dart": {"edge-insets": 2}})

    def test_comments_and_strings_are_not_code(self):
        counts = self.counts(
            "/// Was Color(0xFF000000) before the token.\n"
            "// fontSize: 12\n"
            "/* Colors.red,\n   EdgeInsets.all(4) */\n"
            "final a = 'BorderRadius.circular(8) http://x';\n"
            "final b = \"Colors.blue ${'Colors.red'}\";\n"
            "final c = r'''\nfontSize: 9\n''';\n"
            "final d = AppPalette.accent; // Colors.green\n"
        )
        self.assertEqual(counts, {})

    def test_theme_files_and_non_dart_files_are_not_scanned(self):
        self.repo.write(f"{DESKTOP}/theme/tokens.dart", "final a = Color(0xFF000000);\n")
        self.repo.write(f"{DESKTOP}/notes.txt", "final a = Color(0xFF000000);\n")
        self.assertEqual(style.scan(self.repo.root, [DESKTOP, MOBILE]), {})

    def test_a_missing_root_is_skipped(self):
        self.repo.write(f"{DESKTOP}/a.dart", "final a = Colors.red;\n")
        self.assertEqual(style.scan(self.repo.root, [DESKTOP, MOBILE]),
                         {f"{DESKTOP}/a.dart": {"material-color": 1}})

    def test_a_new_offender_fails_with_its_file_line_and_rule(self):
        self.repo.write(f"{DESKTOP}/a.dart", "final a = AppPalette.accent;\n\nfinal b = Color(0xFF112233);\n")
        self.repo.allow({})
        code, output = self.repo.run()
        self.assertEqual(code, 1)
        self.assertIn(f"{DESKTOP}/a.dart:3: hex-color", output)

    def test_today_offenders_within_the_allowlist_pass(self):
        self.repo.write(f"{DESKTOP}/a.dart", "final a = Colors.red;\nfinal b = Colors.blue;\n")
        self.repo.allow({f"{DESKTOP}/a.dart": {"material-color": 2}})
        self.assertEqual(self.repo.run(), (0, ""))

    def test_one_more_than_allowed_fails(self):
        self.repo.write(f"{DESKTOP}/a.dart", "final a = Colors.red;\nfinal b = Colors.blue;\nfinal c = Colors.green;\n")
        self.repo.allow({f"{DESKTOP}/a.dart": {"material-color": 2}})
        code, output = self.repo.run()
        self.assertEqual(code, 1)
        self.assertIn(f"{DESKTOP}/a.dart: material-color 3, allowed 2", output)

    def test_fewer_than_allowed_asks_to_shrink_the_list(self):
        self.repo.write(f"{DESKTOP}/a.dart", "final a = Colors.red;\n")
        self.repo.allow({f"{DESKTOP}/a.dart": {"material-color": 2, "font-size": 1},
                         f"{DESKTOP}/gone.dart": {"hex-color": 1}})
        code, output = self.repo.run()
        self.assertEqual(code, 1)
        self.assertIn(f"{DESKTOP}/a.dart: material-color 1, allowed 2", output)
        self.assertIn(f"{DESKTOP}/a.dart: font-size 0, allowed 1", output)
        self.assertIn(f"{DESKTOP}/gone.dart: hex-color 0, allowed 1", output)
        self.assertIn("--update", output)

    def test_only_checks_the_named_root_and_ignores_the_other_roots_entries(self):
        self.repo.write(f"{DESKTOP}/a.dart", "final a = Colors.red;\n")
        self.repo.write(f"{MOBILE}/b.dart", "final b = AppPalette.accent;\n")
        self.repo.allow({f"{DESKTOP}/a.dart": {"material-color": 1}, f"{MOBILE}/b.dart": {"hex-color": 4}})
        self.assertEqual(self.repo.run("--only", DESKTOP), (0, ""))
        code, output = self.repo.run("--only", MOBILE)
        self.assertEqual(code, 1)
        self.assertIn(f"{MOBILE}/b.dart: hex-color 0, allowed 4", output)

    def test_entries_for_a_folder_this_branch_lacks_wait_for_it(self):
        self.repo.write(f"{DESKTOP}/a.dart", "final a = Colors.red;\n")
        entries = {f"{DESKTOP}/a.dart": {"material-color": 1}, f"{MOBILE}/b.dart": {"hex-color": 4}}
        self.repo.allow(entries)
        self.assertEqual(self.repo.run(), (0, ""))
        self.assertEqual(self.repo.run("--only", MOBILE), (0, ""))
        self.assertEqual(self.repo.run("--update")[0], 0)
        self.assertEqual(json.loads(self.repo.allowlist.read_text()), entries)

    def test_update_lowers_counts_and_drops_clean_files(self):
        self.repo.write(f"{DESKTOP}/a.dart", "final a = Colors.red;\n")
        self.repo.allow({f"{DESKTOP}/a.dart": {"material-color": 2, "font-size": 1},
                         f"{DESKTOP}/gone.dart": {"hex-color": 1}})
        code, _ = self.repo.run("--update")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(self.repo.allowlist.read_text()),
                         {f"{DESKTOP}/a.dart": {"material-color": 1}})
        self.assertEqual(self.repo.run(), (0, ""))

    def test_update_never_raises_a_count_or_adds_a_file(self):
        self.repo.write(f"{DESKTOP}/a.dart", "final a = Colors.red;\nfinal b = Colors.blue;\n")
        self.repo.write(f"{DESKTOP}/new.dart", "final a = Color(0xFF000000);\n")
        before = {f"{DESKTOP}/a.dart": {"material-color": 1}}
        self.repo.allow(before)
        code, output = self.repo.run("--update")
        self.assertEqual(code, 1)
        self.assertIn(f"{DESKTOP}/a.dart: material-color 2, allowed 1", output)
        self.assertIn(f"{DESKTOP}/new.dart: hex-color 1, allowed 0", output)
        self.assertEqual(json.loads(self.repo.allowlist.read_text()), before)

    def test_init_records_today_offenders_once(self):
        self.repo.write(f"{DESKTOP}/a.dart", "final a = Colors.red;\n")
        self.repo.write(f"{MOBILE}/b.dart", "final b = TextStyle(fontSize: 17);\n")
        self.assertEqual(self.repo.run("--init")[0], 0)
        self.assertEqual(json.loads(self.repo.allowlist.read_text()),
                         {f"{DESKTOP}/a.dart": {"material-color": 1}, f"{MOBILE}/b.dart": {"font-size": 1}})
        code, output = self.repo.run("--init")
        self.assertEqual(code, 1)
        self.assertIn("already exists", output)

    def test_a_missing_allowlist_fails_instead_of_passing_everything(self):
        self.repo.write(f"{DESKTOP}/a.dart", "final a = AppPalette.accent;\n")
        code, output = self.repo.run()
        self.assertEqual(code, 1)
        self.assertIn("--init", output)


if __name__ == "__main__":
    unittest.main()

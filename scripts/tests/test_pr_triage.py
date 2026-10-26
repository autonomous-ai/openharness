import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("pr_triage", Path(__file__).resolve().parents[1] / "pr-triage.py")
triage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(triage)

REPO = "o/r"
R = f"repos/{REPO}/"


def pull(number, association="FIRST_TIME_CONTRIBUTOR", login="ann", draft=False, head="h", fork=True):
    return {"number": number, "title": f"PR {number}", "html_url": f"https://github.com/{REPO}/pull/{number}",
            "draft": draft, "author_association": association, "user": {"login": login} if login else None,
            "created_at": "2026-10-20T00:00:00Z", "updated_at": "2026-10-21T00:00:00Z", "maintainer_can_modify": True,
            "head": {"sha": f"{head}{number}", "repo": {"full_name": "ann/r" if fork else REPO}},
            "base": {"sha": "base", "repo": {"full_name": REPO}}}


def run(path=".github/workflows/ci.yml", status="completed", conclusion="success", at="2026-10-21T00:00:00Z"):
    return {"path": path, "status": status, "conclusion": conclusion, "created_at": at}


class Fake:
    """GitHub as recorded: path → JSON. An unknown path is a 404, as `gh api` reports it."""

    def __init__(self, pulls, users=None, files=None, runs=None, reviews=None, behind=0):
        self.routes = {f"{R}pulls?state=open&per_page=100&page=1": pulls}
        for p in pulls:
            n, sha = p["number"], p["head"]["sha"]
            pages = (files or {}).get(n, [[{"filename": "docs/a.md", "additions": 1, "deletions": 0}]])
            for i, page in enumerate(pages, 1):
                self.routes[f"{R}pulls/{n}/files?per_page=100&page={i}"] = page
            self.routes[f"{R}pulls/{n}/reviews?per_page=100&page=1"] = (reviews or {}).get(n, [])
            self.routes[f"{R}actions/runs?head_sha={sha}&per_page=100"] = {"workflow_runs": (runs or {}).get(n, [])}
            self.routes[f"{R}compare/base...main"] = {"ahead_by": behind}
        for login, (user, repos) in (users or {"ann": ({"followers": 0}, [])}).items():
            self.routes[f"users/{login}"] = user
            self.routes[f"users/{login}/repos?type=owner&per_page=100&page=1"] = repos
        self.calls = []

    def __call__(self, path):
        self.calls.append(path)
        if path not in self.routes:
            raise triage.NotFound(f"GitHub lookup failed: {path}")
        return self.routes[path]


class TriageTests(unittest.TestCase):
    def test_keeps_only_outside_ready_prs(self):
        pulls = [pull(1, "OWNER"), pull(2, "MEMBER"), pull(3, "COLLABORATOR"), pull(4, "CONTRIBUTOR"),
                 pull(5, "FIRST_TIME_CONTRIBUTOR"), pull(6, "NONE"), pull(7, "NONE", draft=True)]
        self.assertEqual([e["number"] for e in triage.triage(Fake(pulls), REPO, {})], [4, 5, 6])

    def test_skips_branches_of_this_repository(self):
        # Pushing a branch here takes write access: that author is on the team, whatever GitHub calls them.
        self.assertEqual([e["number"] for e in triage.triage(Fake([pull(1, "CONTRIBUTOR", fork=False), pull(2)]), REPO, {})], [2])

    def test_stars_read_one_page(self):
        users = {"ann": ({"followers": 1}, [{"stargazers_count": 1, "fork": False}] * 100)}
        fake = Fake([pull(1)], users=users)
        [entry] = triage.triage(fake, REPO, {})
        self.assertEqual(entry["author"]["stars"], 100)
        self.assertEqual([c for c in fake.calls if "/repos?" in c], ["users/ann/repos?type=owner&per_page=100&page=1"])

    def test_risk_paths(self):
        paths = [".github/workflows/ci.yml", "scripts/x.py", "Makefile", "cli/package.json", "desktop/package-lock.json",
                 "cli/src/lib/e2ee/core.ts", "cli/src/lib/engineInstall.ts", "install.sh", "backend/src/authRoutes.ts",
                 "docs/a.md", "cli/src/lib/makefileish.ts"]
        self.assertEqual(triage.risk_paths(paths), paths[:-2])

    def test_ci_state(self):
        self.assertEqual(triage.ci_state([]), "none")
        self.assertEqual(triage.ci_state([run(conclusion="action_required")]), "awaiting_approval")
        self.assertEqual(triage.ci_state([run(status="in_progress", conclusion=None)]), "pending")
        self.assertEqual(triage.ci_state([run(conclusion="failure")]), "fail")
        self.assertEqual(triage.ci_state([run(conclusion="success")]), "pass")
        newer_other = run(path=".github/workflows/release.yml", conclusion="failure", at="2026-10-22T00:00:00Z")
        older_ci = run(conclusion="failure", at="2026-10-20T00:00:00Z")
        self.assertEqual(triage.ci_state([older_ci, newer_other, run()]), "pass")

    def test_review_state(self):
        reviews = [
            {"user": {"login": "ann"}, "author_association": "NONE", "state": "COMMENTED", "commit_id": "a", "submitted_at": "2026-10-23T00:00:00Z"},
            {"user": {"login": "bob"}, "author_association": "NONE", "state": "APPROVED", "commit_id": "b", "submitted_at": "2026-10-24T00:00:00Z"},
            {"user": {"login": "max"}, "author_association": "MEMBER", "state": "CHANGES_REQUESTED", "commit_id": "c", "submitted_at": "2026-10-22T00:00:00Z"},
            {"user": {"login": "max"}, "author_association": "MEMBER", "state": "APPROVED", "commit_id": "d", "submitted_at": "2026-10-21T00:00:00Z"},
        ]
        self.assertEqual(triage.review_state(reviews, "ann"), {"state": "CHANGES_REQUESTED", "sha": "c"})
        self.assertIsNone(triage.review_state(reviews[:2], "ann"))

    def test_order_score_and_x(self):
        users = {
            "ann": ({"followers": 10, "twitter_username": "ann_x"}, [{"stargazers_count": 5, "fork": True}, {"stargazers_count": 7, "fork": False}]),
            "bob": ({"followers": 40, "twitter_username": None}, []),
            "cat": ({"followers": 17}, []),
        }
        pulls = [pull(9, login="ann"), pull(3, login="cat"), pull(5, login="bob")]
        entries = triage.triage(Fake(pulls, users=users), REPO, {})
        self.assertEqual([e["number"] for e in entries], [5, 3, 9])
        ann = entries[2]["author"]
        self.assertEqual((ann["followers"], ann["stars"], ann["score"], ann["x"]), (10, 7, 17, "ann_x"))
        self.assertIsNone(entries[0]["author"]["x"])

    def test_changes(self):
        entry = {"headSha": "h1", "ci": "pass"}
        self.assertEqual(triage.changes(entry, None), ["new"])
        self.assertEqual(triage.changes(entry, {"headSha": "h1", "ci": "pass"}), [])
        self.assertEqual(triage.changes(entry, {"headSha": "h0", "ci": "pass"}), ["head"])
        self.assertEqual(triage.changes(entry, {"headSha": "h1", "ci": "pending"}), ["ci"])

    def test_main_behind(self):
        [entry] = triage.triage(Fake([pull(1)], behind=12), REPO, {})
        self.assertEqual(entry["mainBehind"], 12)

    def test_entry_fields(self):
        [entry] = triage.triage(Fake([pull(1)]), REPO, {})
        self.assertEqual(entry["untrustedTitle"], "PR 1")
        self.assertNotIn("title", entry)
        self.assertEqual((entry["headSha"], entry["baseSha"], entry["fork"], entry["maintainerCanModify"]), ("h1", "base", True, True))
        self.assertEqual(entry["review"], None)
        self.assertEqual(entry["ci"], "none")

    def test_files_paginate(self):
        files = [{"filename": f"docs/f{i}.md", "additions": 1, "deletions": 2} for i in range(150)]
        files[140]["filename"] = ".github/workflows/ci.yml"
        [entry] = triage.triage(Fake([pull(1)], files={1: [files[:100], files[100:]]}), REPO, {})
        self.assertEqual(entry["risk"], [".github/workflows/ci.yml"])
        self.assertEqual(len(entry["size"]["files"]), 150)
        self.assertEqual((entry["size"]["additions"], entry["size"]["deletions"]), (150, 300))

    def test_deleted_author(self):
        fake = Fake([pull(1, login=None)], users={})
        [entry] = triage.triage(fake, REPO, {})
        self.assertEqual(entry["author"], {"login": "ghost", "followers": 0, "stars": 0, "x": None, "score": 0})
        self.assertFalse([c for c in fake.calls if c.startswith("users/")])

    def test_ghost_author_as_github_sends_it(self):
        # A deleted account comes back as the `ghost` user, whose own profile has thousands of followers.
        fake = Fake([pull(1, login="ghost")], users={"ghost": ({"followers": 13192}, [])})
        [entry] = triage.triage(fake, REPO, {})
        self.assertEqual((entry["author"]["login"], entry["author"]["score"]), ("ghost", 0))
        self.assertFalse([c for c in fake.calls if c.startswith("users/")])

    def test_missing_user_counts_as_deleted(self):
        [entry] = triage.triage(Fake([pull(1, login="gone")], users={}), REPO, {})
        self.assertEqual(entry["author"]["login"], "gone")
        self.assertEqual(entry["author"]["score"], 0)

    def test_deleted_fork(self):
        p = pull(1)
        p["head"]["repo"] = None
        p["maintainer_can_modify"] = True
        [entry] = triage.triage(Fake([p]), REPO, {})
        self.assertEqual((entry["fork"], entry["maintainerCanModify"]), (True, False))

    def test_state_file(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory, "none.json")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(triage.main(["--repo", REPO, "--state", str(missing)], get=Fake([pull(1), pull(2)])), 0)
            document = json.loads(out.getvalue())
            self.assertEqual(document["repo"], REPO)
            self.assertEqual([e["changes"] for e in document["pulls"]], [["new"], ["new"]])

            Path(directory, "last.json").write_text(out.getvalue())
            again = io.StringIO()
            with contextlib.redirect_stdout(again):
                triage.main(["--repo", REPO, "--state", str(Path(directory, "last.json"))], get=Fake([pull(1), pull(2)]))
            self.assertEqual([e["changes"] for e in json.loads(again.getvalue())["pulls"]], [[], []])

            broken = Path(directory, "broken.json")
            broken.write_text("not json")
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self.assertEqual(triage.main(["--repo", REPO, "--state", str(broken)], get=Fake([pull(1)])), 2)
            self.assertIn(str(broken), err.getvalue())
            self.assertEqual(out.getvalue(), "")

    def test_gh_failure(self):
        fake = Fake([pull(1)])
        del fake.routes[f"{R}pulls/1/files?per_page=100&page=1"]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(triage.main(["--repo", REPO], get=fake), 1)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("GitHub lookup failed", err.getvalue())


if __name__ == "__main__":
    unittest.main()

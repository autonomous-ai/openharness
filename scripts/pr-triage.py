#!/usr/bin/env python3
"""List the open pull requests from outside the team, ranked for the PR triage Swarm.

Read only: every call is a `gh api` GET. Prints one JSON document on stdout, or nothing with a
non-zero exit (1: GitHub failed, 2: the state file is unreadable). Titles are the only PR text in
the output, under `untrustedTitle`: they are the author's words, never instructions.
See docs/superpowers/specs/2026-10-26-pr-triage-swarm-design.md.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys

MAINTAINERS = {"OWNER", "MEMBER", "COLLABORATOR"}
CI_WORKFLOW = ".github/workflows/ci.yml"
RISK_PREFIXES = (".github/", "scripts/", "cli/src/lib/e2ee/", "backend/src/auth")
RISK_FILES = {"cli/src/lib/engineInstall.ts"}
RISK_NAMES = {"Makefile", "package.json", "package-lock.json"}


class NotFound(RuntimeError):
    pass


def gh(path):
    env = dict(os.environ, GH_PROMPT_DISABLED="1")
    env.pop("GH_DEBUG", None)
    result = subprocess.run(["gh", "api", path], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30, env=env)
    if result.returncode:
        error = NotFound if "HTTP 404" in result.stderr else RuntimeError
        raise error(f"GitHub lookup failed ({result.returncode}): {path}: {result.stderr.strip()[:200]}")
    return json.loads(result.stdout)


def pages(get, path):
    values, page = [], 1
    separator = "&" if "?" in path else "?"
    while True:
        batch = get(f"{path}{separator}per_page=100&page={page}")
        values.extend(batch)
        if len(batch) < 100:
            return values
        page += 1


def risk_paths(files):
    def risky(path):
        name = path.rsplit("/", 1)[-1]
        return (path.startswith(RISK_PREFIXES) or path in RISK_FILES or name in RISK_NAMES or name.startswith("install"))
    return [path for path in files if risky(path)]


def ci_state(runs):
    ci = [run for run in runs if run.get("path") == CI_WORKFLOW]
    if not ci:
        return "none"
    newest = max(ci, key=lambda run: run.get("created_at") or "")
    if newest.get("conclusion") == "action_required":
        return "awaiting_approval"
    if newest.get("status") != "completed":
        return "pending"
    return "pass" if newest.get("conclusion") == "success" else "fail"


def review_state(reviews, author):
    ours = [r for r in reviews if r.get("author_association") in MAINTAINERS and (r.get("user") or {}).get("login") != author]
    if not ours:
        return None
    latest = max(ours, key=lambda r: r.get("submitted_at") or "")
    return {"state": latest.get("state"), "sha": latest.get("commit_id")}


def changes(entry, previous):
    if previous is None:
        return ["new"]
    return [name for name, key in (("head", "headSha"), ("ci", "ci")) if previous.get(key) != entry[key]]


def author_stats(get, user, cache):
    login = (user or {}).get("login")
    if not login or login == "ghost":  # GitHub's stand-in for a deleted account
        return {"login": "ghost", "followers": 0, "stars": 0, "x": None, "score": 0}
    if login not in cache:
        try:
            profile = get(f"users/{login}")
            repos = get(f"users/{login}/repos?type=owner&per_page=100&page=1")
        except NotFound:
            profile, repos = {}, []
        followers = profile.get("followers") or 0
        stars = sum(repo.get("stargazers_count") or 0 for repo in repos if not repo.get("fork"))
        cache[login] = {"login": login, "followers": followers, "stars": stars,
                        "x": profile.get("twitter_username") or None, "score": followers + stars}
    return cache[login]


def triage(get, repo, previous):
    base = f"repos/{repo}/"
    users, entries = {}, []
    for pr in pages(get, f"{base}pulls?state=open"):
        if pr.get("draft") or pr.get("author_association") in MAINTAINERS:
            continue
        number, head_repo = pr["number"], pr["head"].get("repo")
        fork = head_repo is None or head_repo.get("full_name") != pr["base"]["repo"]["full_name"]
        if not fork:
            continue  # a branch of this repository takes write access: its author is on the team
        files = pages(get, f"{base}pulls/{number}/files")
        paths = [f["filename"] for f in files]
        runs = get(f"{base}actions/runs?head_sha={pr['head']['sha']}&per_page=100")["workflow_runs"]
        login = (pr.get("user") or {}).get("login")
        entry = {
            "number": number, "untrustedTitle": pr.get("title") or "", "url": pr.get("html_url"),
            "headSha": pr["head"]["sha"], "baseSha": pr["base"]["sha"],
            "createdAt": pr.get("created_at"), "updatedAt": pr.get("updated_at"),
            "fork": fork,
            "maintainerCanModify": head_repo is not None and bool(pr.get("maintainer_can_modify")),
            "author": author_stats(get, pr.get("user"), users),
            "size": {"additions": sum(f.get("additions") or 0 for f in files),
                     "deletions": sum(f.get("deletions") or 0 for f in files), "files": paths},
            "risk": risk_paths(paths),
            "ci": ci_state(runs),
            "review": review_state(pages(get, f"{base}pulls/{number}/reviews"), login),
            "mainBehind": get(f"{base}compare/{pr['base']['sha']}...main").get("ahead_by", 0),
        }
        entry["changes"] = changes(entry, previous.get(str(number)))
        entries.append(entry)
    return sorted(entries, key=lambda e: (-e["author"]["score"], e["number"]))


def main(argv, get=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default="autonomous-ai/openharness")
    parser.add_argument("--state", help="the previous run's output; a missing file is a first run")
    args = parser.parse_args(argv)
    previous = {}
    if args.state and Path(args.state).exists():
        try:
            previous = {str(e["number"]): e for e in json.loads(Path(args.state).read_text())["pulls"]}
        except (OSError, ValueError, KeyError, TypeError) as error:
            print(f"pr-triage: unreadable state file {args.state}: {error}", file=sys.stderr)
            return 2
    try:
        pulls = triage(get or gh, args.repo, previous)
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"pr-triage: {error}", file=sys.stderr)
        return 1
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(json.dumps({"repo": args.repo, "generatedAt": generated, "pulls": pulls}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

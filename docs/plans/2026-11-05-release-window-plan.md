# Release window guard Implementation Plan

**Goal:** A release outside 09:00-18:00 Asia/Ho_Chi_Minh, or a backend release within 2 hours of the last one, is
refused with the next allowed time. A P0 may release at night with `--urgent "<reason>"`; the reason is recorded and
printed as the one line the releaser posts in the project chat (Dee, 2026-11-05).

**Architecture:** One script, `scripts/release-window.py`, reads its numbers from `scripts/release-window.json`
(zone, window, pace per kind). The four release scripts (backend, CLI, Desktop, web) call it before they tag. The
tag-triggered workflows call it again as their first step, because a hand-pushed tag skips the scripts. An urgent
release writes `Release-Urgent: <reason>` into its tag message, so the workflow can honor the same override and the
reason stays on the tag.

**Tech Stack:** Python 3 stdlib (`zoneinfo`, `unittest`), bash, GitHub Actions YAML.

**Spec:** the task's brief (#3388). Guard name: `RELEASE_WINDOW` (new; not one of the codes #2414 removed).

## Global Constraints

- Refusal names the next allowed time and the next step (`--urgent "<reason>"` for a P0).
- No new refusal for a workflow choice: the guard is the window and the pace, nothing else.
- `--prepare` (Desktop candidate) and `--dry-run` publish nothing, so they are not refused; a dry run reports the verdict.
- Tests never touch the real clock or the real tags: `--now` and a temp git repo.
- Temp files only under `mktemp -d`.

## Review Focus

- A refusal exits non-zero before any tag is created, in all four scripts.
- The workflow check cannot count the tag it is building as "the last release".
- Urgent without a reason is refused; with a reason it is recorded on the tag and printed.

## Tasks

### Task 1: the guard

**Files:** `scripts/release-window.py`, `scripts/release-window.json`, `scripts/tests/test_release_window.py`

**Interfaces:** `check(kind, now, last, config, urgent) -> Verdict`; CLI
`release-window.py --kind K [--now ISO] [--urgent REASON] [--tag TAG] [--repo DIR] [--exclude-tag TAG] [--from-tag TAG] [--advisory]`.
Exit 0 allowed, 2 refused (`RELEASE_WINDOW ...`).

- [ ] Failing tests: inside window allowed; before 09:00, at 18:00 and after refused with next 09:00; backend within 2 h refused with last+2h; pace landing after 18:00 moves to next 09:00; CLI/Desktop/web have no pace; urgent needs a non-blank reason; urgent prints the chat line; zone has no DST shift.
- [ ] Implement.

### Task 2: last release from git, tag override

- [ ] Failing tests (temp git repo): last backend tag time is read; `--exclude-tag` skips the tag being built; `Release-Urgent:` in the tag message is honored with `--from-tag`.
- [ ] Implement.

### Task 3: wire the scripts and workflows

**Files:** `backend/scripts/release-be.sh`, `cli/scripts/release-cli.sh`, `desktop/scripts/release-desktop.sh`, `desktop/scripts/release-web.sh`, `.github/workflows/{production-be-build.yaml,release.yml,release-desktop.yml,release-web.yml}`

- [ ] Failing test: each script and workflow calls the guard before it tags/builds, and a refused guard stops the script (run the script's guard step against a fake `--now`).
- [ ] Implement.

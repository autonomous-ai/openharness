# `local-checks.py --run`: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3** (wave by wave; each task commits its failing
> test, then the code). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `python3 scripts/local-checks.py --run` runs the local checks a branch's paths need on a clean HEAD and
prints the one `harness-local-checks` fence PR CI accepts; the PR template and the validation doc name it as the way
to make receipts.

**Architecture:** A local-only mode in the same script, beside the validation path CI calls, which does not change.
Three pure rules (the running platform, the command with its cap, the passed count) and one `run()` that carries the
order: clean tree, paths from git, required checks, platform, each `CHECKS` command through the shell in its own
process group with a one-hour limit, source unchanged, then the fence, printed only after `validate_receipts` takes it.

**Tech Stack:** Python 3 standard library (`argparse`, `subprocess`, `threading`, `json`, `re`), `unittest`, git. No
new dependency.

**Spec:** [docs/plans/2026-11-13-local-checks-run-design.md](2026-11-13-local-checks-run-design.md). Read it with this
plan and the root `AGENTS.md`. The spec is the authority.

## Global Constraints

- Files: `scripts/local-checks.py`, `scripts/tests/test_local_checks.py`, `.github/pull_request_template.md`,
  `docs/validation-and-release.md`. No product code. `ci-plan.py`, `ci.yml` and the train do not change, and
  `local-checks.py` never imports `ci-plan.py` (`ci-plan.py` imports it). The root `AGENTS.md` does not change: it
  already points at `docs/validation-and-release.md`.
- One more file lives only on the feature branch: the temporary workflow `.github/workflows/tmp-local-checks-run.yml`
  (Task 3). It is removed before the pull request.
- The validation path (`main()` with no argument, as `ci.yml` calls it) and `--list` behave as today. CI never runs a
  command.
- `--run` runs only command strings built from `CHECKS` plus the fixed caps below. Nothing from a PR body, a path,
  `--base` or git output is run or put into a command; `package.json` is read only to decide whether a cap is added.
- Caps, picked by the program, no flag: ` -- --maxWorkers=N` appended to an `npm run test:*` command, `N` = half the
  logical CPUs, at least 1, at most 99, unless the npm script it names already sets `--maxWorkers` (read from
  `cli/package.json` at run time, as data): that command runs as `CHECKS` has it. The `npx vitest … --maxWorkers=1`
  commands as they are; `make desktop-test` gets ` ARGS="--timeout 3600"`. The receipt's `command` is the exact
  command run.
- Paths: `git diff --no-renames --name-only REF...HEAD`, `REF` default `origin/main`, no fetch. `--run` takes no paths.
- stdout is empty or exactly one fence. Everything else goes to stderr. A failure line is a check's name and a fixed
  reason: no output text, path or environment value.
- Each check has 3600 s; past it, its process group is killed. Every required check runs even after one fails.
- macOS, Linux and Windows. Standard library only.
- Tests: `python3 -m unittest` from `scripts/tests`, a throwaway git repository, fake `CHECKS` entries, no real suite,
  no fixed sleep. The red test commit comes before the code commit (Task 3, a temporary workflow, has no test). The
  new tests add under 20 s on CI (the job that runs them, `process-checks`, has 3 minutes; the step takes about 52 s
  today).

Exact stderr copy (each ends with a newline; `run()` exits 1 with all but the first):

| When | Line |
|---|---|
| no check required (exit 0) | `No local check is required.` |
| not inside a git repository | `Local checks not run: this is not a git repository.` |
| any line from `git status --porcelain` | `Local checks not run: the tree has uncommitted changes.` |
| `--base` starts with `-`, or git cannot diff it | `Local checks not run: git cannot compare the base with HEAD; fetch it or pass --base REF.` |
| the OS is none of the three | `Local checks not run: this is not macOS, Linux or Windows.` |
| a required check names another platform (one line each) | `Local checks not run: NAME needs PLATFORM; this is HOST.` |
| a failed check (one line each, name order) | `NAME failed: exit N` · `NAME failed: no passed count` · `NAME failed: timed out` |
| HEAD or `git status` differs after the checks | `Local checks void: HEAD or the tree changed during the run.` |

## Found while reading the code

**Two `npm run` checks cannot take the cap.** `cli/package.json` already sets `--maxWorkers=1` inside
`test:orchestrator` and `test:terminal-contract` (`cli-orchestrator`, `cli-pty`). Vitest 4.1.10 refuses the option
twice: `npx vitest run --maxWorkers=1 --maxWorkers=2 src/does-not-exist.spec.ts` exits 1 with
`Expected a single value for option "--maxWorkers <workers>", received [1, 2]` (run on this Mac, 2026-11-13). A cap
on every `npm run` command would fail those two checks every time, and so every pull request that touches
`cli/package.json` or the lockfile. Decided in the main session on 2026-11-13, and now in the spec's step 5: the cap
is appended only when the npm script the command names does not already set `--maxWorkers`, read at run time from the
`package.json` in the check's `cwd` (`cli/package.json` for every `npm run` check), as data. Such a check's receipt
carries the plain `CHECKS` command, which validation accepts: the cap is optional in `MAX_WORKERS`. The rule follows
the scripts by itself, with no list of check names to keep. Its tests use a fixture `package.json`, never the real
one: PR CI's `process-checks` checkout is sparse and has no `cli/`.

**The summary is not at the end.** Vitest prints its coverage table after `Tests  N passed`; for `test:core` that is
234 files, about 30 KB. So the tail kept for the count is 1 MiB, not a few KB.

## Review Focus

Failure modes the spec implies and its test list does not name, each pinned by a test in Task 1:

1. **No `origin/main`, a mistyped `--base`, or one that looks like an option.** Expected: one fixed line, exit 1,
   nothing run, no traceback, never a git option. `test_the_command_line_…`.
2. **A check that leaves an untracked file but does not move HEAD.** Expected: void, no fence.
   `test_a_run_that_moves_head_or_dirties_the_tree_is_void`.
3. **A hung check that started children.** Expected: the whole group dies at the limit, the check is named
   `timed out`, the next check still runs, `--run` returns. `test_a_check_past_its_limit_…`.
4. **A long report after the summary, bytes that are not UTF-8, a `Tests N passed` line a test printed itself.**
   Expected: the last summary is the count, memory stays bounded. `test_the_count_survives_a_long_report_…` and
   `test_the_count_is_the_last_vitest_summary_…`.
5. **A Desktop receipt that is missing, not JSON, or whose count is not a whole number.** Expected: `no passed
   count`, never a traceback. `test_the_desktop_count_…`.
6. **A Windows text stdout.** There `\n` leaves the program as `\r\n`, and CI's `FENCE` does not match a closing
   fence line that ends in `\r` (checked 2026-11-13: the same body with `\r\n` line ends gives no fence). Expected:
   the fence on stdout ends its lines with `\n` on every platform. `test_the_fence_on_stdout_ends_its_lines_…`.

## Files

| File | What changes | Task |
|---|---|---|
| `scripts/local-checks.py` | `--run`, `--base`, the rules it uses, the docstring, `missing()`'s hint | 1 |
| `scripts/tests/test_local_checks.py` | a shared git fixture, the `--run` tests; the template test | 1, 2 |
| `.github/pull_request_template.md` | the local-checks paragraph names `--run`; the example fence and field rules go | 2 |
| `docs/validation-and-release.md` | the "Checks PR CI does not run" bullet names `--run` | 2 |
| `.github/workflows/tmp-local-checks-run.yml` | temporary: the tests on `windows-latest`; removed before the pull request | 3 |

## Waves

A wave's tasks depend on nothing in the same wave and share no file, tests included.

| Wave | Tasks |
|---|---|
| 1 | 1 `--run` |
| 2 | 2 Template and doc · 3 Temporary Windows workflow |

Tasks 2 and 3 both wait for Task 1 and share no file: Task 2 owns the template, the doc and the test file, Task 3
only the workflow file.

Test commands run from `scripts/tests`.

---

### Task 1: `--run`

**Depends on:** nothing. **Effort:** xhigh (process groups, a timeout, and receipts that CI trusts).

**Files:**
- Modify: `scripts/local-checks.py`
- Test: `scripts/tests/test_local_checks.py`

**Interfaces:**
- Consumes (unchanged): `CHECKS`, `required_checks`, `validate_receipts`, `check`, `FENCE`.
- Produces, in `scripts/local-checks.py`:
  - `RUN_SECONDS = 3600`, `TAIL_BYTES = 1 << 20` (module globals; `RUN_SECONDS` is read when a check starts: a test
    patches it).
  - `host_platform() -> str | None`: `darwin` → `macos`, `linux` → `linux`, `win32` → `windows`, else `None`.
  - `run_command(root: Path, name: str) -> str`: the command `--run` runs for `CHECKS[name]`.
  - `passed_count(name: str, output: str) -> int`: the passed tests in a check's output, `0` when it has none.
  - `run(root: Path, base: str, out, err) -> int`: the whole of `--run` for the repository at `root`; `out` and
    `err` are text streams; returns the exit code. Raises only what `validate_receipts` raises.
  - `main()`: `--run` and `--base REF` (default `origin/main`); `--run` with `--list` is an argparse error.

- [ ] **Step 1: Write the failing tests**

Fixture changes in `scripts/tests/test_local_checks.py`:
- `checks = planner.local_checks` at module level (the module `planner.verify` uses), and `import io`, `time`,
  `from unittest import mock`.
- Move `LocalMappingTests.setUp`, `git`, `write`, `commit` unchanged into a mixin `GitFixture`;
  `write(path, text="fixture\n")`. `LocalMappingTests(GitFixture, unittest.TestCase)` keeps its tests.
- `fake(mode, platform=None, area="a")` returns
  `dict(command=f'"{sys.executable}" fake.py {mode}', cwd="cli", platform=platform, paths=(f"area/{area}/*",))`.
- `cli/fake.py`, committed in the throwaway repository's base commit by `LocalRunTests.setUp`, with these modes.
  `SUMMARY(n)` is Vitest's coloured line,
  `\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m{n} passed\x1b[39m\x1b[22m\x1b[90m ({n})\x1b[39m`; `\|` below is this
  table's escape for `|`:

  | Mode | Prints, does | Exit |
  |---|---|---|
  | `pass N` | `SUMMARY(N)` | 0 |
  | `mark PATH` | writes PATH, `SUMMARY(1)` | 0 |
  | `fail` | `      Tests  1 failed \| 2 passed (3)` | 1 |
  | `nocount` | `ok` | 0 |
  | `skipped` | `      Tests  2 skipped (2)` | 0 |
  | `long` | `SUMMARY(4)`, then 6,000 lines of `b"\xff src/file.ts \| 100 \| 100 \| 100 \| 100 \|\n"` | 0 |
  | `move` | `git commit -q --allow-empty -m moved`, `SUMMARY(1)` | 0 |
  | `litter` | writes `left-behind.txt` in its folder, `SUMMARY(1)` | 0 |
  | `hang` | starts a child that sleeps 600 s, with `stdout=sys.stdout` (passed, so the child holds the pipe on Windows too), then sleeps 600 s itself | never |

- `LocalRunTests(GitFixture, unittest.TestCase)`: `self.marker` is a path in a second temporary folder outside the
  repository; `change(*areas)` writes `area/<area>/1` for each, commits and returns the commit;
  `run_checks(table, base=None)` patches `checks.CHECKS` with `mock.patch.dict(checks.CHECKS, table, clear=True)`,
  calls `checks.run(self.root, base or self.base, out, err)` on two `io.StringIO` and returns `(code, out, err)` as
  text;
  `cli(*args, cwd=None)` runs `[sys.executable, SCRIPTS / "local-checks.py", *args]` in `cwd or self.root`,
  captured, `timeout=60`.

The rules (`class LocalRunRuleTests(unittest.TestCase)`; `self.root` is a temporary folder holding
`cli/package.json` with `scripts`: `test:core` → `vitest run --config vitest.core.config.ts`, `test:orchestrator` →
`vitest run src/orchestrator --maxWorkers=1 --coverage`, `test:terminal-contract` →
`vitest run a.spec.ts --maxWorkers=1 --passWithNoTests`):

```python
def test_the_platform_is_the_running_os(self):
    for name, expected in (("darwin", "macos"), ("linux", "linux"), ("win32", "windows"), ("freebsd14", None)):
        with mock.patch.object(checks.sys, "platform", name):
            self.assertEqual(checks.host_platform(), expected)

def test_run_adds_only_the_caps_validation_accepts(self):
    with mock.patch.object(checks.os, "cpu_count", return_value=8):
        self.assertEqual(checks.run_command(self.root, "cli-core"), "npm run test:core -- --maxWorkers=4")
        # No such script in the fixture: capped, and the command then fails by itself.
        self.assertEqual(checks.run_command(self.root, "cli-harnessd"), "npm run test:harnessd -- --maxWorkers=4")
        for name in ("cli-serial", "cli-shell"):                 # npx vitest … --maxWorkers=1, as they are
            self.assertEqual(checks.run_command(self.root, name), checks.CHECKS[name]["command"])
        self.assertEqual(checks.run_command(self.root, "desktop-macos"), 'make desktop-test ARGS="--timeout 3600"')
    for cpus, workers in ((1, 1), (None, 1), (3, 1), (400, 99)):
        with mock.patch.object(checks.os, "cpu_count", return_value=cpus):
            self.assertEqual(checks.run_command(self.root, "cli-core"), f"npm run test:core -- --maxWorkers={workers}")

# Vitest refuses --maxWorkers twice, and cli/package.json sets it inside test:orchestrator and test:terminal-contract.
def test_a_script_that_already_sets_max_workers_gets_no_cap_and_a_plain_receipt(self):
    package = self.root / "cli/package.json"
    with mock.patch.object(checks.os, "cpu_count", return_value=8):
        for name, command in (("cli-orchestrator", "npm run test:orchestrator"),
                              ("cli-pty", "npm run test:terminal-contract")):
            self.assertEqual(checks.run_command(self.root, name), command)
            r = receipt(name, command=command, cwd="cli", platform="macos")
            self.assertEqual(checks.validate_receipts({"a" * 40: [name]}, [r]), [r])
        # A package.json that cannot be read is no reason to drop the cap, and never a traceback.
        for text in ("not json", "[]", '{"scripts": []}', '{"scripts": {"test:orchestrator": 1}}', None):
            package.write_text(text) if text is not None else package.unlink()
            self.assertEqual(checks.run_command(self.root, "cli-orchestrator"),
                             "npm run test:orchestrator -- --maxWorkers=4")

def test_every_command_run_makes_a_receipt_validation_accepts(self):
    for name, contract in checks.CHECKS.items():
        r = receipt(name, command=checks.run_command(self.root, name), cwd=contract["cwd"],
                    platform=contract["platform"] or "linux")
        self.assertEqual(checks.validate_receipts({"a" * 40: [name]}, [r]), [r])

def test_the_count_is_the_last_vitest_summary_without_colour(self):
    for output, count in [
            (" Test Files  2 passed (2)\n      Tests  12 passed (12)\n", 12),
            ("\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m7 passed\x1b[39m\x1b[22m\x1b[90m (7)\x1b[39m\n", 7),
            ("      Tests  1 failed | 5 passed (6)\n", 5), ("      Tests  3 passed | 2 skipped (5)\r\n", 3),
            ("      Tests  999 passed (999)\nlater\n      Tests  4 passed (4)\n", 4),
            ("      Tests  2 skipped (2)\n", 0), (" Test Files  2 passed (2)\n", 0), ("12 passed\n", 0), ("", 0)]:
        self.assertEqual(checks.passed_count("cli-core", output), count)

def test_the_desktop_count_comes_from_the_receipt_its_output_names(self):
    path = self.root / "receipt.json"
    path.write_text(json.dumps(dict(status="passed", coverage=dict(files=3, passed=41, skipped=1))))
    self.assertEqual(checks.passed_count("desktop-macos", f"desktop-vm: 41 passed\npassed: {path}\n"), 41)
    self.assertEqual(checks.passed_count("desktop-macos", f"passed_after_startup_retry: {path}\n"), 41)
    for output in (f"failed: {path}\n", "passed: /nowhere/receipt.json\n", "      Tests  12 passed (12)\n", ""):
        self.assertEqual(checks.passed_count("desktop-macos", output), 0)
    for bad in ("not json", "[]", '{"coverage": {"passed": "41"}}', '{"coverage": {"passed": true}}'):
        path.write_text(bad)
        self.assertEqual(checks.passed_count("desktop-macos", f"passed: {path}\n"), 0)
```

The run (`LocalRunTests`):

```python
def test_the_printed_fence_is_what_ci_accepts_at_this_head(self):
    self.write(".gitignore", "ignored/\n")
    head = self.change("a", "b")
    self.write("ignored/log")                                    # an ignored file leaves the tree clean
    table = {"fake-b": fake("pass 5", area="b"), "fake-a": fake("pass 3", area="a")}
    code, out, err = self.run_checks(table)
    receipts = [dict(check=name, command=table[name]["command"], cwd="cli", head=head, status="passed",
                     passed=passed, platform=checks.host_platform()) for name, passed in (("fake-a", 3), ("fake-b", 5))]
    self.assertEqual(code, 0, err)
    self.assertEqual(out, "```harness-local-checks\n" + json.dumps(receipts, indent=2) + "\n```\n")
    self.assertIn("3 passed", err)                               # a check's output streams to stderr
    event = dict(pull_request=dict(head=dict(sha=head), body="What changed\n\n" + out))
    with mock.patch.dict(checks.CHECKS, table, clear=True):
        self.assertEqual(checks.check(plan(["area/a/1", "area/b/1"], head=head,
                                           local_checks=["fake-a", "fake-b"]), event), receipts)

def test_a_dirty_tree_is_refused_before_anything_runs(self):
    self.change("a")
    for dirty in ("staged", "unstaged", "untracked"):
        with self.subTest(dirty=dirty):
            self.git("reset", "-q", "--hard"), self.git("clean", "-qfd")
            (self.root / ("new.txt" if dirty == "untracked" else "README.md")).write_text("changed\n")
            if dirty == "staged":
                self.git("add", "README.md")
            code, out, err = self.run_checks({"fake-a": fake(f'mark "{self.marker}"')})
            self.assertEqual((code, out, err), (1, "", "Local checks not run: the tree has uncommitted changes.\n"))
            self.assertFalse(self.marker.exists())

def test_the_checks_are_the_ones_the_paths_since_the_base_need(self):
    first = self.change("a")
    (self.root / "area/a/1").unlink(), self.write("area/c/1"), self.write("area/b/1"), self.commit()
    table = {f"fake-{area}": fake("pass 1", area=area) for area in "abcd"}
    names = lambda result: [r["check"] for r in json.loads(checks.FENCE.findall(result[1])[0])]
    self.assertEqual(names(self.run_checks(table, base=first)), ["fake-a", "fake-b", "fake-c"])  # a move counts twice
    self.assertEqual(names(self.run_checks(table)), ["fake-b", "fake-c"])

def test_no_required_check_prints_nothing_and_passes(self):
    self.write("docs/guide.md"), self.commit()
    self.assertEqual(self.run_checks({"fake-a": fake("fail")}), (0, "", "No local check is required.\n"))

def test_every_failed_check_is_named_and_no_fence_is_printed(self):
    self.change("a", "b", "c", "d")
    code, out, err = self.run_checks({"fake-a": fake("fail", area="a"), "fake-b": fake(f'mark "{self.marker}"', area="b"),
                                      "fake-c": fake("nocount", area="c"), "fake-d": fake("skipped", area="d")})
    self.assertEqual((code, out), (1, ""))
    self.assertTrue(self.marker.exists())                        # a later check runs after one fails
    self.assertTrue(err.endswith("fake-a failed: exit 1\nfake-c failed: no passed count\nfake-d failed: no passed count\n"))

def test_a_check_for_another_platform_is_refused_before_anything_runs(self):
    self.change("a", "b")
    host = checks.host_platform()
    other = "linux" if host == "macos" else "macos"
    table = {"fake-a": fake(f'mark "{self.marker}"', area="a"), "fake-b": fake("pass 1", platform=other, area="b")}
    self.assertEqual(self.run_checks(table), (1, "", f"Local checks not run: fake-b needs {other}; this is {host}.\n"))
    with mock.patch.object(checks, "host_platform", return_value=None):
        self.assertEqual(self.run_checks(table), (1, "", "Local checks not run: this is not macOS, Linux or Windows.\n"))
    self.assertFalse(self.marker.exists())

def test_a_run_that_moves_head_or_dirties_the_tree_is_void(self):
    self.change("a")
    for mode in ("move", "litter"):
        with self.subTest(mode=mode):
            code, out, err = self.run_checks({"fake-a": fake(mode)})
            self.assertEqual((code, out), (1, ""))
            self.assertTrue(err.endswith("Local checks void: HEAD or the tree changed during the run.\n"))
            self.git("clean", "-qfd")

# The child holds the check's stdout, so run() returns only once the whole group is dead. Asking the process table
# instead would be flaky: a killed orphan stays a zombie until init reaps it.
def test_a_check_past_its_limit_is_killed_with_its_children_and_named(self):
    self.change("a", "b")
    started = time.monotonic()
    with mock.patch.object(checks, "RUN_SECONDS", 3):
        code, out, err = self.run_checks({"fake-a": fake("hang", area="a"),
                                          "fake-b": fake(f'mark "{self.marker}"', area="b")})
    self.assertEqual((code, out), (1, ""))
    self.assertTrue(err.endswith("fake-a failed: timed out\n"))
    self.assertTrue(self.marker.exists())
    self.assertLess(time.monotonic() - started, 60)

def test_the_count_survives_a_long_report_after_the_summary(self):
    self.change("a")
    code, out, err = self.run_checks({"fake-a": fake("long")})
    self.assertEqual((code, json.loads(checks.FENCE.findall(out)[0])[0]["passed"]), (0, 4))
    self.assertGreater(len(err), 200000)                         # all of it streamed

def test_a_command_validation_would_refuse_never_becomes_a_fence(self):
    self.change("a")
    out = io.StringIO()
    narrowed = lambda root, name: checks.CHECKS[name]["command"] + " -t one"
    with mock.patch.dict(checks.CHECKS, {"fake-a": fake("pass 3")}, clear=True), \
            mock.patch.object(checks, "run_command", narrowed), self.assertRaisesRegex(ValueError, "receipts: fake-a"):
        checks.run(self.root, self.base, out, io.StringIO())
    self.assertEqual(out.getvalue(), "")

# Windows writes "\n" on a text stdout as "\r\n", and CI's FENCE takes no "\r" before the closing line, so main()
# sets the line end itself. This stream does on every platform what a Windows stdout does.
def test_the_fence_on_stdout_ends_its_lines_as_ci_reads_them(self):
    self.change("a")
    raw = io.BytesIO()
    stdout = io.TextIOWrapper(raw, encoding="utf-8", newline="\r\n")
    self.addCleanup(os.chdir, os.getcwd())
    os.chdir(self.root)
    with mock.patch.dict(checks.CHECKS, {"fake-a": fake("pass 3")}, clear=True), \
            mock.patch.object(sys, "argv", ["local-checks.py", "--run", "--base", self.base]), \
            mock.patch.object(sys, "stdout", stdout), mock.patch.object(sys, "stderr", io.StringIO()), \
            self.assertRaises(SystemExit) as done:
        checks.main()
    stdout.flush()
    self.assertEqual(done.exception.code, 0)
    self.assertNotIn(b"\r", raw.getvalue())
    self.assertEqual(len(checks.FENCE.findall(raw.getvalue().decode())), 1)

def test_the_command_line_runs_from_any_folder_and_refuses_what_git_cannot_compare(self):
    self.write("docs/guide.md"), self.commit()
    result = self.cli("--run", "--base", self.base, cwd=self.root / "docs")
    self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", "No local check is required.\n"))
    refused = "Local checks not run: git cannot compare the base with HEAD; fetch it or pass --base REF.\n"
    for args in (["--base=no-such-ref"], ["--base=--output=leak"], []):   # [] is origin/main, which is not here
        result = self.cli("--run", *args)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, "", refused))
    self.assertEqual(list(self.root.glob("leak*")), [])
    result = self.cli("--run", cwd=self.marker.parent)
    self.assertEqual((result.returncode, result.stdout, result.stderr),
                     (1, "", "Local checks not run: this is not a git repository.\n"))
    self.assertEqual(self.cli("--run", "--list", "x").returncode, 2)
    self.assertEqual(json.loads(self.cli("--list", "cli/src/core/api.ts").stdout),
                     {"cli-core": dict(command="npm run test:core", cwd="cli", platform=None)})
```

And in `LocalGateTests`:

```python
def test_a_refused_body_says_how_to_make_the_receipts(self):
    with self.assertRaisesRegex(ValueError, r"receipts: cli-core\. Run python3 scripts/local-checks\.py --run "):
        planner.verify(plan(), needs(), "a" * 40)
```

- [ ] **Step 2: Run them and see them fail**

Run: `python3 -m unittest test_local_checks -v`
Expected: the 23 tests of today pass; every new one fails or errors (`module 'local_checks' has no attribute
'run_command'`, `host_platform`, `passed_count`, `run`; the command-line test and the line-end test on argparse's
exit 2; the hint test on the old copy). The last `--list` assertion is a guard and is not reached.

- [ ] **Step 3: Commit the red tests**

```bash
git add scripts/tests/test_local_checks.py
git commit -m "Local checks: tests for --run (red)"
```

- [ ] **Step 4: Implement in `scripts/local-checks.py`**

What the signatures and tests do not decide:

- `run_command`: the Desktop suite is the one check with `resources`. An `npm run X` command takes the cap unless
  `scripts[X]` in `root / cwd / "package.json"` is a string that contains `--maxWorkers`; a file or script that
  cannot be read, or has any other shape, counts as not set. The file is only read: nothing from it goes into the
  command. Every other command is returned as it is. `N = max(1, min(99, (os.cpu_count() or 1) // 2))`.
- `passed_count`: strip ANSI (`\x1b\[[0-9;]*m`). The Desktop suite: the last line matching
  `^(?:passed|passed_after_startup_retry): (.+receipt\.json)\s*$`, then that file's `coverage.passed` when
  `type(...) is int`; a file that cannot be read, is not JSON or has any other shape is `0`. Every other check: the
  last match of `^\s*Tests\s+(?:\d+ failed \| )?(\d+) passed` (multiline).
- `run`, in this order, printing the copy in Global Constraints:
  1. `git status --porcelain` empty, else refuse. `head = git rev-parse HEAD`.
  2. Refuse a `base` that starts with `-`. Paths: `git diff --no-renames --name-only -z f"{base}...HEAD" --`, argv
     list, never the shell; a non-zero exit refuses. `names = required_checks(paths)`.
  3. No names: the one line, return 0.
  4. `host_platform()` is `None`: refuse with that one line. Otherwise refuse with one line per check whose
     `platform` is set and differs. Both before anything runs.
  5. Each name in order: `command = run_command(root, name)`; `subprocess.Popen(command, shell=True,
     cwd=root / CHECKS[name]["cwd"], stdin=DEVNULL, stdout=PIPE, stderr=STDOUT)` in its own process group
     (`start_new_session=True`; on Windows `creationflags=CREATE_NEW_PROCESS_GROUP`). Read the pipe to its end,
     writing each chunk to `err` (decoded with `errors="replace"`) and keeping the last `TAIL_BYTES` bytes. A
     `threading.Timer(RUN_SECONDS, …)` kills the group (`os.killpg(pid, SIGKILL)`; on Windows
     `taskkill /T /F /PID pid`) and marks the check timed out; cancel it when the pipe ends. Reason, first that
     applies: `timed out`, `exit N` (N not 0), `no passed count` (`passed_count` of the decoded tail is 0).
  6. `git rev-parse HEAD` equals `head` and `git status --porcelain` is empty, else void.
  7. A check failed or the source moved: the failure lines, then the void line if it moved, return 1. Otherwise
     build the receipts
     (`check, command, cwd, head, status, passed, platform` in that key order), pass them through
     `validate_receipts({head: names}, receipts)` (its `ValueError` is left to the `__main__` handler), and write
     `` "```harness-local-checks\n" + json.dumps(receipts, indent=2) + "\n```\n" `` to `out`.
  Git calls take `timeout=120`, as `ci-plan.py`'s do, and their own output is captured, never printed. One that
  fails or times out where no line above applies: the not-a-repository line before the checks, void after them.
- `main`: `--list` and `--run` in one mutually exclusive group. For `--run`: `sys.stdout.reconfigure(newline="\n")`
  (Review Focus 6), `git rev-parse --show-toplevel` in the current folder (the not-a-repository line and exit 1 when
  it fails), then `sys.exit(run(Path(top), args.base, sys.stdout, sys.stderr))`. The rest of `main` and the
  `__main__` handler stay.
- `missing()`: the text after the names becomes
  `. Run python3 scripts/local-checks.py --run on the tested commit and paste its output into the PR body.`
- Module docstring: validation never runs a command; `--run` runs only `CHECKS` commands, locally, and prints the
  fence; `--list` prints the required checks and their commands.

- [ ] **Step 5: Run the tests and see them pass**

Run: `python3 -m unittest test_local_checks -v`
Expected: OK, every test; the file's wall time on this Mac under 20 s (6 s today).

- [ ] **Step 6: Commit**

```bash
git add scripts/local-checks.py
git commit -m "Local checks: --run runs the checks a branch needs and prints their receipts"
```

---

### Task 2: Template and doc

**Depends on:** Task 1 (the same test file, and the command the words name). **Effort:** medium (copy only).

**Files:**
- Modify: `.github/pull_request_template.md` (the paragraph from "For paths requiring local checks" through "Do not
  include logs, personal paths or environment values.")
- Modify: `docs/validation-and-release.md` (the bullet "Checks PR CI does not run …")
- Test: `scripts/tests/test_local_checks.py`

**Interfaces:** consumes `checks.FENCE` and the command line `python3 scripts/local-checks.py --run` from Task 1.

- [ ] **Step 1: Write the failing test** (a new `class PullRequestTemplateTests(unittest.TestCase)`)

```python
# A body opened from the template and given --run's output must hold one fence: two are refused.
def test_the_template_names_run_and_carries_no_fence_of_its_own(self):
    template = (SCRIPTS.parent / ".github/pull_request_template.md").read_text()
    self.assertIn("`python3 scripts/local-checks.py --run`", template)
    self.assertNotIn("--list", template)
    self.assertEqual(checks.FENCE.findall(template), [])
```

- [ ] **Step 2: Run it and see it fail**

Run: `python3 -m unittest test_local_checks.PullRequestTemplateTests -v`
Expected: FAIL on the first assertion (the template does not name `--run`).

- [ ] **Step 3: Commit the red test**

```bash
git add scripts/tests/test_local_checks.py
git commit -m "Local checks: the template names --run (red)"
```

- [ ] **Step 4: Replace the copy**

In `.github/pull_request_template.md`, the paragraph, the example fence and the "Use a positive test count …"
paragraph become this one paragraph (the "Record the tested commit/tree …" paragraph after it stays):

```markdown
For paths requiring local checks, the CI plan lists the check names. After
testing the final commit, run `python3 scripts/local-checks.py --run` from a
clean tree and paste its output into this body **before pushing that commit or
marking the PR ready**. It runs each required check on that commit and prints
their receipts, or nothing when no local check is required. Body edits alone do
not start another CI run. These are attestations of successful complete checks,
not a way to waive failures. Native checks require `macos`.
```

In `docs/validation-and-release.md`, the bullet's last sentence, `Record them in the PR.`, becomes:

```markdown
Run them with `python3 scripts/local-checks.py --run` from a clean tree at the final commit: it runs the ones your
paths need and prints their receipts; paste its output into the PR body.
```

(re-wrapped into the bullet at the file's 120 columns).

- [ ] **Step 5: Run the tests and see them pass**

Run: `python3 -m unittest test_local_checks -v`
Expected: OK.

- [ ] **Step 6: Commit**

```bash
git add .github/pull_request_template.md docs/validation-and-release.md
git commit -m "Local checks: the template and the validation doc name --run"
```

---

### Task 3: Temporary Windows workflow

**Depends on:** Task 1 (the tests it runs). **Effort:** medium (one file).

**Temporary.** One commit, no red test. It is removed in ken15dev phase 4, after Verification check 6 passes and
before the pull request (`git rm .github/workflows/tmp-local-checks-run.yml`, one commit). The pull request does not
carry it.

Why: the spec lists Windows, and there `--run` has code of its own (`cmd.exe` as the shell, `taskkill` for the tree,
`\r\n` line ends), but PR CI runs `scripts/tests` on Linux only.

**Files:**
- Create: `.github/workflows/tmp-local-checks-run.yml`
- Test: none (a temporary workflow).

- [ ] **Step 1: Create the workflow** with exactly this content

The checkout is the one `ci.yml`'s `process-checks` job uses, so the tests meet the same tree as on PR CI (no
`cli/`), and so is the `maintenance.auto` setting.

```yaml
name: tmp local-checks-run

# TEMPORARY: lives only on this feature branch and is removed before the pull request.
# PR CI runs scripts/tests on Linux only; `local-checks.py --run` has Windows code of its own (the shell, the
# process tree kill, line ends), so its tests run here once on Windows.
on:
  push:
    branches: ['0xken15/local-checks-run']

concurrency:
  group: tmp-local-checks-run
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  windows:
    runs-on: windows-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
        with:
          sparse-checkout: |
            /.github/
            /scripts/
            /desktop/scripts/
            /cli/scripts/release-cli.sh
            /backend/scripts/release-be.sh
            /.gitattributes
            /.gitignore
            /.gitmodules
            /Makefile
          sparse-checkout-cone-mode: false
      - name: local-checks unit tests on Windows
        shell: bash
        working-directory: scripts/tests
        env:
          GIT_CONFIG_COUNT: "1"
          GIT_CONFIG_KEY_0: maintenance.auto
          GIT_CONFIG_VALUE_0: "false"
        run: python3 -m unittest -v test_local_checks
```

It holds no secret, no `workflow_dispatch`, no other trigger, and nothing that releases, publishes, deploys or writes
outside its run.

- [ ] **Step 2: Check the file**

Run: `actionlint .github/workflows/tmp-local-checks-run.yml`
Expected: no output, exit 0.

- [ ] **Step 3: Commit** (the one commit)

```bash
git add .github/workflows/tmp-local-checks-run.yml
git commit -m "TEMPORARY: the local-checks tests on Windows (removed before the pull request)"
```

If the run later stops before any test with `python3: command not found`, the runner has no such name: change that
one word to `python` in this file (the tests start their children with `sys.executable`). That is a workflow fault,
not a test result. A test that fails on Windows is a result: it goes back to the task that owns the test.

---

## Verification

Isolation: nothing here needs a daemon, a backend, an account, a port or a state folder, so the repository's guide
(`docs/development.md`, "Isolated end-to-end testing") has nothing to isolate. The unit tests use
throwaway git repositories in the system temp folder. The one real suite runs in a throwaway git worktree outside
the repository, on a commit that is on no branch and is never pushed. The Windows run is a GitHub-hosted runner with
a read-only token and no secret. Nothing touches production.

All six checks are for the pushed head that still carries the temporary workflow. The commit that removes it deletes
only that file, and PR CI's `process-checks` job runs the tests again on the final head.

| # | What to run | Where | What a person should see |
|---|---|---|---|
| 1 | `cd scripts/tests && python3 -m unittest test_local_checks -v` | this Mac (macOS); PR CI's `process-checks` job runs the same file on Linux in every run, nothing to start by hand | OK. The Mac run is the macOS proof of the group kill. |
| 2 | `python3 scripts/local-checks.py --run; echo "exit=$?"` at the pushed head, tree clean | this Mac, the feature worktree | stdout empty, stderr `No local check is required.`, `exit=0` (the branch touches only scripts, docs and `.github`). |
| 3 | The commands the real table gives, without running one (snippet below) | this Mac, the feature worktree | seven `npm run test:… -- --maxWorkers=N` lines, N half this Mac's logical CPUs; `cli-orchestrator`, `cli-pty`, `cli-serial` and `cli-shell` as `CHECKS` has them; `make desktop-test ARGS="--timeout 3600"`. |
| 4 | A real `cli-core` run on a scratch commit (snippet below) | this Mac, a throwaway worktree | Vitest's output streams on stderr; `exit=0`; `fence.md` is one fence with one receipt: `cli-core`, `npm run test:core -- --maxWorkers=N`, the scratch commit's 40-character head, `macos`, and the number of Vitest's `Tests  N passed` line. |
| 5 | That fence through the entry `ci.yml` calls (snippet below) | the same worktree | `Local check receipts verified: 1` |
| 6 | The temporary workflow `tmp local-checks-run` (Task 3). The push of the branch starts it; nothing is started by hand. Read its result for the pushed head (snippet below) | GitHub, `windows-latest` | one run whose head is the pushed head, conclusion `success`; its log ends with `OK` and holds `test_a_check_past_its_limit_is_killed_with_its_children_and_named … ok`, the Windows proof of the tree kill. Report the run link. |

Check 4 is worth its one real suite (`npm ci` and `npm run test:core`, minutes, half the CPUs, once, on the pushed
head): only it shows that npm hands the cap to Vitest, that Vitest's real summary is read through a pipe with the
coverage table after it, that the suite leaves the tree clean, and that CI's own entry takes the result. The fake
checks cannot show any of the four.

```bash
# 3
python3 - <<'PY'
import importlib.util, pathlib
spec = importlib.util.spec_from_file_location("local_checks", "scripts/local-checks.py")
checks = importlib.util.module_from_spec(spec); spec.loader.exec_module(checks)
for name in checks.CHECKS: print(name, "→", checks.run_command(pathlib.Path("."), name))
PY

# 4: a comment in a spec file is a cli-core path that changes no source and no coverage
S="$(mktemp -d)" && git worktree add --detach "$S/tree" HEAD && cd "$S/tree"
(cd cli && npm ci)
printf '\n// local-checks --run verification: never pushed\n' >> cli/src/core/api.spec.ts
git commit -qam "scratch: local-checks --run verification"
python3 scripts/local-checks.py --run > "$S/fence.md"; echo "exit=$?"

# 5
python3 - "$S" <<'PY'
import json, pathlib, subprocess, sys
s = pathlib.Path(sys.argv[1])
head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
body = "Summary\n\n" + (s / "fence.md").read_text()
(s / "event.json").write_text(json.dumps({"pull_request": {"head": {"sha": head}, "body": body}}))
(s / "plan.json").write_text(json.dumps({"event": "pull_request", "head": head, "draft": False,
                                         "paths": ["cli/src/core/api.spec.ts"], "local_checks": ["cli-core"]}))
PY
CI_PLAN="$(cat "$S/plan.json")" CI_SOURCE_SHA="$(git rev-parse HEAD)" GITHUB_EVENT_NAME=pull_request \
  GITHUB_EVENT_PATH="$S/event.json" GITHUB_OUTPUT="$S/output" python3 scripts/local-checks.py
# then, from the feature worktree: git worktree remove --force "$S/tree"

# 6: from the feature worktree, after the push; HEAD is the pushed head
gh run list --workflow tmp-local-checks-run.yml --branch 0xken15/local-checks-run --commit "$(git rev-parse HEAD)" \
  --json databaseId,headSha,status,conclusion,url
gh run watch RUN_ID --exit-status          # RUN_ID is the databaseId above; waits, exit 0 on success
gh run view RUN_ID --log | grep -E "is_killed_with_its_children|Ran [0-9]+ tests|FAILED|OK"
```

Checks the repository requires and PR CI does not run: none.
`python3 scripts/local-checks.py --list` on the four files, the temporary workflow and the two `docs/plans` files
prints `{}` (checked 2026-11-13), so this pull request carries no fence. PR CI runs every component by itself,
because `scripts/` and `.github/` are shared inputs. No workflow is started by hand; the one temporary workflow
(check 6) starts on the push and is gone before the pull request.

Not checked end to end, and why: a real `make desktop-test` (a long macOS suite; its count rests on the fixture test
against the receipt `scripts/test-desktop.py` writes, and the first Desktop pull request is its proof); the
macOS-only `cli-serial`, `cli-shell` and `cli-pty` (their commands run unchanged and print the same Vitest summary);
a real suite through `--run` on Windows (check 6 runs every `--run` test there with fake checks, which covers the
code that differs on Windows; npm and Vitest are the same programs as in check 4). The pull request names the
platforms (macOS and Linux tested; Windows by check 6, with its run link), each task's red then green commits, and
the output of checks 2, 4 and 5.

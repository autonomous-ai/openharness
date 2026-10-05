#!/usr/bin/env python3
"""Run an explicit validation plan concurrently, with deadlines and a source receipt.

No package installs, baseline retries, publishing, or test selection is implicit.
Plans contain argv arrays, not shell strings. See docs/validation-and-release.md.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def source_state(root):
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=root)

    # Include uncommitted source, including new files; generated output is ignored
    # by git. A SHA alone would falsely identify a dirty checkout as tested HEAD.
    digest = hashlib.sha256(git("diff", "HEAD", "--binary", "--no-ext-diff"))
    untracked = git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0")
    for name in sorted(filter(None, untracked)):
        digest.update(name + b"\0")
        path = root / os.fsdecode(name)
        if path.is_symlink():
            digest.update(os.fsencode(os.readlink(path)))
        else:
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
    return {
        "commit": git("rev-parse", "HEAD").decode().strip(),
        "tree": git("rev-parse", "HEAD^{tree}").decode().strip(),
        "working_changes_sha256": digest.hexdigest(),
        "dirty": bool(git("status", "--porcelain", "--untracked-files=normal")),
    }


def read_plan(path, root):
    plan = json.loads(path.read_text())
    checks = plan.get("checks")
    if not isinstance(checks, list) or not checks:
        raise ValueError("plan must contain a nonempty checks list")
    if not isinstance(plan.get("reason"), str) or not plan["reason"].strip():
        raise ValueError("plan must explain its scope in reason")
    minimum = plan.get("minimum_free_gib", 2)
    if isinstance(minimum, bool) or not isinstance(minimum, (int, float)) or not math.isfinite(minimum) or minimum < 0:
        raise ValueError("minimum_free_gib must be a finite nonnegative number")
    names = set()
    for check in checks:
        name = check.get("name", "")
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", name) or name in names:
            raise ValueError("check names must be unique letters, digits, underscores, or hyphens")
        names.add(name)
        argv = check.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) and a for a in argv):
            raise ValueError(f"{name}: argv must be a nonempty string array")
        timeout = check.get("timeout_seconds")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError(f"{name}: supply a positive timeout_seconds")
        cwd = (root / check.get("cwd", ".")).resolve()
        if not cwd.is_dir() or not cwd.is_relative_to(root):
            raise ValueError(f"{name}: cwd must be a directory in this checkout")
        if "reuse" in check:
            reuse = check["reuse"]
            if not isinstance(reuse, dict):
                raise ValueError(f"{name}: reuse must declare inputs and toolchain")
            inputs = reuse.get("inputs")
            if not isinstance(inputs, list) or not inputs:
                raise ValueError(f"{name}: reuse.inputs must name source/dependency paths")
            for item in inputs:
                if not isinstance(item, str) or not item or Path(item).is_absolute() or ".." in Path(item).parts or any(c in item for c in "*?["):
                    raise ValueError(f"{name}: reuse inputs must be literal checkout-relative files or directories")
            commands = reuse.get("toolchain")
            if not isinstance(commands, list) or not commands or any(
                not isinstance(command, list) or not command or not all(isinstance(arg, str) and arg for arg in command)
                for command in commands
            ):
                raise ValueError(f"{name}: reuse.toolchain must contain version-command argv arrays")
    return plan


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tool_fingerprint(command, cwd):
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               stdin=subprocess.DEVNULL, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=30)
    finally:
        cleanup_error = stop_group(process)
    if cleanup_error:
        raise ValueError(f"toolchain process cleanup failed: {cleanup_error}")
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, command)
    return hashlib.sha256(stdout + b"\0" + stderr).hexdigest()


def reuse_keys(plan, root):
    """Opt-in evidence identity, independent of commit IDs and unrelated files.

    Scope selection remains explicit. Version commands must describe every tool
    used by a check; inputs must include its sources, fixtures, config and locks.
    Environment values and tool output are hashed, never written to receipts.
    """
    reusable = [check for check in plan["checks"] if "reuse" in check]
    if not reusable:
        return {}
    names = set(filter(None, subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root,
    ).decode().split("\0")))
    runtime = {
        "root": str(root), "platform": platform.platform(), "machine": platform.machine(),
        "python": sys.version, "runner": file_sha256(Path(__file__)),
        # Shell bookkeeping may change between invocations without changing a
        # check. All other inherited values participate, including PATH/SDK flags.
        "environment": {key: value for key, value in os.environ.items() if key not in {"_", "SHLVL", "PWD", "OLDPWD"}},
    }
    files, versions, keys = {}, {}, {}
    for check in reusable:
        selected = set()
        for item in check["reuse"]["inputs"]:
            path = Path(item).as_posix().rstrip("/")
            matches = {name for name in names if path == "." or name == path or name.startswith(path + "/")}
            if not matches:
                raise ValueError(f"{check['name']}: reuse input matches no source files: {item}")
            selected.update(matches)
        for name in selected:
            if name in files:
                continue
            path = root / name
            if path.is_symlink() or not path.resolve().is_relative_to(root):
                raise ValueError(f"{check['name']}: reuse input must not traverse a symlink: {name}")
            files[name] = (file_sha256(path), path.stat().st_mode & 0o777) if path.exists() else None
        cwd = root / check.get("cwd", ".")
        tool_ids = []
        for command in check["reuse"]["toolchain"]:
            identity = (str(cwd), tuple(command))
            if identity not in versions:
                versions[identity] = tool_fingerprint(command, cwd)
            tool_ids.append(versions[identity])
        command = check["argv"][0]
        search_path = os.pathsep.join(str(cwd / entry) for entry in os.get_exec_path())
        executable = str(cwd / command) if "/" in command else shutil.which(command, path=search_path)
        if executable is None:
            raise ValueError(f"{check['name']}: executable unavailable: {check['argv'][0]}")
        executable_path = Path(executable)
        if not executable_path.is_absolute():
            executable_path = cwd / executable_path
        identity = dict(runtime, check=check, files={name: files[name] for name in sorted(selected)},
                        toolchain=tool_ids, executable=str(executable_path.resolve()), executable_sha256=file_sha256(executable_path))
        keys[check["name"]] = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    return keys


def reusable_checks(path, keys):
    if path is None:
        return {}
    receipt = json.loads(path.read_text())
    # A partial run can contribute successful checks, but a changing source or
    # incomplete receipt cannot. Never treat failed/blocked/timed-out checks as hits.
    if receipt.get("schema") != 2 or receipt.get("status") not in {"passed", "failed"} or receipt.get("source") != receipt.get("source_after"):
        return {}
    reused = {}
    for check in receipt.get("checks", []):
        name = check.get("name")
        if name not in keys or check.get("reuse_key") != keys[name] or check.get("status") not in {"passed", "reused"}:
            continue
        log = Path(check["log"])
        if not log.is_file() or file_sha256(log) != check.get("log_sha256"):
            continue
        reused[name] = dict(check, status="reused", duration_seconds=0,
                            reused_from=str(path.resolve()), reused_at=utc_now(),
                            original_duration_seconds=check.get("original_duration_seconds", check["duration_seconds"]))
    return reused


def stop_group(process):
    """Only our new session's process group, never global pkill/tmux cleanup."""
    if process.poll() is not None:
        # A reaped Flutter parent often has no remaining children. macOS can
        # reject killpg even for that vanished group. Inspect before signaling;
        # do still terminate children left by an exited parent.
        try:
            groups = subprocess.check_output(["ps", "-A", "-o", "pgid="], text=True, timeout=5)
            if str(process.pid) not in groups.split():
                return None
        except (OSError, subprocess.SubprocessError) as error:
            return f"cannot inspect owned process group: {error}"
    errors = []
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except OSError as error:
        errors.append(str(error))
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        pass
    # The parent may exit on TERM while its fixture children ignore it.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError as error:
        errors.append(str(error))
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired as error:
        errors.append(str(error))
    return "; ".join(errors) or None


def run_checks(plan, root, output, jobs, keys=None, reused=None):
    keys, reused = keys or {}, reused or {}
    pending = list(plan["checks"])
    active = []
    results = []
    try:
        while pending or active:
            while pending and len(active) < jobs:
                check = pending.pop(0)
                if check["name"] in reused:
                    results.append(reused[check["name"]])
                    print(f"{check['name']}: reused ({reused[check['name']]['log']})", flush=True)
                    continue
                result = dict(check, started_at=utc_now(), status="running")
                if check["name"] in keys:
                    result["reuse_key"] = keys[check["name"]]
                log_path = output / (check["name"] + ".log")
                result["log"] = str(log_path)
                log = log_path.open("wb")
                started = time.monotonic()
                try:
                    process = subprocess.Popen(
                        check["argv"], cwd=root / check.get("cwd", "."),
                        stdout=log, stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL, start_new_session=True,
                    )
                except OSError as error:
                    log.close()
                    result.update(status="blocked", error=str(error), duration_seconds=0, finished_at=utc_now())
                    results.append(result)
                    print(f"{check['name']}: blocked ({error})", flush=True)
                    continue
                active.append((process, log, result, started))
                print(f"{check['name']}: started (limit {check['timeout_seconds']}s)", flush=True)
            for item in active[:]:
                process, log, result, started = item
                elapsed = time.monotonic() - started
                code = process.poll()
                if code is None and elapsed < result["timeout_seconds"]:
                    continue
                result["status"] = "timeout" if code is None else ("passed" if code == 0 else "failed")
                cleanup_error = stop_group(process)
                log.close()
                if cleanup_error:
                    result["cleanup_error"] = cleanup_error
                    if result["status"] == "passed":
                        result["status"] = "cleanup_failed"
                result.update(exit_code=process.returncode, duration_seconds=round(elapsed, 3), finished_at=utc_now())
                result["log_sha256"] = file_sha256(Path(result["log"]))
                active.remove(item)
                results.append(result)
                print(f"{result['name']}: {result['status']} ({elapsed:.1f}s), {result['log']}", flush=True)
            if active:
                time.sleep(0.05)
    except KeyboardInterrupt:
        for process, log, result, started in active:
            stop_group(process)
            log.close()
            result.update(status="cancelled", duration_seconds=round(time.monotonic() - started, 3), finished_at=utc_now())
            results.append(result)
        results.extend(dict(check, status="not_run") for check in pending)
    finally:
        # Also clean up owned children if writing a log/receipt or polling fails.
        for process, log, _, _ in active:
            if not log.closed:
                stop_group(process)
                log.close()
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--jobs", type=int, default=2, help="independent checks at once (default: 2)")
    parser.add_argument("--reuse", type=Path, help="reuse passing checks with identical explicit inputs, toolchain and environment")
    args = parser.parse_args(argv)
    if os.name != "posix":
        parser.error("process-group cleanup currently requires macOS or Linux")
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()).resolve()
    plan = read_plan(args.plan, root)
    output = root / ".harness" / "validation" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ") + f"-{os.getpid()}")
    output.mkdir(parents=True)
    receipt = dict(schema=2, started_at=utc_now(), reason=plan["reason"], source=source_state(root), checks=[])
    started = time.monotonic()
    free = shutil.disk_usage(root).free / 1024 ** 3
    receipt["free_gib_before"] = round(free, 3)
    if free < plan.get("minimum_free_gib", 2):
        receipt.update(status="blocked", error=f"Only {free:.2f} GiB free; plan requires {plan.get('minimum_free_gib', 2)} GiB")
        receipt["checks"] = [dict(check, status="not_run") for check in plan["checks"]]
        print(receipt["error"], file=sys.stderr)
    else:
        try:
            keys = reuse_keys(plan, root)
            reused = reusable_checks(args.reuse, keys)
            receipt["checks"] = run_checks(plan, root, output, args.jobs, keys, reused)
            keys_after = reuse_keys(plan, root)
            receipt["source_after"] = source_state(root)
            if receipt["source"] != receipt["source_after"] or keys != keys_after:
                receipt.update(status="source_changed", error="Source or toolchain changed during validation; results do not identify one tested environment")
            else:
                receipt["status"] = "passed" if all(c["status"] in {"passed", "reused"} for c in receipt["checks"]) else "failed"
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            receipt.update(status="blocked", error=str(error))
            if not receipt["checks"]:
                receipt["checks"] = [dict(check, status="not_run") for check in plan["checks"]]
    receipt.update(finished_at=utc_now(), duration_seconds=round(time.monotonic() - started, 3))
    path = output / "receipt.json"
    path.write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"{receipt['status']}: {path}")
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"validation error: {error}", file=sys.stderr)
        sys.exit(2)

#!/usr/bin/env python3
"""RELEASE_WINDOW: refuse a release outside the release window or too soon after the last one.

The numbers are in release-window.json beside this file, in the shape of the project rules record's releaseWindow and
releasePace (window start/end/zone, backend pace in minutes, and the backend's pause inside the window: no backend
release 09:00-10:00 VN, Ken 2026-11-05).

  release-window.py --kind backend                      # the release scripts, before they tag
  release-window.py --kind backend --urgent "P0: ..."   # a P0 at night; prints the line to post in the chat
  release-window.py --kind backend --from-tag TAG --exclude-tag TAG   # a tag-triggered workflow

Exit 0: allowed. Exit 2: refused, with the next allowed time on stderr. An urgent release is recorded on its
tag as a `Release-Urgent: <reason>` line, which --from-tag reads, so the workflow honors the same override and
a tag pushed by hand without one is refused.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from collections import namedtuple
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

CONFIG_PATH = Path(__file__).resolve().parent / "release-window.json"
URGENT_LINE = re.compile(r"^Release-Urgent: (.+)$", re.MULTILINE)

Verdict = namedtuple("Verdict", "allowed next_allowed message urgent_reason chat_line")


def _clock(text):
    hour, minute = text.split(":")
    return time(int(hour), int(minute))


def _stamp(moment, zone):
    return moment.astimezone(zone).strftime("%Y-%m-%d %H:%M")


def _next_opening(moment, start, end):
    """The first instant at or after `moment` (local, aware) that is inside [start, end)."""
    day = moment.date()
    if moment.time() < start:
        return datetime.combine(day, start, tzinfo=moment.tzinfo)
    if moment.time() >= end:
        return datetime.combine(day + timedelta(days=1), start, tzinfo=moment.tzinfo)
    return moment


def check(kind, now, last, config, urgent=None):
    """Decide whether `kind` may be released at `now`, given the time of the last release of that kind."""
    if now.tzinfo is None:
        raise ValueError("now must carry a time zone")
    if kind not in config["kinds"]:
        raise ValueError(f"unknown release kind {kind!r}; expected one of {', '.join(config['kinds'])}")
    window, pace = config["releaseWindow"], config.get("releasePace", {})
    zone = ZoneInfo(window["timeZone"])
    start, end = _clock(window["start"]), _clock(window["end"])
    local_now = now.astimezone(zone)
    shown = f"{window['start']}-{window['end']}"

    pause = pace.get("backendPause") if kind == "backend" else None
    pause_start, pause_end = (_clock(pause["start"]), _clock(pause["end"])) if pause else (None, None)
    minutes = pace.get("backendEveryMinutes") if kind == "backend" else None

    def in_pause(moment):
        return pause is not None and pause_start <= moment.time() < pause_end

    earliest = local_now
    reasons = []
    if minutes and last is not None:
        paced = last.astimezone(zone) + timedelta(minutes=minutes)
        if paced > earliest:
            earliest = paced
            reasons.append(f"the last {kind} release was at {_stamp(last, zone)} and {kind} releases keep {minutes} minutes apart")
    if not (start <= local_now.time() < end):
        reasons.insert(0, f"it is outside {shown}")
    elif in_pause(local_now):
        reasons.insert(0, f"backend releases pause {pause['start']}-{pause['end']}")
    # Settle on the first instant that is in the window and out of the pause (moving one can land in the other).
    allowed_at = earliest
    while True:
        moved = _next_opening(allowed_at, start, end)
        if in_pause(moved):
            moved = datetime.combine(moved.date(), pause_end, tzinfo=moved.tzinfo)
        if moved == allowed_at:
            break
        allowed_at = moved
    if reasons == [] and allowed_at > local_now:
        reasons.append(f"the pace ends outside {shown}")
    allowed = allowed_at == local_now

    if urgent is not None:
        reason = " ".join(urgent.split())
        if not reason:
            return Verdict(False, allowed_at, f'RELEASE_WINDOW: --urgent needs a reason: --urgent "<reason>" (a P0 only).',
                           None, None)
        line = f"Urgent {kind} release at {_stamp(now, zone)} VN: {reason}"
        return Verdict(True, local_now, f"urgent: {reason}", reason, line)

    if allowed:
        return Verdict(True, local_now, "ok", None, None)
    message = (
        f"RELEASE_WINDOW: a {kind} release is refused at {_stamp(now, zone)} {window['timeZone']}: "
        f"{'; '.join(reasons)}. Next allowed: {_stamp(allowed_at, zone)} {window['timeZone']}. "
        f'A P0 releases now with --urgent "<reason>".'
    )
    return Verdict(False, allowed_at, message, None, None)


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout


def last_release_time(repo, kind, exclude_tag=None):
    """When the newest `vX.Y.Z_<kind>` tag was made, or None when there is none."""
    pattern = re.compile(rf"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)_{kind}$")
    out = _git(repo, "for-each-ref", "--format=%(refname:short) %(creatordate:unix)", f"refs/tags/v*_{kind}")
    newest = None
    for row in out.splitlines():
        name, _, stamp = row.partition(" ")
        if name == exclude_tag or not pattern.match(name) or not stamp:
            continue
        moment = datetime.fromtimestamp(int(stamp), tz=timezone.utc)
        if newest is None or moment > newest:
            newest = moment
    return newest


def urgent_reason_of_tag(repo, tag):
    body = _git(repo, "tag", "-l", "--format=%(contents)", tag)
    found = URGENT_LINE.search(body)
    return found.group(1).strip() if found else None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--kind", required=True)
    parser.add_argument("--now", help="ISO time with a zone (tests); default: the clock")
    parser.add_argument("--urgent", help="a P0's reason for releasing outside the window or pace")
    parser.add_argument("--repo", default=".")
    parser.add_argument("--exclude-tag", help="a tag that is the release being built, not the last one")
    parser.add_argument("--from-tag", help="read a Release-Urgent line from this tag's message")
    parser.add_argument("--advisory", action="store_true", help="report a refusal but exit 0 (dry runs)")
    parser.add_argument("--config", default=str(CONFIG_PATH))
    args = parser.parse_args(argv)

    config = json.loads(Path(args.config).read_text())
    now = datetime.fromisoformat(args.now) if args.now else datetime.now(timezone.utc)
    urgent = args.urgent
    if urgent is None and args.from_tag:
        urgent = urgent_reason_of_tag(args.repo, args.from_tag)
    last = None
    if args.kind == "backend" and config.get("releasePace", {}).get("backendEveryMinutes"):
        last = last_release_time(args.repo, args.kind, args.exclude_tag)

    try:
        verdict = check(args.kind, now, last, config, urgent)
    except ValueError as error:
        print(f"RELEASE_WINDOW: {error}", file=sys.stderr)
        return 2
    if verdict.chat_line:
        print(verdict.chat_line)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as handle:
                handle.write(verdict.chat_line + "\n")
    if not verdict.allowed:
        print(verdict.message, file=sys.stderr)
        return 0 if args.advisory else 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

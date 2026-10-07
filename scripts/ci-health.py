#!/usr/bin/env python3
"""Publish bounded, read-only CI workload and freshness measurements."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import time


def api(path):
    repository = os.environ["GITHUB_REPOSITORY"]
    # These are read-only GETs. A transient API failure must not discard the
    # entire workload report; retry within the workflow's bounded deadline.
    for attempt in range(3):
        try:
            result = subprocess.run(["gh", "api", f"repos/{repository}/{path}"], check=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, text=True)
            return json.loads(result.stdout)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def main():
    now = datetime.now(timezone.utc)
    runs = api("actions/runs?per_page=100")["workflow_runs"]
    measured = [r for r in runs if r["path"] in {".github/workflows/ci.yml", ".github/workflows/cli-e2e.yml"}]
    cancelled = [r for r in measured if r["conclusion"] == "cancelled"]

    def cancelled_work(run):
        data = api(f"actions/runs/{run['id']}/jobs?per_page=100")
        if data["total_count"] > len(data["jobs"]):
            raise ValueError("job inventory exceeds health-report bound; extend pagination")
        minutes = sum(max(0, (stamp(j["completed_at"]) - stamp(j["started_at"])).total_seconds()) / 60
                      for j in data["jobs"] if j.get("started_at") and j.get("completed_at") and j["conclusion"] != "skipped")
        return dict(run_id=run["id"], event=run["event"], branch=run["head_branch"], observed_job_minutes=round(minutes, 2))

    with ThreadPoolExecutor(max_workers=4) as pool:
        work = list(pool.map(cancelled_work, cancelled))
    # Search main successes independently: heavy traffic can push the last
    # passing broad validation out of the 100-run overall sample.
    passed = api("actions/workflows/cli-e2e.yml/runs?branch=main&status=success&per_page=100")["workflow_runs"]
    passed = [r for r in passed if r["event"] in {"push", "schedule", "workflow_dispatch"}]
    last = max(passed, key=lambda r: r["updated_at"], default=None)
    report = dict(schema=1, measured_at=now.isoformat(), sample_runs=len(runs), validation_runs=len(measured),
                  sample_oldest=min((r["created_at"] for r in runs), default=None),
                  outcomes=dict(Counter(r["conclusion"] or r["status"] for r in measured)),
                  events=dict(Counter(r["event"] for r in measured)), cancelled_runs=work,
                  cancelled_run_job_minutes=round(sum(r["observed_job_minutes"] for r in work), 2),
                  last_completed_main_e2e=dict(url=last["html_url"], sha=last["head_sha"],
                      completed_at=last["updated_at"], age_minutes=round((now-stamp(last["updated_at"])).total_seconds()/60, 1)) if last else None,
                  note="Bounded latest-100-run sample. Job timestamps are execution observations, not billed minutes. A completed old snapshot does not cover newer main inputs.")
    Path(os.environ["RUNNER_TEMP"], "ci-health.json").write_text(json.dumps(report, indent=2) + "\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write(f"CI sample: {len(measured)} validation runs since {report['sample_oldest']}.\n\n")
        summary.write(f"Outcomes: `{report['outcomes']}`.\n\n")
        summary.write(f"Execution in cancelled runs: **{report['cancelled_run_job_minutes']:g} combined job-minutes**.\n\n")
        if last:
            summary.write(f"Last completed [main E2E]({last['html_url']}): **{report['last_completed_main_e2e']['age_minutes']:g} minutes ago**, source `{last['head_sha']}`.\n\n")
        else:
            summary.write("No completed passing main E2E found.\n\n")
        summary.write(report["note"] + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

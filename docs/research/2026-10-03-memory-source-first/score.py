"""Recompute a diagnostic comparison without inference or production imports."""
import hashlib
import json
import statistics
import sys
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def js_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def summarize(values):
    return {"count": len(values), "median": statistics.median(values) if values else None,
            "max": max(values) if values else None}


def score(report_path):
    here = Path(__file__).resolve().parent
    plan_bytes = (here / "plan.json").read_bytes()
    plan = json.loads(plan_bytes)
    suite_bytes = (here / plan["corpus"]).read_bytes()
    suite = json.loads(suite_bytes)
    report_bytes = Path(report_path).read_bytes()
    report = json.loads(report_bytes)
    assert digest(suite_bytes) == plan["corpusSha256"] == report["suiteSha256"]
    assert digest(plan_bytes) == report["planSha256"]
    for file, field in [("run.mjs", "runnerSha256"), ("source-prompt.txt", "sourcePromptSha256"),
                        ("review-prompt.txt", "reviewPromptSha256")]:
        assert digest((here / file).read_bytes()) == report[field], field
    assert report["limits"] == plan
    assert report["networkGuard"]["nonLoopbackConnectError"] == 1
    assert report["model"]["weightSha256"] == plan["weightSha256"]
    inputs = {}
    for case in suite["cases"]:
        source_input = {key: case["input"][key] for key in ("authorizedScope", "episodes")}
        inputs[digest(js_json(source_input))] = source_input
    frames = {row["key"]: row for row in report["sourceInterpretations"]}
    assert len(frames) == len(report["sourceInterpretations"])
    assert set(frames) <= set(inputs)
    rows = {row["id"]: row for row in report["cases"]}
    assert len(rows) == len(report["cases"])
    assert set(rows) <= {case["id"] for case in suite["cases"]}

    def check_quotes(items, source_input):
        sources = {source["id"]: source["text"]
                   for episode in source_input["episodes"] for source in episode["sources"]}
        for item in items:
            assert item["quote"] and item["quote"] in sources[item["sourceId"]]

    for key, frame in frames.items():
        expected_prompt = (here / "source-prompt.txt").read_text().encode() + js_json(inputs[key])
        assert digest(expected_prompt) == frame["promptSha256"]
        if "interpretation" in frame:
            assert frame["answer"]["finishReason"] == "stop"
            assert json.loads(frame["answer"]["text"]) == frame["interpretation"]
            check_quotes(frame["interpretation"]["statements"] + frame["interpretation"]["qualifications"], inputs[key])
    confusion, mismatches, timings = {}, [], []
    valid = 0
    for case in suite["cases"]:
        row = rows.get(case["id"])
        actual = "missing_review" if row is None else "invalid"
        if row is not None:
            source_input = {key: case["input"][key] for key in ("authorizedScope", "episodes")}
            source_key = digest(js_json(source_input))
            assert row["sourceKey"] == source_key
            if "review" in row:
                frame = frames[source_key]
                assert "interpretation" in frame
                assert row["answer"]["finishReason"] == "stop"
                checks = json.loads(row["answer"]["text"])["checks"]
                assert checks == row["review"]["checks"]
                required = ["/" + field for field in ("kind", "assertionType", "scope", "claim", "rationale",
                            "futureAction", "applicability", "exceptions", "evidenceClass", "validity")
                            if field in case["input"]["candidate"]]
                assert row["requiredPaths"] == required
                assert set(check["path"] for check in checks) == set(row["requiredPaths"])
                for check in checks:
                    assert check["verdict"] in ("supported", "unsupported", "unclear")
                    assert (check["issue"] is None) == (check["verdict"] == "supported")
                    check_quotes(check["evidence"], source_input)
                prompt_input = {**case["input"], "sourceInterpretation": frame["interpretation"],
                                "requiredPaths": row["requiredPaths"]}
                expected_prompt = (here / "review-prompt.txt").read_text().encode() + js_json(prompt_input)
                assert digest(expected_prompt) == row["promptSha256"]
                verdicts = {check["verdict"] for check in checks}
                actual = "unsupported" if "unsupported" in verdicts else "unclear" if "unclear" in verdicts else "supported"
                assert actual == row["review"]["verdict"]
                valid += 1
                timings.append(frame["durationMs"] + row["durationMs"])
        expected = case["expected"]["verdict"]
        key = f"{expected}->{actual}"
        confusion[key] = confusion.get(key, 0) + 1
        if actual != expected:
            mismatches.append({"id": case["id"], "expected": expected, "actual": actual,
                               "note": case["expected"]["note"]})
    calls_with_answers = list(frames.values()) + [row for row in rows.values() if "answer" in row]
    assert len(calls_with_answers) <= report["inferenceCalls"] <= plan["maxCalls"]
    complete = (report["status"] == "completed" and valid == plan["expectedCases"]
                and report.get("workerExit", {}).get("code") == 0)
    usage = {key: sum(row["answer"]["usage"][key] for row in calls_with_answers)
             for key in ("prompt_tokens", "completion_tokens", "total_tokens")}
    return {"schemaVersion": 1, "suiteSha256": digest(suite_bytes), "reportSha256": digest(report_bytes),
            "planSha256": digest(plan_bytes), "evidence": "known_synthetic_development_diagnostic",
            "labelAuthor": {"kind": "implementing_agent", "independent": False},
            "complete": complete, "expectedCases": plan["expectedCases"], "validReviews": valid,
            "confusion": confusion, "mismatches": mismatches,
            "inferenceCalls": report["inferenceCalls"], "answeredCalls": len(calls_with_answers),
            "callsWithoutSavedAnswer": report["inferenceCalls"] - len(calls_with_answers),
            "usageForAnsweredCalls": usage,
            "sourceDurationMs": summarize([row["durationMs"] for row in frames.values()]),
            "reviewDurationMs": summarize([row["durationMs"] for row in rows.values() if "durationMs" in row]),
            "unamortizedSourcePlusReviewMs": summarize(timings),
            "decision": "eligible_for_further_diagnostic_only" if complete and not mismatches else "reject_candidate",
            "productionChange": False}


if __name__ == "__main__":
    assert len(sys.argv) == 3, "score.py REPORT NEW_OUTPUT"
    result = score(sys.argv[1])
    with Path(sys.argv[2]).open("x") as output:
        json.dump(result, output, indent=2)
        output.write("\n")
    print(json.dumps({key: result[key] for key in ("complete", "validReviews", "confusion", "decision")}))

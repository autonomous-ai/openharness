"""Recompute the frozen NLI admission diagnostic without loading a model."""
import hashlib
import importlib.util
import json
import math
import statistics
import sys
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def score(report_path):
    base = Path(__file__).resolve().parent
    report_bytes = Path(report_path).read_bytes()
    report = json.loads(report_bytes)
    plan = json.loads((base / "plan.json").read_bytes())
    assert report["plan"] == plan
    for name in ["plan.json", "model-files.json", "requirements.txt", "run.py", "score.py"]:
        assert report["inputHashes"][name] == sha((base / name).read_bytes()), name
    assert report["model"] == json.loads((base / "model-files.json").read_bytes())
    assert report["networkGuard"]["nonLoopbackConnectError"] == 1
    suite_bytes = (base / plan["suite"]).read_bytes()
    assert sha(suite_bytes) == report["suiteSha256"] == plan["suiteSha256"]
    suite = json.loads(suite_bytes)
    fixtures = {case["id"]: case for case in suite["cases"]}
    assert len(fixtures) == plan["expectedCases"]
    spec = importlib.util.spec_from_file_location("nli_diagnostic", base / "run.py")
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)

    def validate_pair(pair):
        probabilities = pair["probabilities"]
        assert set(probabilities) == {"entailment", "neutral", "contradiction"}
        assert all(isinstance(p, (int, float)) and math.isfinite(p) and 0 <= p <= 1 for p in probabilities.values())
        assert abs(sum(probabilities.values()) - 1) < 1e-8
        assert pair["label"] == max(probabilities, key=probabilities.get)
        assert 0 < pair["pairTokens"] <= plan["maxPairTokens"]
        assert math.isfinite(pair["elapsedMs"]) and pair["elapsedMs"] >= 0

    assert len(report["sanity"]) == 3
    for pair in report["sanity"]:
        validate_pair(pair)
        assert pair["label"] == pair["expected"]
    rows, durations = {}, []
    completed_pairs = len(report["sanity"])
    for row in report["cases"]:
        key = (row["arm"], row["id"])
        assert key not in rows and row["arm"] in plan["arms"] and row["id"] in fixtures
        rows[key] = row
        fixture = fixtures[row["id"]]
        expected_fields = runner.hypotheses(fixture, plan["fields"])
        assert len(row["fields"]) <= len(expected_fields)
        for field, expected in zip(row["fields"], expected_fields):
            assert field["path"] == expected["path"] and field["hypothesis"] == expected["text"]
            assert field["premise"] == runner.premises(fixture)[row["arm"]]
            validate_pair(field)
            completed_pairs += 1
        if row["status"] == "completed":
            assert len(row["fields"]) == len(expected_fields) and expected_fields
            assert row["accepted"] == all(field["label"] == "entailment" for field in row["fields"])
            durations.append(sum(field["elapsedMs"] for field in row["fields"]))
    assert completed_pairs == report["completedPairs"] <= report["attemptedPairs"]
    summary = {}
    for arm in plan["arms"]:
        counts = {"supported_accepted": 0, "supported_withheld": 0,
                  "unsupported_accepted": 0, "unsupported_withheld": 0, "missing_or_incomplete": 0}
        mismatches = []
        for case in suite["cases"]:
            row = rows.get((arm, case["id"]))
            if row is None or row["status"] != "completed":
                counts["missing_or_incomplete"] += 1
                continue
            expected = case["expected"]["verdict"] == "supported"
            counts[("supported" if expected else "unsupported") + ("_accepted" if row["accepted"] else "_withheld")] += 1
            if expected != row["accepted"]:
                mismatches.append({"id": case["id"], "expectedAccepted": expected, "accepted": row["accepted"],
                                   "fields": [{key: field[key] for key in ["path", "label", "probabilities"]}
                                              for field in row["fields"]]})
        complete = report["status"] == "completed" and counts["missing_or_incomplete"] == 0
        summary[arm] = {"complete": complete, "counts": counts, "mismatches": mismatches,
                        "meetsDiagnosticRule": complete and not mismatches}
    return {"schemaVersion": 1, "suiteSha256": report["suiteSha256"], "reportSha256": sha(report_bytes),
            "evidence": "known_synthetic_textual_support_diagnostic", "independentHumanReview": False,
            "primaryArm": plan["primaryArm"], "arms": summary,
            "attemptedPairs": report["attemptedPairs"], "completedPairs": report["completedPairs"],
            "completedProposalDurationMs": {"count": len(durations),
                "median": statistics.median(durations) if durations else None, "max": max(durations) if durations else None},
            "decision": "further_diagnostic_only" if summary[plan["primaryArm"]]["meetsDiagnosticRule"] else "reject_candidate",
            "productionChange": False}


if __name__ == "__main__":
    assert len(sys.argv) == 3, "score.py REPORT NEW_OUTPUT"
    result = score(sys.argv[1])
    with Path(sys.argv[2]).open("x") as output:
        json.dump(result, output, indent=2)
        output.write("\n")
    print(json.dumps({"decision": result["decision"], "arms": {
        arm: value["counts"] for arm, value in result["arms"].items()}}))

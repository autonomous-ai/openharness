#!/usr/bin/env python3
"""Check blinding integrity and reversible presentation changes, not model quality."""

from __future__ import annotations

import hashlib
import importlib.util
import itertools
import json
from pathlib import Path
import re
import sys
import tempfile


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("trial_renderer", ROOT / "prepare_decision_trials.py")
assert spec and spec.loader
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def checksum(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def restore_text(text: str, names: dict, providers: dict) -> str:
    inverse = {value: key for key, value in (names | providers).items()}
    alternatives = "|".join(re.escape(value) for value in sorted(inverse, key=len, reverse=True))
    return re.sub(
        rf"\b({alternatives})(s?)(?![\w])",
        lambda match: inverse[match[1]] + match[2],
        text,
    )


def verify() -> dict:
    original = read(ROOT / "decision-cases.json")
    labels = read(ROOT / "decision-oracle.json")
    cases = {row["id"]: row for row in original["cases"]}
    oracle = {row["id"]: row for row in labels["cases"]}
    payload_fields = {"schema", "id", "task", "observed_facts", "participants", "requester"}
    seen_ids = set()
    checked = 0
    aliases = []
    with tempfile.TemporaryDirectory(prefix="swarm-decision-trials-") as scratch:
        base = Path(scratch)
        for seed in (17, 91):
            orders = set()
            provider_mappings = set()
            observed_combinations = set()
            for rotation, order in itertools.product(range(6), repeat=2):
                destination = base / f"{seed}-{rotation}-{order}"
                result = renderer.prepare(destination, seed, rotation, order)
                assert result["trials"] == len(cases)
                control = read(destination / "control/manifest.json")
                names = control["name_mapping"]
                providers = control["provider_mapping"]
                inverse_names = {value: key for key, value in names.items()}
                inverse_providers = {value: key for key, value in providers.items()}
                aliases.append(tuple(names.values()))
                orders.add(tuple(control["canonical_roster_order"]))
                provider_mappings.add(tuple(providers.items()))
                observed_combinations.add((tuple(control["canonical_roster_order"]), tuple(providers.items())))
                assert len(set(control["schedule"])) == len(cases)
                assert set(control["schedule"]) == {row["trial_id"] for row in control["trials"]}
                rendered = {}
                for row in control["trials"]:
                    case = cases[row["source_case_id"]]
                    label = oracle[case["id"]]
                    trial_id = row["trial_id"]
                    assert trial_id not in seen_ids
                    seen_ids.add(trial_id)
                    payload = read(destination / "inputs" / f"{trial_id}.json")
                    assert set(payload) == payload_fields
                    assert payload["id"] == trial_id
                    for field in ("task", "observed_facts"):
                        assert restore_text(payload[field], names, providers) == case[field]
                    assert inverse_names[payload["requester"]] == case["requester"]
                    assert {
                        inverse_names[name]: inverse_providers[provider]
                        for name, provider in payload["participants"].items()
                    } == case["participants"]
                    assert [inverse_names[name] for name in payload["participants"]] == control["canonical_roster_order"]
                    assert row["allowed_actions"] == label["allowed_actions"]
                    assert (inverse_names[row["recipient"]] if row["recipient"] else None) == label["recipient"]
                    assert restore_text(row["reason"], names, providers) == label["reason"]
                    assert row["tags"] == label["tags"]
                    assert not re.search(r"\b(?:Alpha|Beta|Gamma)s?\b", json.dumps(payload))
                    rendered[case["id"]] = payload
                    checked += 1
                assert rendered["D53"]["task"] == rendered["D54"]["task"]
                assert rendered["D53"]["participants"] == rendered["D54"]["participants"]
                assert rendered["D54"]["observed_facts"].startswith(rendered["D53"]["observed_facts"])
                assert rendered["D55"]["task"] == rendered["D56"]["task"]
                assert rendered["D55"]["participants"] == rendered["D56"]["participants"]
                assert rendered["D57"]["task"] == rendered["D58"]["task"]
                assert rendered["D57"]["participants"] == rendered["D58"]["participants"]
                assert rendered["D59"]["task"] == rendered["D60"]["task"]
                assert rendered["D59"]["participants"] == rendered["D60"]["participants"]
                assert rendered["D61"]["task"] == rendered["D62"]["task"]
                assert rendered["D61"]["participants"] == rendered["D62"]["participants"]
            assert len(orders) == len(provider_mappings) == 6
            assert len(observed_combinations) == 36
        assert len(set(aliases)) == 2

        protected = base / "17-0-0"
        before = checksum(protected / "control/manifest.json")
        try:
            renderer.prepare(protected, 91, 5, 5)
        except ValueError:
            pass
        else:
            raise AssertionError("Existing output was overwritten")
        assert checksum(protected / "control/manifest.json") == before

        # Change evaluator labels deliberately; no model-visible byte may change.
        altered = base / "altered-source"
        altered.mkdir()
        (altered / "decision-cases.json").write_text(json.dumps(original))
        canary = "EVALUATOR_ONLY_CANARY_7419"
        for row in labels["cases"]:
            row["reason"] = canary
            row["allowed_actions"] = [canary]
            row["recipient"] = "Gamma"
            row["tags"] = [canary]
        (altered / "decision-oracle.json").write_text(json.dumps(labels))
        renderer.ROOT = altered
        renderer.prepare(base / "canary-output", 17, 0, 0)
        for path in (protected / "inputs").glob("*.json"):
            assert path.read_bytes() == (base / "canary-output/inputs" / path.name).read_bytes()

        # New unreviewed case fields must not silently become model context.
        original["cases"][0]["allowed_actions"] = [canary]
        (altered / "decision-cases.json").write_text(json.dumps(original))
        try:
            renderer.prepare(base / "bad-fields", 17, 0, 0)
        except ValueError:
            pass
        else:
            raise AssertionError("Unreviewed fields were accepted")
        assert not (base / "bad-fields").exists()
        renderer.ROOT = ROOT

    return {
        "status": "passed: offline rendering integrity only",
        "canonical_cases": len(cases),
        "seeds": [17, 91],
        "provider_permutations": 6,
        "roster_permutations": 6,
        "rendered_inputs_checked": checked,
        "checks": [
            "Every presented fact, task, requester and provider relation restores to the source",
            "All provider/roster combinations are independent and covered per seed",
            "Canonical names and evaluator fields are absent from input payloads",
            "Manual actions and recipients remain aligned with transformed scenarios",
            "Paired answer-use, request-scope, timing, cross-repository and negative-outcome cases retain identical nonmaterial presentation",
            "Changing all oracle labels leaves every model-visible input byte unchanged",
            "Unreviewed input fields are rejected before output creation",
            "Existing output is not overwritten",
        ],
        "source_sha256": {
            name: checksum(ROOT / name)
            for name in ("decision-cases.json", "decision-oracle.json", "prepare_decision_trials.py", "verify_decision_trials.py")
        },
        "model_execution": "not run",
        "decision_quality": "unscored",
        "native_provider_coverage": "not tested by display-label permutations",
    }


if __name__ == "__main__":
    print(json.dumps(verify(), indent=2))

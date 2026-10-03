#!/usr/bin/env python3
"""Render blinded decision inputs. No model calls, runtime tools, or scoring.

Only individual inputs/*.json files belong in a future model's context. Keep
control/ outside its readable environment; separate folders are not isolation.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
from pathlib import Path
import random
import re


ROOT = Path(__file__).resolve().parent
ROLES = ("Alpha", "Beta", "Gamma")
PROVIDERS = ("Codex", "Claude Code", "Grok")
NAMES = ("Cedar", "Juniper", "Maple", "Willow", "Birch", "Aspen", "Alder", "Linden")
ROLE_ORDERS = tuple(itertools.permutations(ROLES))
PROVIDER_ORDERS = tuple(itertools.permutations(PROVIDERS))
TOKENS = re.compile(r"\b(Claude Code|Codex|Grok|Alpha|Beta|Gamma)(s?)(?![\w])")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def transform_text(value: str, names: dict[str, str], providers: dict[str, str]) -> str:
    mapping = names | providers
    return TOKENS.sub(lambda match: mapping[match[1]] + match[2], value)


def prepare(destination: Path, seed: int, provider_rotation: int, roster_order: int) -> dict:
    if destination.exists():
        raise ValueError("Destination exists; choose a new directory")
    if not 0 <= provider_rotation < 6 or not 0 <= roster_order < 6:
        raise ValueError("Provider rotation and roster order must be 0 through 5")

    cases_path = ROOT / "decision-cases.json"
    oracle_path = ROOT / "decision-oracle.json"
    cases = read_json(cases_path)["cases"]
    labels = read_json(oracle_path)["cases"]
    by_id = {label["id"]: label for label in labels}
    case_ids = [case["id"] for case in cases]
    if len(set(case_ids)) != len(case_ids) or len(by_id) != len(labels) or set(case_ids) != set(by_id):
        raise ValueError("Cases and labels must have unique, matching IDs")

    names = dict(zip(ROLES, random.Random(seed).sample(NAMES, len(ROLES))))
    providers = dict(zip(PROVIDERS, PROVIDER_ORDERS[provider_rotation]))
    order = ROLE_ORDERS[roster_order]
    rendered = []
    manifest_rows = []

    for case in cases:
        if set(case) != {"id", "task", "observed_facts", "participants", "requester"}:
            raise ValueError(f"Unreviewed input fields in {case['id']}")
        if set(case["participants"]) != set(ROLES) or case["requester"] not in ROLES:
            raise ValueError(f"Unreviewed role set in {case['id']}")
        if not set(case["participants"].values()) <= set(PROVIDERS):
            raise ValueError(f"Unreviewed provider in {case['id']}")
        label = by_id[case["id"]]
        if label["recipient"] is not None and label["recipient"] not in ROLES:
            raise ValueError(f"Unreviewed recipient in {case['id']}")
        material = f"{seed}:{provider_rotation}:{roster_order}:{case['id']}".encode()
        trial_id = hashlib.sha256(material).hexdigest()[:24]
        payload = {
            "schema": "swarm-decision-trial.v1",
            "id": trial_id,
            "task": transform_text(case["task"], names, providers),
            "observed_facts": transform_text(case["observed_facts"], names, providers),
            "participants": {
                names[role]: providers[case["participants"][role]] for role in order
            },
            "requester": names[case["requester"]],
        }
        rendered.append((trial_id, payload))
        manifest_rows.append({
            "trial_id": trial_id,
            "source_case_id": case["id"],
            "allowed_actions": label["allowed_actions"],
            "recipient": names[label["recipient"]] if label["recipient"] else None,
            "reason": transform_text(label["reason"], names, providers),
            "tags": label["tags"],
        })

    if len({trial_id for trial_id, _ in rendered}) != len(rendered):
        raise ValueError("Trial ID collision")
    destination.mkdir(parents=True)
    inputs = destination / "inputs"
    control = destination / "control"
    inputs.mkdir()
    control.mkdir()
    for trial_id, payload in rendered:
        write_json(inputs / f"{trial_id}.json", payload)
    # The seed, mappings, canonical IDs, labels, and schedule are runner-only.
    schedule = [trial_id for trial_id, _ in rendered]
    random.Random(f"schedule:{seed}:{provider_rotation}:{roster_order}").shuffle(schedule)
    manifest = {
        "schema": "swarm-decision-trial-control.v1",
        "status": "Prepared inputs and manual labels; no model execution or scoring",
        "seed": seed,
        "provider_rotation": provider_rotation,
        "roster_order": roster_order,
        "name_mapping": names,
        "provider_mapping": providers,
        "canonical_roster_order": order,
        "sources": {
            "cases_sha256": digest(cases_path),
            "oracle_sha256": digest(oracle_path),
            "renderer_sha256": digest(Path(__file__)),
        },
        "schedule": schedule,
        "trials": manifest_rows,
        "limits": [
            "Display-provider rotation does not execute or change a native provider.",
            "Names, providers, and order change; explicit observed facts remain supplied.",
            "Do not mount control or the canonical source suite for a participant.",
            "Present one trial per independent episode; labels remain evaluator-only.",
        ],
    }
    write_json(control / "manifest.json", manifest)
    return {
        "destination": str(destination),
        "trials": len(rendered),
        "model_execution": "not run",
        "scoring": "not performed",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--provider-rotation", type=int, choices=range(6), default=0)
    parser.add_argument("--roster-order", type=int, choices=range(6), default=0)
    args = parser.parse_args()
    try:
        result = prepare(args.destination, args.seed, args.provider_rotation, args.roster_order)
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

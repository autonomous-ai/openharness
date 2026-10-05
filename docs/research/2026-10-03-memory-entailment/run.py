"""Offline synthetic NLI diagnostic; no production imports or provider calls."""
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import signal
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def premises(case):
    project = ", ".join(case["input"]["authorizedScope"]["projectIds"]) or "unbound"
    scoped, raw = [], []
    for episode in case["input"]["episodes"]:
        scoped.append(f"Capture boundary: {episode['context']}. Project: {project}.")
        for source in episode["sources"]:
            scoped.append(f"{source['role']}: {source['text']}")
            raw.append(source["text"])
    return {"scoped_source": "\n".join(scoped), "raw_source": "\n".join(raw)}


def hypotheses(case, fields):
    result = []
    for field in fields:
        value = case["input"]["candidate"].get(field)
        if value is not None:
            assert isinstance(value, str) and value
            result.append({"path": "/" + field, "text": value})
    return result


def main():
    assert len(sys.argv) == 3, "run.py MODEL_DIRECTORY NEW_REPORT"
    model_dir, output = Path(sys.argv[1]), Path(sys.argv[2])
    assert output.parent.is_dir() and not output.exists()
    base = Path(__file__).resolve().parent
    inputs = {name: (base / name).read_bytes() for name in
              ["plan.json", "model-files.json", "requirements.txt", "run.py", "score.py"]}
    plan, manifest = json.loads(inputs["plan.json"]), json.loads(inputs["model-files.json"])
    suite_bytes = (base / plan["suite"]).read_bytes()
    assert sha(suite_bytes) == plan["suiteSha256"]
    suite = json.loads(suite_bytes)
    assert len(suite["cases"]) == plan["expectedCases"]
    report = {"schemaVersion": 1, "experiment": plan["experiment"], "status": "running",
              "startedAt": now(), "inputHashes": {name: sha(data) for name, data in inputs.items()},
              "suiteSha256": sha(suite_bytes), "plan": plan, "model": manifest,
              "attemptedPairs": 0, "completedPairs": 0, "sanity": [], "cases": []}

    def save():
        output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")

    save()
    try:
        with socket.socket() as probe:
            probe.settimeout(1)
            report["networkGuard"] = {"nonLoopbackConnectError": probe.connect_ex(("1.1.1.1", 443))}
        assert report["networkGuard"]["nonLoopbackConnectError"] == 1, "OS sandbox must deny networking"
        assert manifest["repository"] == plan["model"] and manifest["revision"] == plan["revision"]
        assert manifest["files"]["model.safetensors"]["sha256"] == plan["weightsSha256"]
        for name, expected in manifest["files"].items():
            file = model_dir / name
            assert file.stat().st_size == expected["bytes"]
            digest = hashlib.sha256()
            with file.open("rb") as stream:
                while chunk := stream.read(1048576):
                    digest.update(chunk)
            assert digest.hexdigest() == expected["sha256"], name
        packages = {}
        for line in inputs["requirements.txt"].decode().splitlines():
            name, version = line.split("==")
            packages[name] = importlib.metadata.version(name)
            assert packages[name] == version, name
        for name, version in plan["packages"].items():
            assert importlib.metadata.version(name) == version, name
        report["environment"] = {"python": platform.python_version(), "os": platform.system(),
                                 "machine": platform.machine(), "packages": packages}
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                          TOKENIZERS_PARALLELISM="false")
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        torch.manual_seed(plan["seed"])
        torch.set_num_threads(plan["threads"])
        torch.set_num_interop_threads(1)
        torch.use_deterministic_algorithms(True)
        started = time.monotonic()
        tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False, use_fast=False)
        model, info = AutoModelForSequenceClassification.from_pretrained(
            model_dir, local_files_only=True, trust_remote_code=False, use_safetensors=True,
            torch_dtype=torch.float32, output_loading_info=True)
        assert all(not info.get(key) for key in ["missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs"]), info
        model.eval().to("cpu")
        report["loadMs"] = (time.monotonic() - started) * 1000
        labels = {int(key): value for key, value in model.config.id2label.items()}
        assert labels == {0: "entailment", 1: "neutral", 2: "contradiction"}
        report["parameters"] = sum(parameter.numel() for parameter in model.parameters())

        def deadline(_signal, _frame):
            raise TimeoutError("evaluation_deadline")

        signal.signal(signal.SIGALRM, deadline)
        signal.setitimer(signal.ITIMER_REAL, plan["inferenceDeadlineSeconds"])

        def infer(premise, hypothesis):
            report["attemptedPairs"] += 1
            started = time.monotonic()
            inputs = tokenizer(premise, hypothesis, return_tensors="pt", truncation=False)
            tokens = inputs["input_ids"].shape[-1]
            assert tokens <= plan["maxPairTokens"], "pair_too_long_no_truncation"
            with torch.inference_mode():
                logits = model(**inputs).logits[0].to(torch.float64)
                probabilities = torch.softmax(logits, dim=-1).tolist()
            assert len(probabilities) == 3 and all(math.isfinite(value) for value in probabilities)
            report["completedPairs"] += 1
            return {"premise": premise, "hypothesis": hypothesis, "pairTokens": tokens,
                    "probabilities": {labels[index]: value for index, value in enumerate(probabilities)},
                    "label": labels[max(range(3), key=lambda index: probabilities[index])],
                    "elapsedMs": (time.monotonic() - started) * 1000}

        controls = [("All rooms are empty.", "There are no people in the rooms.", "entailment"),
                    ("All rooms are empty.", "There is a person in one of the rooms.", "contradiction"),
                    ("There is a tree in the garden.", "The tree is an oak.", "neutral")]
        for premise, hypothesis, expected in controls:
            result = infer(premise, hypothesis)
            report["sanity"].append({**result, "expected": expected})
            assert result["label"] == expected, "sanity_label_mismatch"
        save()
        print(json.dumps({"stage": "ready", "parameters": report["parameters"], "loadMs": report["loadMs"]}), flush=True)
        # Only input text reaches the classifier; labels are consumed later by score.py.
        for arm in plan["arms"]:
            for case in suite["cases"]:
                premise = premises(case)[arm]
                row = {"arm": arm, "id": case["id"], "fields": [], "status": "running"}
                report["cases"].append(row)
                for hypothesis in hypotheses(case, plan["fields"]):
                    report["activePair"] = {"arm": arm, "id": case["id"], "path": hypothesis["path"]}
                    save()
                    row["fields"].append({"path": hypothesis["path"], **infer(premise, hypothesis["text"])})
                row["accepted"] = all(field["label"] == "entailment" for field in row["fields"])
                row["status"] = "completed"
                report.pop("activePair", None)
                save()
                print(json.dumps({"stage": "case", "arm": arm, "id": case["id"], "accepted": row["accepted"]}), flush=True)
        assert sha((base / plan["suite"]).read_bytes()) == report["suiteSha256"]
        for name, data in inputs.items():
            assert (base / name).read_bytes() == data, name
        report["status"] = "completed"
    except Exception as error:
        report["status"] = "stopped"
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        report["finishedAt"] = now()
        save()


if __name__ == "__main__":
    main()

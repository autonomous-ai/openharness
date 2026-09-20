"""Independent reader: stdlib ZIP/hashes/assertions and upstream Core validator.

Never imports the wrapper's engine, calculator, archive or delivery code.
Run with the pinned Core Python and an acceptance.json file or evidence parent.
"""
import asyncio
import hashlib
import importlib.metadata
import json
from pathlib import Path, PurePosixPath
import sys
import tempfile
import zipfile

import homeassistant  # official probatio validation backend must initialize first
from annotatedyaml import parse_yaml
from homeassistant import loader
from homeassistant.core import HomeAssistant
from homeassistant.helpers import condition, trigger
from homeassistant.components.automation.config import async_validate_config_item

def digest(value):
    return hashlib.sha256(value).hexdigest()

def source_revision(project, yaml):
    return digest(json.dumps({"project": project, "yaml": yaml}, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode())

def subset(wanted, actual):
    return isinstance(actual, dict) and all(k in actual and subset(v, actual[k]) for k, v in wanted.items()) if isinstance(wanted, dict) else wanted == actual

async def core_validate(yaml, zone):
    rules = parse_yaml(yaml)
    assert rules and all(rule["initial_state"] is False for rule in rules)
    with tempfile.TemporaryDirectory(prefix="habitat-independent-schema-") as config:
        hass = HomeAssistant(config)
        hass.config.skip_pip = True
        hass.data[loader.DATA_CUSTOM_COMPONENTS] = {}
        loader.async_setup(hass)
        await condition.async_setup(hass)
        await trigger.async_setup(hass)
        await hass.config.async_set_time_zone(zone)
        try:
            for rule in rules:
                checked = await async_validate_config_item(hass, "automation", rule)
                assert str(checked.validation_status) == "ok", rule["id"]
        finally:
            await hass.async_stop(force=True)
    return len(rules)

def verify_results(project, yaml, results):
    revision = source_revision(project, yaml)
    assert results["sourceRevision"] == revision
    assert results["complete"] and results["passed"] and results["engine"] == "2026.9.3"
    assert len(results["results"]) == len(project["scenarios"])
    actual_cases = {c["scenario"]: c for c in results["results"]}
    for case in project["scenarios"]:
        result, expected = actual_cases[case["id"]], case["expect"]
        assert result["passed"] and result["engine"]["network"] == "denied"
        assert "non-persistent" in result["engine"]["storage"]
        assert len(result["calls"]) == len(expected["calls"])
        for call, wanted in zip(result["calls"], expected["calls"], strict=True):
            assert call["service"] == wanted["service"]
            assert sorted(call["entities"]) == sorted(wanted.get("entities", []))
            assert subset(wanted.get("data", {}), call["data"])
            assert wanted["between"][0] - .002 <= call["at"] <= wanted["between"][1] + .002
        for entity, state in expected.get("states", {}).items():
            assert subset(state, result["states"][entity])
        assert result["pending"] == expected.get("pending", 0)
        assert all(check["passed"] for check in result["checks"])
    assert all(rule["completed"] for rule in results["coverage"])
    return actual_cases

async def verify(file):
    receipt = json.loads(file.read_text())
    assert receipt["core"] == "2026.9.3"
    for fixture in receipt["fixtures"]:
        assert fixture["originalRevision"] != fixture["revisedRevision"]
        assert fixture["originalPassed"] and fixture["revisedPassed"]
        assert not fixture["errors"] and not fixture["external"]
        with zipfile.ZipFile(fixture["zip"]) as archive:
            assert archive.testzip() is None
            names = archive.namelist()
            assert len(names) == len(set(names))
            for name in names:
                path = PurePosixPath(name)
                assert not path.is_absolute() and ".." not in path.parts
                assert not any(part in ("secrets.yaml", ".harness", ".runtime", "node_modules") for part in path.parts)
            for required in ("tools/engine.py", "tools/uv.lock", "tools/setup.sh", "tools/serve.mjs", "PROJECT.md", "LICENSE", ".gitignore"):
                assert required in names
            manifest = json.loads(archive.read("output/manifest.json"))
            for item in manifest["files"]:
                value = archive.read("output/" + item["name"])
                assert len(value) == item["bytes"] and digest(value) == item["sha256"]
            project = json.loads(archive.read("project.json"))
            yaml = archive.read("automations.yaml").decode()
            assert archive.read("output/automations.yaml").decode() == yaml
            saved = json.loads(archive.read("output/project.habitat.json"))
            assert saved["project"] == project and saved["yaml"] == yaml
            assert saved["revision"] == source_revision(project, yaml) == manifest["sourceRevision"] == fixture["revisedRevision"]
            results = json.loads(archive.read("output/results.json"))
            cases = verify_results(project, yaml, results)
            assert manifest["runtimeRevision"] == results["runtimeRevision"]
            count = await core_validate(yaml, project["timezone"])
            assert count == (1 if fixture["fixture"] == "hallway" else 2)
            if fixture["fixture"] == "hallway":
                assert abs(cases["normal-evening"]["calls"][-1]["at"] - 190) < .01
                assert abs(cases["people-return"]["calls"][-1]["at"] - 280) < .01
                assert cases["quiet-hours"]["calls"][0]["data"]["brightness_pct"] == 12
                assert not cases["manual-hold"]["calls"]
                assert cases["take-over"]["states"]["light.example_hall"]["state"] == "on"
            else:
                assert abs(cases["complete-cycle"]["calls"][1]["at"] - 780) < .01
                assert abs(cases["brief-pause"]["calls"][1]["at"] - 1380) < .01
                assert not cases["standby"]["calls"] and not cases["power-glitch"]["calls"]
            for kind in ("jsonReopened", "zipReopened"):
                root = Path(fixture[kind])
                assert json.loads((root / "project.json").read_text()) == project
                assert (root / "automations.yaml").read_text() == yaml
                verify_results(project, yaml, json.loads((root / "output/results.json").read_text()))
        print("verified", fixture["fixture"], "ZIP hashes, independently checked calls/states, Core schema and both reopened builds")
    assert receipt["browserProof"]["passed"]

async def main():
    assert importlib.metadata.version("homeassistant") == "2026.9.3"
    target = Path(sys.argv[1])
    files = [target] if target.is_file() else sorted(target.glob("habitat-acceptance-*/acceptance.json"))
    assert files, "No completed acceptance receipts found"
    for file in files:
        await verify(file)

asyncio.run(main())

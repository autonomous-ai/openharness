"""Large plans reach both CI gates as data, without an exec environment size limit."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        tree = subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=ROOT, text=True).strip()
        self.plan = dict(schema=1, kind="ci-plan", event="pull_request", head=head, tree=tree,
                         base="c" * 40, draft=False, suites=[], required_jobs=["process-checks"],
                         paths=[f"docs/{index:05d}-" + "x" * 100 + ".md" for index in range(3000)], local_checks=[])
        self.marker = self.work / "must-not-exist"
        self.plan["paths"].append(f"docs/$(touch {self.marker})\nCI_INPUT\n`touch {self.marker}`.md")
        self.needs = {"plan": dict(result="success", outputs=dict(plan=json.dumps(self.plan))),
                      "process-checks": dict(result="success", outputs=dict(local_receipts="[]"))}
        self.event = self.work / "event.json"
        self.event.write_text(json.dumps(dict(pull_request=dict(head=dict(sha=head), body=""))))
        self.output = self.work / "output.json"
        self.env = {key: value for key, value in os.environ.items() if key not in {"CI_PLAN", "CI_NEEDS"}}
        self.env.update(CI_SOURCE_SHA=head, GITHUB_EVENT_NAME="pull_request", GITHUB_EVENT_PATH=str(self.event),
                        GITHUB_OUTPUT=str(self.output), GITHUB_STEP_SUMMARY=str(self.work / "summary.md"),
                        RUNNER_TEMP=str(self.work))

    def run_gate(self, script, data, *args):
        wire = json.dumps(data)
        self.assertGreater(len(wire.encode()), 131072)
        return subprocess.run([sys.executable, str(ROOT / "scripts" / script), *args], input=wire,
                              cwd=ROOT, env=self.env, text=True, capture_output=True, timeout=10)

    def test_required_gate_reads_large_needs_and_embedded_plan(self):
        result = self.run_gate("ci-plan.py", self.needs, "--verify", "--output", str(self.output))
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(self.output.read_text())
        self.assertEqual(receipt["source_sha"], self.plan["head"])
        self.assertEqual(receipt["status"], "passed")

    def test_large_input_still_requires_every_selected_job(self):
        self.needs["process-checks"]["result"] = "failure"
        result = self.run_gate("ci-plan.py", self.needs, "--verify", "--output", str(self.output))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("required CI job did not pass: process-checks", result.stderr)
        self.assertFalse(self.output.exists())

    def test_local_gate_reads_large_plan(self):
        result = self.run_gate("local-checks.py", self.plan)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output.read_text(), "local_receipts=[]\n")

    def test_workflow_sends_json_through_quoted_stdin(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text()
        self.assertFalse("CI_PLAN:" in workflow, "plan must not be an exec environment string")
        self.assertFalse("CI_NEEDS:" in workflow, "needs must not be an exec environment string")
        self.assertIn("python3 scripts/local-checks.py <<'CI_INPUT'\n          ${{ needs.plan.outputs.plan }}\n          CI_INPUT", workflow)
        self.assertIn('--output "$RUNNER_TEMP/ci-required.json" <<\'CI_INPUT\'\n          ${{ toJSON(needs) }}\n          CI_INPUT', workflow)

    def test_workflow_does_not_expand_commands_or_delimiters_inside_paths(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text()
        for name, expression, value in [("local-checks.py", "${{ needs.plan.outputs.plan }}", self.plan),
                                        ("ci-plan.py", "${{ toJSON(needs) }}", self.needs)]:
            with self.subTest(gate=name):
                match = re.search(r"(?m)^          python3 scripts/" + re.escape(name) + r" .*\n.*\n          CI_INPUT$", workflow)
                self.assertIsNotNone(match)
                script = self.work / "gate.sh"
                script.write_text(textwrap.dedent(match.group()).replace(expression, json.dumps(value, indent=2)))
                result = subprocess.run(["bash", str(script)], cwd=ROOT, env=self.env,
                                        text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(self.marker.exists())


if __name__ == "__main__":
    unittest.main()

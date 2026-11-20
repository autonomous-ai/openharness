"""PR CI's end-to-end jobs in ci.yml: what each runs, where, and that ci/required waits for it."""
from pathlib import Path
import re
import unittest

CI = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"
LOCK = ("ci-${{ github.event_name }}-${{ github.event.action || 'run' }}-"
        "${{ github.event.pull_request.number || github.run_id }}-")


def ci_jobs():
    """ci.yml's text, its jobs by id (test_ci_plan.py's split), and the jobs ci/required needs."""
    text = CI.read_text()
    jobs = dict(re.findall(r"(?m)^  ([\w-]+):\n((?:(?:    .*)?\n)+)", text))
    needs = set(re.findall(r"[\w-]+", re.search(r"(?m)^    needs: \[((?:.|\n)+?)\]", jobs["required"]).group(1)))
    return text, jobs, needs


class WindowsE2ETests(unittest.TestCase):
    def test_windows_e2e_calls_windows_yml_x64_alone_unless_the_plan_says_arm64(self):
        _, jobs, needs = ci_jobs()
        job = jobs.get("windows-e2e")
        self.assertIsNotNone(job, "ci.yml has no windows-e2e job")
        for text in ("uses: ./.github/workflows/windows.yml",
                     "x64_only: ${{ needs.plan.outputs.windows-e2e-arm64 != 'true' }}",
                     "if: needs.plan.outputs.ready == 'true' && needs.plan.outputs.windows-e2e == 'true'",
                     f"group: {LOCK}windows-e2e\n",
                     "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"):
            self.assertIn(text, job)
        for output in ("windows-e2e", "windows-e2e-arm64"):
            self.assertIn(f"      {output}: ${{{{ steps.select.outputs.{output} }}}}\n", jobs["plan"])
        self.assertIn("windows-e2e", needs)


if __name__ == "__main__":
    unittest.main()

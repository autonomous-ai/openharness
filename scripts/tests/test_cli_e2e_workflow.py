"""The CLI's Linux e2e jobs set up through one action, and the dial hosts are one workflow nightly and PR CI both call."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
ACTION = ROOT / ".github/actions/cli-e2e-setup/action.yml"
CLI_E2E = ROOT / ".github/workflows/cli-e2e.yml"
DIAL_HOSTS = ROOT / ".github/workflows/cli-e2e-dial-hosts.yml"
CI = ROOT / ".github/workflows/ci.yml"
SETUP = "uses: ./.github/actions/cli-e2e-setup"


def read(path):
    return path.read_text() if path.exists() else ""


def jobs(text):
    return dict(re.findall(r"(?m)^  ([\w-]+):\n((?:(?:    .*)?\n)+)", text))


def steps(text):
    return re.split(r"(?m)^ *- (?=\S)", text.split("steps:\n", 1)[-1])[1:]


class CliE2eWorkflowTests(unittest.TestCase):
    def test_every_linux_e2e_job_sets_up_through_the_one_action(self):
        nightly = jobs(read(CLI_E2E))
        for job in (nightly.get("e2e", ""), nightly.get("agent-browser-podman", ""), jobs(read(DIAL_HOSTS)).get("dial-hosts", "")):
            self.assertIn(SETUP, job)
        # CI's unit-test job also needs shell completion repair. This contract owns only its e2e setup.
        for path, text in ((CLI_E2E, read(CLI_E2E)), (DIAL_HOSTS, read(DIAL_HOSTS)),
                           (CI, jobs(read(CI)).get("linux-e2e", ""))):
            with self.subTest(path=path.name):
                self.assertIn(SETUP, text)
                self.assertNotIn("compaudit", text)
                self.assertNotIn("fs.inotify", text)
        action = read(ACTION)
        # One copy of each fix: the compaudit repair and the inotify limits.
        self.assertEqual(len(re.findall(r"(?m)^.*insecure=\$\(zsh -fc 'autoload -U compaudit && compaudit'.*$", action)), 1)
        self.assertEqual(len(re.findall(r"(?m)^.*sysctl -w fs\.inotify.*$", action)), 1)

    def test_the_shards_set_up_their_shells_and_the_real_backend(self):
        e2e = jobs(read(CLI_E2E)).get("e2e", "")
        self.assertRegex(e2e, r"packages: tcsh dash xvfb xclip\n")
        self.assertIn("real-backend: 'true'", e2e)
        action = read(ACTION)
        for text in ("using: composite", "redis-server", "mongodb-memory-server@10 redis-memory-server@0.12",
                     "HARNESS_E2E_SERVICES_DIR", "if: inputs.real-backend == 'true'"):
            self.assertIn(text, action)
        runs = [step for step in steps(action) if re.search(r"(?m)^ *run: ", step)]
        self.assertTrue(runs)
        for step in runs:
            self.assertRegex(step, r"(?m)^ *shell: bash$")

    def test_nightly_and_pr_e2e_install_clipboard_tools(self):
        for path, name in ((CLI_E2E, "e2e"), (CI, "linux-e2e")):
            with self.subTest(path=path.name, job=name):
                job = jobs(read(path)).get(name, "")
                package_line = re.search(r"(?m)^ *packages: (.+)$", job)
                self.assertIsNotNone(package_line)
                self.assertTrue({"tcsh", "dash", "xvfb", "xclip"} <= set(package_line.group(1).split()))

    def test_the_dial_hosts_job_is_one_reusable_workflow(self):
        job = jobs(read(CLI_E2E)).get("dial-hosts", "")
        self.assertIn("uses: ./.github/workflows/cli-e2e-dial-hosts.yml", job)
        self.assertIn("if: ${{ !inputs.agent_browser_podman }}", job)
        self.assertNotIn("steps:", job)
        hosts = read(DIAL_HOSTS)
        self.assertRegex(hosts, r"(?m)^on:\n  workflow_call:\n(?! )")
        for text in ("contents: read", "runs-on: ubuntu-24.04", "timeout-minutes: 30",
                     "ref: ${{ github.event.pull_request.head.sha || github.sha }}", "E2E_DIAL_HOSTS: '1'",
                     "HERDR_VERSION: 0.9.5", "ZELLIJ_VERSION: 0.44.3", "WEZTERM_VERSION: 20240203-110809-5046fc22",
                     "name: Require every case to pass without skipping",
                     "HERDR_SHA256: 14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d",
                     "ZELLIJ_SHA256: 0f7c346788627f506c0a28296517768633cff24fc822a739f8264b640ecad751",
                     "WEZTERM_SHA256: 86358dab5794a4fb63f7c91dd68d4fdc3da58faad648a58fc77d2bd51c7b0686"):
            self.assertIn(text, hosts)


if __name__ == "__main__":
    unittest.main()

"""release-device.yml, read from its text as scripts/tests/test_ci_plan.py reads ci.yml: which jobs run for which
platforms, where the secrets and the signing identity are, and the order Windows is signed in. Nothing runs."""
import itertools
from pathlib import Path
import re
import unittest

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"
WINDOWS_JOBS = ("tauri-cli-windows", "build-windows", "sign-windows", "check-windows")
SIGNING = "uses: ./.github/actions/windows-signing"


def code(text):
    """text without its comment lines, so a comment's words are never taken for the workflow's."""
    return "".join(line for line in text.splitlines(keepends=True) if not line.lstrip().startswith("#"))


def jobs(text):
    """Each job's lines under `jobs:`, comments left out."""
    body = text.split("\njobs:\n", 1)[1]
    return {name: code(job) for name, job in re.findall(r"(?m)^  ([\w-]+):\n((?:(?:    .*)?\n)+)", body)}


def header(job):
    """What a job sets before its steps: every step sees it."""
    return job.split("\n    steps:\n", 1)[0]


def steps(job):
    return re.split(r"(?m)^      - ", job.split("\n    steps:\n", 1)[1])[1:]


class ReleaseWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (WORKFLOWS / "release-device.yml").read_text()
        cls.jobs = jobs(cls.text)
        cls.desktop = (WORKFLOWS / "release-desktop.yml").read_text()

    def job(self, name):
        if name not in self.jobs:
            self.fail(f"release-device.yml has no {name} job")
        return self.jobs[name]

    def step(self, job, text):
        """The index of the one step of job that holds text."""
        found = [index for index, step in enumerate(steps(job)) if text in step]
        self.assertEqual(len(found), 1, f"steps holding {text!r}: {len(found)}")
        return found[0]

    def test_platforms_is_macos_unless_asked(self):
        found = re.search(r"(?m)^      platforms:\n((?:        .*\n)+)", self.text)
        self.assertIsNotNone(found, "no platforms input")
        self.assertIn("type: choice", found.group(1))
        self.assertIn("options: [macos, all]", found.group(1))
        self.assertIn("default: macos", found.group(1))
        # Said where it is declared: the first Windows and Linux release removes it.
        before = reversed(self.text[:found.start()].splitlines())
        comment = list(itertools.takewhile(lambda line: line.lstrip().startswith("#"), before))
        self.assertTrue(any("temporary" in line.lower() for line in comment), comment)
        # The macOS build runs whatever the input says, as it did before the input existed.
        self.assertNotRegex(self.job("build"), r"(?m)^    if:")
        self.assertNotIn("platforms", self.job("build"))

    def test_windows_and_linux_build_only_for_all(self):
        for name in ("tauri-cli-windows", "build-windows", "build-linux"):
            with self.subTest(job=name):
                self.assertRegex(self.job(name), r"(?m)^    if: inputs\.platforms == 'all'$")
        # Skipped with build-windows: no condition of their own could run them without it.
        self.assertRegex(self.job("sign-windows"), r"(?m)^    needs: \[version, tauri-cli-windows, build-windows\]$")
        self.assertRegex(self.job("check-windows"), r"(?m)^    needs: \[version, sign-windows\]$")
        for name in ("sign-windows", "check-windows"):
            with self.subTest(job=name):
                self.assertNotRegex(self.job(name), r"(?m)^    if:")

    def test_windows_builds_both_archs_on_one_x64_runner(self):
        job = self.job("build-windows")
        self.assertIn("runs-on: windows-latest", job)
        self.assertEqual(re.findall(r"(?m)^          - (\{.+\})$", job),
                         ["{ arch: x64, target: x86_64-pc-windows-msvc }",
                          "{ arch: arm64, target: aarch64-pc-windows-msvc }"])
        self.assertIn("DEVICE_TARGET: ${{ matrix.target }}", header(job))

    def test_the_job_that_compiles_windows_holds_no_identity_and_no_secret(self):
        job = self.job("build-windows")
        self.assertIn('release-build.sh compile "$VERSION"', job)
        for text in ("secrets.", "id-token", "environment:", "permissions:"):
            with self.subTest(text=text):
                self.assertNotIn(text, job)
        # Nor from the workflow's own permissions, which every job without its own takes.
        top = re.search(r"(?m)^permissions:\n((?:  .*\n)+)", self.text).group(1)
        self.assertEqual(top, "  contents: read\n")
        # What it hands on: the unsigned exe alone, for a day. Its Tauri CLI ran beside the build's code.
        upload = steps(job)[self.step(job, "actions/upload-artifact@")]
        self.assertIn("name: device-windows-${{ matrix.arch }}-unsigned", upload)
        self.assertIn("retention-days: 1", upload)
        self.assertIn("harness-device.exe", steps(job)[self.step(job, "Copy-Item")])
        self.assertNotIn("cargo-tauri", job)

    def test_the_tauri_cli_is_made_where_no_app_code_runs(self):
        job = self.job("tauri-cli-windows")
        self.assertRegex(job, r"(?m)^    needs: version$")
        self.assertIn("runs-on: windows-latest", job)
        self.assertIn("release-setup.sh tauri-cli", job)
        # The app's code is not even checked out: only the release scripts.
        self.assertIn("sparse-checkout: |\n            /device-app/scripts/\n          sparse-checkout-cone-mode: false",
                      job)
        for text in ("secrets.", "id-token", "environment:", "npm", "setup-node", "compile", "release-build.sh",
                     "download-artifact"):
            with self.subTest(text=text):
                self.assertNotIn(text, job)
        upload = steps(job)[self.step(job, "actions/upload-artifact@")]
        self.assertIn("name: tauri-cli-windows", upload)
        self.assertIn("retention-days: 1", upload)
        self.assertIn("cargo-tauri", steps(job)[self.step(job, "Copy-Item")])

    def test_only_the_signing_job_is_in_the_release_environment_with_an_id_token(self):
        self.job("sign-windows")
        in_environment = {name for name, job in self.jobs.items() if re.search(r"(?m)^    environment:", job)}
        self.assertEqual(in_environment, {"sign-windows"})
        self.assertRegex(self.jobs["sign-windows"], r"(?m)^    environment: release$")
        # sign-windows's token is Azure's signing credential; publish's is GCS's, as before.
        with_token = {name for name, job in self.jobs.items() if "id-token: write" in job}
        self.assertEqual(with_token, {"sign-windows", "publish"})
        self.assertRegex(self.jobs["sign-windows"],
                         r"(?m)^    permissions:\n      contents: read\n      id-token: write\n    \S")

    def test_the_signing_job_compiles_and_installs_nothing(self):
        job = self.job("sign-windows")
        for text in ("cargo install", "cargo build", "npm", "release-setup.sh", "compile", "setup-node",
                     "rust-toolchain"):
            with self.subTest(text=text):
                self.assertNotIn(text, job)
        # It runs the Tauri CLI tauri-cli-windows made, from its artifact, and build-windows's exes.
        self.assertIn("pattern: device-windows-*-unsigned", job)
        self.assertIn("actions/download-artifact@", steps(job)[self.step(job, "name: tauri-cli-windows")])
        self.assertIn("cygpath -w \"$PWD/tauri\" >>\"$GITHUB_PATH\"", steps(job)[self.step(job, "GITHUB_PATH")])

    def test_only_sign_update_holds_the_updater_key_on_windows(self):
        holders = []
        for name in WINDOWS_JOBS:
            job = self.job(name)
            self.assertNotIn("secrets.", header(job))
            holders += [(name, step) for step in steps(job) if "secrets." in step]
        self.assertEqual(len(holders), 1, [name for name, _ in holders])
        name, step = holders[0]
        self.assertEqual(name, "sign-windows")
        self.assertIn('release-build.sh sign-update "$VERSION"', step)
        self.assertEqual(set(re.findall(r"secrets\.(\w+)", step)),
                         {"TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"})

    def test_the_installer_is_signed_after_the_exe_and_before_the_update_signature(self):
        job = self.job("sign-windows")
        named = steps(job)
        signing = [index for index, step in enumerate(named) if SIGNING in step]
        self.assertEqual(len(signing), 2)
        bundle = self.step(job, "release-build.sh bundle")
        update = self.step(job, "release-build.sh sign-update")
        self.assertLess(signing[0], bundle)
        self.assertLess(bundle, signing[1])
        self.assertLess(signing[1], update)
        # The sums publish trusts are taken here, by the job that made the files, before anything else touches them.
        sums = self.step(job, "device-manifest.py sums")
        self.assertLess(update, sums)
        self.assertLess(sums, self.step(job, "actions/upload-artifact@"))
        # The update signature is made over the folder the second signing signed.
        out = re.search(r"(?m)^          path: (\S+)$", named[signing[1]]).group(1)
        self.assertIn(f'sign-update "$VERSION" {out}', named[update])
        # release-desktop.yml's inputs, each time.
        block = re.search(r"uses: \./\.github/actions/windows-signing\n        with:\n((?:          .*\n)+)",
                          self.desktop).group(1)
        inputs = [line for line in block.splitlines(keepends=True) if not line.lstrip().startswith("path:")]
        self.assertEqual(len(inputs), 7)
        for index in signing:
            for line in inputs:
                with self.subTest(step=index, input=line.strip()):
                    self.assertIn(line, named[index])

    def test_windows_signing_has_no_switch(self):
        self.assertNotRegex(self.text, r"\bWINDOWS_SIGNING\b")
        self.assertRegex(self.job("check-windows"), r'release-check\.sh out "\$VERSION" "\$PUBKEY" --signed\n')

    def test_check_windows_only_gates(self):
        # It checks sign-windows's artifact, the one publish takes, and hands nothing on: publish trusts no file of its.
        job = self.job("check-windows")
        self.assertIn("name: harness-device-${{ needs.version.outputs.version }}-windows", job)
        for text in ("upload-artifact", "device-manifest.py"):
            with self.subTest(text=text):
                self.assertNotIn(text, job)

    def test_linux_builds_on_ubuntu_22_04_for_both_archs(self):
        job = self.job("build-linux")
        self.assertIn("runs-on: ${{ matrix.runner }}", job)
        entries = re.findall(r"(?m)^          - (\{ runner: .+ \})$", job)
        self.assertEqual(entries, ["{ runner: ubuntu-22.04, arch: x64 }", "{ runner: ubuntu-22.04-arm, arch: arm64 }"])
        # Desktop's runners: its Linux build links the oldest glibc it supports.
        for entry in entries:
            self.assertIn(f"          - {entry}\n", jobs(self.desktop)["build-linux"])

    def test_linux_compiles_before_the_updater_key_exists(self):
        job = self.job("build-linux")
        for text in ("secrets.", "id-token", "environment:"):
            self.assertNotIn(text, header(job))
        holders = [index for index, step in enumerate(steps(job)) if "secrets." in step]
        bundle = self.step(job, "release-build.sh bundle")
        self.assertEqual(holders, [bundle])
        self.assertLess(self.step(job, "release-build.sh compile"), bundle)
        self.assertEqual(set(re.findall(r"secrets\.(\w+)", steps(job)[bundle])),
                         {"TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"})

    def test_publish_checks_each_part_then_passes_the_platforms(self):
        job = self.job("publish")
        self.assertRegex(job, r"(?m)^    needs: \[version, build, check-windows, build-linux\]$")
        condition = re.search(r"(?ms)^    if: (.+?)\n    \S", job).group(1)
        for text in ("!cancelled()", "inputs.publish", "needs.build.result == 'success'", "inputs.platforms == 'macos'",
                     "needs.check-windows.result == 'success'", "needs.build-linux.result == 'success'"):
            with self.subTest(text=text):
                self.assertIn(text, condition)
        self.assertIn("PLATFORMS: ${{ inputs.platforms }}", header(job))
        # Each build hashes its own part, under the artifact name publish looks for.
        version = "${{ needs.version.outputs.version }}"
        for name, artifact, sums in (("build", f"harness-device-{version}\n", '--out "$RUNNER_TEMP/out/sums.json"'),
                                     ("sign-windows", f"harness-device-{version}-windows\n",
                                      "--part windows --out out/sums.json"),
                                     ("build-linux", f"harness-device-{version}-linux-${{{{ matrix.arch }}}}\n",
                                      '--part "linux-$ARCH" --out')):
            with self.subTest(job=name):
                self.assertIn(f"name: {artifact}", self.job(name))
                self.assertIn(sums, self.job(name))
        self.assertIn(f"pattern: harness-device-{version}*", job)
        named = steps(job)
        check = self.step(job, '--part "$part" --check')
        for part in ("windows", "linux-x64", "linux-arm64"):
            self.assertIn(part, named[check])
        for command in ("device-manifest.py publish", "device-manifest.py verify"):
            with self.subTest(command=command):
                index = self.step(job, command)
                self.assertLess(check, index)
                self.assertIn('--platforms "$PLATFORMS"', named[index])


if __name__ == "__main__":
    unittest.main()

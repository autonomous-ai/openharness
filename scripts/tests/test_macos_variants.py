"""Run the build coordinator with disposable toolchain/publication processes.

These cover orchestration and failure isolation. Real signing, renderer pins,
universal binaries, notarization and downloads are checked by the internal build.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("macos_variants", ROOT / "desktop/scripts/build-macos-variants.py")
variants = importlib.util.module_from_spec(spec)
spec.loader.exec_module(variants)


class MacOSVariantTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.desktop = Path(self.temp.name) / "desktop with spaces"
        scripts = self.desktop / "scripts"
        scripts.mkdir(parents=True)
        self.bin = self.desktop / "tools"
        self.bin.mkdir()
        (self.bin / "variant.py").write_text('''import os,sys
from pathlib import Path
variant,version,*args=sys.argv[1:]
if "--no-build" in args:
    app=Path(os.environ["APP_BUNDLE"])
    assert app.joinpath("version").read_text()==version
    app.joinpath("renderer").write_text(variant)
else:
    if os.environ.get("COORDINATOR_FAIL")=="build":sys.exit(4)
    assert variant=="apple-silicon"
    counter=Path("compile-count")
    counter.write_text(str(int(counter.read_text())+1) if counter.exists() else "1")
    Path("build-args.json").write_text(__import__("json").dumps(args))
    if not os.environ.get("COORDINATOR_NO_PROFILE"):
        profile=next(arg.split("=",1)[1] for arg in args if arg.startswith("--performance-measurement-file="))
        Path(profile).write_text(__import__("json").dumps({"targets":[{"name":"release_macos_bundle_flutter_assets","elapsedMilliseconds":1234,"skipped":False,"succeeded":True}]}))
    app=Path("build/macos/Build/Products/Release/Harness.app")
    app.mkdir(parents=True,exist_ok=True)
    app.joinpath("version").write_text(version)
    app.joinpath("payload").write_text("shared compiled bytes")
print("variant ready")
''')
        (self.bin / "upload.py").write_text('''import json,os,sys,time
from pathlib import Path
assert sys.argv[1]=="--no-build"
version=sys.argv[2]
app=Path(os.environ["APP_BUNDLE"])
assert app.joinpath("version").read_text()==version
variant=app.joinpath("renderer").read_text()
other="apple-silicon" if variant=="intel" else "intel"
Path(variant+"-started").touch()
deadline=time.monotonic()+2
while not Path(other+"-started").exists():
    if time.monotonic()>deadline:raise RuntimeError("publication did not overlap")
    time.sleep(.01)
record={key:os.environ[key] for key in ("APP_BUNDLE","OUTPUT_DIR","OTA_KEY","DMG_KEY","GCS_PATH","DMG_GCS_PATH","METADATA_PATH")}
Path(variant+"-publication.json").write_text(json.dumps(record))
if os.environ.get("COORDINATOR_FAIL")==variant:sys.exit(7)
for extension in ("zip","dmg"):
    Path(os.environ["OUTPUT_DIR"],"Harness-macos-"+version+"."+extension).write_text(app.joinpath("payload").read_text())
print("published fixture")
''')
        for script, tool in (("publish-macos-variant.sh", "variant.py"), ("upload-desktop.sh", "upload.py")):
            (scripts / script).write_text(f'exec "{sys.executable}" tools/{tool} "$@"\n')
        ditto = self.bin / "ditto"
        ditto.write_text(f"#!{sys.executable}\nimport shutil,sys\nargs=sys.argv[1:]\nif args[0]=='--clone':args.pop(0)\nshutil.copytree(*args)\n")
        ditto.chmod(0o755)
        self.environment = mock.patch.dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"])
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.output = self.desktop / "build/macos-variants"

    def run_build(self, *options):
        with mock.patch.object(variants, "DESKTOP", self.desktop):
            result = variants.main(["1.2.3", *options])
        receipt = json.loads((self.output / "timing.json").read_text())
        return result, receipt

    def test_builds_once_and_derives_independent_renderer_bundles(self):
        result, receipt = self.run_build("--dart-define=PRIVATE_FIXTURE=do-not-record-this")
        self.assertEqual(result, 0, receipt)
        self.assertEqual((self.desktop / "compile-count").read_text(), "1")
        self.assertIn("--dart-define=PRIVATE_FIXTURE=do-not-record-this", json.loads((self.desktop / "build-args.json").read_text()))
        self.assertNotIn("do-not-record-this", json.dumps(receipt))
        self.assertEqual(receipt["flutter_build"], dict(status="recorded", targets=[dict(
            name="release_macos_bundle_flutter_assets", elapsedMilliseconds=1234, skipped=False, succeeded=True)]))
        for variant in variants.VARIANTS:
            app = self.output / variant / "Harness.app"
            self.assertEqual((app / "renderer").read_text(), variant)
            self.assertEqual((app / "payload").read_text(), "shared compiled bytes")
        self.assertFalse((self.desktop / "build/macos/Build/Products/Release/Harness.app/renderer").exists())
        self.assertFalse(list(self.desktop.glob("*-publication.json")), "build-only published artifacts")

    def test_profiling_never_reuses_a_previous_builds_report(self):
        self.output.mkdir(parents=True)
        (self.output / "flutter-build.json").write_text('{"targets": [{"stale": true}]}')
        with mock.patch.dict(os.environ, COORDINATOR_NO_PROFILE="1"):
            result, receipt = self.run_build()
        self.assertEqual(result, 0)
        self.assertEqual(receipt["flutter_build"], dict(status="unavailable"))
        self.assertFalse((self.output / "flutter-build.json").exists())

    def test_profile_retains_timings_without_arbitrary_diagnostic_fields(self):
        path = self.desktop / "profile.json"
        target = dict(name="kernel_snapshot_program", elapsedMilliseconds=123, skipped=False, succeeded=True)
        path.write_text(json.dumps(dict(targets=[dict(target, argv="private-argument")], environment="private-env")))
        self.assertEqual(variants.flutter_timings(path), dict(status="recorded", targets=[target]))

    def test_missing_or_invalid_profiles_are_explicitly_unavailable(self):
        path = self.desktop / "profile.json"
        self.assertEqual(variants.flutter_timings(path), dict(status="unavailable"))
        valid = dict(name="kernel_snapshot_program", elapsedMilliseconds=123, skipped=False, succeeded=True)
        invalid = [None, {}, {"targets": []}, {"targets": [None]}, {"targets": [{"name": "incomplete"}]}]
        for field, value in (("name", "name\\nprivate=value"), ("elapsedMilliseconds", -1),
                             ("elapsedMilliseconds", True), ("skipped", "false"), ("succeeded", None)):
            invalid.append(dict(targets=[dict(valid, **{field: value})]))
        for value in invalid:
            with self.subTest(value=value):
                path.write_text(json.dumps(value))
                self.assertEqual(variants.flutter_timings(path), dict(status="unavailable"))

    def test_publications_overlap_without_sharing_artifact_or_manifest_paths(self):
        result, receipt = self.run_build("--metadata-prefix", "harness/desktop/.ci/123")
        self.assertEqual(result, 0, receipt)
        intel = json.loads((self.desktop / "intel-publication.json").read_text())
        arm = json.loads((self.desktop / "apple-silicon-publication.json").read_text())
        for field in intel:
            self.assertNotEqual(intel[field], arm[field], field)
        self.assertEqual(intel["GCS_PATH"], "harness/desktop/1.2.3/Harness-macos.zip")
        self.assertEqual(arm["GCS_PATH"], "harness/desktop/1.2.3/Harness-macos-arm64.zip")
        self.assertEqual(intel["METADATA_PATH"], "harness/desktop/.ci/123/macos-intel.json")
        self.assertEqual(arm["METADATA_PATH"], "harness/desktop/.ci/123/macos-apple-silicon.json")
        self.assertEqual((self.desktop / "compile-count").read_text(), "1")

    def test_internal_build_prefix_and_suffix_stay_off_product_paths(self):
        prefix = "harness/desktop-internal/" + "a" * 32
        result, receipt = self.run_build("--metadata-prefix", prefix, "--artifact-prefix", prefix, "--artifact-suffix=-1.2.3-abcd123")
        self.assertEqual(result, 0, receipt)
        for variant, filename in variants.VARIANTS.items():
            record = json.loads((self.desktop / f"{variant}-publication.json").read_text())
            self.assertEqual(record["GCS_PATH"], f"{prefix}/{filename}-1.2.3-abcd123.zip")
            self.assertEqual(record["DMG_GCS_PATH"], f"{prefix}/{filename}-1.2.3-abcd123.dmg")

    def test_failed_variant_blocks_success_but_preserves_both_results(self):
        with mock.patch.dict(os.environ, COORDINATOR_FAIL="intel"):
            result, receipt = self.run_build("--metadata-prefix", "harness/desktop/.ci/123")
        self.assertEqual(result, 1)
        results = {item["name"]: item for item in receipt["checks"]}
        self.assertEqual(results["publish-intel"]["status"], "failed")
        self.assertEqual(results["publish-apple-silicon"]["status"], "passed")
        self.assertEqual(receipt["status"], "failed")

    def test_failed_build_never_starts_publication(self):
        with mock.patch.dict(os.environ, COORDINATOR_FAIL="build"):
            result, receipt = self.run_build("--metadata-prefix", "harness/desktop/.ci/123")
        self.assertEqual(result, 1)
        self.assertEqual(len(receipt["checks"]), 1)
        self.assertFalse(list(self.desktop.glob("*-publication.json")))

    def test_invalid_versions_and_paths_fail_before_building(self):
        for arguments in (["../escape"], ["1.2.3", "--metadata-prefix", "../live"],
                          ["1.2.3", "--metadata-prefix", "/absolute"], ["1.2.3", "--artifact-prefix", "prefix"],
                          ["1.2.3", "--metadata-prefix", "scratch", "--artifact-suffix=../../escape"]):
            with self.subTest(arguments=arguments), mock.patch.object(variants, "DESKTOP", self.desktop):
                with self.assertRaises(SystemExit) as error:
                    variants.main(arguments)
                self.assertEqual(error.exception.code, 2)
        self.assertFalse((self.desktop / "compile-count").exists())


if __name__ == "__main__":
    unittest.main()

/// A staging build: `--dart-define=HARNESS_STAGING=true`, which the Windows
/// desktop workflow's release mode sets. It installs the staging CLI
/// (`harnessInstallScriptUrl` in `bootstrap/environment_provisioner.dart`)
/// and polls the staging desktop manifest (`update/desktop_updater.dart`).
const bool kHarnessStagingBuild = bool.fromEnvironment('HARNESS_STAGING');

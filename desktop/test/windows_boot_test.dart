import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/viewer_mode.dart';
import 'package:harness/state/app_state.dart';

import 'support/guest_app.dart';

class _SignedOut extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: false);
}

/// The Windows provisioner on a PC without Harness: a review of its two in-app
/// items, then an install that fails as install.ps1 says it did.
class _WindowsSetup extends EnvironmentProvisioner {
  _WindowsSetup() : super(isMacOS: false, isLinux: false, isWindows: true);

  final installs = <bool>[];

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    installs.add(install);
    final review = EnvironmentReadiness(
      steps: const {
        EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.failed,
      },
      phase: EnvironmentSetupPhase.review,
      plan: [
        EnvironmentPlanItem.windowsHarnessCli,
        EnvironmentPlanItem.windowsTerminalHost,
      ],
    );
    final result = install
        ? review.copyWith(
            phase: EnvironmentSetupPhase.failed,
            mode: mode,
            failure: const EnvironmentFailure(
              step: EnvironmentStep.harness,
              title: 'Harness could not be installed',
              detail:
                  'The step that failed: Reading the release manifests. '
                  'The remote server returned an error: (404) Not Found.',
            ),
          )
        : review;
    onProgress(result);
    return result;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'a Windows PC boots as this computer: setup runs, and installs in-app with no review',
    (tester) async {
      // On Windows CI this is the line that changes: kViewerMode used to be true there.
      expect(kViewerMode, isFalse);
      final setup = _WindowsSetup();
      final app = GuestTestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLogin: _SignedOut(),
        environmentProvisioner: setup,
      );
      expect(app.viewer, isNull);

      await app.bootstrap();

      // The read-only probe, then the install straight away: no Install button to wait on.
      expect(setup.installs, [false, true]);
      expect(app.status, AppStatus.preparingEnvironment);
      expect(
        app.environmentReadiness.failure?.title,
        'Harness could not be installed',
      );
      app.dispose();
    },
  );

  group('the Windows executable', () {
    test('is harness-desktop.exe', () {
      expect(
        File('windows/CMakeLists.txt').readAsStringSync(),
        contains('set(BINARY_NAME "harness-desktop")'),
      );
    });

    test('says Harness, by Autonomous, in its version resource', () {
      final rc = File('windows/runner/Runner.rc').readAsStringSync();
      for (final value in [
        r'VALUE "FileDescription", "Harness" "\0"',
        r'VALUE "ProductName", "Harness" "\0"',
        r'VALUE "CompanyName", "Autonomous" "\0"',
        r'VALUE "InternalName", "harness-desktop" "\0"',
        r'VALUE "OriginalFilename", "harness-desktop.exe" "\0"',
      ]) {
        expect(rc, contains(value));
      }
    });
  });
}

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/measurement/product_measurement.dart';

import 'support/guest_app.dart';

class _SignedOut extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: false);
}

/// Replays what the real provisioner reports on a new Mac, one list of progress values per call.
class _Replay extends EnvironmentProvisioner {
  _Replay(this.calls) : super(isMacOS: true);
  final List<List<EnvironmentReadiness>> calls;
  var call = 0;

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    final values = calls[call < calls.length ? call : calls.length - 1];
    call++;
    for (final value in values) {
      onProgress(value);
    }
    return values.last;
  }
}

EnvironmentReadiness _state(
  EnvironmentSetupPhase phase, {
  EnvironmentStepStatus harness = EnvironmentStepStatus.ready,
  EnvironmentStepStatus tmux = EnvironmentStepStatus.ready,
  EnvironmentStepStatus clipboard = EnvironmentStepStatus.ready,
  EnvironmentFailure? failure,
}) => EnvironmentReadiness(
  steps: {
    EnvironmentStep.harness: harness,
    EnvironmentStep.tmux: tmux,
    EnvironmentStep.clipboard: clipboard,
  },
  phase: phase,
  mode: EnvironmentSetupMode.automatic,
  failure: failure,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const failed = EnvironmentStepStatus.failed;
  const running = EnvironmentStepStatus.running;
  const pending = EnvironmentStepStatus.pending;

  // The first check finds both tools missing (the probe reports them as failed), the review is
  // skipped because everything installs in-app, and the install re-checks before installing.
  final check = [
    _state(
      EnvironmentSetupPhase.preflight,
      harness: pending,
      tmux: pending,
      clipboard: pending,
    ),
    _state(EnvironmentSetupPhase.preflight, harness: failed, tmux: failed),
    _state(EnvironmentSetupPhase.review, harness: failed, tmux: failed),
  ];
  final installStart = [
    _state(EnvironmentSetupPhase.installing, harness: running, tmux: running),
    _state(EnvironmentSetupPhase.installing, harness: failed, tmux: failed),
    _state(EnvironmentSetupPhase.installing, harness: failed, tmux: running),
    _state(EnvironmentSetupPhase.installing, harness: failed),
    _state(EnvironmentSetupPhase.installing, harness: running),
  ];

  Future<Map<String, dynamic>> run(
    List<List<EnvironmentReadiness>> calls,
  ) async {
    final sent = <Map<String, dynamic>>[];
    final usage = ProductMeasurement(
      surface: 'desktop',
      automatic: false,
      sendSetup: (report) async {
        sent.add(jsonDecode(jsonEncode(report)) as Map<String, dynamic>);
        return {'accepted': true};
      },
    );
    final app = GuestTestApp(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      cliLogin: _SignedOut(),
      environmentProvisioner: _Replay(calls),
      productMeasurement: usage,
    );
    await app.bootstrap();
    await usage.flush();
    app.dispose(); // Disposes the measurement it was given too.
    return {
      for (final report in sent) ...report['counters'] as Map<String, dynamic>,
    };
  }

  test(
    'a new computer whose missing tools install counts no failed step',
    () async {
      final counters = await run([
        check,
        [
          ...installStart,
          _state(EnvironmentSetupPhase.installing),
          _state(EnvironmentSetupPhase.verifying),
          _state(EnvironmentSetupPhase.ready),
        ],
      ]);
      for (final step in ['harness', 'tmux']) {
        expect(
          counters['setup_desktop_setup_${step}_started'],
          1,
          reason: step,
        );
        expect(counters['setup_desktop_setup_${step}_ok'], 1, reason: step);
        expect(
          counters['setup_desktop_setup_${step}_missing'],
          1,
          reason: step,
        );
        expect(counters, isNot(contains('setup_desktop_setup_${step}_failed')));
      }
      expect(counters['setup_desktop_setup_clipboard_ok'], 1);
      expect(
        counters,
        isNot(contains('setup_desktop_setup_clipboard_missing')),
      );
      expect(counters['setup_desktop_setup_ok'], 1);
    },
  );

  test('a setup that ends failed still fails the step that failed', () async {
    final counters = await run([
      check,
      [
        ...installStart,
        _state(
          EnvironmentSetupPhase.failed,
          harness: failed,
          failure: const EnvironmentFailure(
            title: 'Setup could not finish',
            detail: 'synthetic',
          ),
        ),
      ],
    ]);
    expect(counters['setup_desktop_setup_harness_failed'], 1);
    expect(counters['setup_desktop_setup_harness_missing'], 1);
    expect(counters['setup_desktop_setup_tmux_ok'], 1);
    expect(counters['setup_desktop_setup_failed'], 1);
  });
}

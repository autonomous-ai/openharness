import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/bootstrap/setup_progress.dart';

/// The setup tour's bar: time-based like an OS installer, moving forward
/// only, and done only when setup, the app's start and every download are.
class _Setup extends ChangeNotifier {
  EnvironmentReadiness readiness = _installing();
  bool appReady = false;

  void set(EnvironmentReadiness value, {bool? ready}) {
    readiness = value;
    if (ready != null) appReady = ready;
    notifyListeners();
  }
}

EnvironmentReadiness _installing({
  EnvironmentStepStatus harness = EnvironmentStepStatus.running,
  EnvironmentStepStatus tmux = EnvironmentStepStatus.running,
}) => EnvironmentReadiness(
  steps: {
    EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
    EnvironmentStep.tmux: tmux,
    EnvironmentStep.harness: harness,
  },
  phase: EnvironmentSetupPhase.installing,
  mode: EnvironmentSetupMode.automatic,
);

const _ready = EnvironmentReadiness(
  steps: {
    EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
    EnvironmentStep.tmux: EnvironmentStepStatus.ready,
    EnvironmentStep.harness: EnvironmentStepStatus.ready,
  },
  phase: EnvironmentSetupPhase.ready,
  mode: EnvironmentSetupMode.automatic,
);

void main() {
  late _Setup setup;
  late ValueNotifier<SetupDownloads> downloads;
  late DateTime clock;
  late SetupProgressTracker tracker;

  setUp(() {
    setup = _Setup();
    downloads = ValueNotifier(SetupDownloads.none);
    clock = DateTime(2026, 10, 8, 12);
    tracker = SetupProgressTracker(
      setup: setup,
      readiness: () => setup.readiness,
      appReady: () => setup.appReady,
      downloads: downloads,
      now: () => clock,
      // Driven by hand below; the real one ticks every second.
      tick: const Duration(days: 1),
    );
  });

  tearDown(() {
    tracker.dispose();
    downloads.dispose();
    setup.dispose();
  });

  void advance(Duration by) {
    clock = clock.add(by);
    tracker.update();
  }

  // tmux 12 s + Harness CLI 35 s + the app's start 6 s.
  const expectedTotal = Duration(seconds: 53);

  test('runs on the clock and never reaches the end before done', () {
    expect(tracker.value.fraction, 0);
    expect(tracker.value.left, expectedTotal);

    advance(const Duration(seconds: 20));
    final early = tracker.value;
    expect(early.left, const Duration(seconds: 33));
    expect(early.fraction, greaterThan(0.2));
    expect(early.fraction, lessThan(0.9));
    expect(early.done, isFalse);

    // Long past the estimate (a slow connection): no time left is claimed,
    // and the bar creeps without ever filling.
    advance(const Duration(minutes: 5));
    final late = tracker.value;
    expect(late.left, isNull);
    expect(late.fraction, greaterThanOrEqualTo(0.9));
    expect(late.fraction, lessThan(1));
    expect(late.done, isFalse);
  });

  test('a step that finishes early moves the bar on', () {
    advance(const Duration(seconds: 5));
    final before = tracker.value;
    setup.set(_installing(tmux: EnvironmentStepStatus.ready));
    final after = tracker.value;
    expect(after.fraction, greaterThan(before.fraction));
    // The CLI and the start remain, counted from now.
    expect(after.left, const Duration(seconds: 41));
  });

  test('done takes setup, the app and every download', () {
    setup.set(_ready);
    expect(tracker.value.done, isFalse, reason: 'the app has not started');

    downloads.value = const SetupDownloads.pending(
      lines: ['Agents: OpenCode ✓, Codex 61 of 137 MB'],
    );
    setup.set(_ready, ready: true);
    expect(tracker.value.done, isFalse, reason: 'a download is pending');
    expect(tracker.value.fraction, lessThan(1));

    downloads.value = SetupDownloads.none;
    expect(tracker.value.done, isTrue);
    expect(tracker.value.fraction, 1);
    expect(tracker.value.failed, isFalse);
  });

  test("a download's own estimate and bytes hold the bar back", () {
    downloads.value = const SetupDownloads.pending(
      fraction: 0.05,
      left: Duration(seconds: 90),
    );
    advance(const Duration(seconds: 10));
    // Longer than setup's own 43 s, so it is the time left.
    expect(tracker.value.left, const Duration(seconds: 90));
    // 5% of the bytes is 5% of the bar, whatever the clock says.
    expect(tracker.value.fraction, closeTo(0.99 * 0.05, 1e-9));
  });

  test('a failure stops the clock for Retry, and the bar never goes back', () {
    advance(const Duration(seconds: 30));
    final shown = tracker.value.fraction;
    setup.set(
      _installing().copyWith(
        phase: EnvironmentSetupPhase.failed,
        failure: const EnvironmentFailure(
          step: EnvironmentStep.harness,
          title: 'Could not install Harness',
          detail: 'Check your connection, then retry setup.',
        ),
      ),
    );
    expect(tracker.value.failed, isTrue);
    expect(tracker.value.failure, 'Could not install Harness');
    expect(tracker.value.fraction, shown);
    expect(tracker.value.done, isFalse);

    // Retry: the estimate starts again; the bar keeps what it showed.
    setup.set(_installing());
    expect(tracker.value.failed, isFalse);
    expect(tracker.value.fraction, shown);
    expect(tracker.value.left, expectedTotal);
  });
}

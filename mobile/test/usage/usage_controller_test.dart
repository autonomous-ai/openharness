import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/usage/usage_accounts.dart';
import 'package:harness_mobile/usage/usage_controller.dart';
import 'package:harness_mobile/usage/usage_window.dart';

/// The Usage page's poller, as a phone runs it: no local account at all, every
/// figure asked of the linked machines over the relay once a minute.
///
/// What is pinned here is what the page draws between two answers — above all
/// that a figure already on screen is not blanked by one bad round trip.
void main() {
  ProviderUsage claude({double used = 40, UsageStatus? status}) =>
      ProviderUsage(
        provider: UsageProvider.claude,
        status: status ?? UsageStatus.ok,
        account: 'k1',
        message: status == UsageStatus.failed ? 'Claude answered 429' : null,
        windows: status == null || status == UsageStatus.ok
            ? [UsageWindow(label: kWeeklyWindowLabel, usedPercent: used)]
            : const [],
      );

  ProviderUsage codex({double used = 10}) => ProviderUsage(
    provider: UsageProvider.codex,
    status: UsageStatus.ok,
    account: 'k2',
    windows: [UsageWindow(label: '5h', usedPercent: used)],
  );

  MachineUsage studio(List<ProviderUsage> readings) =>
      MachineUsage(machineName: 'Studio', readings: readings);
  MachineUsage laptop(List<ProviderUsage> readings) =>
      MachineUsage(machineName: 'Laptop', readings: readings);

  /// A controller whose every cycle is answered by the next entry of
  /// [answers] — a list, or an error to throw.
  UsageController controller(List<Object> answers) {
    final queue = [...answers];
    return UsageController(
      remote: () async {
        final next = queue.removeAt(0);
        if (next is List<MachineUsage>) return next;
        throw next;
      },
    );
  }

  double? weekly(UsageController usage, UsageProvider provider) => usage
      .accounts
      .where((a) => a.provider == provider)
      .firstOrNull
      ?.reading
      .railWindow
      ?.usedPercent;

  test('nobody asked yet: not loading, and no answer', () {
    final usage = controller(const []);
    addTearDown(usage.dispose);
    // Under `flutter test` a controller never starts itself — and one nobody
    // started is not WAITING for anything, so no skeleton is owed.
    expect(usage.loading, isFalse);
    expect(usage.hasAnswer, isFalse);
    expect(usage.readings, isEmpty);
    expect(usage.answered, isEmpty);
  });

  test('with nobody to ask, the first cycle still resolves — empty', () async {
    final usage = UsageController();
    addTearDown(usage.dispose);
    var notified = 0;
    usage.addListener(() => notified++);
    await usage.refresh();
    expect(usage.hasAnswer, isTrue);
    expect(usage.loading, isFalse);
    expect(usage.accounts, isEmpty);
    expect(usage.stale, isFalse);
    expect(notified, 1);
  });

  test('loading while the first answer is on its way, then the figures', () {
    final answer = Completer<List<MachineUsage>>();
    final usage = UsageController(remote: () => answer.future);
    addTearDown(usage.dispose);
    final cycle = usage.refresh();
    expect(usage.loading, isTrue);
    answer.complete([
      studio([claude()]),
    ]);
    return cycle.then((_) {
      expect(usage.loading, isFalse);
      expect(usage.machines.single.machineName, 'Studio');
      expect(weekly(usage, UsageProvider.claude), 40);
      expect(usage.stale, isFalse);
    });
  });

  test(
    'a first cycle that threw resolves to the empty state, not a spinner',
    () async {
      final usage = controller([StateError('relay down')]);
      addTearDown(usage.dispose);
      await usage.refresh();
      expect(usage.hasAnswer, isTrue);
      expect(usage.loading, isFalse);
      expect(usage.stale, isFalse, reason: 'nothing on screen to be old');
    },
  );

  test('a cycle that threw keeps the figures, and calls them stale', () async {
    final usage = controller([
      [
        studio([claude()]),
      ],
      StateError('relay down'),
    ]);
    addTearDown(usage.dispose);
    await usage.refresh();
    await usage.refresh();
    expect(weekly(usage, UsageProvider.claude), 40);
    expect(usage.stale, isTrue);
  });

  test(
    'a cycle nobody answered keeps the figures, and calls them stale',
    () async {
      final usage = controller([
        [
          studio([claude()]),
        ],
        <MachineUsage>[],
      ]);
      addTearDown(usage.dispose);
      await usage.refresh();
      await usage.refresh();
      expect(weekly(usage, UsageProvider.claude), 40);
      expect(usage.stale, isTrue);
    },
  );

  test('a fresh answer replaces the figures and is not stale', () async {
    final usage = controller([
      [
        studio([claude()]),
      ],
      <MachineUsage>[],
      [
        studio([claude(used: 55)]),
      ],
    ]);
    addTearDown(usage.dispose);
    for (var i = 0; i < 3; i++) {
      await usage.refresh();
    }
    expect(weekly(usage, UsageProvider.claude), 55);
    expect(usage.stale, isFalse);
  });

  group('a partial or failed answer', () {
    test('a vendor that failed this once keeps the figure it last gave', () async {
      // Claude's usage endpoint answers 429 as a matter of course, and a
      // machine that could not reach it this minute has said nothing new about
      // the account — the figure it gave a minute ago is still the best one
      // there is. Replacing it with the failure blanked the card (the page
      // drew "Could not read usage") until the next minute brought it back.
      final usage = controller([
        [
          studio([claude(), codex()]),
        ],
        [
          studio([claude(status: UsageStatus.failed), codex(used: 12)]),
        ],
      ]);
      addTearDown(usage.dispose);
      await usage.refresh();
      await usage.refresh();
      expect(weekly(usage, UsageProvider.claude), 40);
      expect(weekly(usage, UsageProvider.codex), 12);
      expect(usage.stale, isTrue);
    });

    test('a machine missing from an answer keeps its figures too', () async {
      // `readRemoteUsage` drops a machine that timed out rather than
      // reporting it — the same silence the empty-cycle rule above already
      // keeps the page through, for one machine instead of all of them.
      final usage = controller([
        [
          studio([claude()]),
          laptop([codex()]),
        ],
        [
          laptop([codex(used: 20)]),
        ],
      ]);
      addTearDown(usage.dispose);
      await usage.refresh();
      await usage.refresh();
      expect(weekly(usage, UsageProvider.claude), 40);
      expect(weekly(usage, UsageProvider.codex), 20);
      expect(usage.stale, isTrue);
    });

    test('signing out there is news, and takes the figure down', () async {
      final usage = controller([
        [
          studio([claude()]),
        ],
        [
          studio([claude(status: UsageStatus.signedOut)]),
        ],
      ]);
      addTearDown(usage.dispose);
      await usage.refresh();
      await usage.refresh();
      expect(weekly(usage, UsageProvider.claude), isNull);
      expect(usage.stale, isFalse);
    });

    test(
      'a failure with no figure before it is shown as the failure',
      () async {
        final usage = controller([
          [
            studio([claude(status: UsageStatus.failed)]),
          ],
        ]);
        addTearDown(usage.dispose);
        await usage.refresh();
        expect(usage.accounts, isEmpty);
        expect(
          usage.machines.single.readings.single.message,
          'Claude answered 429',
        );
        expect(usage.stale, isFalse);
      },
    );
  });

  test('a slower, older answer never overwrites a newer one', () async {
    final first = Completer<List<MachineUsage>>();
    final second = Completer<List<MachineUsage>>();
    final queue = [first, second];
    final usage = UsageController(remote: () => queue.removeAt(0).future);
    addTearDown(usage.dispose);
    final older = usage.refresh();
    final newer = usage.refresh();
    second.complete([
      studio([claude(used: 70)]),
    ]);
    await newer;
    first.complete([
      studio([claude(used: 10)]),
    ]);
    await older;
    expect(weekly(usage, UsageProvider.claude), 70);
  });

  test(
    'an older cycle that threw after a newer one landed changes nothing',
    () async {
      final first = Completer<List<MachineUsage>>();
      final second = Completer<List<MachineUsage>>();
      final queue = [first, second];
      final usage = UsageController(remote: () => queue.removeAt(0).future);
      addTearDown(usage.dispose);
      final older = usage.refresh();
      final newer = usage.refresh();
      second.complete([
        studio([claude()]),
      ]);
      await newer;
      first.completeError(StateError('late'));
      await older;
      expect(usage.stale, isFalse);
    },
  );

  test('an answer that lands after the page closed touches nothing', () async {
    final answer = Completer<List<MachineUsage>>();
    final usage = UsageController(remote: () => answer.future);
    final landed = usage.refresh();
    usage.dispose();
    answer.complete([
      studio([claude()]),
    ]);
    // Notifying a disposed ChangeNotifier throws; landing quietly is the pass.
    await landed;
    final nobody = UsageController();
    nobody.dispose();
    await nobody.refresh();
  });

  test('a thrown cycle after the page closed touches nothing', () async {
    final answer = Completer<List<MachineUsage>>();
    final usage = UsageController(remote: () => answer.future);
    final landed = usage.refresh();
    usage.dispose();
    answer.completeError(StateError('late'));
    await landed;
  });

  test('once started it asks now, then once a minute, until disposed', () {
    fakeAsync((async) {
      var asked = 0;
      final usage = UsageController(
        remote: () async {
          asked++;
          return const <MachineUsage>[];
        },
        autoStart: false,
      );
      usage.start();
      // A second start is not a second timer.
      usage.start();
      async.flushMicrotasks();
      expect(asked, 1);
      async.elapse(const Duration(seconds: 60));
      expect(asked, 2);
      usage.dispose();
      async.elapse(const Duration(minutes: 5));
      expect(asked, 2);
      // Nor does a disposed controller start again.
      usage.start();
      async.elapse(const Duration(minutes: 1));
      expect(asked, 2);
    });
  });
}

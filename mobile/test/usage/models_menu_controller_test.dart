import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/usage/models_menu_controller.dart';
import 'package:harness_mobile/usage/usage_accounts.dart';
import 'package:harness_mobile/usage/usage_controller.dart';
import 'package:harness_mobile/usage/usage_window.dart';

/// The model sheet's first row: what this agent's own subscription has left.
///
/// A figure there is read at a glance while choosing where an agent runs, so
/// the row must never print a number it cannot stand behind — an old reading,
/// a window that has since reset, a refresh that failed — as if it were live.
void main() {
  late DateTime now;

  setUp(() => now = DateTime(2026, 9, 27, 12));

  ProviderUsage reading({
    UsageProvider provider = UsageProvider.claude,
    List<UsageWindow>? windows,
    String? account,
    Duration age = const Duration(seconds: 30),
  }) => ProviderUsage(
    provider: provider,
    status: UsageStatus.ok,
    account: account,
    fetchedAt: now.subtract(age),
    windows:
        windows ??
        [
          UsageWindow(
            label: 'Session',
            usedPercent: 71,
            resetsAt: now.add(const Duration(hours: 2, minutes: 5)),
          ),
          const UsageWindow(label: kWeeklyWindowLabel, usedPercent: 40),
        ],
  );

  /// A controller over one machine whose answer is [answer], asked with a
  /// clock the test moves.
  ModelsMenuController menu(
    List<ProviderUsage> Function() answer, {
    void Function()? onAsk,
  }) {
    final controller = ModelsMenuController(
      remote: () async {
        onAsk?.call();
        return [MachineUsage(machineName: 'Studio', readings: answer())];
      },
      now: () => now,
    );
    addTearDown(controller.dispose);
    return controller;
  }

  test('nothing to show before the first refresh', () {
    expect(menu(() => [reading()]).rows, isEmpty);
  });

  test(
    'a live figure: what the limiting window has left, then each one',
    () async {
      final controller = menu(() => [reading(account: '0123456789abcdef')]);
      await controller.refresh();
      final row = controller.rows.single;
      expect(row['title'], 'Anthropic');
      expect(row['engine'], 'claude');
      // The opaque account key, shortened — never an email.
      expect(row['account'], '012345');
      // The SESSION window: the weekly one reads healthier while the shorter
      // window is what stops work first.
      expect(row['status'], '29% remaining');
      expect(row['details'], [
        'Limiting window: Session',
        'Session — 29% remaining · resets in 2h 5m',
        'Weekly — 60% remaining',
      ]);
    },
  );

  test(
    'Codex rows are OpenAI\'s, and a key that is not ours shows nothing',
    () async {
      final controller = menu(
        () => [reading(provider: UsageProvider.codex, account: 'someone@x.io')],
      );
      await controller.refresh();
      final row = controller.rows.single;
      expect(row['title'], 'OpenAI');
      expect(row['engine'], 'codex');
      expect(row['iconAsset'], 'assets/engine-icons/codex.png');
      expect(row['account'], '');
    },
  );

  test('a sliver left is "<1%", never rounded down to nothing', () async {
    final controller = menu(
      () => [
        reading(
          windows: const [UsageWindow(label: 'Weekly', usedPercent: 99.6)],
        ),
      ],
    );
    await controller.refresh();
    expect(controller.rows.single['status'], '<1% remaining');
  });

  test(
    'a spent window is 0%, and a partial balance never reads 100%',
    () async {
      final controller = menu(
        () => [
          reading(
            windows: const [
              UsageWindow(label: 'Session', usedPercent: 100),
              UsageWindow(label: 'Weekly', usedPercent: 0.4),
            ],
          ),
        ],
      );
      await controller.refresh();
      expect(controller.rows.single['details'], [
        'Limiting window: Session',
        'Session — 0% remaining',
        'Weekly — 99% remaining',
      ]);
    },
  );

  group('a reading that can no longer be stood behind', () {
    test('older than two minutes: unavailable, and says why', () async {
      final controller = menu(() => [reading(age: const Duration(minutes: 3))]);
      await controller.refresh();
      final row = controller.rows.single;
      expect(row['status'], 'Usage unavailable');
      expect(row['details'], [
        'The last reading has expired. Reopen Models to refresh.',
      ]);
    });

    test('a window whose reset has passed since it was read', () async {
      final controller = menu(
        () => [
          reading(
            windows: [
              UsageWindow(
                label: 'Session',
                usedPercent: 71,
                resetsAt: now.add(const Duration(seconds: 30)),
              ),
            ],
          ),
        ],
      );
      await controller.refresh();
      expect(controller.rows.single['status'], '29% remaining');
      // The reading is barely a minute old, but the session window reset
      // after it was taken: its 71% describes a window that is gone.
      now = now.add(const Duration(seconds: 45));
      expect(controller.rows.single['status'], 'Usage unavailable');
    });

    test(
      'a refresh that threw: unavailable, with no raw error in it',
      () async {
        final usage = _ThrowingUsage();
        final controller = ModelsMenuController(usage: usage, now: () => now);
        addTearDown(() {
          controller.dispose();
          usage.dispose();
        });
        await controller.refresh();
        final row = controller.rows.single;
        expect(row['status'], 'Usage unavailable');
        expect(row['details'], ['Usage unavailable']);
        expect('$row', isNot(contains('secret-token')));
      },
    );
  });

  group('refresh', () {
    test('at most once a minute; the cache answers in between', () async {
      var asked = 0;
      final controller = menu(() => [reading()], onAsk: () => asked++);
      await controller.refresh();
      await controller.refresh();
      expect(asked, 1);
      now = now.add(const Duration(minutes: 1));
      await controller.refresh();
      expect(asked, 2);
    });

    test('a refresh already on its way is shared, not repeated', () async {
      var asked = 0;
      final gate = Completer<void>();
      final controller = ModelsMenuController(
        remote: () async {
          asked++;
          await gate.future;
          return [
            MachineUsage(machineName: 'Studio', readings: [reading()]),
          ];
        },
        now: () => now,
      );
      addTearDown(controller.dispose);
      var notified = 0;
      controller.addListener(() => notified++);
      final first = controller.refresh();
      final second = controller.refresh();
      expect(identical(first, second), isTrue);
      gate.complete();
      await first;
      expect(asked, 1);
      expect(notified, greaterThanOrEqualTo(2));
    });

    test('after the sheet closed, nothing is asked', () async {
      var asked = 0;
      final controller = ModelsMenuController(
        remote: () async {
          asked++;
          return const <MachineUsage>[];
        },
        now: () => now,
      );
      controller.dispose();
      await controller.refresh();
      expect(asked, 0);
    });

    test('a controller handed in is left for its owner to dispose', () async {
      final usage = UsageController(autoStart: false);
      final controller = ModelsMenuController(usage: usage, now: () => now);
      controller.dispose();
      // Still usable: disposing it would throw on the listener below.
      usage.addListener(() {});
      usage.dispose();
    });
  });
}

/// A usage source whose refresh throws something that must never reach the
/// menu — an exception can carry authentication data.
class _ThrowingUsage extends UsageController {
  _ThrowingUsage() : super(autoStart: false);

  @override
  List<UsageAccount> get accounts => [
    UsageAccount(
      reading: ProviderUsage(
        provider: UsageProvider.claude,
        status: UsageStatus.ok,
        fetchedAt: DateTime(2026, 9, 27, 12),
        windows: const [UsageWindow(label: 'Weekly', usedPercent: 10)],
      ),
      isLocal: false,
    ),
  ];

  @override
  Future<void> refresh() async => throw StateError('secret-token');
}

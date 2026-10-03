import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/usage/usage_accounts.dart';
import 'package:harness_mobile/usage/usage_window.dart';

/// One figure per ACCOUNT, however many machines are signed in to it.
///
/// A rate limit belongs to a subscription, not to a computer: three laptops on
/// one Claude plan printed as three cards would triple-count one budget, while
/// two plans merged into one card would hide the one that is running out.
void main() {
  ProviderUsage figures(
    UsageProvider provider, {
    String? account,
    double used = 40,
  }) => ProviderUsage(
    provider: provider,
    status: UsageStatus.ok,
    account: account,
    windows: [UsageWindow(label: kWeeklyWindowLabel, usedPercent: used)],
  );

  MachineUsage machine(String name, List<ProviderUsage> readings) =>
      MachineUsage(machineName: name, readings: readings);

  test('machines on one account are one figure that names them all', () {
    final accounts = groupUsageAccounts(const [], [
      machine('Studio', [figures(UsageProvider.claude, account: 'k1')]),
      machine('Laptop', [figures(UsageProvider.claude, account: 'k1')]),
    ]);
    expect(accounts, hasLength(1));
    expect(accounts.single.isLocal, isFalse);
    expect(accounts.single.provider, UsageProvider.claude);
    expect(accounts.single.machines, ['Studio', 'Laptop']);
  });

  test('a second subscription is a figure of its own', () {
    final accounts = groupUsageAccounts(const [], [
      machine('Studio', [figures(UsageProvider.claude, account: 'k1')]),
      machine('Laptop', [figures(UsageProvider.claude, account: 'k2')]),
    ]);
    expect(
      [for (final a in accounts) a.machines],
      [
        ['Studio'],
        ['Laptop'],
      ],
    );
  });

  test('two readings nobody can name are never merged', () {
    final accounts = groupUsageAccounts(const [], [
      machine('Studio', [figures(UsageProvider.codex)]),
      machine('Laptop', [figures(UsageProvider.codex)]),
    ]);
    expect(accounts, hasLength(2));
  });

  test('a machine with nothing to show adds nothing', () {
    final accounts = groupUsageAccounts(const [], [
      machine('Studio', [
        const ProviderUsage(
          provider: UsageProvider.claude,
          status: UsageStatus.signedOut,
        ),
      ]),
      machine('Laptop', const []),
    ]);
    expect(accounts, isEmpty);
  });

  test('providers in order: every Claude account before any Codex one', () {
    final accounts = groupUsageAccounts(const [], [
      machine('Studio', [
        figures(UsageProvider.codex, account: 'c'),
        figures(UsageProvider.claude, account: 'a'),
      ]),
    ]);
    expect(
      [for (final a in accounts) a.provider],
      [UsageProvider.claude, UsageProvider.codex],
    );
  });

  group('beside a local account (the desktop half of the same rule)', () {
    test('a remote machine on the same account joins the local figure', () {
      final accounts = groupUsageAccounts(
        [figures(UsageProvider.claude, account: 'k1')],
        [
          machine('Studio', [figures(UsageProvider.claude, account: 'k1')]),
        ],
      );
      expect(accounts, hasLength(1));
      expect(accounts.single.isLocal, isTrue);
      expect(accounts.single.machines, ['Studio']);
    });

    test('a local reading with no figures swallows nothing', () {
      // Otherwise a token that expired HERE would hide the live reading a
      // remote machine took of the very same account.
      final accounts = groupUsageAccounts(
        [
          const ProviderUsage(
            provider: UsageProvider.claude,
            status: UsageStatus.signedOut,
            account: 'k1',
          ),
        ],
        [
          machine('Studio', [figures(UsageProvider.claude, account: 'k1')]),
        ],
      );
      expect([for (final a in accounts) a.isLocal], [true, false]);
      expect(accounts.last.machines, ['Studio']);
    });
  });
}

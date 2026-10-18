import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/usage_entry.dart';
import 'package:harness_mobile/phone/usage_page.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/usage/usage_accounts.dart';
import 'package:harness_mobile/usage/usage_summary.dart';
import 'package:harness_mobile/usage/usage_window.dart';

/// A phone whose linked machines answer `usage_read` with [answer].
class _Usage extends AppNotifier {
  _Usage(this.answer)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  final List<MachineUsage> answer;

  @override
  Future<List<MachineUsage>> readRemoteUsage({String? machineId}) async =>
      answer;
}

/// The Usage page's headline and the Settings row it feeds: the tightest
/// window, as what is LEFT of it — the figure the model sheet and the desktop
/// print — never the weekly one as what is spent.
void main() {
  setUp(() => lastUsageSummary.value = null);
  tearDown(() => lastUsageSummary.value = null);

  ProviderUsage reading(UsageProvider provider, List<UsageWindow> windows) =>
      ProviderUsage(
        provider: provider,
        status: UsageStatus.ok,
        windows: windows,
        account: provider.name,
      );

  /// Opens the page on [answer] and pulls it down once: under test the page's
  /// controller never polls on its own, so the pull is its first cycle.
  Future<_Usage> openPage(
    WidgetTester tester,
    List<MachineUsage> answer,
  ) async {
    final app = _Usage(answer);
    addTearDown(app.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.dark),
        home: UsagePage(notifier: app),
      ),
    );
    await tester.fling(
      find.byType(Scrollable).first,
      const Offset(0, 400),
      1000,
    );
    await tester.pumpAndSettle();
    return app;
  }

  Color? inkOf(WidgetTester tester, String text) =>
      tester.widget<Text>(find.text(text)).style?.color;

  testWidgets('each card heads with its tightest window, as what is left', (
    tester,
  ) async {
    await openPage(tester, [
      MachineUsage(
        machineName: 'Studio',
        readings: [
          reading(UsageProvider.claude, const [
            UsageWindow(label: 'Session', usedPercent: 85),
            UsageWindow(label: kWeeklyWindowLabel, usedPercent: 40),
          ]),
        ],
      ),
      MachineUsage(
        machineName: 'Laptop',
        readings: [
          reading(UsageProvider.codex, const [
            UsageWindow(label: kWeeklyWindowLabel, usedPercent: 10),
          ]),
        ],
      ),
    ]);

    // Claude's session window is the one about to stop the work, though its
    // week looks healthy.
    expect(find.text('Session'), findsOneWidget);
    expect(find.text('15% remaining'), findsOneWidget);
    expect(find.text('90% remaining'), findsOneWidget);
    expect(find.textContaining('used'), findsNothing);
    // The week is detail, behind a tap.
    expect(find.text('60% remaining'), findsNothing);
    await tester.tap(find.text('Claude'));
    await tester.pumpAndSettle();
    expect(find.text('60% remaining'), findsOneWidget);

    // The Settings row prints the same words, for the account with least left.
    expect(lastUsageSummary.value, '15% remaining');
    final settings = _Usage(const []);
    addTearDown(settings.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: Builder(
            builder: (context) => buildUsageSettingsRow(context, settings),
          ),
        ),
      ),
    );
    expect(find.text('15% remaining'), findsOneWidget);
  });

  testWidgets('neutral above 20% left, muted amber to 6%, red at 5%', (
    tester,
  ) async {
    await openPage(tester, [
      MachineUsage(
        machineName: 'Studio',
        readings: [
          reading(UsageProvider.claude, const [
            UsageWindow(label: 'Session', usedPercent: 79),
            UsageWindow(label: kWeeklyWindowLabel, usedPercent: 80),
            UsageWindow(label: 'Fable', usedPercent: 94),
          ]),
        ],
      ),
      MachineUsage(
        machineName: 'Laptop',
        readings: [
          reading(UsageProvider.codex, const [
            UsageWindow(label: kWeeklyWindowLabel, usedPercent: 95),
          ]),
        ],
      ),
    ]);
    await tester.tap(find.text('Claude'));
    await tester.pumpAndSettle();

    expect(inkOf(tester, '21% remaining'), AppPalette.textPrimary);
    expect(inkOf(tester, '20% remaining'), AppPalette.usageLow);
    expect(inkOf(tester, '6% remaining'), AppPalette.usageLow);
    expect(inkOf(tester, '5% remaining'), AppPalette.usageCritical);
    // Claude's headline is its 6% window; Codex's 5% is the least left.
    expect(lastUsageSummary.value, '5% remaining');
  });
}

// The phone footer offers Subscriptions only once the account has a computer:
// before one, there is no agent account to read and the row leads nowhere.
// While the machine list is still on its way it stays, so an account that has
// computers never loses it to a slow read.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/web/footer/web_footer_bar.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/web/shell/web_layout.dart';
import 'package:harness/web/tabs/web_tab_switcher.dart';

class _Account extends AppNotifier {
  _Account()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  bool loaded = true;
  @override
  bool get machineInventoryLoaded => loaded;
}

const _menuButton = ValueKey('web-footer-menu-button');
const _subscriptionsRow = ValueKey('web-footer:Subscriptions');

void main() {
  Future<_Account> mount(
    WidgetTester tester, {
    bool loaded = true,
    bool computer = false,
    WorkspaceChrome Function(AppNotifier app) chrome = webWorkspaceChrome,
  }) async {
    final app = _Account()..loaded = loaded;
    addTearDown(app.dispose);
    app.currentUser = const CurrentUserProfile(email: 'new@example.test');
    app.newSwarm(newTabPage: true);
    if (computer) {
      const machine = Machine(
        machineId: 'm',
        name: 'Studio Mac',
        authMode: MachineAuthMode.remote,
      );
      app.machines.add(machine);
      app.machineStates['m'] = MachineState(machine)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected;
    }
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SwarmScreen(
          notifier: app,
          nativeTabs: false,
          chrome: chrome(app),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 200));
    return app;
  }

  /// Every row the footer's menu holds, by its title.
  Future<bool> menuOffersSubscriptions(WidgetTester tester) async {
    await tester.tap(find.byKey(_menuButton));
    await tester.pump(const Duration(milliseconds: 200));
    final offered = find.byKey(_subscriptionsRow).evaluate().isNotEmpty;
    await tester.tapAt(const Offset(5, 5));
    await tester.pump(const Duration(milliseconds: 200));
    return offered;
  }

  Finder footerLabel(String text) =>
      find.descendant(of: find.byKey(_menuButton), matching: find.text(text));

  testWidgets('an account with no computer is not offered Subscriptions', (
    tester,
  ) async {
    await mount(tester);
    // No subscription figures either: there is no computer to read them on.
    expect(footerLabel('Subscriptions'), findsNothing);
    expect(find.textContaining('Claude Code'), findsNothing);
    // The footer still says something true, and leads to Machines.
    expect(footerLabel('Machines 0'), findsOneWidget);
    expect(await menuOffersSubscriptions(tester), isFalse);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('while the machine list is on its way, Subscriptions stays', (
    tester,
  ) async {
    await mount(tester, loaded: false);
    expect(footerLabel('Machines 0'), findsNothing);
    expect(await menuOffersSubscriptions(tester), isTrue);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('an account with a computer is offered Subscriptions', (
    tester,
  ) async {
    await mount(tester, computer: true);
    expect(await menuOffersSubscriptions(tester), isTrue);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a host that leaves the switch off keeps Subscriptions', (
    tester,
  ) async {
    await mount(
      tester,
      chrome: (app) => WorkspaceChrome(
        leadingWidth: (_) => 0,
        leading: (_, _) => const SizedBox.shrink(),
        compactTabs: (context, commands) =>
            WebTabSwitcher(app: app, commands: commands),
        compactFooter: (context, footer) => WebFooterBar(footer: footer),
        compactBelow: kWebCompactBelow,
      ),
    );
    expect(footerLabel('Machines 0'), findsNothing);
    expect(await menuOffersSubscriptions(tester), isTrue);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}

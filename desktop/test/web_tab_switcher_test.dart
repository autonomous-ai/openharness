import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/widgets/web_download_button.dart';

import 'support/real_fonts.dart';

/// The web workspace on a phone: one tab switcher instead of a tab row.
void main() {
  setUpAll(loadRealFonts);
  final boundary = GlobalKey();

  Future<AppNotifier> mount(
    WidgetTester tester,
    Size size, {
    int harnesses = 0,
  }) async {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    for (var i = 0; i < 4; i++) {
      app.newSwarm(newTabPage: true);
    }
    if (harnesses > 0) {
      const machine = Machine(
        machineId: 'm',
        name: 'box',
        authMode: MachineAuthMode.remote,
      );
      app.machines.add(machine);
      app.machineStates['m'] = MachineState(machine)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agents = [
          for (var i = 0; i < harnesses; i++)
            Agent(id: 'a$i', name: 'Agent $i'),
        ];
      app.activeSwarm.panes.addAll([
        for (var i = 0; i < harnesses; i++)
          TerminalPane(id: 100 + i, machineId: 'm', agentId: 'a$i'),
      ]);
    }
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundary,
        child: MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: false,
            chrome: webWorkspaceChrome(app),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 200));
    return app;
  }

  Future<void> capture(WidgetTester tester, String name) async {
    final output = Platform.environment['HARNESS_REFINEMENT_CAPTURE_DIR'];
    if (output == null) return;
    await tester.runAsync(() async {
      final image =
          await (boundary.currentContext!.findRenderObject()
                  as RenderRepaintBoundary)
              .toImage();
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      Directory(output).createSync(recursive: true);
      File('$output/$name.png').writeAsBytesSync(data!.buffer.asUint8List());
      image.dispose();
    });
  }

  Future<void> openSwitcher(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('web-tab-switcher')));
    await tester.pump(const Duration(milliseconds: 100));
  }

  testWidgets('a phone switches, opens and closes tabs from one menu', (
    tester,
  ) async {
    final app = await mount(tester, const Size(390, 844));
    expect(find.byKey(const ValueKey('web-tab-switcher')), findsOneWidget);
    expect(find.byKey(const ValueKey('swarm-store-button')), findsNothing);
    expect(find.byKey(const ValueKey('swarm-new-tab-button')), findsNothing);
    await capture(tester, 'web-phone-tab-bar');

    await openSwitcher(tester);
    for (final tab in app.swarms) {
      expect(find.byKey(ValueKey('web-tab:${tab.id}')), findsOneWidget);
    }
    await capture(tester, 'web-phone-tab-menu');
    final first = app.swarms.first.id;
    await tester.tap(find.byKey(ValueKey('web-tab:$first')));
    await tester.pump(const Duration(milliseconds: 100));
    expect(app.activeSwarmId, first);

    final count = app.swarms.length;
    await tester.tap(find.byKey(const ValueKey('web-new-tab-button')));
    await tester.pump(const Duration(milliseconds: 100));
    expect(app.swarms.length, count + 1);

    await openSwitcher(tester);
    final last = app.swarms.last.id;
    await tester.tap(find.byKey(ValueKey('web-tab:$last:close')));
    await tester.pump(const Duration(milliseconds: 300));
    expect(app.swarms.map((tab) => tab.id), isNot(contains(last)));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('a phone shows one harness of a tab, switched from the menu', (
    tester,
  ) async {
    final app = await mount(tester, const Size(390, 844), harnesses: 3);
    bool onScreen(String name) =>
        find.text(name).hitTestable().evaluate().isNotEmpty;
    expect(onScreen('Agent 0'), isTrue);
    expect(onScreen('Agent 1'), isFalse);
    expect(onScreen('Agent 2'), isFalse);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('web-tab-switcher')),
        matching: find.textContaining('1/3'),
      ),
      findsOneWidget,
    );
    await capture(tester, 'web-phone-solo-pane');

    await openSwitcher(tester);
    // Resting harnesses say nothing: a column of "Idle" is only noise.
    expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.idle);
    expect(find.text(HarnessActivity.idle.label), findsNothing);
    await capture(tester, 'web-phone-harness-menu');
    await tester.tap(find.byKey(const ValueKey('web-pane:101')));
    await tester.pump(const Duration(milliseconds: 300));
    expect(app.focusedPaneId, 101);
    expect(onScreen('Agent 1'), isTrue);
    expect(onScreen('Agent 0'), isFalse);
    // Drawn alone, not zoomed: the desk's own layout is untouched.
    expect(app.zoomedPaneId, isNull);

    // A harness closes from its own row, like a tab.
    await openSwitcher(tester);
    await tester.tap(find.byKey(const ValueKey('web-pane:102:close')));
    await tester.pump(const Duration(milliseconds: 300));
    expect(app.panes.map((pane) => pane.id), [100, 101]);

    await tester.tap(find.byKey(const ValueKey('web-app-menu-button')));
    await tester.pump(const Duration(milliseconds: 100));
    // The phone menu carries Store (its bar has no Store button), not Add phone.
    expect(find.byKey(const ValueKey('web-menu:app.store')), findsOneWidget);
    expect(find.byKey(const ValueKey('web-menu:app.add_phone')), findsNothing);
    await capture(tester, 'web-phone-app-menu');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets(
    'a phone folds the footer into one menu, hidden by the keyboard',
    (tester) async {
      final app = await mount(tester, const Size(390, 844), harnesses: 1);
      app.focusPane(100);
      await tester.pump(const Duration(milliseconds: 100));
      const footer = ValueKey('web-footer-menu-button');
      expect(
        find.descendant(of: find.byKey(footer), matching: find.text('box')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('workspace-subscription-usage')),
        findsNothing,
      );
      // Beside it, Download app alone: Share is off until asked for.
      expect(
        tester.getRect(find.byKey(footer)).right,
        lessThanOrEqualTo(tester.getRect(find.byType(WebDownloadButton)).left),
      );
      expect(
        find.byKey(const ValueKey('workspace-share-button')),
        findsNothing,
      );

      // One harness drawn alone still has a desk to split: the menu offers it.
      await tester.tap(find.byKey(const ValueKey('web-app-menu-button')));
      await tester.pump(const Duration(milliseconds: 100));
      expect(
        find.byKey(const ValueKey('web-menu:pane.split_right')),
        findsOneWidget,
      );
      await tester.tapAt(const Offset(350, 600));
      await tester.pump(const Duration(milliseconds: 100));

      await tester.tap(find.byKey(footer));
      await tester.pump(const Duration(milliseconds: 100));
      expect(
        find.byKey(const ValueKey('web-footer:Subscriptions')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('web-footer:Machine')), findsOneWidget);
      await capture(tester, 'web-phone-footer-menu');
      await tester.tapAt(const Offset(195, 300));
      await tester.pump(const Duration(milliseconds: 100));

      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byKey(footer), findsNothing);
      tester.view.resetViewInsets();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byKey(footer), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      app.dispose();
    },
  );

  testWidgets('a wide window keeps the grid of harnesses', (tester) async {
    final app = await mount(tester, const Size(1280, 800), harnesses: 3);
    expect(find.text('Agent 0').hitTestable(), findsOneWidget);
    expect(find.text('Agent 1').hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('a wide window keeps the row of tabs', (tester) async {
    final app = await mount(tester, const Size(1280, 800));
    expect(find.byKey(const ValueKey('web-tab-switcher')), findsNothing);
    expect(find.byKey(const ValueKey('swarm-store-button')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('workspace-subscription-usage')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('workspace-machine-resources')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('workspace-harness-monitor')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('web-footer-menu-button')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });
}

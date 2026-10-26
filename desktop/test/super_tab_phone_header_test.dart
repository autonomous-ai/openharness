// The Super Tab's header on a phone (the web below compactBelow): Chat and
// the ⋮ menu stay in the bar, a finger's size each, and the menu names what
// the bar drew as bare icons — the group's terminals, its pull requests and
// the people and machines. A wider window keeps the icons.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/app_icon_button.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/roster.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

final _chrome = WorkspaceChrome(
  leadingWidth: (_) => 0,
  leading: (_, _) => const SizedBox.shrink(),
  compactBelow: 720,
);

Future<(ConversationServer, SuperTabController)> _mount(
  WidgetTester tester,
  Size size, {
  VoidCallback? onOpenGroupTerminals,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final server = ConversationServer();
  final lead = (server.state['conversations'] as List).first as Map;
  lead['agentIds'] = ['builder'];
  final controller = server.controller();
  await controller.refresh();
  await tester.pumpWidget(
    MaterialApp(
      home: WorkspaceChromeScope(
        chrome: _chrome,
        child: Scaffold(
          body: SuperTabView(
            controller: controller,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            onOpenGroupTerminals: onOpenGroupTerminals,
            machineName: (_) => 'Test Mac',
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (server, controller);
}

Future<void> _unmount(WidgetTester tester, SuperTabController c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

final _options = find.byKey(const ValueKey('super-group-options'));

void main() {
  testWidgets('a phone keeps Chat and the menu in the bar, a finger each', (
    tester,
  ) async {
    final (_, controller) = await _mount(tester, const Size(390, 844));
    expect(find.byKey(const ValueKey('super-terminals')), findsNothing);
    expect(find.byKey(const ValueKey('super-pull-requests')), findsNothing);
    expect(find.byTooltip('Members and machines'), findsNothing);
    for (final control in [
      find.byTooltip('Conversations'),
      find.byKey(const ValueKey('super-chat')),
      _options,
    ]) {
      expect(control, findsOneWidget);
      final size = tester.getSize(control);
      expect(size.width, greaterThanOrEqualTo(44));
      expect(size.height, greaterThanOrEqualTo(44));
    }
    expect(tester.takeException(), isNull);
    await _unmount(tester, controller);
  });

  testWidgets('the phone menu names terminals, pull requests and people', (
    tester,
  ) async {
    var terminals = 0;
    final (_, controller) = await _mount(
      tester,
      const Size(390, 844),
      onOpenGroupTerminals: () => terminals++,
    );
    Future<void> choose(String label) async {
      await tester.tap(_options);
      await tester.pumpAndSettle();
      final row = find.widgetWithText(MenuItemButton, label);
      expect(tester.getSize(row).height, greaterThanOrEqualTo(44));
      await tester.tap(row);
      await tester.pumpAndSettle();
    }

    await choose('Group terminals (1)');
    expect(terminals, 1);

    await choose('Members and machines');
    expect(find.byType(SuperTabRoster), findsOneWidget);
    await tester.tapAt(const Offset(40, 400));
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabRoster), findsNothing);

    await choose('Pull requests');
    // Chat is no longer the view: the pull requests are.
    expect(
      tester
          .widget<AppIconButton>(find.byKey(const ValueKey('super-chat')))
          .selected,
      isFalse,
    );
    expect(tester.takeException(), isNull);
    await _unmount(tester, controller);
  });

  testWidgets('a wide window keeps the icons in the header', (tester) async {
    final (_, controller) = await _mount(tester, const Size(1280, 800));
    expect(find.byKey(const ValueKey('super-terminals')), findsOneWidget);
    expect(find.byKey(const ValueKey('super-pull-requests')), findsOneWidget);
    await tester.tap(_options);
    await tester.pumpAndSettle();
    expect(find.text('Pull requests'), findsNothing);
    expect(find.text('Members and machines'), findsNothing);
    await _unmount(tester, controller);
  });
}

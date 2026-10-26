// The Super Tab's header on a phone (the web below compactBelow): Chat, the
// people and machines and the ⋮ menu stay in the bar, a finger's size each,
// and the menu names what the bar drew as bare icons — the group's terminals
// and its pull requests — while the header says which of them is open. The
// conversation's own controls are a finger's size there too. A wider window,
// and Desktop at any width, keep the icons and the mouse's sizes.

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
  bool terminalsVisible = false,
  bool desktop = false,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final server = ConversationServer()..append('Ship the phone header.');
  final lead = (server.state['conversations'] as List).first as Map;
  lead['agentIds'] = ['builder'];
  final controller = server.controller();
  await controller.refresh();
  final view = Scaffold(
    body: SuperTabView(
      controller: controller,
      onInvite: () {},
      onAddAgent: (_) {},
      onOpenTerminal: (_) {},
      onOpenGroupTerminals: onOpenGroupTerminals,
      terminalsVisible: terminalsVisible,
      machineName: (_) => 'Test Mac',
    ),
  );
  await tester.pumpWidget(
    MaterialApp(
      // Desktop sets no chrome around its workspace.
      home: desktop ? view : WorkspaceChromeScope(chrome: _chrome, child: view),
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
final _people = find.byTooltip('Members and machines');
final _openView = find.byKey(const ValueKey('super-open-view'));

/// The conversation's own controls: a message's actions, the composer's,
/// a reply's Cancel and the roster's rows.
Map<String, Finder> _conversationControls() => {
  'Reply': find.byTooltip('Reply'),
  'Copy message': find.byTooltip('Copy message'),
  'Attach files': find.byTooltip('Attach files'),
  'Send message': find.byTooltip('Send message'),
};

Future<void> _openReply(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Reply'), warnIfMissed: false);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('a phone keeps Chat and the menu in the bar, a finger each', (
    tester,
  ) async {
    final (_, controller) = await _mount(tester, const Size(390, 844));
    expect(find.byKey(const ValueKey('super-terminals')), findsNothing);
    expect(find.byKey(const ValueKey('super-pull-requests')), findsNothing);
    for (final control in [
      find.byTooltip('Conversations'),
      find.byKey(const ValueKey('super-chat')),
      _people,
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

  testWidgets('the phone menu names terminals and pull requests', (
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

  testWidgets('a phone opens the people and machines in one tap', (
    tester,
  ) async {
    final (_, controller) = await _mount(tester, const Size(390, 844));
    await tester.tap(_people);
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabRoster), findsOneWidget);
    final row = find.byKey(const ValueKey('super-person-owner'));
    expect(tester.getSize(row).height, greaterThanOrEqualTo(44));
    await tester.tapAt(const Offset(40, 400));
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabRoster), findsNothing);
    await _unmount(tester, controller);
  });

  testWidgets('a phone header says which view is open', (tester) async {
    final (_, chat) = await _mount(tester, const Size(390, 844));
    expect(_openView, findsNothing, reason: 'the chat is the default view');
    await tester.tap(_options);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(MenuItemButton, 'Pull requests'));
    await tester.pumpAndSettle();
    expect(tester.widget<Text>(_openView).data, 'Pull requests');
    await _unmount(tester, chat);

    final (_, terminals) = await _mount(
      tester,
      const Size(390, 844),
      terminalsVisible: true,
    );
    expect(tester.widget<Text>(_openView).data, 'Group terminals');
    await _unmount(tester, terminals);
  });

  testWidgets('a phone\'s message and composer controls are a finger each', (
    tester,
  ) async {
    final (_, controller) = await _mount(tester, const Size(390, 844));
    for (final MapEntry(key: label, value: control)
        in _conversationControls().entries) {
      expect(control, findsOneWidget, reason: label);
      final size = tester.getSize(control);
      expect(size.width, greaterThanOrEqualTo(44), reason: label);
      expect(size.height, greaterThanOrEqualTo(44), reason: label);
    }
    await _openReply(tester);
    final cancel = tester.getSize(find.byTooltip('Cancel reply'));
    expect(cancel.width, greaterThanOrEqualTo(44));
    expect(cancel.height, greaterThanOrEqualTo(44));
    expect(tester.takeException(), isNull);
    await _unmount(tester, controller);
  });

  // Desktop sets no compactBelow: a narrow window is no phone.
  testWidgets('Desktop at 600 keeps the bar, the controls and the rows', (
    tester,
  ) async {
    final (_, controller) = await _mount(
      tester,
      const Size(600, 800),
      desktop: true,
    );
    expect(find.byKey(const ValueKey('super-terminals')), findsOneWidget);
    expect(find.byKey(const ValueKey('super-pull-requests')), findsOneWidget);
    for (final MapEntry(key: label, value: control)
        in _conversationControls().entries) {
      expect(tester.getSize(control), const Size(32, 32), reason: label);
    }
    await _openReply(tester);
    expect(tester.getSize(find.byTooltip('Cancel reply')), const Size(32, 32));
    await tester.tap(_people);
    await tester.pumpAndSettle();
    expect(
      tester.getSize(find.byKey(const ValueKey('super-person-owner'))).height,
      36,
    );
    await _unmount(tester, controller);
  });
}

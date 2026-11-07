import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/super_tab_fixture.dart';

/// Task #3820 (Phase 2 of the Board; #3819's Can chat right): in a project on the Board only its owner, the Swarm's
/// owner and the people granted Can chat write in its chat. The owner grants it in Project settings → People; anyone
/// else reads the chat with a line saying why. The server refuses the rest (CHAT_NOT_ALLOWED).

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Finder _key(String k) => find.byKey(ValueKey(k));

Iterable<Map> _commands(ConversationServer server, String type) => [
  for (final post in server.posts)
    if ((post['command'] as Map?)?['type'] == type) post['command'] as Map,
];

void main() {
  Future<(SuperTabController, ConversationServer)> show(
    WidgetTester tester, {
    String reader = 'owner',
    bool boardMode = true,
    List<String> canChat = const [],
  }) async {
    await tester.binding.setSurfaceSize(const Size(1600, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarm();
    (server.state['people'] as List).add({
      'id': 'tuan',
      'email': 'tuan@example.com',
      'role': 'collaborator',
    });
    final project = (server.state['projects'] as List).first as Map;
    project['members'] = [
      {'id': 'owner'},
      {'id': 'tuan'},
    ];
    if (boardMode) {
      project
        ..['boardMode'] = true
        ..['canChat'] = canChat;
    }
    final c = server.controller(
      account: reader,
      initial: {
        'tabId': 'tab',
        'projectsGroupOpen': true,
        'accountId': reader,
        'selectedId': 'lead',
      },
    );
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            board: true,
          ),
        ),
      ),
    );
    await _settle(tester);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    await tester.tap(_key('super-board-tab-chat'));
    await _settle(tester);
    return (c, server);
  }

  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    await tester.pump(const Duration(seconds: 5));
  }

  Future<void> openSettings(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Project options'));
    await _settle(tester);
    await tester.tap(find.widgetWithText(AppMenuItem, 'Project settings…'));
    await _settle(tester);
  }

  Switch canChatSwitch(WidgetTester tester, String person) =>
      tester.widget<Switch>(
        find.descendant(
          of: _key('project-can-chat-$person'),
          matching: find.byType(Switch),
        ),
      );

  testWidgets('the owner grants Can chat in Project settings → People', (
    tester,
  ) async {
    final (c, server) = await show(tester);
    await openSettings(tester);
    expect(_key('super-project-setting-People'), findsOneWidget);
    await tester.tap(_key('super-project-setting-People'));
    await _settle(tester);
    // The owner always may, and that can't be switched off.
    expect(canChatSwitch(tester, 'owner').value, isTrue);
    expect(canChatSwitch(tester, 'owner').onChanged, isNull);
    expect(canChatSwitch(tester, 'tuan').value, isFalse);
    await tester.tap(_key('project-can-chat-tuan'));
    await _settle(tester);
    expect(_commands(server, 'project.canChat'), [
      {
        'type': 'project.canChat',
        'projectId': 'lead',
        'personId': 'tuan',
        'granted': true,
      },
    ]);
    expect(canChatSwitch(tester, 'tuan').value, isTrue);
    await end(tester, c);
  });

  testWidgets("without Can chat the chat is read only and says why; People's "
      'switches are only the owner\'s', (tester) async {
    final (c, _) = await show(tester, reader: 'tuan');
    expect(_key('super-message-composer-row'), findsNothing);
    expect(_key('super-chat-no-can-chat'), findsOneWidget);
    await openSettings(tester);
    await tester.tap(_key('super-project-setting-People'));
    await _settle(tester);
    expect(canChatSwitch(tester, 'tuan').onChanged, isNull);
    await end(tester, c);
  });

  testWidgets('with Can chat a member writes in the chat', (tester) async {
    final (c, _) = await show(tester, reader: 'tuan', canChat: ['tuan']);
    expect(_key('super-message-composer-row'), findsOneWidget);
    expect(_key('super-chat-no-can-chat'), findsNothing);
    await end(tester, c);
  });

  testWidgets('a project not on the Board: everyone who may write writes, and '
      'Project settings has no People', (tester) async {
    final (c, _) = await show(tester, reader: 'tuan', boardMode: false);
    expect(_key('super-message-composer-row'), findsOneWidget);
    expect(_key('super-chat-no-can-chat'), findsNothing);
    await openSettings(tester);
    expect(_key('super-project-setting-People'), findsNothing);
    await end(tester, c);
  });
}

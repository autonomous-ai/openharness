import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// Typing in a long chat must not rebuild its transcript: on a chat holding
/// hundreds of messages each keystroke redid the work of every held message.
void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    final c = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(c.dispose);
    return c;
  }

  final composer = find.byKey(const ValueKey('super-message-composer'));
  final transcript = find.byType(CustomScrollView);

  ConversationServer longChat() {
    final server = ConversationServer()..messagePage = 300;
    for (var i = 0; i < 300; i++) {
      server.append('Update $i');
    }
    return server;
  }

  testWidgets('typing in a 300-message chat leaves the transcript as built', (
    tester,
  ) async {
    final c = await show(tester, longChat());
    expect(c.messages(c.selectedId), hasLength(300));
    await tester.showKeyboard(composer);
    await tester.pump();
    final before = tester.widget(transcript);
    var text = '';
    for (final char in 'abcdefghij'.split('')) {
      text += char;
      tester.testTextInput.updateEditingValue(
        TextEditingValue(
          text: text,
          selection: TextSelection.collapsed(offset: text.length),
        ),
      );
      await tester.pump();
      // A rebuilt transcript is a new widget: the same one was not built again.
      expect(identical(tester.widget(transcript), before), isTrue);
    }
    expect(c.draft(c.selectedId), 'abcdefghij');
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('rows share one map of group references, read again on change', (
    tester,
  ) async {
    final server = ConversationServer();
    (server.state['conversations'] as List)[1]['number'] = 12;
    server.append('See #12');
    server.append('And #12 again');
    final c = await show(tester, server);
    List<Map<int, String>> references() => [
      for (final row in tester.widgetList<SuperTabMessageRow>(
        find.byType(SuperTabMessageRow),
      ))
        row.references,
    ];
    final first = references();
    expect(first, hasLength(2));
    expect(first.first, {12: 'offline'});
    // Built once for the Swarm as read, not once per row.
    expect(identical(first.first, first.last), isTrue);

    (server.state['conversations'] as List).add({
      ...conversationFixture('sync', 'Sync reliability'),
      'number': 13,
    });
    await c.refresh();
    await tester.pumpAndSettle();
    expect(c.snapshot!.conversation('sync'), isNotNull);
    expect(references().first, {12: 'offline', 13: 'sync'});
  });
}

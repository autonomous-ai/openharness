// The saved view on screen (#180 fix 4): a quiet "Saved in this browser ·
// Updating…" beside the Super Tab's title until the first read lands; the
// send box stays usable. It says where the copy is, and the tooltip how long
// it stays and where it is cleared.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/reading.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

const _label = 'Saved in this browser · Updating…';

const _web = SuperTabReading(
  quietPoll: Duration(seconds: 15),
  pausesAway: true,
  messagesWithState: true,
  drawsSaved: true,
);

SuperTabController _controller(ConversationServer server) => SuperTabController(
  tabId: 'tab',
  accountId: 'owner',
  request: server.request,
  save: server.save,
  initial: const {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
  reading: _web,
  pollInterval: Duration.zero,
);

Future<void> _mount(WidgetTester tester, SuperTabController c) async {
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
  await tester.pump();
}

void main() {
  testWidgets('the saved view says Updating until the first read lands', (
    tester,
  ) async {
    final server = ConversationServer()..append('Hello');
    final first = _controller(server);
    await first.refresh();
    final view =
        jsonDecode(jsonEncode(first.savedView)) as Map<String, dynamic>;
    first.dispose();

    server.holdReads = Completer<void>();
    final c = _controller(server)..drawSaved(view);
    addTearDown(c.dispose);
    await _mount(tester, c);
    expect(find.text('Hello'), findsOneWidget);
    expect(find.text(_label), findsOneWidget);
    expect(
      find.byTooltip(
        'This browser keeps a copy of the Super Tabs you open until you sign '
        'out. Settings ▸ Account clears it now.',
      ),
      findsOneWidget,
    );
    // The send box takes a draft meanwhile.
    await tester.enterText(find.byType(TextField).last, 'Go ahead.');
    expect(c.draft('lead'), 'Go ahead.');

    unawaited(c.refresh());
    await tester.pump();
    server.holdReads!.complete();
    server.holdReads = null;
    await tester.pump();
    await tester.pump();
    expect(find.text(_label), findsNothing);
    expect(find.text('Hello'), findsOneWidget);
    // Reading the transcript saves where it was read to, a moment later.
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('a read Swarm says nothing of the kind', (tester) async {
    final server = ConversationServer()..append('Hello');
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    await _mount(tester, c);
    expect(find.text(_label), findsNothing);
    await tester.pump(const Duration(seconds: 1));
  });
}

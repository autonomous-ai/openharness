import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// Reading back to a read mark many pages behind the latest (review of #2131,
/// round 2): what a poll or a failed read does meanwhile.

const _line = ValueKey('super-new-messages-line');

/// [count] messages in the Lead conversation from the Lead agent, pages of 20,
/// read up to message 5 on another device.
ConversationServer _server(int count) {
  final server = ConversationServer()..messagePage = 20;
  for (var i = 1; i <= count; i++) {
    _fromLead(server, 'Update $i');
  }
  return server..markReadElsewhere('lead', 5);
}

void _fromLead(ConversationServer server, String text) {
  server.append(text);
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'lead-agent',
    'name': 'Lead',
  };
}

/// A controller of [server] whose reads of a path containing a key of [gates]
/// wait for that gate (completing [asked]'s entry for it as they set out),
/// and whose reads of one in [fail] fail once (each in [down], every time,
/// counted in [refused]).
SuperTabController _controller(
  ConversationServer server, {
  Map<String, Completer<void>> gates = const {},
  Map<String, Completer<void>> asked = const {},
  Set<String> fail = const {},
  Set<String> down = const {},
  List<String>? refused,
}) => SuperTabController(
  tabId: 'tab',
  accountId: 'owner',
  request: (method, path, {body}) async {
    for (final MapEntry(:key, :value) in [...gates.entries]) {
      if (!path.contains(key)) continue;
      if (asked[key] case final told? when !told.isCompleted) told.complete();
      await value.future;
    }
    if (down.any(path.contains)) {
      refused?.add(path);
      throw StateError('Offline');
    }
    if (fail.any(path.contains)) {
      fail.removeWhere(path.contains);
      throw StateError('Offline');
    }
    return server.request(method, path, body: body);
  },
  save: server.save,
  pollInterval: Duration.zero,
);

void main() {
  test('a poll that set out before the read back lands after it does not '
      'join across the gap, and newer history stays marked', () async {
    final server = _server(200);
    final gates = {'after=5': Completer<void>()};
    final asked = {'after=5': Completer<void>()};
    final c = _controller(server, gates: gates, asked: asked);
    addTearDown(c.dispose);
    await c.refresh();
    final back = c.loadBackTo('lead', 5);
    // The page after the mark is on its way; a poll sets out from the newest
    // held message meanwhile.
    await asked['after=5']!.future;
    gates['after=200'] = Completer<void>();
    asked['after=200'] = Completer<void>();
    _fromLead(server, 'Update 201');
    final poll = c.loadMessages('lead');
    await asked['after=200']!.future;
    gates['after=5']!.complete();
    await back;
    gates['after=200']!.complete();
    await poll;
    final held = c.messages('lead').map((m) => m.sequence).toList();
    expect(held.first, 6);
    expect(held, isNot(contains(201)));
    // Every held message follows the one before it: no gap inside.
    expect(held, [for (var i = 6; i < 6 + held.length; i++) i]);
    expect(c.hasNewer('lead'), isTrue);
  });

  Future<SuperTabController> show(
    WidgetTester tester,
    SuperTabController c,
  ) async {
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

  testWidgets('a failed read back leaves the line unplaced and nothing '
      'marked read, and the next read places it at the first unread', (
    tester,
  ) async {
    final server = _server(200);
    final c = await show(tester, _controller(server, fail: {'after=5'}));
    expect(find.byKey(_line), findsNothing);
    expect(c.readMark('lead'), 5);
    expect(server.readMarkPosts, isEmpty);
    // Tried again shortly, and this time the page arrives.
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    expect(find.byKey(_line), findsOneWidget);
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      lessThan(tester.getTopLeft(find.text('Update 6')).dy),
    );
    expect(c.readMark('lead'), 5);
  });

  testWidgets('a read back that keeps failing is tried three times, then '
      'left: no line, nothing marked read', (tester) async {
    final server = _server(200);
    final refused = <String>[];
    final c = await show(
      tester,
      _controller(server, down: {'after=5'}, refused: refused),
    );
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
    }
    expect(refused, hasLength(3));
    expect(find.byKey(_line), findsNothing);
    expect(c.readMark('lead'), 5);
    expect(server.readMarkPosts, isEmpty);
  });
}

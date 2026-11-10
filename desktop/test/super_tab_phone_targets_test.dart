// The Super Tab's conversation on a phone (the web below compactBelow): every
// control a finger presses in it — a message's author, Reply and Copy, its
// files, a routing note's Details, the composer's Attach and Send and a
// reply's Cancel — is 44x44 at least. Desktop, which sets no compactBelow,
// keeps the mouse's sizes at any width.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/message_row.dart';

import 'support/super_tab_fixture.dart';
import 'support/super_tab_phone.dart';

const _agent = {'kind': 'agent', 'id': 'builder', 'name': 'Builder'};

/// An agent's message with a file, and its routing note.
void _agentMessages(ConversationServer server) {
  (server.state['agents'] as List).add({
    'id': 'builder',
    'name': 'Builder',
    'displayName': 'Lark',
    'machineId': 'm',
    'harnessId': 'native-builder',
    'contributorId': 'owner',
    'configuration': {'engine': 'claude'},
  });
  server.append(
    'The header is done.',
    attachments: [
      {
        'id': 'a1',
        // A file that stays a chip: a picture shows in place.
        'name': 'fixture-375.pdf',
        'mime': 'application/pdf',
        'size': 2048,
        'url': 'https://cdn.harness.autonomous.ai/a1/fixture-375.pdf',
      },
    ],
  );
  server.messages.last['author'] = _agent;
  server.append('Routed to Lark');
  server.messages.last
    ..['author'] = _agent
    ..['source'] = {
      'kind': 'route',
      'decisionId': 'd1',
      'via': 'order',
      'p': null,
      'belowFloor': false,
      'why': 'phone hit sizes',
      'pick': {'id': 'c0', 'title': 'Lark · Claude opus high · Test Mac'},
      'alternatives': const <Object>[],
    };
}

void main() {
  testWidgets('a phone\'s taller author keeps the name in place', (
    tester,
  ) async {
    Future<double> tops({required bool desktop}) async {
      final (_, controller) = await mountPhoneSuperTab(
        tester,
        const Size(390, 844),
        desktop: desktop,
        seed: _agentMessages,
      );
      final row = find.ancestor(
        of: find.text('The header is done.'),
        matching: find.byType(SuperTabMessageRow),
      );
      // From the row's own top: the rows above it are taller on a phone.
      double top(Finder f) =>
          tester.getTopLeft(find.descendant(of: row, matching: f)).dy -
          tester.getTopLeft(row).dy;
      final result = top(find.text('Lark'));
      await unmountPhoneSuperTab(tester, controller);
      return result;
    }

    expect(await tops(desktop: false), await tops(desktop: true));
  });
}

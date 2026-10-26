// The Super Tab's conversation on a phone (the web below compactBelow): every
// control a finger presses in it — a message's author, Reply and Copy, its
// files, a routing note's Details, the composer's Attach and Send and a
// reply's Cancel — is 44x44 at least. Desktop, which sets no compactBelow,
// keeps the mouse's sizes at any width.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/identity.dart';
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
        'name': 'fixture-375.png',
        'mime': 'image/png',
        'size': 2048,
        'url': 'https://cdn.harness.autonomous.ai/a1/fixture-375.png',
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

/// The conversation's controls, by what they are called.
Map<String, Finder> _controls() => {
  'Reply': find.byTooltip('Reply'),
  'Copy message': find.byTooltip('Copy message'),
  'Attach files': find.byTooltip('Attach files'),
  'Send message': find.byTooltip('Send message'),
  'author': find.descendant(
    of: find.byType(SuperTabMessageRow),
    matching: find.widgetWithText(InkWell, 'Lark'),
  ),
  'file': find.byKey(const ValueKey('super-attachment:a1')),
  'Details': find.widgetWithText(TextButton, 'Details'),
};

/// The size of every control [finder] finds.
Iterable<Size> _sizes(WidgetTester tester, Finder finder, String label) {
  expect(finder, findsWidgets, reason: label);
  return [
    for (var i = 0; i < finder.evaluate().length; i++)
      tester.getSize(finder.at(i)),
  ];
}

Future<void> _openReply(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Reply').first, warnIfMissed: false);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('a phone\'s conversation controls are a finger each', (
    tester,
  ) async {
    final (_, controller) = await mountPhoneSuperTab(
      tester,
      const Size(390, 844),
      seed: _agentMessages,
    );
    final controls = {
      ..._controls(),
      'Cancel reply': find.byTooltip('Cancel reply'),
    };
    await _openReply(tester);
    for (final MapEntry(key: label, value: control) in controls.entries) {
      for (final size in _sizes(tester, control, label)) {
        expect(size.width, greaterThanOrEqualTo(44), reason: label);
        expect(size.height, greaterThanOrEqualTo(44), reason: label);
      }
    }
    expect(tester.takeException(), isNull);
    await unmountPhoneSuperTab(tester, controller);
  });

  testWidgets('a phone\'s taller author keeps the name and avatar in place', (
    tester,
  ) async {
    Future<(double, double)> tops({required bool desktop}) async {
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
      final result = (top(find.text('Lark')), top(find.byType(SuperTabAvatar)));
      await unmountPhoneSuperTab(tester, controller);
      return result;
    }

    expect(await tops(desktop: false), await tops(desktop: true));
  });

  // Desktop sets no compactBelow: a narrow window is no phone.
  testWidgets('Desktop at 600 keeps the bar, the controls and the rows', (
    tester,
  ) async {
    final (_, controller) = await mountPhoneSuperTab(
      tester,
      const Size(600, 800),
      desktop: true,
      seed: _agentMessages,
    );
    expect(find.byKey(const ValueKey('super-terminals')), findsOneWidget);
    expect(find.byKey(const ValueKey('super-pull-requests')), findsOneWidget);
    const mouse = {
      'Reply': Size(32, 32),
      'Copy message': Size(32, 32),
      'Attach files': Size(32, 32),
      'Send message': Size(32, 32),
    };
    for (final MapEntry(key: label, value: size) in mouse.entries) {
      expect(_sizes(tester, _controls()[label]!, label), everyElement(size));
    }
    for (final label in ['file', 'Details']) {
      expect(
        _sizes(tester, _controls()[label]!, label).map((s) => s.height),
        everyElement(28),
        reason: label,
      );
    }
    expect(
      _sizes(tester, _controls()['author']!, 'author').single.height,
      lessThan(28),
    );
    await _openReply(tester);
    expect(tester.getSize(find.byTooltip('Cancel reply')), const Size(32, 32));
    await tester.tap(find.byTooltip('Members and machines'));
    await tester.pumpAndSettle();
    expect(
      tester.getSize(find.byKey(const ValueKey('super-person-owner'))).height,
      36,
    );
    expect(tester.getSize(find.byTooltip('Invite people')), const Size(32, 32));
    await unmountPhoneSuperTab(tester, controller);
  });
}

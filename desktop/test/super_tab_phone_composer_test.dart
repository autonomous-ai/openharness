// The message box on a phone's browser (Huy, 2026-11-02, IMG_4431): the field
// had about 40% of the width, sharing its row with its actions, its hint wrapped, and a line kept free under the box held it off the
// keyboard. On a phone the field has the width and the actions a row below.

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_attachments.dart';

import 'support/super_tab_fixture.dart';
import 'support/super_tab_phone.dart';

const _phone = Size(390, 844);
final _surface = find.byKey(const ValueKey('super-message-composer-surface'));
final _field = find.byKey(const ValueKey('super-message-composer'));
final _actions = find.byKey(const ValueKey('super-message-composer-actions'));
final _send = find.byTooltip('Send message');

/// The reader's own Buddy chat ('offline' in the fixture), as in Huy's
/// screenshot.
ConversationServer _buddyChat() {
  final server = ConversationServer()..threads = true;
  final chat =
      (server.state['conversations'] as List)[1] as Map<String, dynamic>
        ..['kind'] = 'buddy'
        ..['buddyOwnerId'] = 'owner'
        ..['title'] = 'Rowan';
  (server.state['agents'] as List).add({
    'id': 'buddy-main',
    'name': 'Rowan',
    'displayName': 'Rowan',
    'machineId': 'mac',
    'harnessId': 'h-main',
    'contributorId': 'owner',
    'buddyOf': {'personId': 'owner', 'generation': 'g1'},
    'configuration': {'engine': 'claude'},
  });
  chat['agentIds'] = ['buddy-main'];
  server.append('Hello', conversationId: 'offline');
  return server;
}

void main() {
  testWidgets(
    'in a Buddy chat: a one-line hint, send below the field, nothing under the box',
    (tester) async {
      final (_, c) = await mountPhoneSuperTab(
        tester,
        _phone,
        server: _buddyChat(),
        initial: 'offline',
      );
      expect(tester.widget<TextField>(_field).decoration!.hintMaxLines, 1);
      await tester.enterText(_field, 'a draft');
      await tester.pump();
      expect(
        tester.getRect(_send).top,
        greaterThanOrEqualTo(tester.getRect(_field).bottom),
      );
      expect(
        _phone.height - tester.getRect(_surface).bottom,
        lessThanOrEqualTo(8),
      );
      expect(tester.widget<TextField>(_field).controller!.text, 'a draft');
      expect(tester.testTextInput.isVisible, isTrue);
      expect(tester.takeException(), isNull);
      await unmountPhoneSuperTab(tester, c);
    },
  );

  testWidgets('a narrow phone with large text does not overflow', (
    tester,
  ) async {
    final (_, c) = await mountPhoneSuperTab(
      tester,
      const Size(320, 640),
      server: _buddyChat(),
      initial: 'offline',
      textScale: 1.5,
    );
    expect(_actions, findsOneWidget);
    expect(tester.getRect(_send).right, lessThanOrEqualTo(320));
    expect(tester.takeException(), isNull);
    await unmountPhoneSuperTab(tester, c);
  });

  // Found in review at 696bfb0c4: a 5-line field on a small phone with the
  // keyboard up overflowed the pane by 23 px.
  for (final (height, keyboard) in [
    (568.0, 216.0),
    (568.0, 260.0),
    (667.0, 260.0),
  ]) {
    testWidgets(
      'a long draft fits a 320x$height phone with a ${keyboard}px keyboard',
      (tester) async {
        final (_, c) = await mountPhoneSuperTab(
          tester,
          Size(320, height),
          server: _buddyChat(),
          initial: 'offline',
        );
        tester.view.viewInsets = FakeViewPadding(bottom: keyboard);
        addTearDown(tester.view.resetViewInsets);
        await tester.pumpAndSettle();
        await tester.enterText(_field, List.filled(12, 'line').join('\n'));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(
          tester.getRect(_send).bottom,
          lessThanOrEqualTo(height - keyboard),
        );
        await unmountPhoneSuperTab(tester, c);
      },
    );
  }

  testWidgets('a short screen with a file and a long draft does not overflow', (
    tester,
  ) async {
    final (_, c) = await mountPhoneSuperTab(
      tester,
      const Size(390, 320),
      server: _buddyChat(),
      initial: 'offline',
    );
    c.attachments('offline').add([
      HarnessAttachment('notes.txt', Uint8List(4)),
    ]);
    await tester.enterText(_field, List.filled(12, 'line').join('\n'));
    await tester.pumpAndSettle();
    expect(find.text('notes.txt'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await unmountPhoneSuperTab(tester, c);
  });

  testWidgets(
    'a narrow phone with under 280 px left keeps one row, squeezed but whole',
    (tester) async {
      final (_, c) = await mountPhoneSuperTab(
        tester,
        const Size(320, 568),
        server: _buddyChat(),
        initial: 'offline',
      );
      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpAndSettle();
      await tester.enterText(_field, List.filled(12, 'line').join('\n'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(tester.getRect(_send).right, lessThanOrEqualTo(320));
      await unmountPhoneSuperTab(tester, c);
    },
  );

  // The Tester at b68a639b7: a field of one line is a single-line field, which
  // strips line breaks, so a draft of three lines became "onetwothree".
  for (final (size, keyboard) in [
    (const Size(320, 308), 0.0),
    (const Size(390, 308), 0.0),
    (const Size(320, 568), 260.0),
    (const Size(320, 568), 300.0),
    (const Size(667, 375), 190.0),
  ]) {
    testWidgets(
      'line breaks survive at ${size.width}x${size.height} with a ${keyboard}px keyboard, and nothing overflows',
      (tester) async {
        final (_, c) = await mountPhoneSuperTab(
          tester,
          size,
          server: _buddyChat(),
          initial: 'offline',
        );
        tester.view.viewInsets = FakeViewPadding(bottom: keyboard);
        addTearDown(tester.view.resetViewInsets);
        await tester.pumpAndSettle();
        await tester.enterText(_field, 'one\ntwo\nthree');
        await tester.pumpAndSettle();
        expect(
          tester.widget<TextField>(_field).controller!.text,
          'one\ntwo\nthree',
        );
        // At least the 2 lines main gives there.
        expect(tester.getSize(_field).height, greaterThanOrEqualTo(40));
        expect(tester.takeException(), isNull);
        await unmountPhoneSuperTab(tester, c);
      },
    );
  }
}

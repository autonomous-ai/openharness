// The message box on a phone's browser (Huy, 2026-11-02, IMG_4431): the field
// had about 40% of the width, sharing its row with New session, attach and
// send, its hint wrapped, and a line kept free under the box held it off the
// keyboard. On a phone the field has the width and the actions a row below.

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/app_icon_button.dart';
import 'package:harness/state/harness_attachments.dart';

import 'support/super_tab_fixture.dart';
import 'support/super_tab_phone.dart';

const _phone = Size(390, 844);
final _surface = find.byKey(const ValueKey('super-message-composer-surface'));
final _field = find.byKey(const ValueKey('super-message-composer'));
final _actions = find.byKey(const ValueKey('super-message-composer-actions'));
final _send = find.byTooltip('Send message');
final _attach = find
    .descendant(of: _surface, matching: find.byType(AppIconButton))
    .first;

final _session = find.byKey(const ValueKey('super-chat-new-session'));
final _note = find.byKey(const ValueKey('super-chat-session-note'));

/// The reader's own Buddy chat ('offline' in the fixture), with New session on
/// offer and a long Buddy name, as in Huy's screenshot.
ConversationServer _buddyChat() {
  final server = ConversationServer()..threads = true;
  server.state['threadSessions'] = true;
  server.state['sessionsFromChat'] = true;
  final chat =
      (server.state['conversations'] as List)[1] as Map<String, dynamic>
        ..['kind'] = 'buddy'
        ..['buddyOwnerId'] = 'owner'
        ..['title'] = "phamngochuy.1989's Buddy";
  (server.state['agents'] as List).add({
    'id': 'buddy-main',
    'name': "phamngochuy.1989's Buddy",
    'displayName': "phamngochuy.1989's Buddy",
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
    'on a phone the field spans the box and the actions sit below it',
    (tester) async {
      final (_, c) = await mountPhoneSuperTab(tester, _phone);
      final surface = tester.getRect(_surface), field = tester.getRect(_field);
      expect(surface.width - field.width, lessThanOrEqualTo(32));
      expect(_actions, findsOneWidget);
      expect(tester.getRect(_actions).top, greaterThanOrEqualTo(field.bottom));
      expect(tester.getRect(_send).top, greaterThanOrEqualTo(field.bottom));
      // Send at the right, attach at the left, each a finger's size.
      expect(tester.getRect(_attach).right, lessThan(surface.center.dx));
      expect(tester.getRect(_send).left, greaterThan(surface.center.dx));
      expect(tester.getSize(_send).height, greaterThanOrEqualTo(44));
      expect(tester.takeException(), isNull);
      await unmountPhoneSuperTab(tester, c);
    },
  );

  testWidgets(
    'the field grows to 5 lines, then scrolls, and the actions stay',
    (tester) async {
      final (_, c) = await mountPhoneSuperTab(tester, _phone);
      final one = tester.getSize(_field).height;
      await tester.enterText(_field, List.filled(5, 'line').join('\n'));
      await tester.pump();
      final five = tester.getSize(_field).height;
      expect(five, greaterThan(one * 4));
      await tester.enterText(_field, List.filled(12, 'line').join('\n'));
      await tester.pump();
      expect(tester.getSize(_field).height, five);
      expect(tester.getRect(_send).bottom, lessThanOrEqualTo(_phone.height));
      expect(tester.takeException(), isNull);
      await unmountPhoneSuperTab(tester, c);
    },
  );

  testWidgets(
    '5 lines hold on a short screen too: the keyboard takes the height',
    (tester) async {
      final (_, c) = await mountPhoneSuperTab(tester, const Size(390, 500));
      final one = tester.getSize(_field).height;
      await tester.enterText(_field, List.filled(8, 'line').join('\n'));
      await tester.pump();
      expect(tester.getSize(_field).height, greaterThan(one * 4));
      expect(tester.takeException(), isNull);
      await unmountPhoneSuperTab(tester, c);
    },
  );

  testWidgets('a draft and its focus survive turning past the phone width', (
    tester,
  ) async {
    final (_, c) = await mountPhoneSuperTab(tester, _phone);
    await tester.tap(_field);
    await tester.enterText(_field, 'a draft');
    await tester.pump();
    tester.view.physicalSize = const Size(1280, 800);
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(_field).controller!.text, 'a draft');
    expect(tester.widget<TextField>(_field).focusNode!.hasFocus, isTrue);
    expect(tester.testTextInput.isVisible, isTrue);
    expect(tester.takeException(), isNull);
    await unmountPhoneSuperTab(tester, c);
  });

  testWidgets('a wider window keeps one row', (tester) async {
    final (_, c) = await mountPhoneSuperTab(
      tester,
      const Size(1280, 800),
      desktop: true,
    );
    expect(_actions, findsNothing);
    final field = tester.getRect(_field), send = tester.getRect(_send);
    expect(send.left, greaterThanOrEqualTo(field.right));
    expect(send.center.dy, closeTo(field.center.dy, 12));
    await unmountPhoneSuperTab(tester, c);
  });

  testWidgets(
    'the box sits against the bottom, with nothing kept free under it',
    (tester) async {
      final (_, c) = await mountPhoneSuperTab(tester, _phone);
      expect(
        _phone.height - tester.getRect(_surface).bottom,
        lessThanOrEqualTo(8),
      );
      expect(tester.takeException(), isNull);
      await unmountPhoneSuperTab(tester, c);
    },
  );

  testWidgets(
    'in a Buddy chat: a one-line hint, New session below the field, its note above the box, nothing under it',
    (tester) async {
      final (_, c) = await mountPhoneSuperTab(
        tester,
        _phone,
        server: _buddyChat(),
        initial: 'offline',
      );
      expect(find.text('Message Buddy'), findsOneWidget);
      expect(tester.widget<TextField>(_field).decoration!.hintMaxLines, 1);
      expect(
        tester.getRect(_session).top,
        greaterThanOrEqualTo(tester.getRect(_field).bottom),
      );
      expect(
        tester.getRect(_session).right,
        lessThan(tester.getRect(_send).left),
      );
      expect(_note, findsNothing);
      expect(
        _phone.height - tester.getRect(_surface).bottom,
        lessThanOrEqualTo(8),
      );
      await tester.enterText(_field, 'a draft');
      await tester.tap(_session);
      await tester.pump();
      expect(
        tester.getRect(_note).bottom,
        lessThanOrEqualTo(tester.getRect(_surface).top),
      );
      expect(
        _phone.height - tester.getRect(_surface).bottom,
        lessThanOrEqualTo(8),
      );
      // The field kept its input through the line coming in above it.
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

  testWidgets('a long chat title stays one line in its hint', (tester) async {
    final (_, c) = await mountPhoneSuperTab(
      tester,
      _phone,
      seed: (server) {
        ((server.state['conversations'] as List).first as Map)['title'] = 'A very long conversation title that would have wrapped on this phone';
      },
    );
    expect(tester.widget<TextField>(_field).decoration!.hintMaxLines, 1);
    expect(tester.getSize(_field).height, lessThan(30));
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
      'a long draft with New session on fits a 320x$height phone with a ${keyboard}px keyboard',
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
        await tester.tap(_session);
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

  testWidgets('the keyboard closing gives the field its 5 lines back', (
    tester,
  ) async {
    final (_, c) = await mountPhoneSuperTab(tester, const Size(320, 568));
    tester.view.viewInsets = const FakeViewPadding(bottom: 216);
    addTearDown(tester.view.resetViewInsets);
    await tester.pumpAndSettle();
    await tester.enterText(_field, List.filled(12, 'line').join('\n'));
    await tester.pumpAndSettle();
    final small = tester.getSize(_field).height;
    tester.view.resetViewInsets();
    await tester.pumpAndSettle();
    expect(tester.getSize(_field).height, greaterThan(small));
    expect(
      tester.widget<TextField>(_field).controller!.text.split('\n'),
      hasLength(12),
    );
    expect(tester.takeException(), isNull);
    await unmountPhoneSuperTab(tester, c);
  });

  testWidgets('a phone on its side with its keyboard up keeps one row', (
    tester,
  ) async {
    final (_, c) = await mountPhoneSuperTab(tester, const Size(667, 375));
    expect(_actions, findsOneWidget);
    tester.view.viewInsets = const FakeViewPadding(bottom: 190);
    addTearDown(tester.view.resetViewInsets);
    await tester.pumpAndSettle();
    expect(_actions, findsNothing);
    await tester.enterText(_field, 'a draft');
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(_field).controller!.text, 'a draft');
    expect(tester.testTextInput.isVisible, isTrue);
    expect(tester.takeException(), isNull);
    await unmountPhoneSuperTab(tester, c);
  });

  testWidgets(
    'a short screen with a file, the note and a long draft does not overflow',
    (tester) async {
      final (_, c) = await mountPhoneSuperTab(
        tester,
        const Size(390, 320),
        server: _buddyChat(),
        initial: 'offline',
      );
      c.attachments('offline').add([
        HarnessAttachment('notes.txt', Uint8List(4)),
      ]);
      await tester.tap(_session);
      await tester.enterText(_field, List.filled(12, 'line').join('\n'));
      await tester.pumpAndSettle();
      expect(_note, findsOneWidget);
      expect(find.text('notes.txt'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await unmountPhoneSuperTab(tester, c);
    },
  );

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
      await tester.tap(_session);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(tester.getRect(_send).right, lessThanOrEqualTo(320));
      await unmountPhoneSuperTab(tester, c);
    },
  );
}

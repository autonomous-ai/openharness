import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Copy on a message says it worked (Tony, 11-02): Copied with a check for
/// about 3 seconds, in the main chat and in threads. Taps meanwhile neither
/// copy again nor restart the 3 seconds.
void main() {
  late List<String> copied;

  /// What the clipboard does with a copy; by default it takes it at once.
  late Future<void> Function() clipboard;

  setUp(() {
    copied = [];
    clipboard = () async {};
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') {
            copied.add((call.arguments as Map)['text'] as String);
            await clipboard();
          }
          return null;
        });
  });
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null),
  );

  Widget row(String id, String text, {bool inThread = false}) => MaterialApp(
    home: Scaffold(
      body: ListView(
        children: [
          SwarmMessageRow(
            message: SuperTabMessage.fromJson({
              'id': id,
              'conversationId': 'g1',
              'text': text,
              'sequence': 1,
              'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'Lead'},
              'createdAt': DateTime.utc(2026, 11, 2).toIso8601String(),
            }),
            name: 'River',
            look: (picture: null, status: null),
            role: 'PM',
            mentions: SwarmMentions(const []),
            grouped: false,
            lit: false,
            quote: null,
            actions: true,
            onTap: () {},
            onReply: () {},
            inThread: inThread,
          ),
        ],
      ),
    ),
  );

  void expectCopy(WidgetTester tester) {
    expect(find.text('Copy'), findsOneWidget);
    expect(find.text('Copied'), findsNothing);
    expect(find.byIcon(LucideIcons.copy), findsOneWidget);
    expect(find.byIcon(LucideIcons.check), findsNothing);
  }

  void expectCopied(WidgetTester tester) {
    expect(find.text('Copied'), findsOneWidget);
    expect(find.text('Copy'), findsNothing);
    expect(find.byIcon(LucideIcons.check), findsOneWidget);
    expect(find.byIcon(LucideIcons.copy), findsNothing);
  }

  for (final inThread in [false, true]) {
    final where = inThread ? 'in a thread' : 'in the main chat';

    testWidgets('$where, Copy reads Copied with a check, for about 3 seconds, '
        'then Copy again', (tester) async {
      await tester.pumpWidget(row('m1', 'the words', inThread: inThread));
      expectCopy(tester);

      await tester.tap(find.text('Copy'));
      await tester.pump();
      expect(copied, ['the words']);
      expectCopied(tester);

      await tester.pump(const Duration(milliseconds: 2900));
      expectCopied(tester);
      await tester.pump(const Duration(milliseconds: 200));
      expectCopy(tester);
    });
  }

  testWidgets('taps while it says Copied neither copy again nor restart the '
      '3 seconds', (tester) async {
    await tester.pumpWidget(row('m1', 'the words'));
    await tester.tap(find.text('Copy'));
    await tester.pump();

    for (var i = 0; i < 3; i++) {
      await tester.pump(const Duration(milliseconds: 900));
      await tester.tap(find.text('Copied'));
      await tester.pump();
    }
    expect(copied, ['the words'], reason: 'one copy');
    expectCopied(tester);

    // 2.7 s gone: a restart on the last tap would hold it for 3 s more.
    await tester.pump(const Duration(milliseconds: 400));
    expectCopy(tester);
  });

  testWidgets('it copies again once it reads Copy again', (tester) async {
    await tester.pumpWidget(row('m1', 'the words'));
    await tester.tap(find.text('Copy'));
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expectCopy(tester);

    await tester.tap(find.text('Copy'));
    await tester.pump();
    expect(copied, ['the words', 'the words']);
    expectCopied(tester);
  });

  testWidgets('a second tap while the clipboard is still taking the first '
      'copies once', (tester) async {
    final taking = Completer<void>();
    clipboard = () => taking.future;
    await tester.pumpWidget(row('m1', 'the words'));

    await tester.tap(find.text('Copy'));
    await tester.pump();
    await tester.tap(find.text('Copy'));
    await tester.pump();
    expect(copied, ['the words']);
    expectCopy(tester);

    taking.complete();
    await tester.pump();
    await tester.pump();
    expectCopied(tester);
  });

  testWidgets('a copy that failed never says Copied, and can be tried again', (
    tester,
  ) async {
    clipboard = () async => throw PlatformException(code: 'clipboard');
    await tester.pumpWidget(row('m1', 'the words'));

    await tester.tap(find.text('Copy'));
    await tester.pump();
    expect(tester.takeException(), isNull);
    expectCopy(tester);

    clipboard = () async {};
    await tester.tap(find.text('Copy'));
    await tester.pump();
    expect(copied, ['the words', 'the words']);
    expectCopied(tester);
  });

  testWidgets('the row showing another message is not Copied, and copies that '
      'message', (tester) async {
    await tester.pumpWidget(row('m1', 'the words'));
    await tester.tap(find.text('Copy'));
    await tester.pump();
    expectCopied(tester);

    await tester.pumpWidget(row('m2', 'other words'));
    expectCopy(tester);
    await tester.tap(find.text('Copy'));
    await tester.pump();
    expect(copied, ['the words', 'other words']);
  });

  testWidgets('it copies the words the message has now', (tester) async {
    await tester.pumpWidget(row('m1', 'the words'));
    await tester.pumpWidget(row('m1', 'edited words'));
    await tester.tap(find.text('Copy'));
    await tester.pump();
    expect(copied, ['edited words']);
  });

  testWidgets('the row leaving while it says Copied leaves nothing running', (
    tester,
  ) async {
    await tester.pumpWidget(row('m1', 'the words'));
    await tester.tap(find.text('Copy'));
    await tester.pump();
    expectCopied(tester);

    await tester.pumpWidget(const SizedBox());
    // A timer still running fails this test when it ends.
    expect(tester.takeException(), isNull);
  });

  testWidgets('the row leaving while the clipboard is taking the copy changes '
      'nothing after it', (tester) async {
    final taking = Completer<void>();
    clipboard = () => taking.future;
    await tester.pumpWidget(row('m1', 'the words'));
    await tester.tap(find.text('Copy'));
    await tester.pump();

    await tester.pumpWidget(const SizedBox());
    taking.complete();
    await tester.pump();
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('a screen reader hears Copied too', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(row('m1', 'the words'));
    expect(find.bySemanticsLabel('Copy'), findsOneWidget);

    await tester.tap(find.text('Copy'));
    await tester.pump();
    expect(find.bySemanticsLabel('Copied'), findsOneWidget);
    semantics.dispose();
  });
}

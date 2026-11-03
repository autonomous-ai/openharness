import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_code_block.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';

/// A fenced block in a message, as Slack shows one on a phone (Dee, 10-29):
/// monospace, its name, Copy, and a long one folded behind Show more.
void main() {
  group('swarmTextParts', () {
    test('splits prose from fenced blocks, with each fence name', () {
      expect(
        swarmTextParts('Try:\n```main.dart\nfinal x = 1;\n```\nthen run it'),
        [
          (text: 'Try:', code: false, name: null),
          (text: 'final x = 1;', code: true, name: 'main.dart'),
          (text: 'then run it', code: false, name: null),
        ],
      );
    });

    test('a fence with no name, and text with no fence', () {
      expect(swarmTextParts('```\nls -la\n```'), [
        (text: 'ls -la', code: true, name: null),
      ]);
      expect(swarmTextParts('plain words'), [
        (text: 'plain words', code: false, name: null),
      ]);
    });

    test('an unclosed fence stays prose', () {
      expect(swarmTextParts('see ```dart\nx'), [
        (text: 'see ```dart\nx', code: false, name: null),
      ]);
    });
  });

  late List<String> copied;
  setUp(() {
    copied = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') {
            copied.add((call.arguments as Map)['text'] as String);
          }
          return null;
        });
  });
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null),
  );

  Future<void> show(WidgetTester tester, String text) async {
    final message = SuperTabMessage.fromJson({
      'id': 'm1',
      'conversationId': 'g1',
      'text': text,
      'sequence': 1,
      'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'Lead'},
      'createdAt': DateTime.now().toUtc().toIso8601String(),
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView(
            children: [
              SwarmMessageRow(
                message: message,
                name: 'River',
                look: (picture: null, status: null),
                role: 'PM',
                mentions: SwarmMentions(const []),
                grouped: false,
                lit: false,
                quote: null,
                actions: false,
                onTap: () {},
                onReply: null,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('a code block is monospace, named, and Copy copies it', (
    tester,
  ) async {
    await show(tester, 'Try:\n```main.dart\nfinal x = 1;\nprint(x);\n```');

    expect(find.text('Try:'), findsOneWidget);
    final code = find.text('final x = 1;\nprint(x);');
    expect(code, findsOneWidget);
    expect(
      tester.widget<Text>(code).style?.fontFamily,
      Tty.of(tester.element(code)).fontFamily,
    );
    expect(find.text('main.dart'), findsOneWidget);
    expect(find.textContaining('```'), findsNothing);
    await tester.tap(find.text('Copy'));
    await tester.pump();
    expect(copied, ['final x = 1;\nprint(x);']);
  });

  testWidgets('a long block folds with Show more, and Copy takes it all', (
    tester,
  ) async {
    final lines = [for (var i = 1; i <= 30; i++) 'line $i'];
    await show(tester, '```\n${lines.join('\n')}\n```');

    expect(find.text(lines.take(12).join('\n')), findsOneWidget);
    expect(find.textContaining('line 13'), findsNothing);
    await tester.tap(find.text('Show more'));
    await tester.pump();
    expect(find.text(lines.join('\n')), findsOneWidget);
    await tester.ensureVisible(find.text('Show less'));
    await tester.pump();
    await tester.tap(find.text('Show less'));
    await tester.pump();
    expect(find.textContaining('line 13'), findsNothing);
    await tester.tap(find.text('Copy'));
    await tester.pump();
    expect(copied, [lines.join('\n')]);
  });

  testWidgets('a short block has no Show more', (tester) async {
    await show(
      tester,
      '```\n${[for (var i = 1; i <= 12; i++) 'l$i'].join('\n')}\n```',
    );

    expect(find.text('Show more'), findsNothing);
  });

  testWidgets('every Copy and Show more is a finger tall', (tester) async {
    final lines = [for (var i = 1; i <= 30; i++) 'line $i'];
    await show(tester, '```\n${lines.join('\n')}\n```');

    for (final label in ['Copy', 'Show more']) {
      final control = find.ancestor(
        of: find.text(label),
        matching: find.byType(GestureDetector),
      );
      expect(tester.getSize(control.first).height, greaterThanOrEqualTo(44));
    }
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/pending_question.dart';

import 'edge_fixture.dart';

/// Focus's edge cases that are not about room: names cut short, machines that go away, taps that
/// come twice, a keyboard and a mic at once.
void main() {
  Future<void> pumpFocus(
    WidgetTester tester,
    AppNotifier app, {
    String agentId = 'a',
  }) async {
    setPhone(tester, largePhone);
    await tester.pumpWidget(
      phoneApp(
        TerminalPage(
          notifier: app,
          machineId: 'm',
          agentId: agentId,
          voice: edgeVoice().voice,
        ),
      ),
    );
    await frames(tester);
  }

  void ask(AppNotifier app, String agentId) {
    app.stateOf('m')!.blockedAgents[agentId] = PendingQuestion(
      machineId: 'm',
      agentId: agentId,
      requestId: 'q-$agentId',
      answerKey: '1',
      prompt: 'Run the migration?',
      options: const ['Yes', 'No'],
      multi: false,
      since: DateTime.now(),
    );
  }

  bool wellFormed(String text) {
    final units = text.codeUnits;
    for (var i = 0; i < units.length; i++) {
      final unit = units[i];
      if (unit >= 0xD800 && unit <= 0xDBFF) {
        if (i + 1 >= units.length ||
            units[i + 1] < 0xDC00 ||
            units[i + 1] > 0xDFFF) {
          return false;
        }
        i++;
      } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
        return false;
      }
    }
    return true;
  }

  group('names cut short keep whole characters', () {
    testWidgets('another harness asking, its emoji name cut at a dozen', (
      tester,
    ) async {
      final app = edgeApp(
        agents: [
          edgeAgent('a'),
          edgeAgent('b', name: emojiName),
        ],
      );
      addTearDown(app.dispose);
      ask(app, 'b');
      await liveTerminal(app, 'a');
      await pumpFocus(tester, app);

      // Before: `substring(0, 12)` kept half of 👩, and the text engine threw on the title.
      expect(tester.takeException(), isNull);
      final asking = tester
          .widgetList<Text>(find.byType(Text))
          .map((text) => text.data ?? '')
          .firstWhere((text) => text.endsWith(' asking'));
      expect(asking, '🚀 ship it 👩‍💻🔥 asking');
      expect(wellFormed(asking), isTrue);
      await unmount(tester);
    });

    testWidgets('a long branch with emoji, shortened in the middle', (
      tester,
    ) async {
      const branch = 'feat/🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀-launch-the-rocket';
      final app = edgeApp(agents: [edgeAgent('a', branch: branch)]);
      addTearDown(app.dispose);
      await liveTerminal(app, 'a');
      await pumpFocus(tester, app);

      expect(tester.takeException(), isNull);
      expect(
        find.text('feat/🚀🚀🚀🚀🚀🚀🚀🚀🚀…nch-the-rocket'),
        findsOneWidget,
      );
      await unmount(tester);
    });
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/agent_install_cover.dart';

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  testWidgets(
    'says the agent is getting ready, with a moving bar and the waiting message',
    (tester) async {
      await tester.pumpWidget(
        _host(AgentInstallCover(engine: 'cursor', messageWaiting: true)),
      );
      expect(find.text('Getting Cursor ready…'), findsOneWidget);
      expect(find.textContaining('your message is waiting'), findsOneWidget);
      final first = tester
          .widget<LinearProgressIndicator>(
            find.byKey(const ValueKey('agent-install-progress')),
          )
          .value!;
      await tester.pump(const Duration(seconds: 3));
      final later = tester
          .widget<LinearProgressIndicator>(
            find.byKey(const ValueKey('agent-install-progress')),
          )
          .value!;
      expect(later, greaterThan(first));
      expect(later, lessThan(1));
      expect(find.textContaining('harness:'), findsNothing);
    },
  );

  testWidgets(
    'Show details uncovers the terminal and Hide details covers it again',
    (tester) async {
      await tester.pumpWidget(_host(AgentInstallCover(engine: 'copilot')));
      await tester.tap(
        find.byKey(const ValueKey('agent-install-show-details')),
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('agent-install-cover')), findsNothing);
      expect(find.text('Getting Copilot ready…'), findsOneWidget);
      await tester.tap(
        find.byKey(const ValueKey('agent-install-hide-details')),
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('agent-install-cover')), findsOneWidget);
    },
  );

  testWidgets('a failed install says so and offers Try again', (tester) async {
    var tried = 0;
    await tester.pumpWidget(
      _host(
        AgentInstallCover(
          engine: 'grok',
          failed: true,
          onTryAgain: () => tried++,
        ),
      ),
    );
    expect(find.text('Grok could not be installed'), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-install-progress')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('agent-install-try-again')));
    expect(tried, 1);
  });
}

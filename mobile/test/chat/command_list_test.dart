import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/chat/chat_composer.dart';
import 'package:harness_mobile/chat/command_list.dart';
import 'package:harness_mobile/core/agent_command.dart';

/// The chat's `/` list as somebody types into it: the agent's own commands, narrowed as the name is typed, and one
/// tapped into the composer.
void main() {
  const commands = [
    AgentCommand(
      name: 'compact',
      description: 'Free up context by summarizing the conversation so far',
      argumentHint: '[instructions]',
    ),
    AgentCommand(name: 'model', description: 'Set the AI model'),
    AgentCommand(name: 'clear', description: 'Start a new session'),
    AgentCommand(name: 'autocompact', description: 'Compact on its own'),
  ];

  Future<int Function()> open(
    WidgetTester tester, {
    List<AgentCommand> answer = commands,
  }) async {
    var asked = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: ChatComposer(
              onSend: (_) async => true,
              onStop: () {},
              working: false,
              commands: () async {
                asked++;
                return answer;
              },
            ),
          ),
        ),
      ),
    );
    return () => asked;
  }

  testWidgets('a `/` lists the agent\'s commands with their lines', (
    tester,
  ) async {
    final asked = await open(tester);
    expect(find.byType(CommandList), findsNothing);
    expect(asked(), 0, reason: 'nothing is asked before a `/`');

    await tester.enterText(find.byType(TextField), '/');
    await tester.pump();
    expect(find.text('Commands'), findsOneWidget);
    expect(find.text('/compact [instructions]'), findsOneWidget);
    expect(
      find.text('Free up context by summarizing the conversation so far'),
      findsOneWidget,
    );
    expect(find.text('/model'), findsOneWidget);

    // Typed again and again, asked once.
    await tester.enterText(find.byType(TextField), '');
    await tester.pump();
    expect(find.byType(CommandList), findsNothing);
    await tester.enterText(find.byType(TextField), '/');
    await tester.pump();
    expect(asked(), 1);
  });

  testWidgets(
    'the name typed narrows it, those starting with it first, and a tap puts the command in the composer',
    (tester) async {
      await open(tester);
      await tester.enterText(find.byType(TextField), '/comp');
      await tester.pump();
      final shown = tester.widget<CommandList>(find.byType(CommandList));
      expect(shown.commands.map((c) => c.name), ['compact', 'autocompact']);

      await tester.tap(find.text('/compact [instructions]'));
      await tester.pump();
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller!.text, '/compact ');
      // A space after the name: the command is chosen, and the list goes.
      expect(find.byType(CommandList), findsNothing);
    },
  );

  testWidgets(
    'no list for a name nothing matches, and none from an agent with no commands, asked again later',
    (tester) async {
      final asked = await open(tester, answer: const []);
      await tester.enterText(find.byType(TextField), '/');
      await tester.pump();
      expect(find.byType(CommandList), findsNothing);
      await tester.enterText(find.byType(TextField), '/x');
      await tester.pump();
      expect(asked(), 2);
    },
  );

  testWidgets(
    'a bare `/model` opens the Model sheet instead of the agent\'s picker, which Chat UI would hide',
    (tester) async {
      final sent = <String>[];
      var sheets = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: ChatComposer(
                onSend: (text) async {
                  sent.add(text);
                  return true;
                },
                onStop: () {},
                working: false,
                model: 'Claude Opus 5.5',
                onModel: () => sheets++,
                sheetCommands: const {'/model', '/effort'},
              ),
            ),
          ),
        ),
      );
      Future<void> send(String text) async {
        await tester.enterText(find.byType(TextField), text);
        await tester.pump();
        await tester.tap(find.byTooltip('Send'));
        await tester.pump();
      }

      await send('/model ');
      expect(sheets, 1);
      expect(sent, isEmpty);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty,
      );
      // With its argument it picks nothing: Claude Code takes it as it is.
      await send('/model sonnet');
      expect(sent, ['/model sonnet']);
      expect(sheets, 1);
    },
  );
}

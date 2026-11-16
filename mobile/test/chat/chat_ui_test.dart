import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/chat/chat_composer.dart';
import 'package:harness_mobile/chat/chat_transcript.dart';
import 'package:harness_mobile/chat/chat_view.dart';
import 'package:harness_mobile/chat/chat_view_store.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/terminal/question_pane.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../phone_edge/edge_fixture.dart';
import '../voice_fakes.dart';

Map<String, dynamic> _event(String type, Map<String, dynamic> payload) => {
  'type': type,
  'payload': payload,
};

/// Chat UI as somebody uses it: turned on in Settings, read, answered and written to.
void main() {
  setUpAll(
    () => PackageInfo.setMockInitialValues(
      appName: 'Harness',
      packageName: 'ai.autonomous.harness',
      version: '1.2.3',
      buildNumber: '456',
      buildSignature: '',
    ),
  );
  setUp(() => chatViewStore.storageForTest = MemoryKeyValueStore());
  tearDown(() => chatViewStore.setChatByDefault(false));

  testWidgets('Settings ▸ Chat UI opens every agent as chat', (tester) async {
    setPhone(tester, largePhone);
    final app = edgeApp();
    app.currentUser = const CurrentUserProfile(
      id: 'u',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    );
    await tester.pumpWidget(phoneApp(SettingsPage(notifier: app, large: true)));
    await frames(tester);
    expect(chatViewStore.showsChat('m', 'a'), isFalse);

    await tapInView(tester, find.text('Open agents in Chat UI'));
    await frames(tester);

    expect(chatViewStore.chatByDefault, isTrue);
    expect(chatViewStore.showsChat('m', 'a'), isTrue);
    expect(tester.widget<Switch>(find.byType(Switch).last).value, isTrue);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  });

  testWidgets(
    'the conversation reads as chat, and a dialog is answered with a tap',
    (tester) async {
      setPhone(tester, largePhone);
      final conversation = ChatConversation(
        read: (_) async => (
          events: [
            _event('user_message', {'content': 'Deploy it'}),
            _event('text_delta', {'content': 'Deploying **now**.'}),
            _event('tool_start', {
              'id': 't1',
              'tool': 'Bash',
              'input': {'command': 'make deploy'},
            }),
          ],
          hasMore: false,
          oldestCursor: null,
        ),
      );
      await conversation.open();
      const question = QuestionPaneView(
        question: 'Do you want to proceed?',
        rows: [
          QuestionPaneRow(number: '1', label: 'Yes', checked: false),
          QuestionPaneRow(number: '2', label: 'No', checked: false),
        ],
        multi: false,
        enterSubmits: false,
        partial: false,
      );
      String? pressed;
      await tester.pumpWidget(
        phoneApp(
          ChatTranscriptView(
            conversation: conversation,
            question: question,
            onAnswer: (view, number) => pressed = number,
          ),
        ),
      );
      await frames(tester);

      expect(find.text('Deploy it'), findsOneWidget);
      expect(
        find.textContaining('Deploying', findRichText: true),
        findsOneWidget,
      );
      expect(find.text('Bash'), findsOneWidget);
      expect(find.text('make deploy'), findsOneWidget);
      expect(find.text('Do you want to proceed?'), findsOneWidget);

      await tester.tap(find.text('1. Yes'));
      expect(pressed, '1');

      conversation.ingest('turn_started', {'userMessage': 'Deploy it'});
      await tester.pump();
      expect(find.textContaining('Working'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'the composer sends what is typed, and Stop shows while the agent works',
    (tester) async {
      setPhone(tester, largePhone);
      final sent = <String>[];
      var stopped = 0;
      Widget composer({required bool working}) => phoneApp(
        Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: ChatComposer(
              working: working,
              onSend: (text) async {
                sent.add(text);
                return true;
              },
              onStop: () => stopped++,
            ),
          ),
        ),
      );
      await tester.pumpWidget(composer(working: false));
      await tester.enterText(find.byType(TextField), 'run the tests');
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await tester.pump();

      expect(sent, ['run the tests']);
      expect(
        find.text('run the tests'),
        findsNothing,
        reason: 'cleared once sent',
      );

      await tester.pumpWidget(composer(working: true));
      await tester.tap(find.byTooltip('Stop'));
      expect(stopped, 1);
      await tester.pumpWidget(const SizedBox());
    },
  );
}

// Voice messages in a Swarm conversation (#2584): a message whose one file
// carries `voice`, its words the message's text. The model reads the clip's
// facts, and every quote of one says its length rather than its words.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_link.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/voice_length.dart';

import 'support/super_tab_fixture.dart';

const _words = 'Ship the login fix today, then look at the sidebar.';

/// A voice file as the backend's message reads give it (backend messages.ts).
Map<String, dynamic> voiceRow({
  String id = 'v1',
  int durationMs = 81000,
  bool transcribed = true,
  String? failure,
  Object? waveform,
}) => {
  'id': id,
  'name': 'Voice message.wav',
  'mime': 'audio/wav',
  'size': 2592044,
  'url': 'https://cdn.harness.autonomous.ai/$id/Voice%20message.wav',
  'voice': {
    'durationMs': durationMs,
    'waveform': waveform ?? [for (var i = 0; i < 48; i++) (i * 7) % 32],
    'transcribed': transcribed,
    'failure': ?failure,
  },
};

SuperTabAttachment attachment(Map<String, dynamic> row) =>
    SuperTabAttachment.fromJson(row);

void main() {
  group('the model', () {
    test('reads a voice file’s length, waveform and whether it has words', () {
      final voice = attachment(voiceRow()).voice!;
      expect(voice.durationMs, 81000);
      expect(voice.waveform, hasLength(48));
      expect(voice.waveform.take(3), [0, 7, 14]);
      expect(voice.transcribed, isTrue);
      expect(voice.failure, isNull);
    });

    test('a file with no words says why', () {
      final voice = attachment(voiceRow(transcribed: false, failure: 'limit'))
          .voice!;
      expect(voice.transcribed, isFalse);
      expect(voice.failure, 'limit');
    });

    test('a waveform value out of range is held to 0..31', () {
      final voice = attachment(voiceRow(waveform: [-4, 0, 31, 40, 12.6]))
          .voice!;
      expect(voice.waveform, [0, 0, 31, 31, 12]);
    });

    test('an old file has no voice', () {
      final row = voiceRow()..remove('voice');
      expect(attachment(row).voice, isNull);
    });

    test('a malformed voice reads as none and keeps the file', () {
      for (final bad in <Object?>[
        'voice',
        42,
        <String, Object?>{'durationMs': 'long', 'waveform': <int>[]},
        <String, Object?>{'durationMs': 81000, 'waveform': 'bars'},
        <String, Object?>{'durationMs': 81000, 'transcribed': true},
        <String, Object?>{
          'durationMs': -1,
          'waveform': <int>[],
          'transcribed': true,
        },
        <String, Object?>{
          'durationMs': 81000,
          'waveform': ['a'],
          'transcribed': 'yes',
        },
      ]) {
        final file = attachment(voiceRow()..['voice'] = bad);
        expect(file.voice, isNull, reason: '$bad');
        expect(file.id, 'v1', reason: '$bad');
      }
      final message = SuperTabMessage.fromJson({
        'id': 'm1',
        'conversationId': 'lead',
        'sequence': 1,
        'text': '',
        'author': {'kind': 'person', 'id': 'owner', 'name': 'Owner'},
        'attachments': [voiceRow()..['voice'] = 'broken'],
      });
      expect(message.attachments.single.voice, isNull);
    });

    test('a message’s voice file is the one that carries voice', () {
      SuperTabMessage message(List<Map<String, dynamic>> files) =>
          SuperTabMessage.fromJson({
            'id': 'm1',
            'conversationId': 'lead',
            'sequence': 1,
            'text': _words,
            'author': {'kind': 'person', 'id': 'owner', 'name': 'Owner'},
            'attachments': files,
          });
      expect(superTabVoiceOf(message([voiceRow()]))?.id, 'v1');
      expect(superTabVoiceOf(message([voiceRow()..remove('voice')])), isNull);
      expect(superTabVoiceOf(message([])), isNull);
    });
  });

  group('the length', () {
    test('is M:SS, rounded down to the second', () {
      expect(superTabVoiceLength(const Duration(seconds: 81)), '1:21');
      expect(superTabVoiceLength(const Duration(seconds: 600)), '10:00');
      expect(superTabVoiceLength(const Duration(milliseconds: 999)), '0:00');
      expect(superTabVoiceLength(const Duration(milliseconds: 81999)), '1:21');
      expect(superTabVoiceLength(const Duration(seconds: 9)), '0:09');
      expect(superTabVoiceLength(Duration.zero), '0:00');
    });

    test('labels a voice message', () {
      expect(
        superTabVoiceLabel(const Duration(seconds: 81)),
        'Voice message (1:21)',
      );
    });
  });

  group('quotes of a voice message', () {
    late SuperTabController c;

    Future<void> show(WidgetTester tester, ConversationServer server) async {
      await tester.binding.setSurfaceSize(const Size(1200, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      c = server.controller();
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Team Mac',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    Future<void> close(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    }

    ConversationServer withVoice() =>
        ConversationServer()..append(_words, attachments: [voiceRow()]);

    testWidgets('a reply quotes its length, not its words', (tester) async {
      final server = withVoice()..append('On it.');
      server.messages.last['replyTo'] = 'message-1';
      await show(tester, server);
      final quote = find.descendant(
        of: find.byKey(const ValueKey('super-message-message-2')),
        matching: find.byType(SuperTabReplyPreview),
      );
      expect(
        find.descendant(of: quote, matching: find.text('Voice message (1:21)')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: quote, matching: find.textContaining('Ship')),
        findsNothing,
      );
      await close(tester);
    });

    testWidgets('the composer’s Replying to quotes its length', (tester) async {
      await show(tester, withVoice());
      final row = find.byKey(const ValueKey('super-message-message-1'));
      tester
          .widget<Focus>(
            find.descendant(of: row, matching: find.byType(Focus)).first,
          )
          .focusNode!
          .requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.keyR);
      await tester.pump();
      final quote = find.ancestor(
        of: find.textContaining('Replying to'),
        matching: find.byType(SuperTabReplyPreview),
      );
      expect(quote, findsOneWidget);
      expect(
        find.descendant(of: quote, matching: find.text('Voice message (1:21)')),
        findsOneWidget,
      );
      await close(tester);
    });

    testWidgets('a link to it previews its length', (tester) async {
      const link = SwarmMessageLink(
        tabId: 'tab',
        conversationId: 'lead',
        messageId: 'message-1',
      );
      await show(tester, withVoice()..append('See ${link.url}'));
      final preview = find.byKey(
        const ValueKey('super-message-link-preview-message-1'),
      );
      expect(preview, findsOneWidget);
      expect(
        find.descendant(
          of: preview,
          matching: find.text('Voice message (1:21)'),
        ),
        findsOneWidget,
      );
      await close(tester);
    });
  });
}

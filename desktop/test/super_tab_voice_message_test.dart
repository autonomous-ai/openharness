// Voice messages in a Swarm conversation (#2584): a message whose one file
// carries `voice`, its words the message's text. The model reads the clip's
// facts, every quote of one says its length rather than its words, and the
// chat draws it as a bubble that plays a local copy of the file.
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_link.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/message_text.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/voice_bubble.dart';
import 'package:harness/super_tabs/voice_length.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:video_player/video_player.dart';

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

  group('the bubble', () {
    final url = Uri.parse(
      'https://cdn.harness.autonomous.ai/v1/Voice%20message.wav',
    );
    final clip = Uint8List.fromList([for (var i = 0; i < 64; i++) i]);
    final fetched = <Uri>[], opened = <Uri>[], sources = <Uri>[];
    late _Player player;

    setUp(() {
      fetched.clear();
      opened.clear();
      sources.clear();
      final fetcher = attachmentFetcher,
          browser = browserOpener,
          makePlayer = superTabVoicePlayer;
      attachmentFetcher = (url, {maxBytes}) async {
        fetched.add(url);
        return clip;
      };
      browserOpener = (url) async {
        opened.add(url);
        return true;
      };
      superTabVoicePlayer = (source) {
        sources.add(source);
        return player = _Player();
      };
      addTearDown(() {
        attachmentFetcher = fetcher;
        browserOpener = browser;
        superTabVoicePlayer = makePlayer;
      });
    });

    final bubble = find.byKey(const ValueKey('super-attachment-voice:v1'));
    final toggle = find.byKey(const ValueKey('super-voice-words-toggle:v1'));
    final bars = find.byWidgetPredicate(
      (widget) => switch (widget.key) {
        ValueKey<String>(:final value) => value.startsWith(
          'super-voice-bar:v1:',
        ),
        _ => false,
      },
    );
    Color? colorOf(Element bar) =>
        ((bar.widget as DecoratedBox).decoration as BoxDecoration).color;

    /// Lets the copy be written to disk, which the test's clock does not run.
    Future<void> settleFiles(WidgetTester tester) async {
      for (var i = 0; i < 20 && sources.isEmpty; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 10)),
        );
        await tester.pump();
      }
      await tester.pump();
    }

    testWidgets('shows play, the waveform, its length and →A, and no text', (
      tester,
    ) async {
      await show(tester, withVoice());
      final row = find.byKey(const ValueKey('super-message-message-1'));
      expect(find.descendant(of: row, matching: bubble), findsOneWidget);
      expect(
        find.descendant(of: bubble, matching: find.byTooltip('Play')),
        findsOneWidget,
      );
      expect(bars, findsNWidgets(48));
      expect(
        find.descendant(of: bubble, matching: find.text('1:21')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: bubble, matching: find.text('→A')),
        findsOneWidget,
      );
      expect(find.text(_words), findsNothing);
      expect(
        find.descendant(of: row, matching: find.byType(SuperTabMessageText)),
        findsNothing,
      );
      // Not a file chip as well.
      expect(find.text('Voice message.wav'), findsNothing);
      expect(fetched, isEmpty);
      await close(tester);
    });

    testWidgets('→A shows the words under the bubble, and again hides them', (
      tester,
    ) async {
      await show(tester, withVoice());
      expect(find.byTooltip('Show words'), findsOneWidget);
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(find.text(_words), findsOneWidget);
      expect(find.byTooltip('Hide words'), findsOneWidget);
      expect(
        tester.getTopLeft(find.text(_words)).dy,
        greaterThan(tester.getBottomLeft(bubble).dy),
      );
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(find.text(_words), findsNothing);
      await close(tester);
    });

    testWidgets('a clip with no words says so, and why', (tester) async {
      await show(
        tester,
        ConversationServer()
          ..append('', attachments: [voiceRow(transcribed: false)])
          ..append(
            '',
            attachments: [
              voiceRow(id: 'v2', transcribed: false, failure: 'limit'),
            ],
          ),
      );
      await tester.tap(toggle);
      await tester.tap(
        find.byKey(const ValueKey('super-voice-words-toggle:v2')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Not transcribed'), findsOneWidget);
      expect(
        find.text('Not transcribed: today’s voice limit was used'),
        findsOneWidget,
      );
      await close(tester);
    });

    testWidgets('Play reads the file into a local copy and plays that', (
      tester,
    ) async {
      await show(tester, withVoice());
      await tester.tap(find.byTooltip('Play'));
      await settleFiles(tester);

      expect(fetched, [url]);
      final source = sources.single;
      expect(source.isScheme('file'), isTrue, reason: '$source');
      final copy = File.fromUri(source);
      expect(copy.readAsBytesSync(), clip);
      expect(player.calls, ['initialize', 'play']);
      expect(
        find.descendant(of: bubble, matching: find.byTooltip('Pause')),
        findsOneWidget,
      );

      await tester.tap(find.byTooltip('Pause'));
      await tester.pump();
      expect(player.calls.last, 'pause');
      expect(find.byTooltip('Play'), findsOneWidget);
      // Playing again plays the same copy, not another read.
      await tester.tap(find.byTooltip('Play'));
      await tester.pump();
      expect(player.calls.last, 'play');
      expect(fetched, hasLength(1));

      // The copy goes with the bubble.
      await close(tester);
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      expect(player.disposed, isTrue);
      expect(copy.existsSync(), isFalse);
    });

    testWidgets('the played part of the waveform fills in the accent', (
      tester,
    ) async {
      await show(tester, withVoice());
      final at = find.descendant(of: bubble, matching: bars);
      expect(at.evaluate().map(colorOf).toSet(), {
        DesktopChrome.muted,
      }, reason: 'nothing played yet');
      await tester.tap(find.byTooltip('Play'));
      await settleFiles(tester);
      player.value = player.value.copyWith(
        position: const Duration(milliseconds: 32400),
      );
      await tester.pump();

      final colors = at.evaluate().map(colorOf).toList();
      expect(colors.take(19).toSet(), {DesktopChrome.accent});
      expect(colors.skip(19).toSet(), {DesktopChrome.muted});
      // Playing, it counts up.
      expect(
        find.descendant(of: bubble, matching: find.text('0:32')),
        findsOneWidget,
      );

      player.finish();
      await tester.pump();
      expect(
        find.descendant(of: bubble, matching: find.text('1:21')),
        findsOneWidget,
      );
      expect(find.byTooltip('Play'), findsOneWidget);
      await close(tester);
    });

    testWidgets(
      'on Linux and Windows Play opens the file as a chip does',
      (tester) async {
        await show(tester, withVoice());
        await tester.tap(find.byTooltip('Play'));
        await tester.pumpAndSettle();
        expect(opened, [url]);
        expect(fetched, isEmpty);
        expect(sources, isEmpty);
        await close(tester);
      },
      variant: TargetPlatformVariant({
        TargetPlatform.linux,
        TargetPlatform.windows,
      }),
    );
  });
}

/// A player that plays nothing, and says what it was asked.
class _Player extends VideoPlayerController {
  _Player() : super.file(File('/voice/clip.wav'));

  final List<String> calls = [];
  bool disposed = false;

  @override
  Future<void> initialize() async {
    calls.add('initialize');
    value = value.copyWith(
      isInitialized: true,
      duration: const Duration(seconds: 81),
    );
  }

  @override
  Future<void> play() async {
    calls.add('play');
    value = value.copyWith(isPlaying: true, isCompleted: false);
  }

  @override
  Future<void> pause() async {
    calls.add('pause');
    value = value.copyWith(isPlaying: false);
  }

  @override
  Future<void> seekTo(Duration position) async {
    calls.add('seekTo');
    value = value.copyWith(position: position);
  }

  @override
  Future<void> dispose() async {
    disposed = true;
    await super.dispose();
  }

  void finish() => value = value.copyWith(
    isPlaying: false,
    isCompleted: true,
    position: const Duration(seconds: 81),
  );
}

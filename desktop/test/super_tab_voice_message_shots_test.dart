import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/voice_bubble.dart';
import 'package:video_player/video_player.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the voice message PR's pictures there.
final shots = Platform.environment['SUPER_TAB_VOICE_SHOTS'];

/// A chat with a voice message, as the PR shows it (#2584): at rest, with its
/// words open under →A, and playing at 40%, in both appearances.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets(
      'voice messages in ${brightness.name}',
      (tester) async {
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        tester.view.devicePixelRatio = 2;
        tester.view.physicalSize = const Size(2400, 1400);
        addTearDown(tester.view.reset);

        final fetcher = attachmentFetcher, makePlayer = superTabVoicePlayer;
        _Player? player;
        attachmentFetcher = (url, {maxBytes}) async => Uint8List(64);
        superTabVoicePlayer = (_) => player = _Player();
        addTearDown(() {
          attachmentFetcher = fetcher;
          superTabVoicePlayer = makePlayer;
        });

        final server = ConversationServer();
        (server.state['people'] as List).add({
          'id': 'dee',
          'email': 'dee@example.com',
          'role': 'collaborator',
        });
        final now = DateTime.now().toUtc();
        void say(
          String text,
          Map<String, Object> author, {
          List<Map<String, Object>> files = const [],
          String? replyTo,
          int secondsAgo = 0,
        }) {
          server.append(text, attachments: files);
          server.messages.last
            ..['author'] = author
            ..['createdAt'] = now
                .subtract(Duration(seconds: secondsAgo))
                .toIso8601String();
          if (replyTo != null) server.messages.last['replyTo'] = replyTo;
        }

        const dee = {'kind': 'person', 'id': 'dee', 'name': 'dee@example.com'};
        const pm = {
          'kind': 'agent',
          'id': 'pm',
          'name': 'Lead',
          'displayName': 'River',
        };
        // A spoken message's loudness: quiet at the edges, louder in phrases.
        final waveform = [
          for (var i = 0; i < 48; i++)
            (4 + 24 * ((i * 37) % 11) / 10 * (1 - (i - 24).abs() / 30)).round(),
        ];
        say('The sidebar is fixed on my phone now.', dee, secondsAgo: 400);
        say(
          'The login screen still hangs after I pick Google. Can someone '
          'look at it today, and then at the sidebar on the phone? It '
          'scrolls under the keyboard.',
          dee,
          secondsAgo: 300,
          files: [
            {
              'id': 'v1',
              'name': 'Voice message.wav',
              'mime': 'audio/wav',
              'size': 2592044,
              'url': 'https://cdn.harness.autonomous.ai/v1/Voice%20message.wav',
              'voice': {
                'durationMs': 81000,
                'waveform': waveform,
                'transcribed': true,
              },
            },
          ],
        );
        say(
          'On it: the login hang first, then the sidebar.',
          pm,
          replyTo: 'message-2',
          secondsAgo: 240,
        );
        ((server.state['conversations'] as List)[0] as Map)['leadId'] = 'pm';
        final c = server.controller(account: 'dee');
        await c.refresh();
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: SuperTabView(
                controller: c,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Mac Studio',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await captureWindow(tester, shots, 'voice-chat-${brightness.name}');

        final words = find.byKey(const ValueKey('super-voice-words-toggle:v1'));
        await tester.tap(words);
        await tester.pumpAndSettle();
        await captureWindow(tester, shots, 'voice-words-${brightness.name}');
        await tester.tap(words);
        await tester.pumpAndSettle();

        await tester.tap(find.byTooltip('Play'));
        for (var i = 0; i < 20 && player == null; i++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 10)),
          );
          await tester.pump();
        }
        player!.value = player!.value.copyWith(
          position: const Duration(milliseconds: 32400),
        );
        await tester.pumpAndSettle();
        expect(find.byTooltip('Pause'), findsOneWidget);
        await captureWindow(tester, shots, 'voice-playing-${brightness.name}');

        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
      },
      skip: shots == null,
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  }
}

/// A player that plays nothing and stays where it is put.
class _Player extends VideoPlayerController {
  _Player() : super.file(File('/voice/clip.wav'));

  @override
  Future<void> initialize() async => value = value.copyWith(
    isInitialized: true,
    duration: const Duration(seconds: 81),
  );

  @override
  Future<void> play() async => value = value.copyWith(isPlaying: true);

  @override
  Future<void> pause() async => value = value.copyWith(isPlaying: false);
}

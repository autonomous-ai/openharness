import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_file_links.dart';
import 'package:harness_mobile/swarm/swarm_voice_bubble.dart';
import 'package:video_player/video_player.dart';

/// A voice message as both apps draw it (task #2584):
///
///     ( ▶ )  ıllıllııılllıı.ılıı.ıll   1:21        →A
///
/// Play hears it, from a copy of the file on the phone; →A shows its words
/// under it, and a second tap hides them.
void main() {
  final clip = SuperTabAttachment.fromJson({
    'id': 'clip',
    'name': 'Voice message.wav',
    'mime': 'audio/wav',
    'size': 2592044,
    'url': 'https://cdn.example.test/super-tabs/tab/abc/Voice_message.wav',
    'voice': {
      'durationMs': 81000,
      'waveform': List.generate(48, (i) => i % 32),
      'transcribed': true,
    },
  });
  late _Player player;
  late List<SwarmFileRef> fetched;
  File? local;

  setUp(() {
    player = _Player();
    fetched = [];
    local = File('/cache/clip.wav');
    final file = swarmVoiceFile, make = swarmVoicePlayer;
    swarmVoiceFile = (context, ref) async {
      fetched.add(ref);
      return local;
    };
    swarmVoicePlayer = (file) {
      player.source = file;
      return player;
    };
    addTearDown(() {
      swarmVoiceFile = file;
      swarmVoicePlayer = make;
    });
  });

  Future<void> pump(
    WidgetTester tester, {
    SuperTabAttachment? file,
    String words = 'Ship the parser today.',
  }) async {
    final shown = file ?? clip;
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SwarmVoiceBubble(
            file: shown,
            voice: shown.voice!,
            words: words,
            fileRef: SwarmFileRef(shown),
          ),
        ),
      ),
    );
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  testWidgets('shows play, its waveform, its length and →A, and no words', (
    tester,
  ) async {
    await pump(tester);
    expect(key('swarm-voice-play'), findsOneWidget);
    expect(key('swarm-voice-bars'), findsOneWidget);
    expect(find.text('1:21'), findsOneWidget);
    expect(key('swarm-voice-words-toggle'), findsOneWidget);
    expect(find.text('Ship the parser today.'), findsNothing);
  });

  testWidgets('→A shows its words under it, and a second tap hides them', (
    tester,
  ) async {
    await pump(tester);
    await tester.tap(key('swarm-voice-words-toggle'));
    await tester.pump();
    expect(find.text('Ship the parser today.'), findsOneWidget);
    await tester.tap(key('swarm-voice-words-toggle'));
    await tester.pump();
    expect(find.text('Ship the parser today.'), findsNothing);
  });

  testWidgets('without words, →A says why', (tester) async {
    final quiet = SuperTabAttachment.fromJson({
      'id': 'quiet',
      'name': 'Voice message.wav',
      'mime': 'audio/wav',
      'size': 64044,
      'url': 'https://cdn.example.test/super-tabs/tab/abc/q.wav',
      'voice': {
        'durationMs': 2000,
        'waveform': List.filled(48, 3),
        'transcribed': false,
        'failure': 'limit',
      },
    });
    await pump(tester, file: quiet, words: '');
    await tester.tap(key('swarm-voice-words-toggle'));
    await tester.pump();
    expect(find.text(swarmVoiceNoWordsLimit), findsOneWidget);
  });

  testWidgets('Play hears a copy of the file on the phone, and shows pause', (
    tester,
  ) async {
    await pump(tester);
    await tester.tap(key('swarm-voice-play'));
    await tester.pump();
    await tester.pump();
    expect(fetched.single.file.id, 'clip');
    expect(player.source!.path, '/cache/clip.wav');
    expect(player.calls, ['initialize', 'play']);
    expect(key('swarm-voice-pause'), findsOneWidget);

    await tester.tap(key('swarm-voice-pause'));
    await tester.pump();
    expect(player.calls.last, 'pause');
    expect(key('swarm-voice-play'), findsOneWidget);
  });

  testWidgets('the part played fills its bars, and the time counts it', (
    tester,
  ) async {
    await pump(tester);
    await tester.tap(key('swarm-voice-play'));
    await tester.pump();
    await tester.pump();
    player.value = player.value.copyWith(
      position: const Duration(milliseconds: 40500),
    );
    await tester.pump();
    final bars = tester.widget<SwarmVoiceBars>(key('swarm-voice-bars'));
    expect(bars.played, closeTo(0.5, 0.01));
    expect(find.text('0:40'), findsOneWidget);
  });

  testWidgets('a file that cannot be had plays nothing', (tester) async {
    local = null;
    await pump(tester);
    await tester.tap(key('swarm-voice-play'));
    await tester.pump();
    await tester.pump();
    expect(player.calls, isEmpty);
    expect(key('swarm-voice-play'), findsOneWidget);
  });
}

class _Player extends VideoPlayerController {
  _Player() : super.file(File('/nowhere.wav'));

  File? source;
  final List<String> calls = [];

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
    value = value.copyWith(position: position);
  }

  @override
  Future<void> dispose() async {}
}

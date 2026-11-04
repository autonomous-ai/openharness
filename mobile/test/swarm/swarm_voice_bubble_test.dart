import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_attachment_store.dart';
import 'package:harness_mobile/swarm/swarm_file_links.dart';
import 'package:harness_mobile/swarm/swarm_voice_bubble.dart';
import 'package:http/http.dart' as http;
import 'package:video_player/video_player.dart';

import 'swarm_attachment_fakes.dart';

/// A voice message as both apps draw it (task #2584):
///
///     ( ▶ )  ıllıllııılllıı.ılıı.ıll   1:21        →A
///
/// Play hears it, from a copy of the file on the phone; →A shows its words
/// under it, and a second tap hides them.
void main() {
  final cachedCopy = swarmVoiceFile;
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

  testWidgets('fits a narrow message column, its waveform drawn narrower', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 280,
              child: SwarmVoiceBubble(
                file: clip,
                voice: clip.voice!,
                words: '',
                fileRef: SwarmFileRef(clip),
              ),
            ),
          ),
        ),
      ),
    );
    expect(tester.takeException(), isNull);
    expect(
      tester.getSize(key('swarm-voice-bars')).width,
      lessThan(48 * (SwarmVoiceBars.bar + SwarmVoiceBars.gap)),
    );
    expect(find.text('1:21'), findsOneWidget);
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

  // As the app plays it: its copy kept by the store, fetched over its signed
  // link from storage that serves it as bare bytes, as the backend does.
  group('from the copy the store keeps', () {
    late Directory root;
    late _Storage storage;
    final signed = SuperTabAttachment.fromJson({
      'id': 'clip',
      'name': 'Voice message.wav',
      'mime': 'audio/wav',
      'size': 2592044,
      'url': 'https://cdn.example.test/super-tabs/tab/abc/Voice_message.wav',
      'link':
          'https://storage.googleapis.com/harness-cdn/super-tabs/tab/abc/'
          'Voice_message.wav?X-Goog-Signature=sig',
      'expiresAt': DateTime(2100).millisecondsSinceEpoch,
      'voice': {
        'durationMs': 81000,
        'waveform': List.generate(48, (i) => i % 32),
        'transcribed': true,
      },
    });

    setUp(() {
      root = Directory.systemTemp.createTempSync('swarm-voice-');
      storage = _Storage();
      final store = swarmAttachments;
      swarmAttachments = storeIn(root, SwarmFileFetch(client: storage));
      swarmVoiceFile = cachedCopy;
      addTearDown(() {
        swarmAttachments = store;
        if (root.existsSync()) root.deleteSync(recursive: true);
      });
    });

    /// Real time for the file to be fetched and written, a frame after each
    /// step, until the player has it.
    Future<File> played(WidgetTester tester) async {
      for (var i = 0; i < 100 && player.source == null; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 10)),
        );
        await tester.pump();
      }
      expect(player.calls, ['initialize', 'play']);
      return player.source!;
    }

    /// The bubble gone, and the cache's own cleanup, which it runs every few
    /// seconds, let run.
    Future<void> closed(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 1));
    }

    testWidgets("plays it kept as .wav, which an iPhone's player opens", (
      tester,
    ) async {
      await tester.runAsync(() => swarmAttachments.keepOnly('person-me'));
      await pump(tester, file: signed);
      await tester.tap(key('swarm-voice-play'));
      final source = await played(tester);
      expect(source.path, endsWith('.wav'));
      expect(await tester.runAsync(source.readAsBytes), _Storage.wav);
      expect(storage.asked.single.path, endsWith('/Voice_message.wav'));
      expect(find.textContaining("Couldn't"), findsNothing);
      await closed(tester);
    });

    testWidgets('a copy kept as .bin before is fetched again, never played', (
      tester,
    ) async {
      final old = (await tester.runAsync(() async {
        await swarmAttachments.keepOnly('person-me');
        storage.named = false;
        final kept = await swarmAttachments.file(
          Uri.parse('https://storage.googleapis.com/harness-cdn/old'),
          key: 'voice:clip',
        );
        storage.named = true;
        return kept;
      }))!;
      expect(old.path, endsWith('.bin'));
      await pump(tester, file: signed);
      await tester.tap(key('swarm-voice-play'));
      final source = await played(tester);
      expect(source.path, isNot(old.path));
      expect(source.path, endsWith('.wav'));
      await closed(tester);
    });
  });
}

/// Harness's file storage, serving a voice message's clip as the backend
/// serves any file but a picture: bare bytes, named in its
/// `Content-Disposition` while [named].
class _Storage extends http.BaseClient {
  static final wav = [...'RIFF'.codeUnits, 0, 0, 0, 0, ...'WAVE'.codeUnits];

  final asked = <Uri>[];
  bool named = true;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    asked.add(request.url);
    return http.StreamedResponse(
      Stream.value(wav),
      HttpStatus.ok,
      headers: {
        'content-type': 'application/octet-stream',
        if (named)
          'content-disposition':
              "attachment; filename*=UTF-8''Voice%20message.wav",
      },
    );
  }
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

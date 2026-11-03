import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_recorder.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_file_picker.dart';
import 'package:harness_mobile/swarm/swarm_outgoing_files.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:image_picker/image_picker.dart' show XFile;

import '../voice_fakes.dart';
import '../swarm/swarm_chat_dictation_test.dart' show FakeDictation;
import '../swarm/swarm_fixture.dart';

/// Renders a phone Swarm chat's composer in the states Tony's composer brief
/// (11-01) names — empty, text, five lines, the @ picker open, a reply, files
/// and listening, the voice row's Send live, off and sending — in light and
/// dark, on a 393 x 852 iPhone with the keyboard
/// up (336 tall), in the system fonts, to PNGs a reviewer can compare.
///
/// Only keys the composer has had since before the card are used, so the same
/// file draws the old composer too.
///
/// Skipped unless PHONE_RENDER_DIR names a directory to write into:
///
///     PHONE_RENDER_DIR=/tmp/renders flutter test test/render/swarm_composer_render_test.dart
///
/// macOS only: it loads SF Pro and SF Mono from /System/Library/Fonts.
final _outDir = Platform.environment['PHONE_RENDER_DIR'];

Future<void> _loadFonts() async {
  Future<void> load(String family, String path) async {
    final bytes = await File(path).readAsBytes();
    await (FontLoader(
      family,
    )..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
  }

  for (final family in ['.AppleSystemUIFont', 'SF Pro Text', 'Roboto']) {
    await load(family, '/System/Library/Fonts/SFNS.ttf');
  }
  for (final family in ['.AppleSystemUIFontMonospaced', 'SF Mono']) {
    await load(family, '/System/Library/Fonts/SFNSMono.ttf');
  }
  final lucide =
      '${Platform.environment['HOME']}/.pub-cache/hosted/pub.dev/lucide_icons_flutter-3.1.19/assets';
  await load('packages/lucide_icons_flutter/Lucide', '$lucide/lucide.ttf');
  for (final weight in [100, 200, 300, 400, 500, 600]) {
    await load(
      'packages/lucide_icons_flutter/Lucide$weight',
      '$lucide/build_font/LucideVariable-w$weight.ttf',
    );
  }
}

/// A photo-like picture: a sky over a field, encoded as PNG.
Future<Uint8List> _photo(Color sky, Color ground) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(const Rect.fromLTWH(0, 0, 120, 80), Paint()..color = sky);
  canvas.drawRect(const Rect.fromLTWH(0, 50, 120, 30), Paint()..color = ground);
  final image = await recorder.endRecording().toImage(120, 80);
  final png = await image.toByteData(format: ui.ImageByteFormat.png);
  return png!.buffer.asUint8List();
}

void main() {
  final skip = _outDir == null;
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const sample = 'Check whether PR #2466 has merged yet';

  final original = (photos: pickSwarmPhotos, copies: swarmPickerCopyFolders);
  setUp(() => swarmPickerCopyFolders = () async => const []);
  tearDown(() {
    swarmPickerCopyFolders = original.copies;
    pickSwarmPhotos = original.photos;
  });

  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          groupData(
            'g1',
            title: 'Login crash on iPhone',
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'working',
            lastMessageSequence: 1,
          ),
        ],
      ),
      'members': [part(me, 1, person(me))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[messages] = (_) => {
      'messages': [
        {
          'id': 'm1',
          'conversationId': 'g1',
          'text': 'The fix is ready. Ship it to TestFlight today?',
          'sequence': 1,
          'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
          'attachments': <Object>[],
          'reactions': <Object>[],
          'createdAt': DateTime.utc(2026, 11, 1, 4, 1).toIso8601String(),
        },
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/commands'] = (_) =>
        Completer<Object?>().future;
    return fake;
  }

  /// Uploads held where they are, a fixed part of the way up.
  Future<Map<String, dynamic>> stuck({
    required String tabId,
    required String conversationId,
    required String name,
    required String mime,
    required SwarmOutgoingFile file,
    required dynamic cancel,
    required void Function(double sent) onProgress,
  }) => Completer<Map<String, dynamic>>().future;

  Future<void> shoot(WidgetTester tester, GlobalKey key, String name) async {
    await tester.runAsync(() async {
      final boundary =
          key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 3);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      final file = File('$_outDir/$name.png');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(png!.buffer.asUint8List());
    });
  }

  for (final brightness in Brightness.values) {
    final look = brightness.name;

    Future<GlobalKey> chat(
      WidgetTester tester, {
      _MeteredRecorder? recorder,
      FakeTranscriber? stt,
      FakeDictation? dictation,
    }) async {
      await tester.runAsync(_loadFonts);
      final photos = (await tester.runAsync(
        () async => [
          await _photo(const Color(0xFF7FB2E5), const Color(0xFF5E8C4A)),
          await _photo(const Color(0xFFE9A86B), const Color(0xFF3F5B73)),
        ],
      ))!;
      pickSwarmPhotos = (limit) async => [
        XFile.fromData(photos[0], path: '/copies/IMG_2041.jpg'),
        XFile.fromData(photos[1], path: '/copies/IMG_2050.jpg'),
      ];
      final palette = HarnessPalette.values.firstWhere(
        (p) => p.brightness == brightness,
      );
      final previous = (
        grid.AppTheme.brightness.value,
        grid.AppTheme.palette.value,
      );
      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() {
        grid.AppTheme.brightness.value = previous.$1;
        grid.AppTheme.palette.value = previous.$2;
      });
      // A 393 x 852 iPhone with the keyboard up, as the prototype draws it.
      tester.view.physicalSize = const Size(393 * 3, 852 * 3);
      tester.view.devicePixelRatio = 3;
      tester.view.padding = const FakeViewPadding(top: 59 * 3);
      tester.view.viewPadding = const FakeViewPadding(
        top: 59 * 3,
        bottom: 34 * 3,
      );
      tester.view.viewInsets = const FakeViewPadding(bottom: 336 * 3);
      addTearDown(tester.view.reset);

      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: backend().request,
        upload: stuck,
        notices: SilentSystemNotices(),
        features: features,
        voice: () => VoiceInputController(
          transcriber: (stt ?? FakeTranscriber()).call,
          recorder: recorder ?? _MeteredRecorder(),
          language: ValueNotifier('en'),
        ),
        dictation: dictation,
      )..foreground = false;
      addTearDown(host.dispose);
      final key = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: grid.BrightnessScope(
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (context, child) =>
                  SwarmScope(notifier: host, child: child!),
              home: const SwarmConversationPage(
                swarmId: tab,
                conversationId: 'g1',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return key;
    }

    Future<void> type(WidgetTester tester, String text) async {
      await tester.showKeyboard(find.byType(TextField));
      await tester.enterText(find.byType(TextField), text);
      await tester.pumpAndSettle();
    }

    testWidgets('empty ($look)', skip: skip, (tester) async {
      final key = await chat(tester);
      await shoot(tester, key, 'composer-empty-$look');
    });

    testWidgets('text ($look)', skip: skip, (tester) async {
      final key = await chat(tester);
      await type(tester, sample);
      await shoot(tester, key, 'composer-text-$look');
    });

    testWidgets('five lines and more ($look)', skip: skip, (tester) async {
      final key = await chat(tester);
      await type(
        tester,
        [
          'Check whether PR #2466 has merged yet.',
          'If it has, cut the next phone build.',
          'Then tell Dee and the Lead.',
          'Attach the release notes.',
          'Check the crash rate after an hour.',
          'And the one on Android too.',
          'Last: close the old ticket.',
        ].join('\n'),
      );
      await shoot(tester, key, 'composer-long-$look');
    });

    testWidgets('@ picker open ($look)', skip: skip, (tester) async {
      final key = await chat(tester);
      await type(tester, 'Check whether PR #2466 @');
      await shoot(tester, key, 'composer-tag-$look');
    });

    testWidgets('reply ($look)', skip: skip, (tester) async {
      final key = await chat(tester);
      await tester.tap(
        find.text('The fix is ready. Ship it to TestFlight today?'),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('swarm-reply-m1')));
      await tester.pumpAndSettle();
      await type(tester, sample);
      await shoot(tester, key, 'composer-reply-$look');
    });

    testWidgets('files ($look)', skip: skip, (tester) async {
      final key = await chat(tester);
      await tester.tap(find.byKey(const ValueKey('swarm-attach')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('swarm-attach-library')));
      await tester.pumpAndSettle();
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 300)),
      );
      await tester.pumpAndSettle();
      await type(tester, sample);
      await shoot(tester, key, 'composer-files-$look');
    });

    testWidgets('listening ($look)', skip: skip, (tester) async {
      final recorder = _MeteredRecorder();
      final key = await chat(tester, recorder: recorder);
      await type(tester, 'Check whether PR #2466');
      await tester.tap(find.byKey(const ValueKey('swarm-mic')));
      for (var i = 0; i < 5; i++) {
        await tester.pump();
      }
      for (var i = 0; i < 48; i++) {
        final level = const [0.2, 0.6, 0.9, 0.4, 0.7, 0.3, 0.8, 0.5][i % 8];
        recorder.meter.value = level;
        await tester.pump(const Duration(milliseconds: 120));
      }
      await shoot(tester, key, 'composer-listening-$look');
    });

    // Tony, 11-01: the voice row's Send, right of stop: off on an empty box
    // with the phone's recognizer, live once it has words.
    for (final words in ['', 'Check whether PR #2466 has merged']) {
      final name = words.isEmpty ? 'off' : 'live';
      testWidgets('voice row Send $name, dictation ($look)', skip: skip, (
        tester,
      ) async {
        final dictation = FakeDictation();
        final key = await chat(tester, dictation: dictation);
        await tester.showKeyboard(find.byType(TextField));
        await tester.tap(find.byKey(const ValueKey('swarm-mic')));
        for (var i = 0; i < 5; i++) {
          await tester.pump();
        }
        if (words.isNotEmpty) dictation.say(words);
        for (var i = 0; i < 24; i++) {
          dictation.loud(const [0.3, 0.7, 0.5, 0.9][i % 4]);
          await tester.pump(const Duration(milliseconds: 120));
        }
        await shoot(tester, key, 'composer-voice-send-$name-$look');
      });
    }

    testWidgets('voice row Send while sending ($look)', skip: skip, (
      tester,
    ) async {
      final recorder = _MeteredRecorder();
      final stt = FakeTranscriber()..pending = Completer<String>();
      final key = await chat(tester, recorder: recorder, stt: stt);
      await type(tester, 'Check whether PR #2466');
      await tester.tap(find.byKey(const ValueKey('swarm-mic')));
      for (var i = 0; i < 24; i++) {
        recorder.meter.value = const [0.3, 0.7, 0.5, 0.9][i % 4];
        await tester.pump(const Duration(milliseconds: 120));
      }
      await tester.tap(find.byKey(const ValueKey('swarm-voice-send')));
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 120));
      }
      await shoot(tester, key, 'composer-voice-sending-$look');
    });
  }
}

/// A microphone that also says how loud it is: what the wave follows.
class _MeteredRecorder extends FakeVoiceRecorder implements VoiceLevelMeter {
  final meter = ValueNotifier<double>(0);

  @override
  ValueListenable<double> get level => meter;
}

import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/voice_recorder.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import '../swarm/swarm_fixture.dart';

/// Renders a phone Swarm chat's voice messages (task #2584) — the mic at
/// rest, a take recording, a voice message and the mic refused — in light
/// and dark, at iPhone 14 size in the system fonts, to PNGs a reviewer can
/// look at without a phone.
///
/// Skipped unless PHONE_RENDER_DIR names a directory to write into:
///
///     PHONE_RENDER_DIR=/tmp/renders flutter test test/render/swarm_voice_render_test.dart
///
/// macOS only: it loads SF Pro and SF Mono from /System/Library/Fonts.
final _outDir = Platform.environment['PHONE_RENDER_DIR'];

Future<void> _loadFonts() async {
  Future<void> load(String family, String file) async {
    final bytes = await File('/System/Library/Fonts/$file').readAsBytes();
    await (FontLoader(
      family,
    )..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
  }

  for (final family in ['.AppleSystemUIFont', 'SF Pro Text', 'Roboto']) {
    await load(family, 'SFNS.ttf');
  }
  for (final family in ['.AppleSystemUIFontMonospaced', 'SF Mono']) {
    await load(family, 'SFNSMono.ttf');
  }
  // The icons, from the package in the pub cache.
  final lucide =
      '${Platform.environment['HOME']}/.pub-cache/hosted/pub.dev/lucide_icons_flutter-3.1.19/assets';
  Future<void> icons(String family, String file) async {
    final bytes = await File('$lucide/$file').readAsBytes();
    await (FontLoader(
      family,
    )..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
  }

  await icons('packages/lucide_icons_flutter/Lucide', 'lucide.ttf');
  for (final weight in [100, 200, 300, 400, 500, 600]) {
    await icons(
      'packages/lucide_icons_flutter/Lucide$weight',
      'build_font/LucideVariable-w$weight.ttf',
    );
  }
}

void main() {
  final skip = _outDir == null;
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';

  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      groups: [
        groupData(
          'g1',
          title: 'Login crash on iPhone',
          agentIds: ['agent-lead', 'agent-builder'],
          leadId: 'agent-lead',
          status: 'working',
          lastMessageSequence: 2,
        ),
      ],
    );
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
          'createdAt': DateTime.utc(2026, 10, 28, 4, 1).toIso8601String(),
        },
        {
          'id': 'm2',
          'conversationId': 'g1',
          'text':
              'Yes, ship it today, and tell me when the build is up so I '
              'can try the login on my phone.',
          'sequence': 2,
          'author': {'kind': 'person', 'id': me, 'name': 'dee'},
          'attachments': [
            {
              'id': 'clip',
              'name': 'Voice message.wav',
              'mime': 'audio/wav',
              'size': 2592044,
              'url': 'https://cdn.example.test/super-tabs/$tab/a/clip.wav',
              'voice': {
                'durationMs': 81000,
                'waveform': [
                  for (var i = 0; i < 48; i++)
                    (6 +
                            20 *
                                (0.5 + 0.5 * math.sin(i * 0.7)) *
                                (i % 5 == 0 ? 0.4 : 1))
                        .round(),
                ],
                'transcribed': true,
              },
            },
          ],
          'reactions': <Object>[],
          'createdAt': DateTime.utc(2026, 10, 28, 4, 3).toIso8601String(),
        },
      ],
      'next': null,
    };
    return fake;
  }

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
      WidgetTester tester,
      _MeteredRecorder recorder,
    ) async {
      await tester.runAsync(_loadFonts);
      // A palette carries its brightness: a light one is how the app goes light.
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
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
      tester.view.viewPadding = const FakeViewPadding(
        top: 47 * 3,
        bottom: 34 * 3,
      );
      addTearDown(tester.view.reset);

      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: backend().request,
        notices: SilentSystemNotices(),
        features: features,
        voice: () => recorder,
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

    Future<void> tapMic(WidgetTester tester) async {
      await tester.tap(find.byKey(const ValueKey('swarm-mic')));
      for (var i = 0; i < 5; i++) {
        await tester.pump();
      }
    }

    testWidgets('mic at rest, a voice message ($look)', skip: skip, (
      tester,
    ) async {
      final key = await chat(tester, _MeteredRecorder());
      await shoot(tester, key, 'swarm-voice-message-$look');
    });

    testWidgets('recording ($look)', skip: skip, (tester) async {
      final recorder = _MeteredRecorder();
      final key = await chat(tester, recorder);
      await tapMic(tester);
      for (var i = 0; i < 40; i++) {
        recorder.meter.value = const [0.2, 0.6, 0.9, 0.4, 0.7, 0.3][i % 6];
        await tester.pump(const Duration(milliseconds: 350));
      }
      await shoot(tester, key, 'swarm-voice-recording-$look');
    });

    testWidgets('mic refused ($look)', skip: skip, (tester) async {
      final key = await chat(tester, _MeteredRecorder()..permitted = false);
      await tapMic(tester);
      await tester.pumpAndSettle();
      await shoot(tester, key, 'swarm-voice-refused-$look');
    });
  }
}

/// A microphone that also says how loud it is: what the bars follow.
class _MeteredRecorder extends FakeVoiceRecorder implements VoiceLevelMeter {
  final meter = ValueNotifier<double>(0);

  @override
  ValueListenable<double> get level => meter;
}

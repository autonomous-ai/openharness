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
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import '../swarm/swarm_fixture.dart';

/// Renders a phone Swarm chat's mic — at rest, listening, with what was heard
/// in the box, and refused — in light and dark, at iPhone 14 size in the
/// system fonts, to PNGs a reviewer can look at without a phone.
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
          status: 'working',
          lastMessageSequence: 1,
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
      FakeTranscriber stt,
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
        voice: () => VoiceInputController(
          transcriber: stt.call,
          recorder: recorder,
          language: ValueNotifier('en'),
        ),
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

    testWidgets('mic at rest ($look)', skip: skip, (tester) async {
      final key = await chat(tester, _MeteredRecorder(), FakeTranscriber());
      await shoot(tester, key, 'swarm-voice-rest-$look');
    });

    testWidgets('listening ($look)', skip: skip, (tester) async {
      final recorder = _MeteredRecorder();
      final key = await chat(tester, recorder, FakeTranscriber());
      await tapMic(tester);
      recorder.meter.value = 0.7;
      await tester.pump(const Duration(milliseconds: 400));
      await shoot(tester, key, 'swarm-voice-listening-$look');
    });

    testWidgets('heard into the box ($look)', skip: skip, (tester) async {
      final stt = FakeTranscriber()
        ..replies.add('Yes, ship it today and tell me when it is up.');
      final key = await chat(tester, _MeteredRecorder(), stt);
      await tapMic(tester);
      await tapMic(tester);
      await tester.pumpAndSettle();
      await shoot(tester, key, 'swarm-voice-heard-$look');
    });

    testWidgets('mic refused ($look)', skip: skip, (tester) async {
      final key = await chat(
        tester,
        _MeteredRecorder()..permitted = false,
        FakeTranscriber(),
      );
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

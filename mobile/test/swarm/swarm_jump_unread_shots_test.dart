import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of Jump to first unread in a phone chat: alone, with
/// Jump to latest at once, and where a tap lands. At 390 and 320 wide in both
/// phone themes, from made-up data only, to the folder
/// `SWARM_JUMP_UNREAD_SHOTS` names.
final shots = Platform.environment['SWARM_JUMP_UNREAD_SHOTS'];
void main() {
  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    final mono = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFontMonospaced', 'monospace']) {
      await (FontLoader(family)..addFont(Future.value(mono))).load();
    }
    final manifest =
        jsonDecode(await rootBundle.loadString('FontManifest.json')) as List;
    for (final entry in manifest.cast<Map<String, dynamic>>()) {
      final loader = FontLoader(entry['family'] as String);
      for (final font in (entry['fonts'] as List).cast<Map>()) {
        loader.addFont(rootBundle.load(font['asset'] as String));
      }
      await loader.load();
    }
  });

  const chat = 'buddy-me';
  const lines = [
    'The login screen now keeps the email you typed when the code fails.',
    'Checked it on both themes. The error sits under the field.',
    'Next I am looking at the retry timer, which resets too early.',
    'Found it: the timer starts again each time the screen is rebuilt.',
  ];

  Map<String, dynamic> said(int sequence) => {
    'id': 'msg-$sequence',
    'conversationId': chat,
    'text': lines[sequence % lines.length],
    'sequence': sequence,
    'author': {'kind': 'agent', 'id': 'agent-wren', 'name': 'Wren'},
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 10, 29, 1, sequence).toIso8601String(),
  };

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
          buddyChatData(
            chat,
            agentIds: ['agent-wren'],
            lastMessageSequence: 40,
          ),
        ],
        agents: [buddyData('agent-wren', displayName: 'Wren')],
        derived: {
          'readMarks': {chat: 5},
        },
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
    fake.routes['/api/super-tabs/$tab/conversations/$chat/messages'] = (_) => {
      'messages': [for (var i = 40; i >= 1; i--) said(i)],
      'next': null,
    };
    return fake;
  }

  testWidgets('the pill alone, with Jump to latest, and where it lands', (
    tester,
  ) async {
    for (final (width, height, top, bottom) in const [
      (390.0, 844.0, 47.0, 34.0),
      (320.0, 568.0, 20.0, 0.0),
    ]) {
      await tester.binding.setSurfaceSize(Size(width, height));
      tester.view.padding = FakeViewPadding(top: top * 3, bottom: bottom * 3);
      for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
        final brightness = palette.brightness;
        AppTheme.palette.value = palette;
        AppTheme.brightness.value = brightness;
        final boundary = GlobalKey();
        Future<void> capture(String name) => tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 3);
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await File(
            '$shots/jump-unread-$name-${width.toInt()}-${brightness.name}.png',
          ).writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });

        /// The chat opened from a notice at [messageId].
        Future<SwarmHost> open(String messageId) async {
          final features = ExperimentalFeaturesStore(
            storage: MemoryKeyValueStore(),
          )..value = {PhoneExperiment.swarm};
          final host = SwarmHost(
            accountId: () => me,
            account: ValueNotifier<String?>(me),
            request: backend().request,
            notices: SilentSystemNotices(),
            features: features,
            readMarks: MemoryKeyValueStore(),
          )..foreground = false;
          await tester.pumpWidget(
            RepaintBoundary(
              key: boundary,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: buildAppTheme(brightness: brightness),
                builder: (_, child) =>
                    SwarmScope(notifier: host, child: child!),
                home: SwarmConversationPage(
                  swarmId: tab,
                  conversationId: chat,
                  messageId: messageId,
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          return host;
        }

        Future<void> close(SwarmHost host) async {
          await tester.pumpWidget(const SizedBox());
          await tester.pump(const Duration(seconds: 30));
          host.dispose();
        }

        final pill = find.byKey(const ValueKey('swarm-jump-unread'));
        final latest = find.byKey(const ValueKey('swarm-jump-latest'));

        // Near the foot: this pill alone.
        var host = await open('msg-39');
        expect(pill, findsOneWidget);
        expect(latest, findsNothing);
        await capture('alone');
        await close(host);

        // Further back: the pair.
        host = await open('msg-20');
        expect(pill, findsOneWidget);
        expect(latest, findsOneWidget);
        await capture('both');

        await tester.tap(pill);
        await tester.pumpAndSettle();
        expect(pill, findsNothing);
        await capture('landed');
        await close(host);
      }
    }
    await tester.binding.setSurfaceSize(null);
    tester.view.resetPadding();
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

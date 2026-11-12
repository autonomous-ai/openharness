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
import 'swarm_new_project_fixture.dart';

/// Review screenshots of "Not sent · this chat has no Lead" in a project's
/// channel and "Waiting for the Product Manager" in the PM's own chat, in both
/// phone themes at phone width, from made-up data only, to
/// `SWARM_NO_LEAD_SHOTS`.
final shots = Platform.environment['SWARM_NO_LEAD_SHOTS'];

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

  Map<String, dynamic> machine(String id, String name, {bool online = true}) {
    final m = leadPool(id, name: name);
    (m['observation'] as Map)['receivedAt'] = DateTime.now()
        .subtract(Duration(minutes: online ? 0 : 30))
        .millisecondsSinceEpoch;
    return m;
  }

  testWidgets('the lines before a delivery, in both themes', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    const pmChat = 'pm-chat';
    final shown = [
      for (final line in [
        ('line', leadChat, 'Not sent · this chat has no Lead'),
        ('waiting-pm', pmChat, 'Waiting for the Product Manager'),
      ])
        for (final palette in [HarnessPalette.graphite, HarnessPalette.paper])
          (line, palette),
    ];
    for (final ((name, chat, words), palette) in shown) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
      fake.routes['/api/super-tabs/$tab/parts'] = (_) {
        final load = firstLoad(
          head: headData(
            projects: [
              {
                ...swarmProject(project, 'Mobile', repo: harnessRepo),
                if (chat == pmChat) 'pmChat': {'id': pmChat},
              },
            ],
          ),
          groups: [
            if (chat == pmChat)
              {
                ...groupData(
                  pmChat,
                  title: 'Product Manager',
                  agentIds: const [],
                  lastMessageSequence: 1,
                ),
                'kind': 'agent-chat',
              },
          ],
          machines: [machine('mac-1', 'Mac Studio')],
        );
        (load['groups'] as List).first['data'] = groupData(
          leadChat,
          title: 'Mobile',
          lastMessageSequence: chat == leadChat ? 1 : 0,
        );
        return load;
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/conversations/$chat/messages'] =
          (_) => {
            'messages': [
              {
                'id': 'm1',
                'conversationId': chat,
                'text': 'Who picks this up?',
                'sequence': 1,
                'author': {'kind': 'person', 'id': me, 'name': 'tony'},
                'createdAt': DateTime.now().toUtc().toIso8601String(),
              },
            ],
            'next': null,
          };
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      await tester.runAsync(() => host.session!.inbox.refresh());
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            home: SwarmConversationPage(swarmId: tab, conversationId: chat),
          ),
        ),
      );
      for (var i = 0; i < 5; i++) {
        await tester.runAsync(pumpEventQueue);
        await tester.pump(const Duration(milliseconds: 100));
      }
      Future<void> capture() => tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/no-lead-$name-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      expect(find.text(words), findsOneWidget);
      await capture();
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
      host.dispose();
      account.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

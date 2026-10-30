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
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The person's Buddy chat with its Buddy running, in both phone themes, for
/// the pull request, written to the folder `SWARM_BUDDY_CHAT_SHOTS` names
/// (run this file alone, on a Mac). Scripted data only.
final shots = Platform.environment['SWARM_BUDDY_CHAT_SHOTS'];

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

  testWidgets('the Buddy chat with its Buddy running, both themes', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    const chat = 'buddy-me';
    Map<String, dynamic> message(
      String id,
      int sequence,
      String text, {
      String? agent,
      int minute = 0,
    }) => {
      'id': id,
      'conversationId': chat,
      'text': text,
      'sequence': sequence,
      'author': switch (agent) {
        null => {'kind': 'person', 'id': me, 'name': 'tony'},
        'agent-lead' => {'kind': 'agent', 'id': agent, 'name': 'River'},
        _ => {'kind': 'agent', 'id': agent, 'name': 'Wren'},
      },
      'attachments': <Object>[],
      'reactions': <Object>[],
      'createdAt': DateTime.utc(2026, 10, 29, 8, minute).toIso8601String(),
    };
    final page = [
      message(
        'm1',
        1,
        'The phone chain installs this afternoon: drawer names, task lines '
            'and the Buddy chat.',
        agent: 'agent-lead',
      ),
      message('m2', 2, 'Can the chat start right under the header?', minute: 2),
      message(
        'm3',
        3,
        'Yes. Nothing sits between the header and your messages now.',
        agent: 'agent-wren',
        minute: 3,
      ),
    ];

    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
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
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          groups: [
            buddyChatData(
              chat,
              agentIds: ['agent-wren'],
              lastMessageSequence: page.length,
            ),
          ],
          agents: [
            agent('agent-lead', name: 'Lead', displayName: 'River'),
            buddyData('agent-wren', displayName: 'Wren'),
          ],
          machines: [
            {
              'machineId': 'mac-1',
              'name': 'Studio-Mac.local',
              'contributorId': me,
              'engines': ['claude', 'codex'],
            },
          ],
        ),
        'members': [part(me, 1, person(me))],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/conversations/$chat/messages'] = (_) =>
          {'messages': page.reversed.toList(), 'next': null};
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => me,
        account: account,
        request: fake.request,
        upload: refuseSwarmUpload,
        notices: SilentSystemNotices(),
        features: features,
      )..foreground = false;
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            home: const SwarmConversationPage(
              swarmId: tab,
              conversationId: chat,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/buddy-chat-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      account.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

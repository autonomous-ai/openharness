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
import 'package:harness_mobile/swarm/swarm_activity_page.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A decision's choices in the Buddy chat, and Activity's Answered list, in
/// both phone themes, for the pull request, written to the folder
/// `SWARM_DECISION_SHOTS` names (run this file alone, on a Mac). Scripted data
/// only.
final shots = Platform.environment['SWARM_DECISION_SHOTS'];

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

  testWidgets('a decision\'s choices and the answered list, both themes', (
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

    Map<String, dynamic> decision(
      String id,
      String question,
      List<String> options, {
      int? choice,
      bool delegated = false,
    }) => {
      'id': id,
      'batchId': id,
      'projectId': project,
      'projectName': 'Mobile',
      'conversationId': chat,
      'conversationTitle': 'Buddy',
      'askerName': 'River',
      'question': question,
      'options': options,
      'recommended': 0,
      'unblocks': 'the release notes',
      'choice': ?choice,
      if (delegated) 'delegated': true,
      'createdAt': DateTime.utc(2026, 10, 29, 8, 4).toIso8601String(),
    };
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
          derived: {'decisionsWaiting': 1},
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
          changes(cursor: 'c2', derived: {'decisionsWaiting': 1});
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': [
          decision('d1', 'Ship the beta on Friday?', [
            'Yes, Friday',
            'No, wait',
          ]),
        ],
      };
      fake.routes['/api/super-tabs/$tab/decisions?state=settled'] = (_) => {
        'decisions': [
          decision('a1', 'Which region first?', ['Europe', 'Asia'], choice: 0),
          decision(
            'a2',
            'Keep the old installer?',
            ['Yes', 'No'],
            choice: 0,
            delegated: true,
          ),
        ],
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
        // Not now keeps its choice here: in memory, never in this Mac's files.
        readMarks: MemoryKeyValueStore(),
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
      Future<void> capture(String name) => tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/decision-$name-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await capture('choices');
      await tester.tap(find.text('Let Product Manager decide'));
      await tester.pump();
      await capture('held');
      await tester.tap(find.byKey(const ValueKey('swarm-undo-d1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('swarm-decision-later-d1')));
      await tester.pumpAndSettle();
      await capture('aside');
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            home: const SwarmActivityPage(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await capture('answered');
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      account.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

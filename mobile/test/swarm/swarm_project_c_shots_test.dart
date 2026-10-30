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
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of a project's screen in Swarm Home C, as Tony's
/// prototype draws it (2026-10-30): its chat with the New messages line,
/// a task card and a PR card, a code block, reactions with the add-reaction
/// chip and a replies row; ☰ open; its Leaderboard sheet; its Team sheet with
/// open tasks on top, See all and the agents in their states; and Approve's
/// question. On 390- and 320-point phones in both phone themes, from made-up
/// data only, to the folder `SWARM_PROJECT_C_SHOTS` names.
final shots = Platform.environment['SWARM_PROJECT_C_SHOTS'];
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

  testWidgets('the project screen, its menu and sheets, in both phone themes', (
    tester,
  ) async {
    addTearDown(tester.view.reset);
    // Real shadows: a test's stand-in draws a menu's as a thick black rim.
    debugDisableShadows = false;
    // An iPhone's status bar and home indicator.
    tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
    addTearDown(tester.view.resetPadding);
    for (final (palette, size) in [
      for (final palette in [HarnessPalette.graphite, HarnessPalette.paper])
        for (final size in const [Size(390, 844), Size(320, 568)])
          (palette, size),
    ]) {
      // The view, not only the surface: a sheet takes its height from
      // MediaQuery.
      tester.view
        ..physicalSize = size * 3
        ..devicePixelRatio = 3;
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final now = DateTime.now().toUtc();
      String ago(int minutes) =>
          now.subtract(Duration(minutes: minutes)).toIso8601String();
      const pr = 'https://github.com/example/app/pull/2161';
      Map<String, dynamic> said(
        String id,
        int sequence,
        String text, {
        String author = 'agent-lead',
        String kind = 'agent',
        String name = 'River',
        Map<String, List<(String, String)>> reactions = const {},
      }) => {
        'id': id,
        'conversationId': leadChat,
        'text': text,
        'sequence': sequence,
        'thread': id,
        'author': {'kind': kind, 'id': author, 'name': name},
        'reactions': [
          for (final MapEntry(key: emoji, value: by) in reactions.entries)
            {
              'emoji': emoji,
              'count': by.length,
              'by': [
                for (final (kind, who) in by) {'kind': kind, 'id': who},
              ],
            },
        ],
        'createdAt': ago(40 - sequence * 4),
      };
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Autonomous', 'ownerId': me},
        ],
        'next': null,
      };
      const derived = {
        'decisionsWaiting': 1,
        'readMarks': {leadChat: 5},
      };
      final load = firstLoad(
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          agent('agent-builder', displayName: 'Nova'),
          agent('agent-juno', displayName: 'Juno'),
          agent('agent-ash', displayName: 'Ash'),
          {...agent('agent-wren', displayName: 'Wren'), 'workDecision': 'stop'},
        ],
        groups: [
          groupData(
            'g1',
            title: 'Buddy chat header',
            number: 2156,
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'working',
            workerId: 'agent-builder',
            lastMessageSequence: 3,
          ),
          groupData(
            'g2',
            title: 'Saved views cache',
            number: 2160,
            agentIds: ['agent-lead', 'agent-juno'],
            status: 'needs_human',
            workerId: 'agent-juno',
            lastMessageSequence: 4,
          ),
          for (final (i, title) in const [
            'Sign-in retries',
            'Push token refresh',
            'Machine list paging',
            'Voice note waveform',
            'Offline queue limits',
            'Thread reply count',
            'Attachment previews',
          ].indexed)
            groupData(
              'g-more-$i',
              title: title,
              number: 2170 + i,
              agentIds: ['agent-lead', 'agent-builder'],
              status: 'working',
              workerId: 'agent-builder',
              lastMessageSequence: 2,
            ),
        ],
        derived: derived,
      );
      final groups = load['groups'] as List;
      // When each chat last moved: Juno's ask a few minutes ago.
      for (final row in groups.cast<Map>()) {
        row['changedAt'] = now
            .subtract(Duration(minutes: row['key'] == 'g2' ? 7 : 2))
            .millisecondsSinceEpoch;
      }
      final lead = (groups.first as Map)['data'] as Map;
      lead
        ..['lastMessageSequence'] = 7
        ..['number'] = 12
        ..['pullRequestUrls'] = [pr]
        ..['cards'] = {
          'task': 'm1',
          'pullRequests': [
            {'url': pr, 'messageId': 'm2'},
          ],
        };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...load,
        'members': [
          part(me, 1, person(me)),
          part('diego', 1, {
            ...person('diego', role: 'collaborator'),
            // No emoji: the test engine draws none.
            'status': {'text': 'Reviewing PRs'},
          }),
          part('ken', 1, person('ken', role: 'collaborator')),
        ],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2', derived: derived);
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': [
          {
            'id': 'd1',
            'projectId': project,
            'projectName': 'Mobile',
            'conversationId': 'g2',
            'conversationTitle': 'Saved views cache',
            'askerName': 'River',
            'question': 'Merge #2160?',
            'options': ['Merge', 'Wait'],
            'recommended': 0,
            'createdAt': ago(3),
          },
        ],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
          (_) => {
            'messages': [
              said('m1', 1, 'Brief: the project screen, Chat and Team.'),
              said(
                'm2',
                2,
                'Opened $pr',
                author: 'agent-builder',
                name: 'Nova',
              ),
              said(
                'm3',
                3,
                'Run this:\n```bash\nflutter test test/swarm\n```',
                author: 'agent-builder',
                name: 'Nova',
              ),
              said(
                'm4',
                4,
                'Shipped to TestFlight.',
                reactions: {
                  'eyes': [('person', me), ('person', 'diego')],
                  'check': [('person', 'diego')],
                  'rocket': [('agent', 'agent-builder')],
                },
              ),
              said(
                'm5',
                5,
                'Which header goes on Team?',
                author: 'diego',
                kind: 'person',
                name: 'Diego',
              ),
              said(
                'm6',
                6,
                'The #name one, with the humans and agents line.',
                author: 'agent-builder',
                name: 'Nova',
              ),
              said('m7', 7, 'Juno needs a call on the saved views cache.'),
            ],
            'threads': [
              {
                'id': 'm5',
                'replies': 3,
                'lastSequence': 9,
                'lastAt': ago(2),
                'authors': [
                  {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
                  {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
                ],
                'people': <String>[],
              },
            ],
            'next': null,
          };
      fake.routes['/api/super-tabs/$tab/leaderboard?projectId=$project'] =
          (_) => leaderboardData(
            people: [
              {
                ...scoreData(
                  me,
                  points: 1320,
                  rank: 1,
                  shipped: 6,
                  unblocked: 3,
                ),
                'displayName': 'Ada',
              },
              {
                ...scoreData('diego', points: 1050, rank: 2, lentMs: 36000000),
                'displayName': 'Diego',
              },
              {
                ...scoreData('ken', points: 640, rank: 3, unblocked: 2),
                'displayName': 'Ken',
              },
            ],
          );
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => me,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: features,
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
            home: const SwarmProjectPage(
              swarmId: tab,
              projectId: project,
              tabs: SwarmProjectTab.homeC,
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
        final width = size.width.round();
        await File('$shots/project-c-$width-$name-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      Finder key(String value) => find.byKey(ValueKey(value));
      await capture('chat');
      await tester.drag(key('swarm-messages'), const Offset(0, 600));
      await tester.pumpAndSettle();
      await capture('chat-earlier');
      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      await capture('menu');
      await tester.tap(key('swarm-project-menu-leaderboard'));
      await tester.pumpAndSettle();
      await capture('leaderboard');
      await tester.tap(key('swarm-leaderboard-close'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-project-menu-team'));
      await tester.pumpAndSettle();
      await capture('team');
      await tester.dragUntilVisible(
        key('swarm-team-see-all'),
        key('swarm-project-team-list'),
        const Offset(0, -200),
      );
      await tester.pumpAndSettle();
      await capture('team-see-all');
      await tester.drag(key('swarm-project-team-list'), const Offset(0, -1000));
      await tester.pumpAndSettle();
      await capture('team-agents');
      await tester.drag(key('swarm-project-team-list'), const Offset(0, 2000));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-approve-d1'));
      await tester.pumpAndSettle();
      await capture('approve');
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 30));
      host.dispose();
      account.dispose();
    }
    debugDisableShadows = true;
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

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
import 'package:harness_mobile/swarm/swarm_tabs.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of the Buddy tab, 390 points wide in both phone themes,
/// from made-up data, to the folder `SWARM_BUDDY_TAB_SHOTS` names: running,
/// no Buddy yet, its ⋮ with two Swarms, Old chats and an old chat.
final shots = Platform.environment['SWARM_BUDDY_TAB_SHOTS'];

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

  testWidgets('the Buddy tab, in both phone themes', (tester) async {
    const chat = 'buddy-one', old = 'buddy-old';
    addTearDown(() => tester.binding.setSurfaceSize(null));
    Map<String, dynamic> line(
      String id,
      int sequence,
      String text, {
      bool mine = false,
    }) => {
      'id': id,
      'conversationId': id.startsWith('o') ? old : chat,
      'text': text,
      'sequence': sequence,
      'author': mine
          ? {'kind': 'person', 'id': me, 'name': 'tony'}
          : {'kind': 'agent', 'id': 'agent-wren', 'name': 'Wren'},
      'createdAt': DateTime.now()
          .subtract(Duration(minutes: 9 - sequence))
          .toUtc()
          .toIso8601String(),
    };
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      await tester.binding.setSurfaceSize(const Size(390, 780));
      for (final state in [
        'running',
        'start',
        'menu',
        'old-list',
        'old-chat',
      ]) {
        final running = state != 'start';
        final fake = FakeSwarm();
        fake.routes['/api/super-tabs/list'] = (_) => {
          'tabs': [
            {'id': tab, 'name': 'autonomous.ai', 'ownerId': me},
            if (state == 'menu')
              {'id': 'swarm-2', 'name': 'Home lab', 'ownerId': me},
          ],
          'next': null,
        };
        const derived = {'swarmBuddy': true};
        final load = {
          ...firstLoad(
            groups: [
              {
                ...groupData(
                  chat,
                  title: 'Buddy',
                  agentIds: const ['agent-wren'],
                  lastMessageSequence: 3,
                ),
                'kind': 'swarm-buddy',
                'buddyOwnerId': me,
                'buddyName': 'Wren',
              }..remove('projectId'),
              buddyChatData(old, lastMessageSequence: 2),
            ],
            agents: [
              agent('agent-lead', name: 'Lead', displayName: 'River'),
              if (running)
                {
                  ...buddyData('agent-wren', displayName: 'Wren'),
                  'buddyScope': 'swarm',
                }..remove('projectId'),
            ],
            machines: [
              {
                'machineId': 'mac-1',
                'name': "Tony's Mac",
                'contributorId': me,
                'engines': ['claude', 'codex'],
                'observation': {
                  'receivedAt': DateTime.now().millisecondsSinceEpoch,
                },
              },
            ],
            derived: derived,
          ),
          'members': [
            part(me, 1, {...person(me), 'email': 'tony@example.com'}),
          ],
        };
        fake.routes['/api/super-tabs/$tab/parts'] = (_) => load;
        fake.routes['/api/super-tabs/swarm-2/parts'] = (_) =>
            firstLoad(tabId: 'swarm-2', derived: derived);
        for (final swarm in [tab, 'swarm-2']) {
          fake.routes['/api/super-tabs/$swarm/changes'] = (_) =>
              changes(cursor: 'c2', derived: derived);
          fake.routes['/api/super-tabs/$swarm/decisions?state=open'] = (_) => {
            'decisions': <Object>[],
          };
          fake.routes['/api/super-tabs/$swarm/mentions?state=waiting'] = (_) =>
              {'mentions': <Object>[]};
        }
        fake.routes['/api/super-tabs/$tab/conversations/$chat/messages'] =
            (_) => {
              'messages': [
                line('m3', 3, 'It treats your one Buddy as every project\'s.'),
                line('m2', 2, 'Look at the held pull request.', mine: true),
                line('m1', 1, 'Morning. What are we looking at?'),
              ],
              'next': null,
            };
        fake.routes['/api/super-tabs/$tab/conversations/$old/messages'] = (_) =>
            {
              'messages': [
                line('o2', 2, 'Notes from before the one Buddy.'),
                line('o1', 1, 'Can you read the release plan?', mine: true),
              ],
              'next': null,
            };
        final host = SwarmHost(
          accountId: () => me,
          account: ValueNotifier<String?>(me),
          request: fake.request,
          notices: SilentSystemNotices(),
          features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
            ..value = {PhoneExperiment.swarm},
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
              home: const SwarmTabsPage(),
            ),
          ),
        );
        Future<void> settle() async {
          for (var i = 0; i < 12; i++) {
            await tester.pump(const Duration(milliseconds: 100));
          }
        }

        await settle();
        await tester.tap(find.byKey(const ValueKey('swarm-tab-buddy')));
        await settle();
        if (state != 'running' && state != 'start') {
          await tester.tap(find.byKey(const ValueKey('swarm-buddy-menu')));
          await settle();
          expect(find.text('Old chats'), findsOneWidget);
        }
        if (state == 'old-list' || state == 'old-chat') {
          await tester.tap(find.text('Old chats'));
          await settle();
        }
        if (state == 'old-chat') {
          await tester.tap(find.text('Mobile'));
          await settle();
        }
        expect(tester.takeException(), isNull);
        await tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 3);
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/phone-buddy-tab-$state-${brightness.name}-390.png')
              .writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
        await tester.pumpWidget(const SizedBox());
        host.dispose();
        await tester.pump(const Duration(minutes: 1));
      }
    }
  }, skip: shots == null);
}

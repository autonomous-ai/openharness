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
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of Swarm Home and its drawer with a chat unread and a
/// tag waiting, in both phone themes, from made-up Swarm data only.
final shots = Platform.environment['SWARM_NEWS_SHOTS'];
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

  testWidgets('Home and the drawer, unread and tagged, in both phone themes', (
    tester,
  ) async {
    const web = 'project-web';
    const webLead = 'group-web-lead';
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'OpenHarness', 'ownerId': me},
        ],
        'next': null,
      };
      Map<String, dynamic> inWeb(Map<String, dynamic> row) => {
        ...row,
        'projectId': web,
      };
      Map<String, dynamic> work(String id, String title, int number, int at) =>
          groupData(
            id,
            title: title,
            number: number,
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'working',
            workerId: 'agent-builder',
            lastMessageSequence: at,
          );
      const derived = {'mentionsWaiting': 1};
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        derived: derived,
        head: headData(
          name: 'OpenHarness',
          projects: [
            {
              'id': project,
              'name': 'openharness',
              'ownerId': me,
              'leadConversationId': leadChat,
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
            },
            {
              'id': web,
              'name': 'web-2',
              'ownerId': me,
              'leadConversationId': webLead,
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
            },
          ],
        ),
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          agent('agent-builder', displayName: 'Nova'),
          buddyData('agent-wren', displayName: 'Wren'),
          inWeb(agent('agent-cleo', name: 'Lead', displayName: 'Cleo')),
        ],
        groups: [
          work('g-bold', 'Mobile: bold names and @N', 12, 3),
          work('g-agents', 'Desktop: agents list', 13, 2),
          buddyChatData(
            'buddy-me',
            agentIds: ['agent-wren'],
            lastMessageSequence: 1,
          ),
          inWeb(
            groupData(
              webLead,
              title: 'web-2',
              agentIds: ['agent-cleo'],
              leadId: 'agent-cleo',
              lastMessageSequence: 1,
            ),
          ),
        ],
      );
      // Read once: what was there is read; then the work chat and the Buddy
      // chat move on.
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2', derived: derived);
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': [
          {
            'id': 'm1',
            'projectId': project,
            'projectName': 'openharness',
            'conversationId': leadChat,
            'conversationTitle': 'openharness',
            'messageId': 'msg-1',
            'leadName': 'River',
            'text': 'Can you check the mockups?',
            'createdAt': '2026-10-29T01:00:00.000Z',
          },
        ],
      };
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
            home: const SwarmPage(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        derived: derived,
        groups: [
          part(
            'g-bold',
            30,
            work('g-bold', 'Mobile: bold names and @N', 12, 5),
          ),
          part(
            'buddy-me',
            31,
            buddyChatData(
              'buddy-me',
              agentIds: ['agent-wren'],
              lastMessageSequence: 2,
            ),
          ),
        ],
      );
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();
      Future<void> capture(String name) => tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/news-$name-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await capture('home');
      await tester.tap(find.byKey(const ValueKey('swarm-menu')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('swarm-drawer-chats-$tab-$project')),
      );
      await tester.pumpAndSettle();
      await capture('drawer');
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      account.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

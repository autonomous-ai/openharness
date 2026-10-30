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

/// Review screenshots of Swarm Home, direction C, as Tony's prototype C1
/// draws it (2026-10-30) — over two Swarms, back after an hour away:
/// While you were away, Pinned, Projects by latest activity with the quiet
/// ones folded, an unread project and a tagged one — then its switcher, in
/// both phone themes, from made-up Swarm data only, to the folder
/// `SWARM_HOME_SHOTS` names.
final shots = Platform.environment['SWARM_HOME_SHOTS'];
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

  testWidgets('Home and its switcher, in both phone themes', (tester) async {
    const other = 'tab-2';
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final now = DateTime.now();
      int ago(Duration age) => now.subtract(age).millisecondsSinceEpoch;
      const minute = Duration(minutes: 1);

      Map<String, dynamic> projectOf(String id, String name) => {
        'id': id,
        'name': name,
        'ownerId': me,
        'leadConversationId': 'lead-$id',
        'visibility': 'public',
        'members': <Object>[],
        'updateMinutes': 5,
      };
      Map<String, dynamic> agentIn(
        String projectId,
        String id,
        String displayName, {
        String name = 'Builder',
      }) => {
        ...agent(id, name: name, displayName: displayName),
        'projectId': projectId,
      };
      Map<String, dynamic> chat(
        String projectId,
        String id,
        String title, {
        int? number,
        String? status,
        String? worker,
        int sequence = 1,
        String? leadId,
      }) => {
        ...groupData(
          id,
          title: title,
          number: number,
          agentIds: [?worker, ?leadId],
          status: status,
          workerId: worker,
          leadId: leadId,
          lastMessageSequence: sequence,
        ),
        'projectId': projectId,
      };
      final projects = [
        projectOf('p-oh', 'openharness'),
        projectOf('p-web', 'web-2'),
        projectOf('p-desk', 'desktop-app'),
        projectOf('p-docs', 'docs'),
        projectOf('p-infra', 'infra'),
      ];
      // When each chat last moved: openharness and web-2 a few minutes ago,
      // desktop-app within the hour, docs and infra days ago.
      final moved = {
        'lead-p-oh': ago(minute * 3),
        'g-ship': ago(minute * 2),
        'g-ask': ago(minute * 9),
        'g-threads': ago(minute * 6),
        'lead-p-web': ago(minute * 12),
        'g-cache': ago(minute * 14),
        'lead-p-desk': ago(minute * 48),
        'lead-p-docs': ago(const Duration(days: 2)),
        'lead-p-infra': ago(const Duration(days: 3)),
      };
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'OpenHarness', 'ownerId': me},
          {'id': other, 'name': 'Design Lab', 'ownerId': me},
        ],
        'next': null,
      };
      final load = firstLoad(
        head: headData(name: 'OpenHarness', projects: projects),
        agents: [
          agentIn('p-oh', 'agent-river', 'River', name: 'Lead'),
          agentIn('p-oh', 'agent-ash', 'Ash'),
          agentIn('p-oh', 'agent-wren', 'Wren'),
          agentIn('p-oh', 'agent-moss', 'Moss'),
          agentIn('p-web', 'agent-cleo', 'Cleo', name: 'Lead'),
          agentIn('p-web', 'agent-juno', 'Juno'),
          agentIn('p-desk', 'agent-pike', 'Pike', name: 'Lead'),
          {
            ...agentIn('p-desk', 'agent-kite', 'Kite'),
            'downSince': '2026-10-29T01:00:00.000Z',
          },
          agentIn('p-docs', 'agent-sage', 'Sage', name: 'Lead'),
          agentIn('p-infra', 'agent-flint', 'Flint', name: 'Lead'),
        ],
        groups: [
          for (final p in projects)
            chat(
              p['id'] as String,
              'lead-${p['id']}',
              p['name'] as String,
              leadId: switch (p['id']) {
                'p-oh' => 'agent-river',
                'p-web' => 'agent-cleo',
                'p-desk' => 'agent-pike',
                'p-docs' => 'agent-sage',
                _ => 'agent-flint',
              },
            ),
          chat(
            'p-oh',
            'g-ship',
            'Batch AB',
            number: 2154,
            status: 'working',
            worker: 'agent-moss',
          ),
          chat(
            'p-oh',
            'g-ask',
            'phone leaderboard',
            number: 2151,
            status: 'needs_human',
            worker: 'agent-ash',
          ),
          chat(
            'p-oh',
            'g-threads',
            'Threads option B',
            status: 'working',
            worker: 'agent-wren',
          ),
          chat(
            'p-web',
            'g-cache',
            'Saved views cache',
            status: 'working',
            worker: 'agent-juno',
            sequence: 3,
          ),
        ],
      );
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...load,
        // The fixture's lead chat is another project's.
        'groups': [
          for (final row in load['groups'] as List)
            if ((row as Map)['key'] != leadChat)
              {...row, 'changedAt': ?moved[row['key']]},
        ],
      };
      fake.routes['/api/super-tabs/$other/parts'] = (_) => firstLoad(
        tabId: other,
        head: headData(
          id: other,
          name: 'Design Lab',
          projects: [projectOf('p-brand', 'brand')],
        ),
        agents: [agentIn('p-brand', 'agent-ivy', 'Ivy', name: 'Lead')],
        groups: [chat('p-brand', 'lead-p-brand', 'brand', leadId: 'agent-ivy')],
      );
      const derived = {'decisionsWaiting': 1, 'mentionsWaiting': 1};
      for (final id in [tab, other]) {
        fake.routes['/api/super-tabs/$id/changes'] = (_) =>
            changes(cursor: 'c2', derived: id == tab ? derived : const {});
        fake.routes['/api/super-tabs/$id/decisions?state=open'] = (_) => {
          'decisions': [
            if (id == tab)
              {
                'id': 'd1',
                'projectId': 'p-oh',
                'projectName': 'openharness',
                'conversationId': 'g-ship',
                'conversationTitle': 'Batch AB',
                'askerName': 'River',
                'question': 'PR #2154 is ready to merge. Merge it?',
                'options': ['Merge', 'Wait'],
                'recommended': 0,
                'createdAt': DateTime.fromMillisecondsSinceEpoch(
                  ago(minute * 2),
                ).toUtc().toIso8601String(),
              },
          ],
        };
        fake.routes['/api/super-tabs/$id/mentions?state=waiting'] = (_) => {
          'mentions': [
            if (id == tab)
              {
                'id': 'm1',
                'projectId': 'p-desk',
                'projectName': 'desktop-app',
                'conversationId': 'lead-p-desk',
                'conversationTitle': 'desktop-app',
                'messageId': 'msg-1',
                'leadName': 'Pike',
                'text': 'Can you check the installer copy?',
                'createdAt': DateTime.fromMillisecondsSinceEpoch(
                  ago(minute * 48),
                ).toUtc().toIso8601String(),
              },
          ],
        };
      }
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
      host.session!.home
        ..pin(tab, 'p-oh', true)
        ..seen(now.subtract(const Duration(hours: 1)));
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
      // Read once: what was there is read; then web-2's work moves on.
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        derived: derived,
        groups: [
          {
            ...part(
              'g-cache',
              30,
              chat(
                'p-web',
                'g-cache',
                'Saved views cache',
                status: 'working',
                worker: 'agent-juno',
                sequence: 5,
              ),
            ),
            'changedAt': ago(minute * 12),
          },
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
        await File('$shots/home-c-$name-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await capture('home');
      await tester.tap(find.byKey(const ValueKey('swarm-other-projects')));
      await tester.pumpAndSettle();
      await capture('home-quiet-open');
      await tester.tap(find.byKey(const ValueKey('swarm-title-button')));
      await tester.pumpAndSettle();
      await capture('switcher');
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      account.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The drawer's and the project sheet's task lines in both phone themes, for
/// the pull request: `SWARM_TASK_STATUS_SHOTS=<dir> flutter test
/// test/swarm/swarm_task_status_shots_test.dart` on a Mac. Scripted data only.
final shots = Platform.environment['SWARM_TASK_STATUS_SHOTS'];

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

  testWidgets('task lines in the drawer and the project sheet, both themes', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final now = clock.now();
      int ago(Duration age) => now.subtract(age).millisecondsSinceEpoch;
      const minute = Duration(minutes: 1);
      Map<String, dynamic> task(
        String id,
        String title,
        int number, {
        String? worker,
        String? status,
        String? result,
        Duration? progress,
        Map<String, dynamic>? liveness,
        Map<String, dynamic>? leadAction,
        required int sequence,
      }) => {
        ...groupData(
          id,
          title: title,
          number: number,
          agentIds: [?worker],
          lastMessageSequence: sequence,
        ),
        'assignment': worker == null
            ? null
            : {
                'id': 'attempt-$id',
                'agentId': worker,
                'status': status,
                'result': result,
                'progressAt': ?(progress == null ? null : ago(progress)),
              },
        'liveness': ?liveness,
        'leadAction': ?leadAction,
      };
      Map<String, dynamic> state(
        String state,
        String why,
        Duration since, {
        String? personId,
      }) => {
        'state': state,
        'why': why,
        'since': ago(since),
        'personId': ?personId,
      };

      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'OpenHarness', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
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
            ],
          ),
          agents: [
            agent('agent-lead', name: 'Lead', displayName: 'River'),
            agent('agent-nova', displayName: 'Nova'),
            agent('agent-lark', displayName: 'Lark'),
            agent('agent-atlas', displayName: 'Atlas'),
          ],
          groups: [
            task(
              'g-ask',
              'Mobile: task status line',
              1036,
              worker: 'agent-lark',
              status: 'needs_human',
              result: 'mockup OK?',
              liveness: state(
                'waiting',
                'person',
                minute * 12,
                personId: 'person-tony',
              ),
              sequence: 9,
            ),
            task(
              'g-review',
              'Buddy replaces Chat with PM',
              1031,
              worker: 'agent-nova',
              status: 'review',
              liveness: state('waiting', 'review', minute * 3),
              leadAction: {'kind': 'post', 'at': ago(minute)},
              sequence: 8,
            ),
            task(
              'g-quiet',
              'Leaderboard tabs',
              1029,
              worker: 'agent-atlas',
              status: 'working',
              liveness: state('quiet', 'silent', minute * 34),
              leadAction: {'kind': 'assign', 'at': ago(minute)},
              sequence: 7,
            ),
            task(
              'g-work',
              'WS Phase 2b',
              1027,
              worker: 'agent-nova',
              status: 'working',
              progress: minute * 4,
              sequence: 6,
            ),
            task(
              'g-queued',
              'Swarm machines probe',
              1025,
              liveness: state('waiting', 'queued', minute * 25),
              leadAction: {'kind': 'route', 'at': ago(minute * 2)},
              sequence: 5,
            ),
            task(
              'g-lost',
              'Desktop release notes',
              1023,
              worker: 'agent-atlas',
              status: 'working',
              liveness: state('orphaned', 'lost', minute * 5),
              sequence: 4,
            ),
          ],
        ),
        'members': [
          part(me, 1, person(me)),
          part('person-tony', 1, {
            ...person('person-tony'),
            'email': 'tony@example.com',
          }),
        ],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': [
          {
            'id': 'm1',
            'projectName': 'openharness',
            'conversationId': 'g-ask',
            'conversationTitle': 'Mobile: task status line',
            'messageId': 'msg-1',
            'leadName': 'River',
            'text': 'Can you check the mockup?',
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
      await host.session!.inbox.refresh();
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
      Future<void> capture(String name) => tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File(
          '$shots/task-status-$name-${brightness.name}.png',
        ).writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await tester.tap(find.byKey(const ValueKey('swarm-menu')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('swarm-drawer-chats-$tab-$project')),
      );
      await tester.pumpAndSettle();
      await tester.drag(find.byType(ListView).last, const Offset(0, -160));
      await tester.pumpAndSettle();
      await capture('drawer');
      await tester.tap(find.byKey(const ValueKey('swarm-drawer-close')));
      await tester.pumpAndSettle();
      showSwarmProjectSheet(
        tester.element(find.byType(SwarmPage)),
        swarmId: tab,
        projectId: project,
      );
      await tester.pumpAndSettle();
      await capture('sheet');
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      account.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

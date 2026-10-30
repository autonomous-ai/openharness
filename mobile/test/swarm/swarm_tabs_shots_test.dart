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
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_tabs.dart';

import '../voice_fakes.dart';
import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';

/// Review screenshots of Swarm's tab bar, direction C, as Tony's prototype
/// C1 draws it (2026-10-30), with the tabs main has screens for: Swarm Home
/// as C1 draws it over the bar — back after two hours away — with what
/// waits on the person counted on Activity, its switcher and Jump to, each
/// touch area outlined; Activity's Needs you; and You as C4 draws it, on a
/// 390-point phone in both phone themes, from made-up data only, to the
/// folder `SWARM_TABS_SHOTS` names.
final shots = Platform.environment['SWARM_TABS_SHOTS'];
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

  testWidgets('the tab bar under Swarm Home, in both phone themes', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    // An iPhone's status bar and home indicator.
    tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
    addTearDown(tester.view.resetPadding);
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
      Map<String, dynamic> lead(String projectId) => {
        ...groupData(
          'lead-$projectId',
          title: projectId,
          agentIds: ['agent-river'],
          leadId: 'agent-river',
        ),
        'projectId': projectId,
      };
      // Work in each project: Nova working on mobile, Ash waiting on the
      // person in the API, Kite down on desktop; three tasks done since the
      // person left, one before.
      Map<String, dynamic> work(
        String projectId,
        String id,
        String status,
        String worker, {
        Duration? done,
      }) => {
        ...groupData(
          id,
          title: id,
          agentIds: [worker],
          status: status,
          workerId: worker,
        ),
        'projectId': projectId,
        if (done != null)
          'assignment': {
            'id': 'attempt-$id',
            'agentId': worker,
            'status': status,
            'result': null,
            'progressAt': ago(done),
          },
      };
      // When each project's chat last moved, in minutes.
      const moved = {
        'lead-p-oh': 2,
        'lead-p-mobile': 6,
        'lead-p-api': 31,
        'lead-p-desk': 41,
      };
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Autonomous', 'ownerId': me},
        ],
        'next': null,
      };
      final load = firstLoad(
        head: {
          ...headData(
            name: 'Autonomous',
            projects: [
              projectOf('p-oh', 'openharness'),
              projectOf('p-mobile', 'harness-mobile'),
              projectOf('p-api', 'backend-api'),
              projectOf('p-desk', 'desktop'),
            ],
          ),
          'localModels': {'grid': 'grid-1', 'enabled': true},
        },
        agents: [
          {
            ...agent('agent-river', name: 'Lead', displayName: 'River'),
            'projectId': 'p-oh',
          },
          {
            ...agent('agent-nova', displayName: 'Nova'),
            'projectId': 'p-mobile',
          },
          {...agent('agent-ash', displayName: 'Ash'), 'projectId': 'p-api'},
          {
            ...agent('agent-kite', displayName: 'Kite'),
            'projectId': 'p-desk',
            'downSince': '2026-10-29T01:00:00.000Z',
          },
        ],
        groups: [
          for (final id in ['p-oh', 'p-mobile', 'p-api', 'p-desk']) lead(id),
          work('p-mobile', 'g-tabs', 'working', 'agent-nova'),
          work('p-api', 'g-ask', 'needs_human', 'agent-ash'),
          for (final (i, minutes) in [20, 45, 70, 180].indexed)
            work(
              'p-oh',
              'g-done-$i',
              'done',
              'agent-river',
              done: minute * minutes,
            ),
        ],
      );
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...load,
        // A made-up person, in a meeting (no emoji: a test draws none), and
        // the models one machine serves.
        'members': [
          part(me, 1, {
            ...person(me),
            'email': 'ada@example.com',
            'status': {'text': 'In a meeting'},
          }),
        ],
        'machines': [
          part('mac-1', 1, {
            'machineId': 'mac-1',
            'name': 'Studio',
            'contributorId': me,
            'observation': {
              'receivedAt': now.millisecondsSinceEpoch,
              'localModels': [
                for (final (model, kind) in [
                  ('qwen3-coder', 'local'),
                  ('llama-4', 'shared'),
                  ('moonshotai/kimi-k3', 'api'),
                ])
                  {'grid': 'grid-1', 'model': model, 'kind': kind},
              ],
            },
          }),
        ],
        // The fixture's lead chat is another project's.
        'groups': [
          for (final row in load['groups'] as List)
            if ((row as Map)['key'] != leadChat)
              {
                ...row,
                if (moved[row['key']] case final age?)
                  'changedAt': ago(minute * age),
              },
        ],
      };
      const derived = {'decisionsWaiting': 1, 'mentionsWaiting': 0};
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2', derived: derived);
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': [
          {
            'id': 'd1',
            'projectId': 'p-oh',
            'projectName': 'openharness',
            'conversationId': 'lead-p-oh',
            'conversationTitle': 'openharness',
            'askerName': 'River',
            'question': 'PR #2154 is ready to merge. Merge it?',
            'options': ['Merge', 'Wait'],
            'recommended': 0,
            'createdAt': DateTime.fromMillisecondsSinceEpoch(ago(minute * 2))
                .toUtc()
                .toIso8601String(),
          },
        ],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final computers =
          FakeComputers(const [
              (name: 'Studio', away: false),
              (name: 'Laptop', away: false),
              (name: 'Mini', away: true),
            ])
            ..own = [
              (id: 'studio', name: 'Studio', away: false),
              (id: 'laptop', name: 'Laptop', away: false),
              (id: 'mini', name: 'Mini', away: true),
            ];
      final host = SwarmHost(
        accountId: () => me,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: features,
        readMarks: MemoryKeyValueStore(),
        computers: computers,
      )..foreground = false;
      // Gone two hours: Home has While you were away.
      host.session!.home.seen(now.subtract(const Duration(hours: 2)));
      final boundary = GlobalKey();
      final targets = ValueNotifier(<Rect>[]);
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (_, child) => SwarmScope(
              notifier: host,
              child: Stack(
                children: [
                  child!,
                  IgnorePointer(
                    child: ValueListenableBuilder(
                      valueListenable: targets,
                      builder: (_, rects, _) => CustomPaint(
                        size: Size.infinite,
                        painter: _Targets(rects),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            home: SwarmTabsPage(onSettings: (_) {}),
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
        await File('$shots/tabs-$name-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      Rect rect(String key) => tester.getRect(find.byKey(ValueKey(key)));
      await capture('home');
      targets.value = [
        for (final key in [
          'swarm-title-button',
          'swarm-compose',
          'swarm-jump',
          'swarm-away',
          'swarm-project-$tab-p-oh',
        ])
          rect(key),
        for (final tab in [SwarmTab.home, SwarmTab.activity, SwarmTab.you])
          rect('swarm-tab-${tab.name}'),
      ];
      await tester.pump();
      await capture('targets');
      targets.value = [];
      await tester.tap(find.byKey(const ValueKey('swarm-title-button')));
      await tester.pumpAndSettle();
      await capture('switcher');
      targets.value = [rect('swarm-switch-$tab'), rect('swarm-switch-join')];
      await tester.pump();
      await capture('switcher-targets');
      targets.value = [];
      Navigator.of(
        tester.element(find.byKey(const ValueKey('swarm-switch-join'))),
      ).pop();
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('swarm-jump')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('swarm-jump-query')),
        'har',
      );
      await tester.pump();
      await capture('jump');
      await tester.tap(find.byKey(const ValueKey('swarm-jump-cancel')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('swarm-tab-activity')));
      await tester.pumpAndSettle();
      await capture('activity');
      await tester.tap(find.byKey(const ValueKey('swarm-tab-you')));
      await tester.pumpAndSettle();
      await capture('you');
      targets.value = [
        for (final row in ['status', 'models', 'devices', 'settings'])
          tester.getRect(find.byKey(ValueKey('swarm-you-$row'))),
      ];
      await tester.pump();
      await capture('you-targets');
      targets.value = [];
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 30));
      host.dispose();
      computers.dispose();
      account.dispose();
      targets.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

/// Each tab's touch area, outlined, with its size in points.
class _Targets extends CustomPainter {
  _Targets(this.rects);

  final List<Rect> rects;

  @override
  void paint(Canvas canvas, Size size) {
    final rim = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..color = const Color(0xFFE5484D);
    for (final rect in rects) {
      canvas.drawRect(rect.deflate(.75), rim);
      final text = TextPainter(
        text: TextSpan(
          text: '${rect.width.round()}×${rect.height.round()}',
          style: const TextStyle(
            fontFamily: '.AppleSystemUIFont',
            color: Color(0xFFE5484D),
            fontSize: 10,
            fontWeight: FontWeight.w600,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      text.paint(canvas, rect.topLeft + const Offset(4, 2));
      text.dispose();
    }
  }

  @override
  bool shouldRepaint(_Targets oldDelegate) => oldDelegate.rects != rects;
}

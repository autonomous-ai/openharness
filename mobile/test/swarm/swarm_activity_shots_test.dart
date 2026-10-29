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
import 'package:harness_mobile/swarm/swarm_buddies_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of Activity and Buddies, direction C, as Tony's
/// prototype C2 and C3 draw them (2026-10-30) — each filter of Activity,
/// Approve's confirm and its Undo, a need opened, the handled row, and
/// Buddies — with their touch targets outlined and measured, in both phone
/// themes, from made-up Swarm data only, to the folder
/// `SWARM_ACTIVITY_SHOTS` names.
final shots = Platform.environment['SWARM_ACTIVITY_SHOTS'];
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

  testWidgets('Activity and Buddies, in both phone themes', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final now = DateTime.now();
      String ago(Duration age) => now.subtract(age).toUtc().toIso8601String();
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
      Map<String, dynamic> inProject(String id, Map<String, dynamic> row) => {
        ...row,
        'projectId': id,
      };
      final projects = [
        projectOf('p-oh', 'openharness'),
        projectOf('p-desk', 'desktop-app'),
        projectOf('p-fw', 'firmware-dial'),
        projectOf('p-web', 'web-2'),
      ];
      final leads = {
        'p-oh': 'agent-river',
        'p-desk': 'agent-pike',
        'p-fw': 'agent-kite',
        'p-web': 'agent-cleo',
      };
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'OpenHarness', 'ownerId': me},
        ],
        'next': null,
      };
      const derived = {
        'decisionsWaiting': 2,
        'mentionsWaiting': 2,
        'readMarks': {
          'lead-p-oh': 20,
          'lead-p-desk': 10,
          'buddy-oh': 12,
          'buddy-desk': 6,
          'buddy-web': 3,
        },
      };
      final load = firstLoad(
        derived: derived,
        head: headData(name: 'OpenHarness', projects: projects),
        agents: [
          inProject(
            'p-oh',
            agent('agent-river', name: 'Lead', displayName: 'River'),
          ),
          inProject('p-oh', agent('agent-ash', displayName: 'Ash')),
          inProject('p-oh', agent('agent-moss', displayName: 'Moss')),
          inProject(
            'p-desk',
            agent('agent-pike', name: 'Lead', displayName: 'Pike'),
          ),
          inProject(
            'p-fw',
            agent('agent-kite', name: 'Lead', displayName: 'Kite'),
          ),
          inProject(
            'p-web',
            agent('agent-cleo', name: 'Lead', displayName: 'Cleo'),
          ),
          inProject('p-oh', buddyData('agent-wren', displayName: 'Wren')),
          inProject('p-desk', {
            ...buddyData('agent-juno', displayName: 'Juno'),
            'downSince': ago(const Duration(hours: 2)),
          }),
          inProject('p-web', buddyData('agent-sage', displayName: 'Sage')),
        ],
        groups: [
          for (final p in projects)
            inProject(
              p['id'] as String,
              groupData(
                'lead-${p['id']}',
                title: p['name'] as String,
                agentIds: [leads[p['id']]!],
                leadId: leads[p['id']],
                lastMessageSequence: 24,
              ),
            ),
          inProject(
            'p-oh',
            groupData(
              'g-ask',
              title: 'phone leaderboard',
              number: 2151,
              status: 'needs_human',
              workerId: 'agent-ash',
              agentIds: ['agent-ash'],
            ),
          ),
          inProject(
            'p-oh',
            buddyChatData(
              'buddy-oh',
              agentIds: ['agent-wren'],
              lastMessageSequence: 14,
            ),
          ),
          inProject(
            'p-desk',
            buddyChatData(
              'buddy-desk',
              agentIds: ['agent-juno'],
              lastMessageSequence: 6,
            ),
          ),
          inProject(
            'p-web',
            buddyChatData(
              'buddy-web',
              agentIds: ['agent-sage'],
              lastMessageSequence: 3,
            ),
          ),
        ],
      );
      int at(Duration age) => now.subtract(age).millisecondsSinceEpoch;
      // When each chat last moved.
      final moved = {
        'g-ask': at(minute * 12),
        'buddy-oh': at(minute),
        'buddy-desk': at(const Duration(hours: 2)),
        'buddy-web': at(const Duration(days: 1)),
        for (final p in projects) 'lead-${p['id']}': at(minute * 4),
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...load,
        // The fixture's lead chat is another project's.
        'groups': [
          for (final row in load['groups'] as List)
            if ((row as Map)['key'] != leadChat)
              {...row, 'changedAt': ?moved[row['key']]},
        ],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2', derived: derived);
      var answered = false;
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': [
          if (!answered)
            {
              'id': 'd1',
              'projectId': 'p-oh',
              'projectName': 'openharness',
              'conversationId': 'g-ask',
              'conversationTitle': 'phone leaderboard',
              'askerName': 'River',
              'question': 'Approve merge: PR #2154 Batch AB',
              'options': ['Merge', 'Wait'],
              'recommended': 0,
              'createdAt': ago(minute * 2),
            },
          {
            'id': 'd2',
            'projectId': 'p-desk',
            'projectName': 'desktop-app',
            'conversationId': 'lead-p-desk',
            'conversationTitle': 'desktop-app',
            'askerName': 'Pike',
            'question': 'Review proposal: Windows pipe fix',
            'options': ['Approve', 'Hold'],
            'recommended': 0,
            'createdAt': ago(minute * 31),
          },
        ],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': [
          {
            'id': 'm1',
            'projectId': 'p-oh',
            'projectName': 'openharness',
            'conversationId': 'lead-p-oh',
            'conversationTitle': 'openharness',
            'messageId': 'oh-9',
            'leadName': 'River',
            'text': 'Wait for #2151 before TestFlight?',
            'createdAt': ago(minute * 9),
          },
          {
            'id': 'm2',
            'projectId': 'p-fw',
            'projectName': 'firmware-dial',
            'conversationId': 'lead-p-fw',
            'conversationTitle': 'firmware-dial',
            'messageId': 'fw-3',
            'leadName': 'Kite',
            'text': 'Plug in the Dial to flash the build',
            'createdAt': ago(minute * 41),
          },
        ],
      };
      fake.routes['/api/super-tabs/$tab/commands'] = (body) {
        if (body?['command']?['type'] == 'decision.answer') answered = true;
        return {'result': <String, dynamic>{}};
      };
      Map<String, dynamic> message(
        String chat,
        String id,
        int sequence,
        String text, {
        String? by,
        Duration age = const Duration(minutes: 30),
        List<Map<String, dynamic>> reactions = const [],
      }) => {
        'id': id,
        'conversationId': chat,
        'text': text,
        'sequence': sequence,
        'thread': id,
        'author': by == null
            ? {'kind': 'person', 'id': me, 'name': 'person-me@example.com'}
            : {'kind': 'agent', 'id': by, 'name': 'Agent'},
        'reactions': reactions,
        'createdAt': ago(age),
      };
      Map<String, dynamic> thread(
        String root,
        int last,
        String by, {
        int replies = 2,
        Duration age = const Duration(minutes: 5),
      }) => {
        'id': root,
        'replies': replies,
        'lastSequence': last,
        'lastAt': ago(age),
        'authors': [
          {'kind': 'agent', 'id': by, 'name': 'Agent'},
        ],
        'people': [me],
      };
      Map<String, dynamic> pageOf(
        List<Map<String, dynamic>> messages, [
        List<Map<String, dynamic>> threads = const [],
      ]) => {'messages': messages, 'threads': threads, 'next': null};
      fake.routes['/api/super-tabs/$tab/conversations/'] = (_) =>
          pageOf(const []);
      fake.routes['/api/super-tabs/$tab/conversations/lead-p-oh/messages'] =
          (_) => pageOf(
            [
              message(
                'lead-p-oh',
                'oh-4',
                4,
                'Ship the TestFlight tonight?',
                age: const Duration(hours: 1),
              ),
              message(
                'lead-p-oh',
                'oh-6',
                6,
                'Settings copy is fixed.',
                age: minute * 50,
                reactions: [
                  {
                    'emoji': 'check',
                    'by': [
                      {'kind': 'agent', 'id': 'agent-river'},
                    ],
                  },
                  {
                    'emoji': 'rocket',
                    'by': [
                      {'kind': 'agent', 'id': 'agent-moss'},
                    ],
                  },
                ],
              ),
              message(
                'lead-p-oh',
                'oh-8',
                8,
                'Starting the Dial build now.',
                age: minute * 20,
                reactions: [
                  {
                    'emoji': 'eyes',
                    'by': [
                      {'kind': 'agent', 'id': 'agent-ash'},
                    ],
                  },
                ],
              ),
            ],
            [thread('oh-4', 24, 'agent-ash', replies: 3, age: minute * 4)],
          );
      fake.routes['/api/super-tabs/$tab/conversations/lead-p-desk/messages'] =
          (_) => pageOf(
            [
              message(
                'lead-p-desk',
                'desk-3',
                3,
                'Is the 0.9 installer signed yet?',
                age: const Duration(hours: 3),
              ),
            ],
            [thread('desk-3', 8, 'agent-pike', age: const Duration(hours: 2))],
          );
      fake.routes['/api/super-tabs/$tab/conversations/buddy-oh/messages'] =
          (_) => pageOf([
            message(
              'buddy-oh',
              'b-oh-14',
              14,
              'Sent the Batch PR report: 3 of 4 checks green.',
              by: 'agent-wren',
              age: minute,
            ),
          ]);
      fake.routes['/api/super-tabs/$tab/conversations/buddy-desk/messages'] =
          (_) => pageOf([
            message(
              'buddy-desk',
              'b-desk-6',
              6,
              'Is 0.9 out yet?',
              age: const Duration(hours: 2),
            ),
          ]);
      fake.routes['/api/super-tabs/$tab/conversations/buddy-web/messages'] =
          (_) => pageOf([
            message(
              'buddy-web',
              'b-web-3',
              3,
              'The 502s were the worker pool running out.',
              by: 'agent-sage',
              age: const Duration(days: 1),
            ),
          ]);

      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      // Not this phone's first Activity: the reactions are new.
      final store = MemoryKeyValueStore()
        ..values['swarm_activity.$me.$tab'] = '{"marks":{}}';
      final host = SwarmHost(
        accountId: () => me,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: features,
        readMarks: store,
      )..foreground = false;
      final boundary = GlobalKey();
      final targets = ValueNotifier<List<Rect>>(const []);
      final screen = ValueNotifier<Widget>(const SwarmActivityView());
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: Directionality(
            textDirection: TextDirection.ltr,
            child: Stack(
              children: [
                ValueListenableBuilder<Widget>(
                  valueListenable: screen,
                  builder: (_, home, _) => MaterialApp(
                    key: ValueKey(home.runtimeType),
                    debugShowCheckedModeBanner: false,
                    theme: buildAppTheme(brightness: brightness),
                    builder: (_, child) =>
                        SwarmScope(notifier: host, child: child!),
                    home: home,
                  ),
                ),
                Positioned.fill(
                  child: IgnorePointer(
                    child: ValueListenableBuilder<List<Rect>>(
                      valueListenable: targets,
                      builder: (_, rects, _) =>
                          CustomPaint(painter: _Targets(rects)),
                    ),
                  ),
                ),
              ],
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
        await File('$shots/activity-c-$name-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      Finder keyed(String prefix) => find.byWidgetPredicate(
        (widget) =>
            widget.key is ValueKey<String> &&
            (widget.key! as ValueKey<String>).value.startsWith(prefix),
      );
      // Outlines what a thumb can tap, each with its size.
      Future<void> captureTargets(String name, List<String> prefixes) async {
        targets.value = [
          for (final prefix in prefixes)
            for (final element in keyed(prefix).evaluate())
              tester.getRect(find.byWidget(element.widget)),
        ];
        await tester.pump();
        await capture(name);
        targets.value = const [];
        await tester.pump();
      }

      Future<void> filter(String name) async {
        await tester.ensureVisible(
          find.byKey(ValueKey('swarm-activity-filter-$name')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(ValueKey('swarm-activity-filter-$name')));
        await tester.pumpAndSettle();
      }

      await capture('needs');
      await captureTargets('needs-targets', [
        'swarm-activity-filter-',
        'swarm-activity-approve-',
        'swarm-activity-reply-',
      ]);
      await tester.tap(
        find.byKey(const ValueKey('swarm-activity-row-decision:d2')),
      );
      await tester.pumpAndSettle();
      await capture('needs-open');
      await tester.tap(
        find.byKey(const ValueKey('swarm-activity-approve-decision:d1')),
      );
      await tester.pumpAndSettle();
      await capture('approve-confirm');
      await tester.tap(
        find.byKey(const ValueKey('swarm-activity-approve-confirm')),
      );
      // The confirm closes, then its answer is held for Undo.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await capture('approve-held');
      await tester.pump(const Duration(seconds: 6));
      await tester.pumpAndSettle();
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();
      await capture('approved');
      await filter('mentions');
      await capture('mentions');
      await filter('threads');
      await capture('threads');
      await filter('reactions');
      await capture('reactions');
      await captureTargets('reactions-targets', [
        'swarm-activity-filter-',
        'swarm-activity-reply-',
      ]);

      screen.value = const SwarmBuddiesView();
      await tester.pumpAndSettle();
      await capture('buddies');
      await captureTargets('buddies-targets', ['swarm-buddies-row-']);

      await tester.pumpWidget(const SizedBox());
      host.dispose();
      account.dispose();
      targets.dispose();
      screen.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

/// Each touch target outlined, its size in points over it.
class _Targets extends CustomPainter {
  _Targets(this.rects);

  final List<Rect> rects;

  @override
  void paint(Canvas canvas, Size size) {
    const color = Color(0xFFFF2D96);
    final outline = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    for (final rect in rects) {
      canvas.drawRect(rect.deflate(.75), outline);
      final label = TextPainter(
        text: TextSpan(
          text: '${rect.width.round()}×${rect.height.round()}',
          style: const TextStyle(
            fontFamily: '.AppleSystemUIFont',
            color: Colors.white,
            fontSize: 9,
            fontWeight: FontWeight.w700,
            backgroundColor: color,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      label.paint(canvas, rect.topLeft + const Offset(2, 1));
    }
  }

  @override
  bool shouldRepaint(_Targets old) => old.rects != rects;
}

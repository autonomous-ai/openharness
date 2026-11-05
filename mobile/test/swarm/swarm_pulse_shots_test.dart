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
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of the board pulse on the phone (task #3384): the strip
/// on top of a project's Team sheet, calm and with every rule red, and the
/// lists its asks and Held open. On 390- and 320-point phones in both phone
/// themes, from made-up data only, to the folder `SWARM_PULSE_SHOTS` names
/// (run this file alone, on a Mac).
final shots = Platform.environment['SWARM_PULSE_SHOTS'];

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

  testWidgets('the pulse strip and its lists, in both phone themes', (
    tester,
  ) async {
    addTearDown(tester.view.reset);
    debugDisableShadows = false;
    // An iPhone's status bar and home indicator.
    tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
    addTearDown(tester.view.resetPadding);
    const huy = 'person-huy', mai = 'person-mai';
    for (final (palette, size) in [
      for (final palette in [HarnessPalette.graphite, HarnessPalette.paper])
        for (final size in const [Size(390, 844), Size(320, 568)])
          (palette, size),
    ]) {
      for (final red in [false, true]) {
        tester.view
          ..physicalSize = size * 3
          ..devicePixelRatio = 3;
        final brightness = palette.brightness;
        AppTheme.palette.value = palette;
        AppTheme.brightness.value = brightness;
        final now = clock.now();
        int ago(Duration age) => now.subtract(age).millisecondsSinceEpoch;
        const minute = Duration(minutes: 1);
        final past = ago(minute);
        Map<String, dynamic> task(
          String id,
          String title,
          int number, {
          String? status,
          String worker = 'agent-atlas',
        }) => {
          ...groupData(
            id,
            title: title,
            number: number,
            agentIds: [if (status != null) worker],
            status: status,
            workerId: worker,
            lastMessageSequence: 1,
          ),
          if (status != null)
            'assignment': {
              'id': 'attempt-$id',
              'agentId': worker,
              'status': status,
              'result': null,
              'progressAt': ago(minute * 4),
            },
        };
        final derived = {
          'pulse': {
            project: {
              'pmId': 'agent-lead',
              'asks': {
                'count': 2,
                'oldestAt': ago(minute * (red ? 24 : 14)),
                'personId': huy,
                'list': [
                  {
                    'conversationId': leadChat,
                    'messageId': 'm-1',
                    'personId': huy,
                    'at': ago(minute * (red ? 24 : 14)),
                  },
                  {
                    'conversationId': 'g-search',
                    'messageId': 'm-2',
                    'personId': mai,
                    'at': ago(minute * 3),
                  },
                ],
              },
              'working': {
                'count': red ? 0 : 6,
                'crew': 10,
                'agentIds': red ? <String>[] : ['agent-atlas', 'agent-nova'],
              },
              'nextUp': {
                'count': 7,
                'conversationIds': ['g-docs', 'g-onboard'],
              },
              'lost': {
                'count': red ? 1 : 0,
                'since': red ? ago(minute * 12) : null,
                'conversationIds': [if (red) 'g-sync'],
              },
              'held': {
                'count': 3,
                'withoutReason': 1,
                'list': [
                  {
                    'conversationId': 'g-billing',
                    'reason': 'Waiting on the Stripe API key from finance',
                  },
                  {'conversationId': 'g-later', 'reason': 'Not before Monday'},
                  {'conversationId': 'g-export', 'reason': null},
                ],
              },
              'idleSince': red ? ago(minute * 11) : null,
              'redAt': {
                'asks': red ? past : ago(-minute),
                'idle': red ? past : null,
                'lost': red ? past : null,
                'held': red ? past : null,
              },
              'limits': {
                'askMinutes': 15,
                'idleMinutes': 10,
                'lostMinutes': 10,
              },
            },
          },
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
            head: headData(name: 'OpenHarness'),
            agents: [
              agent('agent-lead', name: 'Lead', displayName: 'River'),
              agent('agent-atlas', displayName: 'Atlas'),
              agent('agent-nova', displayName: 'Nova'),
            ],
            groups: [
              task('g-search', 'Search page', 6, status: 'working'),
              task(
                'g-login',
                'Fix login',
                8,
                status: 'working',
                worker: 'agent-nova',
              ),
              task('g-docs', 'Docs for the CLI', 11),
              task('g-onboard', 'Onboarding copy', 12),
              task('g-sync', 'Sync settings', 13),
              task('g-billing', 'Billing page', 9),
              task('g-later', 'Weekly digest', 10),
              task('g-export', 'Export to CSV', 14),
            ],
            derived: derived,
          ),
          'members': [
            part(me, 1, {...person(me), 'name': 'Ada'}),
            part(huy, 1, {...person(huy, role: 'member'), 'name': 'Huy'}),
            part(mai, 1, {...person(mai, role: 'member'), 'name': 'Mai'}),
          ],
        };
        fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
            changes(cursor: 'c2', derived: derived);
        fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
          'decisions': <Object>[],
        };
        fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
          'mentions': <Object>[],
        };
        fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
          'messages': <Object>[],
          'next': null,
        };
        final features = ExperimentalFeaturesStore(
          storage: MemoryKeyValueStore(),
        )..value = {PhoneExperiment.swarm};
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
          await File('$shots/pulse-$width-$name-${brightness.name}.png')
              .writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
        Finder key(String value) => find.byKey(ValueKey(value));
        await tester.tap(key('swarm-project-menu'));
        await tester.pumpAndSettle();
        await tester.tap(key('swarm-project-menu-team'));
        await tester.pumpAndSettle();
        await capture(red ? 'strip-red' : 'strip');
        if (!red) {
          await tester.tap(key('swarm-pulse-asks'));
          await tester.pumpAndSettle();
          await capture('asks');
          await tester.tap(key('swarm-pulse-close'));
          await tester.pumpAndSettle();
          await tester.tap(key('swarm-pulse-held'));
          await tester.pumpAndSettle();
          await capture('held');
        }
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 30));
        host.dispose();
        account.dispose();
      }
    }
    debugDisableShadows = true;
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

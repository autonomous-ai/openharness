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

/// Review screenshots of the project status card at the top of a project's
/// chat (Tony 11-01, task 1): open, with the report and a decision waiting,
/// then folded. On a 390-point phone in both phone themes, from made-up data
/// only, to the folder `SWARM_PROJECT_STATUS_SHOTS` names.
final shots = Platform.environment['SWARM_PROJECT_STATUS_SHOTS'];
void main() {
  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
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

  testWidgets('the status card open and folded, in both phone themes', (
    tester,
  ) async {
    addTearDown(tester.view.reset);
    debugDisableShadows = false;
    tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
    addTearDown(tester.view.resetPadding);
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      const size = Size(390, 844);
      tester.view
        ..physicalSize = size * 3
        ..devicePixelRatio = 3;
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final now = DateTime.now().toUtc();
      String ago(int minutes) =>
          now.subtract(Duration(minutes: minutes)).toIso8601String();
      Map<String, dynamic> said(String id, int sequence, String text) => {
        'id': id,
        'conversationId': leadChat,
        'text': text,
        'sequence': sequence,
        'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
        'createdAt': ago(40 - sequence * 4),
      };
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Autonomous', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        head: headData(
          projects: [
            {
              'id': project,
              'name': 'openharness',
              'ownerId': me,
              'leadConversationId': leadChat,
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
              'status': {
                'text':
                    'Running: phone status card (Lark), Activity filters '
                    '(Nova)\nWaiting on you: 1 decision\nDone today: #2459 '
                    'Swarm phone direct reads, #2460 signed chat files',
                'at': ago(12),
              },
            },
          ],
        ),
        derived: {'decisionsWaiting': 1},
      );
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2', derived: {'decisionsWaiting': 1});
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': [
          {
            'id': 'd1',
            'projectId': project,
            'projectName': 'openharness',
            'conversationId': leadChat,
            'conversationTitle': 'openharness',
            'askerName': 'River',
            'question': 'Fold the card by default on small phones?',
            'options': ['Yes', 'No'],
            'recommended': 1,
            'unblocks': 'The card',
            'createdAt': ago(5),
          },
        ],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
        'messages': [
          said('m3', 3, 'Lark has the status card mockup up for Tony.'),
          said('m2', 2, 'CI on #2460 is green; merging.'),
          said('m1', 1, 'Morning all. Phone catch-up is today\'s focus.'),
        ],
        'next': null,
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
        await File('$shots/project-status-390-$name-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      expect(
        find.byKey(const ValueKey('swarm-project-status-$project')),
        findsOneWidget,
      );
      await capture('open');
      await tester.tap(
        find.byKey(const ValueKey('swarm-project-status-fold-$project')),
      );
      await tester.pumpAndSettle();
      await capture('folded');
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    }
    debugDisableShadows = true;
  }, skip: shots == null);
}

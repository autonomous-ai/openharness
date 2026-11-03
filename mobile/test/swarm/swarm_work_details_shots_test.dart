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
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of a task's Work details on the phone (Tony's mobile
/// list, task 31): the chat's ⋮ with Work details, and the page. On a
/// 390-point phone in both phone themes, from made-up data only, to the folder
/// `SWARM_WORK_DETAILS_SHOTS` names.
final shots = Platform.environment['SWARM_WORK_DETAILS_SHOTS'];
void main() {
  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in {
      '.AppleSystemUIFont',
      'Roboto',
      AppFont.sans,
      ...AppFont.sansFallback,
    }) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    // The tab's title is set in the terminal's face.
    final mono = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
    );
    final terminal = terminalFontStore.value;
    for (final family in {
      '.AppleSystemUIFontMonospaced',
      'monospace',
      AppFont.mono,
      ...AppFont.monoFallback,
      terminal.fontFamily,
      ...terminal.fontFamilyFallback,
    }) {
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

  testWidgets('the chat menu and Work details, in both phone themes', (
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
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Autonomous', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        groups: [
          {
            ...groupData(
              'g1',
              title: 'Fix the login loop',
              number: 14,
              status: 'review',
              agentIds: ['agent-builder'],
            ),
            'brief':
                'Goal:\nPeople signed out on a phone get sent back to '
                'sign-in in a loop.\n\nChanges:\nKeep the session through '
                'the redirect.\n\nConstraints:\nNo new dependency.',
            'checks': [
              {
                'id': 'c1',
                'description': 'The new test fails on main and passes',
                'evidence': 'Failed at abc123, passes at def456.',
                'passedBy': 'agent-builder',
              },
              {'id': 'c2', 'description': 'Tried on a real phone'},
            ],
            'assignment': {
              'id': 'attempt-g1',
              'agentId': 'agent-builder',
              'status': 'review',
              'result': 'PR 12 at def456.',
            },
          },
          {
            ...groupData(
              'g2',
              title: 'Review: PR 12',
              number: 15,
              status: 'done',
              workerId: 'agent-lead',
            ),
            'reviewOf': 'g1',
            'step': 'Review',
            'checks': [
              {'id': 'r1', 'description': 'Reads well', 'passedBy': 'x'},
            ],
          },
        ],
      );
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/conversations/g1/messages'] = (_) => {
        'messages': <Object>[],
        'next': null,
      };
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => me,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
      )..foreground = false;
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            home: const Scaffold(
              body: SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> capture(String name) async {
        if (shots == null) return;
        await tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 3);
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await File('$shots/work-details-390-$name-${brightness.name}.png')
              .writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
      }

      await tester.tap(find.byKey(const ValueKey('swarm-chat-menu')));
      await tester.pumpAndSettle();
      expect(find.text('Work details'), findsOneWidget);
      await capture('menu');
      await tester.tap(find.text('Work details'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('swarm-work-details')), findsOneWidget);
      await capture('page');
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    }
    debugDisableShadows = true;
  }, skip: shots == null);
}

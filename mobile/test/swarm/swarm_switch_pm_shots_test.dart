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
import 'package:harness_mobile/swarm/swarm_switch_pm.dart' show swarmProfileId;

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of Switch PM on the phone, as Desktop's dialog has it:
/// Project settings… with its Switch PM… row, then the dialog with its
/// Machine and Model rows, an account and a model picked, and each row's
/// menu open — the machines with why one cannot take the PM, the Swarm's
/// models. On a 390-point phone in both phone themes, from made-up data
/// only, to the folder `SWARM_SWITCH_PM_SHOTS` names.
final shots = Platform.environment['SWARM_SWITCH_PM_SHOTS'];

void main() {
  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    // Every name the app's text asks for; one left out draws as blocks.
    for (final family in {
      '.AppleSystemUIFont',
      'Roboto',
      AppFont.sans,
      ...AppFont.sansFallback,
    }) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    final mono = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
    );
    for (final family in {
      '.AppleSystemUIFontMonospaced',
      'monospace',
      AppFont.mono,
      ...AppFont.monoFallback,
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

  testWidgets('Switch PM with Machine and Model, in both phone themes', (
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
      final read = DateTime.now().millisecondsSinceEpoch;
      Map<String, dynamic> machine(
        String id,
        String name, {
        String contributorId = me,
        int? readAt,
        List<Map<String, dynamic>> profiles = const [],
        List<String> engines = const ['claude', 'codex'],
      }) => {
        'machineId': id,
        'name': name,
        'contributorId': contributorId,
        'engines': engines,
        'observation': {
          'receivedAt': readAt ?? read,
          'capabilities': ['leadStart', 'leadSwitch'],
          'profiles': profiles,
        },
      };
      Map<String, dynamic> account(
        String engine,
        String id,
        String label,
        int left,
      ) => {
        'engine': engine,
        'id': id,
        'label': label,
        'leftPercent': left,
        'resetsAt': null,
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
            },
          ],
        ),
        agents: [
          {
            ...agent('agent-lead', name: 'Lead', displayName: 'River'),
            'machineOwnerId': me,
          },
        ],
        machines: [
          machine(
            'mac-1',
            'Team Mac.local',
            profiles: [
              // The account River runs in now.
              account(
                'claude',
                swarmProfileId('mac-1', 'claude', 'default'),
                'Default',
                40,
              ),
              account('claude', 'aaaaaaaaaaaaaaaa', 'Work', 0),
              account('codex', 'bbbbbbbbbbbbbbbb', 'Side', 70),
            ],
          ),
          machine(
            'mac-2',
            'Studio.local',
            engines: ['codex'],
            profiles: [account('codex', 'cccccccccccccccc', 'Studio', 55)],
          ),
          machine('mac-3', 'Ken’s MacBook Pro', contributorId: 'person-ken'),
          machine('mac-4', 'Old Mac', readAt: read - 600000),
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
      fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
        'messages': <Object>[],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/routing-policy'] = (_) => {
        'catalog': {
          'models': [
            for (final (engine, model) in const [
              ('claude', 'opus'),
              ('codex', 'default'),
              ('codex', 'gpt-6.1-sol'),
              ('codex', 'gpt-6-astra'),
              ('claude', 'sonnet'),
            ])
              {'engine': engine, 'model': model, 'offered': true},
          ],
        },
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
            home: const SwarmProjectPage(
              swarmId: tab,
              projectId: project,
              tabs: SwarmProjectTab.homeC,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Finder key(String value) => find.byKey(ValueKey(value));
      Future<void> capture(String name) => tester.runAsync(() async {
        expect(tester.takeException(), isNull);
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File(
          '$shots/phone-swarm-switch-pm-$name-${brightness.name}-390.png',
        ).writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-project-menu-settings'));
      await tester.pumpAndSettle();
      await capture('settings');
      await tester.tap(find.text('Switch PM…'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-switch-pm-model'));
      await tester.pumpAndSettle();
      await capture('model-menu');
      await tester.tap(key('swarm-switch-pm-model-gpt-6.1-sol'));
      await tester.pumpAndSettle();
      await capture('dialog');
      await tester.tap(key('swarm-switch-pm-machine'));
      await tester.pumpAndSettle();
      await capture('machine-menu');
      await tester.tap(key('swarm-switch-pm-machine-mac-2'));
      await tester.pumpAndSettle();
      await capture('other-machine');
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    }
    debugDisableShadows = true;
  }, skip: shots == null);
}

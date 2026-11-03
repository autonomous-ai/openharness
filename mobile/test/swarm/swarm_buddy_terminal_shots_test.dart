import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';

/// Review screenshots of Open terminal in the real Buddy chat's ⋮, 390 points
/// wide in both phone themes, from made-up data, to the folder
/// `SWARM_BUDDY_TERMINAL_SHOTS` names: each state of its row.
final shots = Platform.environment['SWARM_BUDDY_TERMINAL_SHOTS'];

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

  testWidgets('Open terminal, in both phone themes', (tester) async {
    const chat = 'buddy-me';
    addTearDown(() => tester.binding.setSurfaceSize(null));
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      await tester.binding.setSurfaceSize(const Size(390, 640));
      for (final state in ['open', 'stopped', 'offline', 'not-linked']) {
        final fake = FakeSwarm();
        fake.routes['/api/super-tabs/list'] = (_) => {
          'tabs': [
            {'id': tab, 'name': 'OpenHarness', 'ownerId': me},
          ],
          'next': null,
        };
        fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
          ...firstLoad(
            groups: [
              {
                ...buddyChatData(chat, agentIds: ['agent-wren']),
                'buddyName': 'Wren',
              },
            ],
            agents: [
              agent('agent-lead', name: 'Lead', displayName: 'River'),
              {
                ...buddyData('agent-wren', displayName: 'Wren'),
                if (state == 'stopped') 'workDecision': 'stop',
              },
            ],
          ),
          'members': [
            part(me, 1, {...person(me), 'email': 'tony@example.com'}),
          ],
        };
        fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
            changes(cursor: 'c2');
        fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
          'decisions': <Object>[],
        };
        fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
          'mentions': <Object>[],
        };
        fake.routes['/api/super-tabs/$tab/conversations/$chat/messages'] = (
          _,
        ) => {'messages': <Object>[], 'next': null};
        final computers = FakeComputers(const [])
          ..own = [
            if (state != 'not-linked')
              (
                id: 'mac-1',
                name: 'Tonys-MacBook-Pro',
                away: state == 'offline',
              ),
          ];
        final host = SwarmHost(
          accountId: () => me,
          account: ValueNotifier<String?>(me),
          request: fake.request,
          notices: SilentSystemNotices(),
          computers: computers,
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
              builder: (_, child) => PhoneShellScope(
                onMachineLinked: (_) {},
                onOpenAgent: (_, _) {},
                canOpenMachine: (id) =>
                    id == 'mac-1' && (state == 'open' || state == 'stopped'),
                child: SwarmScope(notifier: host, child: child!),
              ),
              home: const SwarmConversationPage(
                swarmId: tab,
                conversationId: chat,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('swarm-buddy-menu')));
        await tester.pumpAndSettle();
        expect(find.text('Open terminal'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 3);
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File(
            '$shots/phone-buddy-terminal-$state-${brightness.name}-390.png',
          ).writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
        await tester.pumpWidget(const SizedBox());
        host.dispose();
        computers.dispose();
        await tester.pump(const Duration(minutes: 1));
      }
    }
  }, skip: shots == null);
}

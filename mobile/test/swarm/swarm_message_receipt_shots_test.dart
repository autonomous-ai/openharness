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
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of the delivery line in the real chat, 390 and 320 points
/// wide in both phone themes, from made-up data, to the folder
/// `SWARM_RECEIPT_SHOTS` names: claims failing, nothing picked up yet, and the
/// computer offline.
final shots = Platform.environment['SWARM_RECEIPT_SHOTS'];

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

  testWidgets('the delivery line, in both phone themes and both widths', (
    tester,
  ) async {
    const messages = '/api/super-tabs/$tab/conversations/g1/messages';
    addTearDown(() => tester.binding.setSurfaceSize(null));
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      for (final width in [390.0, 320.0]) {
        await tester.binding.setSurfaceSize(Size(width, 560));
        for (final state in ['failing', 'waiting', 'offline']) {
          final now = clock.now();
          DateTime ago(Duration age) => now.subtract(age);
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
                groupData(
                  'g1',
                  title: 'Pilot',
                  agentIds: ['agent-lead'],
                  leadId: 'agent-lead',
                  lastMessageSequence: 2,
                ),
              ],
              agents: [agent('agent-lead', name: 'Lead', displayName: 'River')],
              machines: [
                {
                  'machineId': 'mac-1',
                  'name': 'Team Mac',
                  'contributorId': me,
                  'observation': {
                    'receivedAt':
                        (state == 'offline'
                                ? ago(const Duration(minutes: 3))
                                : now)
                            .millisecondsSinceEpoch,
                  },
                },
              ],
            ),
            'members': [part(me, 1, person(me))],
          };
          fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
              changes(cursor: 'c2');
          fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
            'decisions': <Object>[],
          };
          fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
            'mentions': <Object>[],
          };
          fake.routes[messages] = (_) => {
            'messages': [
              {
                'id': 'm2',
                'conversationId': 'g1',
                'text': 'Can you check the build on the release branch?',
                'sequence': 2,
                'author': {'kind': 'person', 'id': me, 'name': 'tony'},
                'deliveries': [
                  {
                    'id': 'd1',
                    'agentId': 'agent-lead',
                    'status': 'queued',
                    if (state == 'failing')
                      'claimFailingSince': ago(const Duration(minutes: 2))
                          .toUtc()
                          .toIso8601String(),
                  },
                ],
                'createdAt': ago(const Duration(minutes: 3))
                    .toUtc()
                    .toIso8601String(),
              },
              {
                'id': 'm1',
                'conversationId': 'g1',
                'text': 'The pilot build is ready to try.',
                'sequence': 1,
                'author': {
                  'kind': 'agent',
                  'id': 'agent-lead',
                  'name': 'River',
                },
                'createdAt': ago(const Duration(minutes: 20))
                    .toUtc()
                    .toIso8601String(),
              },
            ],
            'next': null,
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
                builder: (_, child) =>
                    SwarmScope(notifier: host, child: child!),
                home: const SwarmConversationPage(
                  swarmId: tab,
                  conversationId: 'g1',
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          await host.session!.inbox.reader(tab)!.refresh();
          await tester.pumpAndSettle();
          expect(
            find.text(
              state == 'offline'
                  ? "River's computer is offline"
                  : 'Not delivered yet',
            ),
            findsOneWidget,
          );
          expect(tester.takeException(), isNull);
          await tester.runAsync(() async {
            final image =
                await (boundary.currentContext!.findRenderObject()!
                        as RenderRepaintBoundary)
                    .toImage(pixelRatio: 3);
            final png = await image.toByteData(format: ui.ImageByteFormat.png);
            await Directory(shots!).create(recursive: true);
            await File(
              '$shots/phone-receipt-$state-${brightness.name}-${width.toInt()}.png',
            ).writeAsBytes(png!.buffer.asUint8List());
            image.dispose();
          });
          await tester.pumpWidget(const SizedBox());
          host.dispose();
          await tester.pump(const Duration(minutes: 1));
        }
      }
    }
  }, skip: shots == null);
}

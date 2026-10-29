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
import 'package:harness_mobile/swarm/swarm_leaderboard.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'leaderboard_fixture.dart';
import 'swarm_fixture.dart';

/// Set to a folder to write the phone leaderboard's screenshot there, light
/// and dark, over a scripted backend: never a real Swarm.
final shots = Platform.environment['SWARM_LEADERBOARD_SHOTS'];

void main() {
  const path = '/api/super-tabs/$tab/leaderboard?projectId=$project';
  final now = DateTime.utc(2026, 10, 28, 2);
  final monday = DateTime.utc(2026, 10, 26).millisecondsSinceEpoch;

  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    // The title's terminal face, and the crown: the test engine reaches no
    // system font, so each is loaded under a name the app already asks for
    // (the mono face, and the last of the sans fallbacks for the emoji).
    final mono = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
    );
    await (FontLoader(
      '.AppleSystemUIFontMonospaced',
    )..addFont(Future.value(mono))).load();
    final emoji = ByteData.sublistView(
      await File('/System/Library/Fonts/Apple Color Emoji.ttc').readAsBytes(),
    );
    await (FontLoader('Arial')..addFont(Future.value(emoji))).load();
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

  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        machines: [
          {
            'machineId': 'mac-1',
            'name': 'Mac Studio.local',
            'contributorId': me,
          },
        ],
      ),
      'members': [
        part(me, 1, person(me)),
        part('diego', 1, person('diego', role: 'collaborator')),
        part('ken', 1, person('ken', role: 'collaborator')),
        part('tony', 1, person('tony', role: 'collaborator')),
        part('maximilian', 1, person('maximilian', role: 'collaborator')),
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes[path] = (_) =>
        leaderboardData(
            week: monday,
            people: [
              {
                ...scoreData(
                  'diego',
                  points: 28,
                  rank: 1,
                  shipped: 8,
                  unblocked: 1,
                  lentMs: 40 * 3600000,
                ),
                'displayName': 'Diego',
              },
              {
                ...scoreData(
                  'ken',
                  points: 21,
                  rank: 2,
                  shipped: 3,
                  unblocked: 4,
                ),
                'displayName': 'Ken',
              },
              {
                ...scoreData(me, points: 6, rank: 3, unblocked: 2),
                'displayName': 'Dee',
              },
              scoreData('tony', points: 2, rank: 4, shipped: 1),
              scoreData('maximilian', points: 0, rank: 5),
            ],
          )
          ..['agents'] = [
            agentScoreData(
              'agent-lead',
              displayName: 'River',
              points: 36,
              rank: 1,
              shipped: 12,
            ),
            agentScoreData(
              'buddy-ken',
              displayName: 'Aria',
              kind: 'buddy',
              personId: 'ken',
              points: 12,
              rank: 2,
              shipped: 4,
            ),
            agentScoreData(
              'buddy-old',
              displayName: 'Former Buddy',
              kind: 'buddy',
              points: 0,
              rank: 3,
            ),
          ]
          ..['byModel'] = [
            modelScoreData(
              'claude',
              model: 'claude-opus-5-5',
              effort: 'high',
              reviewed: 8,
              passed: 7,
            ),
            modelScoreData(
              'claude',
              model: 'claude-opus-5-5',
              effort: 'xhigh',
              reviewed: 4,
              passed: 4,
            ),
            modelScoreData(
              'codex',
              model: 'gpt-5.6-sol',
              effort: 'xhigh',
              reviewed: 16,
              passed: 13,
            ),
            modelScoreData(
              'claude',
              model: 'claude-sonnet-5-5',
              reviewed: 10,
              passed: 7,
            ),
            // Nothing reviewed this week: not listed.
            modelScoreData(
              'codex',
              model: 'gpt-5.5',
              effort: 'medium',
              reviews: 5,
            ),
          ];
    return fake;
  }

  testWidgets('screenshots for review', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    // A palette carries its brightness: the shell's default dark one, and
    // the neutral light one.
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: backend().request,
        notices: SilentSystemNotices(),
        features: features,
      )..foreground = false;
      await host.session!.inbox.refresh();
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (context, child) =>
                SwarmScope(notifier: host, child: child!),
            home: SwarmLeaderboardPage(
              swarmId: tab,
              projectId: project,
              now: () => now,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/phone-leaderboard-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
      });
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

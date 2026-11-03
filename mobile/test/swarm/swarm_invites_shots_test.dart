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
import 'package:harness_mobile/swarm/swarm_leaderboard_reader.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Set to a folder to write the phone's Share Swarm screenshots there, light
/// and dark, over a scripted backend: never a real Swarm.
final shots = Platform.environment['SWARM_INVITES_SHOTS'];

void main() {
  final now = DateTime.now().toUtc();
  final day = const Duration(days: 1).inMilliseconds;

  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    // Every name the app's text asks for: the reading face and its
    // fallbacks, and the terminal's, which the top bar's title is set in. A
    // name left out draws as solid blocks.
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
        head: {
          ...headData(),
          'invitations': [
            {
              'id': 'i1',
              'email': 'ana@acme.com',
              'role': 'viewer',
              'conversationId': leadChat,
              'expiresAt': now.millisecondsSinceEpoch + 6 * day + 3600000,
            },
            {
              'id': 'i2',
              'email': 'bo@acme.com',
              'role': 'collaborator',
              'conversationId': leadChat,
              'expiresAt': now.millisecondsSinceEpoch - day,
            },
          ],
        },
      ),
      'members': [
        part(me, 1, person(me)),
        part('diego', 1, person('diego', role: 'collaborator')),
        part('ken', 1, person('ken', role: 'collaborator')),
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    final monday = swarmWeekOf(now);
    fake.routes['/api/super-tabs/$tab/leaderboard?projectId=$project'] = (_) =>
        leaderboardData(
          week: monday,
          people: [
            {
              ...scoreData('diego', points: 28, rank: 1, shipped: 8),
              'displayName': 'Diego',
            },
            {
              ...scoreData('ken', points: 21, rank: 2, shipped: 3),
              'displayName': 'Ken',
            },
            {
              ...scoreData(me, points: 6, rank: 3, unblocked: 2),
              'displayName': 'Dee',
            },
          ],
        );
    fake.routes['/api/super-tabs/$tab/sharing'] = (_) => {
      'revision': 1,
      'access': {'mode': 'link', 'role': 'viewer'},
      'joinUrl': 'harness://swarm/join/$tab?token=${'A' * 43}',
    };
    return fake;
  }

  testWidgets('screenshots for review', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
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
      await host.session!.inbox.reader(tab)!.refresh();
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (context, child) =>
                SwarmScope(notifier: host, child: child!),
            home: const SwarmLeaderboardPage(swarmId: tab, projectId: project),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> shoot(String name) => tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/phone-invites-$name-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
      });
      await shoot('leaderboard');
      await tester.tap(find.byKey(const ValueKey('swarm-invite-people')));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pumpAndSettle();
      await shoot('sheet');
      await tester.tap(find.byKey(const ValueKey('swarm-invite-revoke-i1')));
      await tester.pumpAndSettle();
      await shoot('revoke');
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      // What the reads left waiting runs out before the next palette.
      await tester.pump(const Duration(minutes: 1));
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

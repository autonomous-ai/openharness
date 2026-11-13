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
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of a guest's Home and Swarm switcher, where Dee's
/// Personal Swarm they were invited to shows as "Dee's Swarm" beside their
/// own Personal, in both phone themes at phone width, from made-up data only,
/// to `SWARM_PERSONAL_NAME_SHOTS`.
final shots = Platform.environment['SWARM_PERSONAL_NAME_SHOTS'];

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

  const dee = 'person-dee';
  const deeSwarm = 'swarm-dee';
  const mine = 'swarm-mine';

  /// The reader's own Personal Swarm, and Dee's they were invited to, each
  /// with one project.
  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {
          'id': mine,
          'name': 'Personal',
          'ownerId': me,
          'personal': true,
          'personalSwarm': true,
        },
        {
          'id': deeSwarm,
          'name': 'Personal',
          'ownerId': dee,
          'personalSwarm': true,
        },
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
    Map<String, dynamic> load(
      String id,
      String owner,
      String project,
      List<Map<String, dynamic>> people,
    ) => {
      ...firstLoad(
        tabId: id,
        // Each Swarm runs its owner's agents.
        agents: [
          {
            ...agent(
              'agent-lead',
              name: 'Lead',
              displayName: owner == me ? 'River' : 'Ada',
            ),
            'contributorId': owner,
          },
        ],
        head: headData(
          id: id,
          name: 'Personal',
          ownerId: owner,
          projects: [
            {
              ...(headData()['projects'] as List).single
                  as Map<String, dynamic>,
              'name': project,
              'ownerId': owner,
            },
          ],
        ),
      ),
      'members': [for (final p in people) part(p['id'] as String, 1, p)],
    };
    fake.routes['/api/super-tabs/$mine/parts'] = (_) =>
        load(mine, me, 'Notes', [person(me)]);
    fake.routes['/api/super-tabs/$deeSwarm/parts'] = (_) =>
        load(deeSwarm, dee, 'Website', [
          {...person(dee), 'username': 'dee', 'name': 'Dee'},
          person(me, role: 'collaborator'),
        ]);
    for (final id in [mine, deeSwarm]) {
      fake.routes['/api/super-tabs/$id/changes'] = (_) => changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$id/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$id/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
    }
    return fake;
  }

  testWidgets("a guest's Home and switcher, in both themes", (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final shown = [
      for (final screen in ['home', 'switcher'])
        for (final palette in [HarnessPalette.graphite, HarnessPalette.paper])
          (screen, palette),
    ];
    for (final (screen, palette) in shown) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final fake = backend();
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      await tester.runAsync(() => host.session!.inbox.refresh());
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            // Half an hour after the fixture's parts last changed: no
            // project folds as quiet.
            home: SwarmPage(
              now: () => DateTime.fromMillisecondsSinceEpoch(
                0,
                isUtc: true,
              ).add(const Duration(minutes: 30)),
            ),
          ),
        ),
      );
      for (var i = 0; i < 5; i++) {
        await tester.runAsync(pumpEventQueue);
        await tester.pump(const Duration(milliseconds: 100));
      }
      if (screen == 'switcher') {
        await tester.tap(find.byKey(const ValueKey('swarm-title-button')));
        for (var i = 0; i < 5; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
      }
      expect(find.text("Dee's Swarm"), findsWidgets);
      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/personal-name-$screen-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
      host.dispose();
      account.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

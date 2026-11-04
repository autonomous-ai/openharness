import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
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

/// Review screenshots of Home's Sort by and Filter menu, at 390 wide in both
/// phone themes, with the app's own fonts, from made-up data only, to the
/// folder `SWARM_HOME_VIEW_SHOTS` names.
final shots = Platform.environment['SWARM_HOME_VIEW_SHOTS'];
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

  final now = DateTime.utc(2026, 11, 2, 9, 41);
  const web = 'project-web', webLead = 'lead-web';

  FakeSwarm backend() {
    const derived = {
      'readMarks': {leadChat: 2, 'g1': 1, webLead: 1},
    };
    final at = {
      leadChat: now.subtract(const Duration(hours: 3)).millisecondsSinceEpoch,
      'g1': now.subtract(const Duration(hours: 3)).millisecondsSinceEpoch,
      webLead: now.subtract(const Duration(hours: 1)).millisecondsSinceEpoch,
    };
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) {
      final read = firstLoad(
        derived: derived,
        head: headData(
          projects: [
            ...headData()['projects'] as List,
            {
              'id': web,
              'name': 'Web',
              'ownerId': me,
              'leadConversationId': webLead,
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
            },
          ],
        ),
        groups: [
          groupData('g1', title: 'Fix login', lastMessageSequence: 5),
          {
            ...groupData(webLead, title: 'Web', lastMessageSequence: 1),
            'projectId': web,
          },
        ],
      );
      return {
        ...read,
        'groups': [
          for (final part in read['groups'] as List)
            {...part as Map<String, dynamic>, 'changedAt': at[part['key']]},
        ],
      };
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/'] = (body) => {
      'sequence': body?['sequence'],
      'messages': <Object>[],
      'next': null,
    };
    return fake;
  }

  testWidgets('Home, its menu shut and open', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final boundary = GlobalKey();
      Future<void> capture(String name) => tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/home-view-$name-390-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: backend().request,
        notices: SilentSystemNotices(),
        features: features,
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            onGenerateRoute: (_) => CupertinoPageRoute<void>(
              builder: (_) => SwarmPage(now: () => now),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> tap(String key) async {
        await tester.tap(find.byKey(ValueKey(key)));
        await tester.pumpAndSettle();
      }

      await tap('swarm-title-button');
      await capture('switcher');
      await tap('swarm-switch-view');
      await capture('menu');
      await tap('swarm-view-sort');
      await tap('swarm-view-unreads-true');
      await capture('sort-open');
      await tap('swarm-view-sort');
      await tap('swarm-view-filter');
      await tap('swarm-view-filter-unread');
      await capture('filter-open');
      await tester.tapAt(const Offset(195, 60));
      await tester.pumpAndSettle();
      await capture('home-dot');

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 30));
      host.dispose();
    }
    await tester.binding.setSurfaceSize(null);
    tester.view.resetPadding();
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

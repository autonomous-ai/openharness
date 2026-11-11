import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import '../swarm/swarm_fixture.dart';

/// Renders a phone Swarm project — its channel under its #name — in light and
/// dark, at iPhone 14 size in the system fonts, to PNGs a reviewer can look at
/// without a phone. Made up data only.
///
/// Skipped unless PHONE_RENDER_DIR names a directory to write into:
///
///     PHONE_RENDER_DIR=/tmp/renders flutter test test/render/swarm_project_render_test.dart
///
/// macOS only: it loads SF Pro and SF Mono from /System/Library/Fonts.
final _outDir = Platform.environment['PHONE_RENDER_DIR'];

Future<void> _loadFonts() async {
  Future<void> load(String family, String file) async {
    final bytes = await File('/System/Library/Fonts/$file').readAsBytes();
    await (FontLoader(
      family,
    )..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
  }

  for (final family in ['.AppleSystemUIFont', 'SF Pro Text', 'Roboto']) {
    await load(family, 'SFNS.ttf');
  }
  for (final family in ['.AppleSystemUIFontMonospaced', 'SF Mono']) {
    await load(family, 'SFNSMono.ttf');
  }
  // The icons, from the package in the pub cache.
  final lucide =
      '${Platform.environment['HOME']}/.pub-cache/hosted/pub.dev/lucide_icons_flutter-3.1.19/assets';
  Future<void> icons(String family, String file) async {
    final bytes = await File('$lucide/$file').readAsBytes();
    await (FontLoader(
      family,
    )..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
  }

  await icons('packages/lucide_icons_flutter/Lucide', 'lucide.ttf');
  for (final weight in [100, 200, 300, 400, 500, 600]) {
    await icons(
      'packages/lucide_icons_flutter/Lucide$weight',
      'build_font/LucideVariable-w$weight.ttf',
    );
  }
}

void main() {
  final skip = _outDir == null;

  /// A project of four agents: its Product Manager idle, two at work, one
  /// down.
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
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          agent('agent-builder', displayName: 'Nova'),
          agent('agent-reviewer', name: 'Reviewer', displayName: 'Ken'),
          {
            ...agent('agent-tester', name: 'Tester', displayName: 'Pike'),
            'downSince': '2026-10-28T03:00:00.000Z',
          },
        ],
        groups: [
          groupData(
            'g1',
            title: 'Fix login',
            number: 4,
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'working',
            workerId: 'agent-builder',
            lastMessageSequence: 12,
          ),
          groupData(
            'g2',
            title: 'Skeleton rows on Home',
            number: 5,
            agentIds: ['agent-lead', 'agent-reviewer'],
            status: 'review',
            workerId: 'agent-reviewer',
            lastMessageSequence: 9,
          ),
          groupData(
            'g3',
            title: 'Lazy project list',
            number: 6,
            agentIds: ['agent-lead', 'agent-tester'],
            status: 'working',
            workerId: 'agent-tester',
            lastMessageSequence: 7,
          ),
          groupData(
            'g4',
            title: 'Quiet hours setting',
            number: 3,
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'done',
            workerId: 'agent-builder',
            lastMessageSequence: 15,
          ),
          groupData(
            'g5',
            title: 'Empty state copy',
            number: 2,
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'done',
            workerId: 'agent-builder',
            lastMessageSequence: 14,
          ),
        ],
      ),
      'members': [part(me, 1, person(me))],
    };
    // Fix login moved two minutes ago; two tasks finished today, their
    // agents' last progress then.
    final load = fake.routes['/api/super-tabs/$tab/parts']!;
    fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
      final answer = await load(body) as Map<String, dynamic>;
      final now = DateTime.now();
      int ago(int minutes) =>
          now.subtract(Duration(minutes: minutes)).millisecondsSinceEpoch;
      final at = {'g1': ago(2), 'g4': ago(40), 'g5': ago(95)};
      Map<String, dynamic> moved(Map<String, dynamic> row) {
        final data = row['data'] as Map<String, dynamic>;
        final done = (data['assignment'] as Map?)?['status'] == 'done';
        return {
          ...row,
          'changedAt': ?at[row['key']],
          if (done)
            'data': {
              ...data,
              'assignment': {
                ...data['assignment'] as Map<String, dynamic>,
                'progressAt': at[row['key']],
              },
            },
        };
      }

      return {
        ...answer,
        'groups': [
          for (final row in answer['groups'] as List)
            moved(row as Map<String, dynamic>),
        ],
      };
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    Map<String, dynamic> message(
      int sequence,
      String text,
      Map<String, dynamic> author,
    ) => {
      'id': 'm$sequence',
      'conversationId': leadChat,
      'text': text,
      'sequence': sequence,
      'author': author,
      'reactions': <Object>[],
      'createdAt': DateTime.utc(2026, 10, 28, 4, sequence).toIso8601String(),
    };
    const river = {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'};
    fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
        (_) => {
          'messages': [
            message(
              3,
              'Nova is on Fix login, Ken reviews the skeleton rows. Pike is '
              'down; I will hand Lazy project list on if it stays down.',
              river,
            ),
            message(2, 'Where are we on the login crash?', {
              'kind': 'person',
              'id': me,
              'name': 'tony',
            }),
            message(1, 'Morning. Three things open in Mobile today.', river),
          ],
          'next': null,
        };
    return fake;
  }

  Future<void> shoot(WidgetTester tester, GlobalKey key, String name) async {
    await tester.runAsync(() async {
      final boundary =
          key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 3);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      final file = File('$_outDir/$name.png');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(png!.buffer.asUint8List());
    });
  }

  for (final brightness in Brightness.values) {
    final look = brightness.name;

    Future<GlobalKey> page(WidgetTester tester) async {
      await tester.runAsync(_loadFonts);
      // A palette carries its brightness: a light one is how the app goes light.
      final palette = HarnessPalette.values.firstWhere(
        (p) => p.brightness == brightness,
      );
      final previous = (
        grid.AppTheme.brightness.value,
        grid.AppTheme.palette.value,
      );
      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() {
        grid.AppTheme.brightness.value = previous.$1;
        grid.AppTheme.palette.value = previous.$2;
      });
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
      tester.view.viewPadding = const FakeViewPadding(
        top: 47 * 3,
        bottom: 34 * 3,
      );
      addTearDown(tester.view.reset);

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
      addTearDown(host.dispose);
      final key = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: grid.BrightnessScope(
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (context, child) =>
                  SwarmScope(notifier: host, child: child!),
              home: const SwarmProjectPage(swarmId: tab, projectId: project),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return key;
    }

    testWidgets('project chat ($look)', skip: skip, (tester) async {
      final key = await page(tester);
      await shoot(tester, key, 'swarm-project-chat-$look');
    });
  }
}

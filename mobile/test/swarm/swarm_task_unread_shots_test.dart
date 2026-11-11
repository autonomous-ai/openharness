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
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of a task's chat with the New messages line, and with
/// Jump to first unread when a notice opened it further down. 390 points
/// wide in both phone themes, from made-up data only, to the folder
/// `SWARM_TASK_UNREAD_SHOTS` names.
final shots = Platform.environment['SWARM_TASK_UNREAD_SHOTS'];

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

  const task = 'task-1';
  const lines = [
    'Pushed the plan for the login retry fix to the draft PR.',
    'The failing test is in: the timer restarts on every rebuild.',
    'Fix is in. The timer now starts once per code request.',
    'CI is green on the head. Asking for review next.',
  ];

  Map<String, dynamic> said(int sequence) => {
    'id': '$task-$sequence',
    'conversationId': task,
    'text': lines[sequence % lines.length],
    'sequence': sequence,
    'author': {'kind': 'agent', 'id': 'agent-dev', 'name': 'Dev'},
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 11, 2, 9, sequence).toIso8601String(),
  };

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
        groups: [
          groupData(
            task,
            title: 'Fix the login retry timer',
            number: 12,
            agentIds: ['agent-dev'],
            status: 'working',
            workerId: 'agent-dev',
            lastMessageSequence: 40,
          ),
        ],
        agents: [agent('agent-dev', displayName: 'Plover')],
        derived: {
          'readMarks': {task: 30},
        },
      ),
      'members': [part(me, 1, person(me))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/$task/messages'] = (_) => {
      'messages': [for (var i = 40; i >= 1; i--) said(i)],
      'next': null,
    };
    return fake;
  }

  testWidgets("a task's chat: the New messages line, and Jump to first "
      'unread', (tester) async {
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
        await Directory(shots!).create(recursive: true);
        await File('$shots/task-unread-$name-390-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });

      /// The task's chat opened, from a notice at [messageId] when given.
      Future<SwarmHost> open([String? messageId]) async {
        final host = SwarmHost(
          accountId: () => me,
          account: ValueNotifier<String?>(me),
          request: backend().request,
          notices: SilentSystemNotices(),
          features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
            ..value = {PhoneExperiment.swarm},
          readMarks: MemoryKeyValueStore(),
        )..foreground = false;
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildAppTheme(brightness: brightness),
              builder: (_, child) => SwarmScope(notifier: host, child: child!),
              home: SwarmConversationPage(
                swarmId: tab,
                conversationId: task,
                messageId: messageId,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        return host;
      }

      Future<void> close(SwarmHost host) async {
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 30));
        host.dispose();
      }

      final line = find.byKey(const ValueKey('swarm-new-messages-line'));
      final pill = find.byKey(const ValueKey('swarm-jump-unread'));

      // Opened as it is: at the line, above the first message not read.
      var host = await open();
      expect(line, findsOneWidget);
      expect(tester.takeException(), isNull);
      await capture('line');
      await close(host);

      // Opened by a notice near the foot: the line is above, not seen yet.
      host = await open('$task-39');
      expect(pill, findsOneWidget);
      expect(tester.takeException(), isNull);
      await capture('jump');
      await close(host);
    }
    await tester.binding.setSurfaceSize(null);
    tester.view.resetPadding();
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}

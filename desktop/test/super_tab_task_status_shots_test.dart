import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';
import 'package:harness/terminal/terminal_typography.dart';

import 'support/capture.dart';
import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's pictures of the task status lines there.
final shots = Platform.environment['SUPER_TAB_TASK_SHOTS'];

/// The four rows of the mockup Ken approved (#957), in both appearances.
void main() {
  setUpAll(() async {
    await loadCaptureFonts(shots);
    if (shots == null || !Platform.isMacOS) return;
    // The marks are drawn in the status bar's monospace, with the OS symbol
    // font for the spinner's Braille, as on a Mac.
    Future<void> face(String family, String path) async {
      final bytes = ByteData.sublistView(await File(path).readAsBytes());
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }

    for (final family in {terminalFontFamily, ...terminalFontFallback}) {
      await face(family, '/System/Library/Fonts/SFNSMono.ttf');
    }
    await face('Apple Symbols', '/System/Library/Fonts/Apple Symbols.ttf');
  });
  // The real clock: the rows are drawn again as the picture is taken.
  final now = DateTime.now().toUtc();
  int ago(int minutes) =>
      now.subtract(Duration(minutes: minutes)).millisecondsSinceEpoch;

  for (final brightness in Brightness.values) {
    testWidgets('task status lines in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(2400, 1200);
      addTearDown(tester.view.reset);
      final server = humansSwarm();
      Map<String, dynamic> task(
        String id,
        int number,
        String title,
        Map<String, dynamic>? assignment, {
        Map<String, dynamic>? liveness,
        Map<String, dynamic>? leadAction,
      }) => {
        ...conversationFixture(id, title),
        'number': number,
        'assignment': assignment,
        'liveness': ?liveness,
        'leadAction': ?leadAction,
      };
      Map<String, dynamic> work(String status, {String? result, int? at}) => {
        'id': 'a-$status',
        'agentId': 'w',
        'status': status,
        'result': result,
        'progressAt': ?at,
      };
      (server.state['conversations'] as List)
        ..removeWhere((g) => (g as Map)['id'] == 'offline')
        ..addAll(<Map<String, dynamic>>[
          task('ws', 931, 'WS Phase 1a', work('working', at: ago(4))),
          task(
            'buddies',
            937,
            'Buddies leave Agents list',
            work('needs_human', result: 'mockup OK?'),
            liveness: {
              'state': 'waiting',
              'why': 'person',
              'since': ago(12),
              'personId': 'owner',
            },
          ),
          task(
            'codex',
            294,
            'Codex update screen',
            null,
            liveness: {'state': 'waiting', 'why': 'queued', 'since': ago(25)},
            leadAction: {'kind': 'route', 'at': ago(2)},
          ),
          task(
            'security',
            919,
            'Security review 2',
            work('working', at: ago(34)),
            liveness: {'state': 'quiet', 'why': 'silent', 'since': ago(34)},
            leadAction: {'kind': 'assign', 'at': ago(1)},
          ),
        ]);
      final c = server.controller(
        account: 'peer',
        initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
      );
      await c.refresh();
      c.expandedProjects.add('lead');
      final picture = GlobalKey();
      await withClock(
        Clock.fixed(now),
        () => tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: RepaintBoundary(
              key: picture,
              child: Scaffold(
                body: SuperTabView(
                  controller: c,
                  onInvite: () {},
                  onAddAgent: (_) {},
                  onOpenTerminal: (_) {},
                  machineName: (_) => 'Studio',
                ),
              ),
            ),
          ),
        ),
      );
      // The working mark spins, so the page never settles.
      await tester.pump(const Duration(milliseconds: 100));
      await captureBoundary(
        tester,
        picture.currentContext!.findRenderObject()! as RenderRepaintBoundary,
        shots,
        'task-status-${brightness.name}',
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }
}

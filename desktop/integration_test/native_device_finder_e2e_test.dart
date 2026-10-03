import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:xterm/xterm.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';

import '../test/device_finder_test.dart' show FinderRemote;
import '../test/swarm_state_test.dart' show createApp;
import '../test/swarm_screen_test.dart' show terminal;

void main() {
  if (!kUnderTest) throw StateError('Finder fixture requires FLUTTER_TEST=1');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native spoken Finder opens exact panes and retains reading position',
    (t) async {
      final app = createApp(connected: true), input = <TerminalBinaryFrame>[];
      final a = terminal('a0', input), b = terminal('a69', input);
      a.terminal.write(
        List.generate(160, (i) => '  Original reading line $i\r\n').join(),
      );
      b.terminal.write('  Different work, found by name.\r\n');
      final origin = app.adoptSessionForTest(a), originTab = app.activeSwarmId;
      app.renameSwarm(originTab, 'Reading');
      app.newSwarm(name: 'Other work');
      final target = app.adoptSessionForTest(b), targetTab = app.activeSwarmId;
      app.selectSwarm(originTab);
      final directory = Directory('/private/tmp/habitat16-native')
        ..createSync(recursive: true);
      final boundary = GlobalKey();
      Future<void> capture(String name) async {
        final render =
            boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final bitmap = await render.toImage(pixelRatio: 1);
        final png = await bitmap.toByteData(format: ui.ImageByteFormat.png);
        await File('${directory.path}/$name.png')
            .writeAsBytes(png!.buffer.asUint8List());
        bitmap.dispose();
      }

      try {
        await t.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: Brightness.dark),
              home: SwarmScreen(
                notifier: app,
                nativeTabs: false,
                projectStore: SwarmProjectStore(),
              ),
            ),
          ),
        );
        await t.pump(const Duration(milliseconds: 200));
        final finder = find.byWidgetPredicate(
          (w) => w is TerminalView && w.terminal == a.terminal,
        );
        final renderer = t.state(finder), view = t.widget<TerminalView>(finder);
        view.scrollController!.jumpTo(240);
        await t.pump();
        final before = view.scrollController!.offset;
        final width = a.terminal.viewWidth, height = a.terminal.viewHeight;
        final r = FinderRemote(t, app);
        await r.send('open');
        expect(view.scrollController!.offset, closeTo(before, .01));
        await capture('find');
        await r.say('Agent 69.');
        expect(view.scrollController!.offset, closeTo(before, .01));
        await capture('named');
        expect(app.focusedPane, same(origin));
        expect(a.terminal.viewWidth, width);
        expect(a.terminal.viewHeight, height);
        final stale = r.state['revision'] as int;
        await r.send('activate');
        await r.send('state');
        expect(r.state['active'], isFalse);
        expect(app.activeSwarmId, targetTab);
        expect(app.focusedPane, same(target));
        expect(app.paneFocusByUser, isFalse);
        await capture('opened');
        await r.send('activate', revision: stale);
        expect(app.allPanes, hasLength(2));
        r.id = 'find-return';
        await r.send('open');
        await r.say('Agent 0.');
        await r.send('activate');
        await r.send('state');
        expect(app.focusedPane, same(origin));
        expect(t.state(finder), same(renderer));
        expect(view.scrollController!.offset, closeTo(before, .01));
        expect(input, isEmpty);
        expect(app.allPanes, hasLength(2));
        await capture('returned');
        await File('${directory.path}/result.json').writeAsString(
          jsonEncode({
            'fixture': 'native macOS production search and pane activation, synthetic terminals and transcripts',
            'voice_only_filters': true,
            'duplicate_views_created': 0,
            'terminal_input_frames': input.length,
            'search_resized_terminal': false,
            'reading_offset_before': before,
            'reading_offset_after': view.scrollController!.offset,
            'same_original_renderer': true,
            'passed': true,
          }),
        );
      } finally {
        await t.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );
}

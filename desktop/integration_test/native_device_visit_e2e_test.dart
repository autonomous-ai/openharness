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

import '../test/swarm_state_test.dart' show createApp;
import '../test/swarm_screen_test.dart' show terminal;

/// Native renderer and actual navigation, with synthetic terminals only.
void main() {
  if (!kUnderTest) throw StateError('Device fixtures require FLUTTER_TEST=1');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('attention detour returns to the same native reading surface', (
    tester,
  ) async {
    final app = createApp(connected: true);
    final input = <TerminalBinaryFrame>[];
    final a = terminal('a0', input), b = terminal('a1', input);
    a.terminal.write(
      List.generate(
        180,
        (i) =>
            '  Reading line $i: keep this place while inspecting another agent.\r\n',
      ).join(),
    );
    b.terminal.write(
      '  Review requested\r\n\r\n  The implementation is ready.\r\n  Inspect it, then return to your work.\r\n',
    );
    final origin = app.adoptSessionForTest(a);
    final tab = app.activeSwarmId;
    app.renameSwarm(tab, 'Reading');
    app.newSwarm(name: 'Needs you');
    app.adoptSessionForTest(b);
    app.selectSwarm(tab);
    final boundary = GlobalKey();
    final directory = Directory('/private/tmp/habitat13-native')
      ..createSync(recursive: true);
    Future<void> capture(String name) async {
      await tester.pump();
      final render =
          boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final bitmap = await render.toImage(pixelRatio: 1);
      final png = await bitmap.toByteData(format: ui.ImageByteFormat.png);
      await File('${directory.path}/$name.png')
          .writeAsBytes(png!.buffer.asUint8List());
      bitmap.dispose();
    }

    try {
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: RepaintBoundary(
            key: boundary,
            child: SwarmScreen(
              notifier: app,
              nativeTabs: false,
              projectStore: SwarmProjectStore(),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 150));
      final finder = find.byWidgetPredicate(
        (w) => w is TerminalView && w.terminal == a.terminal,
      );
      final renderer = tester.state(finder);
      final view = tester.widget<TerminalView>(finder);
      view.scrollController!.jumpTo(360);
      await capture('before');
      final before = view.scrollController!.offset;
      Map<String, dynamic> command(String op) => {
        'op': op,
        'requestId': 'native-$op',
        'visitId': 'native-visit',
        'expiresAt': DateTime.now().millisecondsSinceEpoch + 2000,
        'fromMachineId': 'm',
        'fromAgentId': 'a0',
        'machineId': 'm',
        'agentId': 'a1',
      };
      expect(app.visitFromDevice('m', command('open'))!['ok'], isTrue);
      await capture('visiting');
      a.terminal.write('  New output arrived while you were away.\r\n');
      expect(app.visitFromDevice('m', command('back'))!['ok'], isTrue);
      await tester.pump();
      await capture('returned');
      expect(app.focusedPane, same(origin));
      expect(tester.state(finder), same(renderer));
      expect(view.scrollController!.offset, closeTo(before, .01));
      expect(input, isEmpty);
      await File('${directory.path}/result.json').writeAsString(
        jsonEncode({
          'fixture': 'synthetic terminals in native macOS renderer',
          'reading_offset_before': before,
          'reading_offset_after': view.scrollController!.offset,
          'same_renderer': identical(tester.state(finder), renderer),
          'terminal_input_frames': input.length,
          'passed': true,
        }),
      );
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });
}

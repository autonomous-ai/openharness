import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:xterm/xterm.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';

/// Real renderer, synthetic terminal. No daemon connection or agent input.
void main() {
  if (!kUnderTest) {
    throw StateError('Native device fixtures require FLUTTER_TEST=1');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'spoken search finds and selects native terminal output without typing',
    (tester) async {
      final notifier = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      final controls = <String>[];
      final inputs = <TerminalBinaryFrame>[];
      final session =
          TerminalSession(
              machineId: 'fixture-machine',
              agentId: 'fixture-agent',
              agentName: 'Find and speak',
              engineId: 'codex',
              send: (type, _) async {
                controls.add(type);
                return true;
              },
              sendBinary: (frame) async {
                inputs.add(frame);
                return true;
              },
            )
            ..status = TerminalSessionStatus.controlling
            ..streamId = '00112233-4455-6677-8899-aabbccddeeff';
      addTearDown(notifier.dispose);
      addTearDown(session.dispose);
      final capture = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: RepaintBoundary(
            key: capture,
            child: Scaffold(
              body: TerminalPanel(
                notifier: notifier,
                session: session,
                focused: true,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      session.terminal.write(
        List.generate(
          60,
          (i) => switch (i % 6) {
            0 => '  diff --git a/voice.ts b/voice.ts',
            1 => '  + keep the selected terminal passage with this recording',
            2 => '  + discard cancels pending delivery',
            3 => '  + the original pane stays the recipient',
            4 => '  Tests passed. Ready to review.',
            _ => '  passage $i / use the device to choose a line',
          },
        ).join('\r\n'),
      );
      await tester.pump();
      final terminal = session.terminal;
      final size = (terminal.viewWidth, terminal.viewHeight);
      controls.clear();
      var revision = 0;
      Map<String, dynamic> select(
        String op, [
        Map<String, dynamic> extra = const {},
      ]) => session.selectPassage({
        'selectionId': 'native-fixture',
        'revision': ++revision,
        'op': op,
        ...extra,
      });
      expect(select('begin')['ok'], isTrue);
      Future<Map<String, dynamic>> search(
        String op,
        Map<String, dynamic> extra,
      ) => session.searchPassage({
        'selectionId': 'native-fixture',
        'revision': ++revision,
        'op': op,
        ...extra,
      });
      final lookup = search('search', {'query': 'discard cancels'});
      await tester.pumpAndSettle();
      final found = await lookup;
      expect(found['ok'], isTrue);
      expect(found['matches'], 10);
      final next = search('match', {'delta': 1});
      await tester.pumpAndSettle();
      final moved = await next;
      expect(moved['ok'], isTrue);
      expect(moved['match'], isNot(found['match']));
      final view = tester.widget<TerminalView>(find.byType(TerminalView));
      expect(view.controller!.highlights, isNotEmpty);
      expect(find.textContaining('Find "discard cancels"'), findsOneWidget);
      final selected = select('pin');
      expect(selected['ok'], isTrue);
      expect(selected['text'], contains('discard cancels pending delivery'));
      await tester.pump();
      expect(identical(session.terminal, terminal), isTrue);
      expect((terminal.viewWidth, terminal.viewHeight), size);
      expect(inputs.where((f) => f.kind == TerminalBinaryKind.input), isEmpty);
      expect(
        controls.where((t) => t == 'terminal_resize' || t == 'terminal_scroll'),
        isEmpty,
      );
      final boundary =
          capture.currentContext!.findRenderObject() as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 1);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      final output = Directory('/private/tmp/habitat21-native');
      await output.create(recursive: true);
      await File('${output.path}/output-search.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
      await File('${output.path}/result.json').writeAsString(
        jsonEncode({
          'native_renderer': true,
          'synthetic_terminal': true,
          'selected_rows': selected['rows'],
          'query': found['query'],
          'matches': found['matches'],
          'match_step_changed_selection': true,
          'terminal_recreated': false,
          'terminal_resized': false,
          'agent_input_frames': 0,
          'physical_touch_or_voice_test': false,
        }),
      );
      select('cancel');
      await tester.pump();
      expect(view.controller!.highlights, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}

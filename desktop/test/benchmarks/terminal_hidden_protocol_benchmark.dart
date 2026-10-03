// Diagnostic workload: protocol decoding, hidden terminal parsing, and any
// resulting Flutter work. This is headless Debug, not whole-app energy.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:xterm/xterm.dart';

import '../support/cpu_profile.dart';
import '../swarm_screen_test.dart' show mount;
import '../swarm_state_test.dart' show createApp;
import 'swarm_benchmark.dart' show distribution;

void main() {
  for (final count in [16, 48]) {
    testWidgets('$count hidden terminals receiving protocol output', (
      tester,
    ) async {
      final app = createApp();
      final sessions = <TerminalSession>[];
      final sequences = <int>[];
      var inputCount = 0;
      for (var i = 0; i < count; i++) {
        if (i > 0 && i % 4 == 0) app.newSwarm();
        final session =
            TerminalSession(
                machineId: 'm',
                agentId: 'a$i',
                agentName: 'Session $i',
                engineId: 'codex',
                send: (_, _) async => true,
                sendBinary: (_) async {
                  inputCount++;
                  return true;
                },
              )
              ..streamId =
                  '00000000-0000-4000-8000-${(i + 1).toString().padLeft(12, '0')}';
        await session.handleBinary(
          TerminalBinaryFrame(
            kind: TerminalBinaryKind.keyframe,
            streamId: session.streamId!,
            seq: 0,
            bytes: utf8.encode(
              List.generate(1000, (line) => 'History line $line\r\n').join(),
            ),
            compressed: false,
            cols: 120,
            rows: 30,
          ),
        );
        sessions.add(session);
        sequences.add(1);
        app.adoptSessionForTest(session);
      }
      await mount(tester, app);
      for (final tab in app.swarms.toList()) {
        app.selectSwarm(tab.id);
        await tester.pump();
      }
      app.newSwarm();
      await tester.pumpAndSettle();
      final views = tester
          .stateList<TerminalViewState>(
            find.byType(TerminalView, skipOffstage: false),
          )
          .toList();
      expect(views, hasLength(count));
      expect(find.byType(TerminalView), findsNothing);
      expect(app.panes, isEmpty);
      final output = utf8.encode(
        '\x1b7\x1b[H${List.generate(8, (row) => '\x1b[2K\x1b[32mAgent row $row: ${'x' * 80}\x1b[0m\r\n').join()}\x1b8',
      );
      Future<void> burst() async {
        for (var i = 0; i < count; i++) {
          final frame = TerminalBinaryFrame(
            kind: TerminalBinaryKind.output,
            streamId: sessions[i].streamId!,
            seq: sequences[i]++,
            bytes: output,
            compressed: false,
          );
          await app.handleTerminalBinaryForTest(
            'm',
            encodeTerminalLocal(frame)!,
          );
        }
      }

      for (var i = 0; i < 20; i++) {
        await burst();
        await tester.pump(const Duration(milliseconds: 50));
      }
      final profilePath = Platform.environment['HARNESS_HIDDEN_CPU_PROFILE'];
      final profile = profilePath == null
          ? null
          : await tester.runAsync(BenchmarkCpuProfile.start);
      if (profile != null) {
        addTearDown(() => tester.runAsync(profile.close));
      }
      final samples = <int>[];
      var scheduledByOutput = 0;
      for (var sample = 0; sample < 300; sample++) {
        final watch = Stopwatch()..start();
        await burst();
        if (tester.binding.hasScheduledFrame) scheduledByOutput++;
        await tester.pump(const Duration(milliseconds: 50));
        samples.add(watch.elapsedMicroseconds);
      }
      if (profile != null) {
        await tester.runAsync(() => profile.save('$profilePath-$count.json'));
      }
      final rebuilds = <String, int>{};
      debugOnRebuildDirtyWidget = (element, _) {
        final type = element.widget.runtimeType.toString();
        rebuilds.update(type, (value) => value + 1, ifAbsent: () => 1);
      };
      try {
        await burst();
        await tester.pump(const Duration(milliseconds: 50));
      } finally {
        debugOnRebuildDirtyWidget = null;
      }
      expect(inputCount, 0);
      expect(
        views.where((view) => view.renderTerminal.debugNeedsLayout),
        isEmpty,
      );
      expect(
        sessions.every((s) => s.status == TerminalSessionStatus.controlling),
        isTrue,
      );
      debugPrint(
        'HIDDEN_PROTOCOL_BENCH ${jsonEncode({'kind': 'headless_debug', 'hiddenTerminals': count, 'bytesPerBurst': output.length * count, 'samples': samples.length, 'simulatedBurstIntervalMs': 50, 'scheduledFrameBeforePump': scheduledByOutput, 'burstAndPump': distribution(samples), 'rebuildsOnSeparateBurst': rebuilds})}',
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }
}

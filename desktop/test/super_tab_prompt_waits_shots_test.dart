// Task #3029 (Gray, 11-05): the Decisions row of an agent at a prompt in the reader's task, for the PR's pictures,
// light and dark. Writes nothing unless PROMPT_SHOTS names a folder.
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/decisions_page.dart';

import 'super_tab_activity_lists_test.dart' show load, swarm;
import 'super_tab_prompt_waits_test.dart' show wrenAtPrompt;
import 'support/capture.dart';

final shots = Platform.environment['PROMPT_SHOTS'];
final _now = DateTime(2026, 11, 5, 10, 30);

void main() {
  setUpAll(() async {
    await loadCaptureFonts(shots);
    // The last lines are in the terminal's face: SF Mono, under its name here.
    if (shots == null || !Platform.isMacOS) return;
    final mono = File('/System/Library/Fonts/SFNSMono.ttf').readAsBytesSync();
    await (FontLoader(
      grid.AppType.monoFamily,
    )..addFont(Future.value(ByteData.sublistView(mono)))).load();
  });

  for (final brightness in Brightness.values) {
    testWidgets('the prompt row in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(1440, 900);
      addTearDown(tester.view.reset);
      await withClock(Clock.fixed(_now), () async {
        final server = swarm()..followedThreads = null;
        server.ask(['Ship the board firmware behind a flag?']);
        wrenAtPrompt(server);
        final activity = (await tester.runAsync(() => load(server)))!;
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: SuperTabDecisionsPage(
                activity: activity,
                onOpenConversation: (_) {},
                now: () => _now,
              ),
            ),
          ),
        );
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 80)),
        );
        await tester.pumpAndSettle();
        await captureWindow(tester, shots, 'prompt-row-${brightness.name}');
      });
    });
  }
}

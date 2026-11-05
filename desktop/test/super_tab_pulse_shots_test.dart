import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;

import 'super_tab_pulse_test.dart'
    show closePulse, pulseFixture, pulseServer, segment, showPulse;
import 'support/capture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_PULSE_SHOTS'];

/// The board's pulse as the PR shows it (task #3384): the strip on top of the
/// Board with the oldest ask over its limit and a hold without a reason, both
/// red, and the Held list open, in both appearances.
void main() {
  setUpAll(() async {
    await loadCaptureFonts(shots);
    if (shots != null && Platform.isMacOS) {
      for (final (family, path) in [
        ('.AppleSystemUIFontMonospaced', '/System/Library/Fonts/SFNSMono.ttf'),
        ('Apple Symbols', '/System/Library/Fonts/Apple Symbols.ttf'),
      ]) {
        final bytes = ByteData.sublistView(await File(path).readAsBytes());
        await (FontLoader(family)..addFont(Future.value(bytes))).load();
      }
    }
  });

  for (final brightness in Brightness.values) {
    for (final view in ['strip', 'held']) {
      testWidgets('screenshots for review ($view, ${brightness.name})', (
        tester,
      ) async {
        final before = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = before);
        final (c, _) = await showPulse(
          tester,
          pulseServer(
            pulseFixture(
              redAt: {
                'asks': DateTime(2026, 11, 4, 8, 59).millisecondsSinceEpoch,
                'held': DateTime(2026, 11, 4, 8, 50).millisecondsSinceEpoch,
              },
            ),
          ),
          brightness: brightness,
          size: const Size(1500, 640),
        );
        if (view == 'held') {
          await tester.tap(segment('held'));
          await tester.pumpAndSettle();
          expect(find.text('No reason'), findsOneWidget);
        }
        expect(tester.takeException(), isNull);
        await captureWindow(tester, shots, 'pulse-$view-${brightness.name}');
        await closePulse(tester, c);
      });
    }
  }
}

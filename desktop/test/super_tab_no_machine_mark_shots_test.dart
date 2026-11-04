import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'super_tab_leaderboard_shots_test.dart' show showHumans;
import 'support/capture.dart';
import 'support/super_tab_members.dart';

/// Set to a folder to write the People list's no-machine mark there, in light
/// and dark, and its hover (task #2699): the real right pane over the
/// in-memory Swarm, never a backend or the live app.
final shots = Platform.environment['SUPER_TAB_NO_MACHINE_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  testWidgets('screenshots for review', (tester) async {
    for (final (brightness, name) in [
      (Brightness.light, 'light'),
      (Brightness.dark, 'dark'),
    ]) {
      await showHumans(tester, brightness);
      await openSuperTabMembers(tester);
      await captureWindow(tester, shots, 'people-no-machine-$name');
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(
        tester.getCenter(
          find.byKey(const ValueKey('super-person-no-machine-tony')),
        ),
      );
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'people-no-machine-hover-$name');
      await mouse.removePointer();
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    }
  }, skip: shots == null);
}

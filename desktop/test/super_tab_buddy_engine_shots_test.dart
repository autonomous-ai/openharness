import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;

import 'support/buddy_engine_fixture.dart';
import 'support/capture.dart';

final shots = Platform.environment['SUPER_TAB_BUDDY_ENGINE_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));
  for (final brightness in Brightness.values) {
    for (final state in ['menu', 'limit-narrow', 'pending', 'large-narrow']) {
      testWidgets('Buddy engine $state in ${brightness.name}', (tester) async {
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        final c = await showBuddyEngine(
          tester,
          buddyEngineSwarm(
            limited: state != 'pending',
            switchRequest: state == 'pending'
                ? {
                    'id': 'request',
                    'engine': 'codex',
                    'profileId': 'default',
                    'requestedBy': 'peer',
                    'at': DateTime.now().toUtc().toIso8601String(),
                  }
                : null,
          ),
          brightness: brightness,
          narrow: state.endsWith('narrow'),
          textScale: state == 'large-narrow' ? 2 : 1,
        );
        expect(
          find.byKey(const ValueKey('super-buddy-engine')),
          findsOneWidget,
        );
        if (state == 'menu' || state == 'limit-narrow') {
          await tester.tap(
            state == 'menu'
                ? find.byKey(const ValueKey('super-buddy-engine'))
                : find.text('Switch engine'),
          );
          await tester.pumpAndSettle();
          expect(find.text('Codex'), findsOneWidget);
        }
        await captureWindow(
          tester,
          shots,
          'buddy-engine-$state-${brightness.name}',
        );
        await closeBuddyEngine(tester, c);
      }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
    }
  }
}

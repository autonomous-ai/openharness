import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/join_dialog.dart';
import 'package:harness/super_tabs/join_link.dart';

import 'support/capture.dart';

void main() {
  final shots = Platform.environment['HARNESS_V3_JOIN_SHOTS'];
  setUpAll(() => loadCaptureFonts(shots));

  // Audit finding 13 (#4442), in both themes for the pull request.
  for (final brightness in Brightness.values) {
    testWidgets('join dialog loading and dead link in ${brightness.name}', (
      tester,
    ) async {
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(720, 420));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      Future<void> show(String name, SuperTabRequest request) async {
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: Center(
                child: SizedBox(
                  width: 480,
                  child: SwarmJoinDialog(
                    key: ValueKey(name),
                    link: const SwarmJoinLink('tab', token: 'invite'),
                    accountEmail: 'leo@example.com',
                    isCurrent: () => true,
                    onJoined: (_, _) {},
                    request: request,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pump();
        await captureWindow(tester, shots, 'join-$name-${brightness.name}');
      }

      final loading = Completer<Map<String, dynamic>>();
      await show('loading', (_, _, {body}) => loading.future);
      expect(find.text('Join Swarm'), findsWidgets);
      expect(find.text('Retry'), findsNothing);
      await show(
        'dead-link',
        (_, _, {body}) async =>
            throw const SuperTabFailure('LINK_REVOKED', 'x', statusCode: 410),
      );
      expect(find.text('Close'), findsOneWidget);
      expect(find.text('Retry'), findsNothing);
      loading.complete({'id': 'tab', 'name': 'Pilot', 'role': 'viewer'});
      await tester.pumpWidget(const SizedBox());
    });
  }
}

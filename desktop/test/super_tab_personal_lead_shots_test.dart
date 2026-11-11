import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/personal_lead.dart';

import 'super_tab_receipt_test.dart' show ReceiptFixture;
import 'support/capture.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the PR's pictures of a Personal project's Lead
/// starting, and failing to, under the person's message (task #2633, for Huy).
final _shots = Platform.environment['PERSONAL_LEAD_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(_shots));

  for (final brightness in Brightness.values) {
    for (final failed in [false, true]) {
      final name =
          'personal-lead-${failed ? 'failed' : 'starting'}-${brightness.name}';
      testWidgets(name, (tester) async {
        if (_shots == null) return;
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        final app = createApp(connected: true);
        addTearDown(app.dispose);
        final f = ReceiptFixture(tester, status: null);
        await f.show(
          app: app,
          brightness: brightness,
          prepare: () {
            (f.server.state['conversations'] as List).first['leadId'] = null;
            f.message['text'] = 'Make the landing page dark by default.';
          },
        );
        PersonalLeadStarter.of(app).setStatusForTest(
          f.controller,
          'lead',
          failed
              ? const PersonalLeadStatus.failed(
                  'Claude Code and Codex aren’t signed in on Studio',
                )
              : PersonalLeadStatus.starting(clock.now()),
        );
        // A still mark: the spinner never settles.
        tester.platformDispatcher.accessibilityFeaturesTestValue =
            const FakeAccessibilityFeatures(disableAnimations: true);
        addTearDown(
          tester.platformDispatcher.clearAccessibilityFeaturesTestValue,
        );
        await tester.pump();
        await captureWindow(tester, _shots, name);
        await tester.pumpWidget(const SizedBox());
        await f.controller.flush();
        f.controller.dispose();
      });
    }
  }
}

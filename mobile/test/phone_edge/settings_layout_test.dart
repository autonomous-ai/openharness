import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/demo/sample_mode.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'edge_fixture.dart';

/// Settings laid out at every phone, scale and brightness — as the tab, as a page pushed from a
/// terminal's menu, and inside the sample — for an account with every name long. None may report
/// an overflow.
void main() {
  setUpAll(loadRealFontsIfAsked);

  Future<void> pumpSettings(
    WidgetTester tester,
    AppNotifier app,
    double scale,
    Brightness brightness, {
    bool large = true,
    bool sample = false,
  }) async {
    final page = SettingsPage(notifier: app, large: large);
    await tester.pumpWidget(
      phoneApp(
        sample ? SampleMode(session: FakeSample(app), child: page) : page,
        textScale: scale,
        brightness: brightness,
      ),
    );
    await frames(tester);
    // Every row, top to bottom: the list builds only what it shows.
    await tester.drag(find.byType(ListView), const Offset(0, -3000));
    await frames(tester);
  }

  for (final (label, name, email) in [
    (
      'long',
      longName,
      'ada.lovelace.the.first.programmer@analytical-engine.example.com',
    ),
    ('emoji', emojiName, '🦄@example.com'),
    ('right-to-left', rtlName, 'مستخدم@example.com'),
  ]) {
    testWidgets('signed in with a $label name, the tab', (tester) async {
      await expectNoLayoutErrors(tester, (scale, brightness) async {
        final app = edgeApp(machineName: longMachine);
        addTearDown(app.dispose);
        app.currentUser = CurrentUserProfile(id: 'u', name: name, email: email);
        await pumpSettings(tester, app, scale, brightness);
      });
    });
  }

  testWidgets('pushed from a terminal, with no machines', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(noMachines: true);
      addTearDown(app.dispose);
      await pumpSettings(tester, app, scale, brightness, large: false);
    });
  });

  testWidgets('inside the sample', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp();
      addTearDown(app.dispose);
      await pumpSettings(tester, app, scale, brightness, sample: true);
    });
  });
}

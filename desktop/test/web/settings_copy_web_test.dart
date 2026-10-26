@TestOn('browser')
library;

// A browser is not "this computer" (docs/naming-system.md). Audit finding P3.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/shared_tabs.dart';
import 'package:harness/agent_messages/update_harness.dart';
import 'package:harness/core/viewer_mode.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/sections/account_section.dart';
import 'package:harness/state/app_state.dart';

void main() {
  testWidgets('Settings ▸ Account: your Harness sign-in in this browser', (
    tester,
  ) async {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    )..signedIn = true;
    addTearDown(app.dispose);
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: AccountSection(notifier: app))),
    );
    expect(find.text('Your Harness sign-in in this browser.'), findsOneWidget);
    expect(find.textContaining('this computer'), findsNothing);
  });

  test('an unreachable computer is your computer, not this one', () {
    expect(
      unreachableComputer,
      'Harness could not reach your computer. Check that it is online, then try again.',
    );
  });

  test('Tab invites: a Harness too old is on your computer', () {
    expect(
      harnessTooOldLine('0.4.1', viewer: kViewerMode),
      startsWith('Your computer runs Harness 0.4.1;'),
    );
  });
}

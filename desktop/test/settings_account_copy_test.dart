// Settings ▸ Account names where the sign-in lives. On Desktop that is this
// computer, word for word as before; the browser's wording is pinned in
// test/web/settings_copy_web_test.dart.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/sections/account_section.dart';
import 'package:harness/state/app_state.dart';

void main() {
  testWidgets('Desktop: your Harness sign-in on this computer', (
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
    expect(find.text('Your Harness sign-in on this computer.'), findsOneWidget);
  });
}

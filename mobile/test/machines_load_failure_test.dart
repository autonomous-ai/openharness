import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/machines_tab.dart';
import 'package:harness_mobile/state/app_state.dart';

/// An account whose machines cannot be fetched — the relay down, the phone offline.
class _Unreachable extends AppNotifier {
  _Unreachable()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  int attempts = 0;

  @override
  Future<void> ensureCliDaemonReady() async {
    attempts++;
    throw StateError('The network connection was lost.');
  }
}

void main() {
  testWidgets('machines that could not load say so, and offer another go', (
    tester,
  ) async {
    final app = _Unreachable();
    addTearDown(app.dispose);
    await app.retryMachines();
    await tester.pumpWidget(MaterialApp(home: MachinesTab(notifier: app)));

    // Not "No machines yet": that tells somebody with three machines to go and
    // set one up.
    expect(find.text('No machines yet'), findsNothing);
    expect(find.text("Couldn't load your machines"), findsOneWidget);

    await tester.tap(find.text('Try again'));
    await tester.pump();

    expect(app.attempts, 2);
  });
}

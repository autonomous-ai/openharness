import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/phone_shell.dart';

import 'devices_fixture.dart';

/// The page stack is rebuilt from the shell while a page that counts on it is up: a page pushed
/// over the home screen may read the app in `build`, so an app update (an agent synced on any
/// machine, a turn starting) rebuilds it.
void main() {
  late DevicesApp app;

  setUp(() {
    app = DevicesApp()
      ..currentUser = const CurrentUserProfile(
        id: 'person-me',
        email: 'me@example.com',
      );
  });
  tearDown(() => app.dispose());

  /// Frames enough for a page to slide in, and for the shell to hear that the stack moved.
  Future<void> frames(WidgetTester tester) async {
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 150));
    }
  }

  /// Three app updates, each with a frame after it.
  Future<void> ticks(WidgetTester tester) async {
    for (var i = 0; i < 3; i++) {
      app.notifyListeners();
      await tester.pump();
    }
  }

  testWidgets('a page that does not listen for itself is rebuilt on every app '
      'update', (tester) async {
    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await frames(tester);
    var built = 0;
    unawaited(
      Navigator.of(tester.element(find.byType(AgentHome))).push(
        phoneRoute((_) {
          built++;
          return const Text('reads the app in build');
        }),
      ),
    );
    await frames(tester);
    final before = built;

    await ticks(tester);

    expect(built - before, 3);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/join/bring_agent.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'swarm_state_test.dart' show createApp;

void main() {
  // Finding 1: opening a project put its Board in the middle and selected the Buddy chat for the right side, so the
  // Buddy's row lit up and the project's did not.
  // Finding 3: a page or Manage in the middle turned the board layout off, and the Tasks pane with it.
  // Finding 6: with this computer not connected yet, the box said to wait and try again, with only Close.
  group('Connect this computer', () {
    /// The agent box opened before this computer's Harness connection is up: the app knows only another computer.
    Future<(AppNotifier, Future<Map<String, dynamic>?>)> open(
      WidgetTester tester,
    ) async {
      final server = swarm();
      final c = server.controller(account: 'owner');
      addTearDown(c.dispose);
      await tester.runAsync(c.refresh);
      final app = createApp()
        ..status = AppStatus.authenticated
        ..currentUser = const CurrentUserProfile(
          id: 'owner',
          email: 'owner@example.com',
        );
      addTearDown(app.dispose);
      late BuildContext context;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (c) {
              context = c;
              return const SizedBox();
            },
          ),
        ),
      );
      var open = true;
      final result = showBringAgentForm(
        context,
        controller: c,
        app: app,
        isCurrent: () => open,
      );
      addTearDown(() => open = false);
      // The box's spinner never settles: pump its opening alone.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Connect this computer'), findsOneWidget);
      return (app, result);
    }

    testWidgets('the box waits, and goes on by itself once this computer '
        'connects', (tester) async {
      final (app, _) = await open(tester);
      expect(find.text('Close'), findsNothing);
      app.machineStates['m']!.localOnly = true;
      app.notifyListeners();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Connect this computer'), findsNothing);
    });

    testWidgets('Open Machines closes it and opens Machines', (tester) async {
      final (app, result) = await open(tester);
      await tester.tap(find.text('Open Machines'));
      await tester.pumpAndSettle();
      expect(find.text('Connect this computer'), findsNothing);
      expect(app.machinesRequest, isNotNull);
      expect(await result, isNull);
    });
  });
}

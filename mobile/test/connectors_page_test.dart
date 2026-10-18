import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/connectors_page.dart';
import 'package:harness_mobile/state/app_state.dart';

/// One computer, answering `connectors` from a script: its connections, and whether it passes
/// them on to the account's other computers ([shared]). Records what it was asked.
class _App extends AppNotifier {
  _App({required this.shared})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    machines = [studio];
    machineStates['studio'] = MachineState(studio)..nodeOnline = true;
  }

  static const studio = Machine(
    machineId: 'studio',
    authMode: MachineAuthMode.remote,
    name: 'studio',
  );

  final bool shared;
  final asked = <Map<String, dynamic>>[];

  /// Tracker is connected; Wiki is not. Codes with no bundled icon: the page draws an initial.
  @override
  Future<Map<String, dynamic>> connectors(
    String machineId,
    Map<String, dynamic> payload, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    asked.add({'machine': machineId, ...payload});
    return switch (payload['action']) {
      'list' => {
        'shared': shared,
        'connections': [
          {
            'connector': 'tracker',
            'name': 'Tracker',
            'description': 'Issues',
            'auth': 'dcr',
            'state': 'connected',
          },
          {
            'connector': 'wiki',
            'name': 'Wiki',
            'description': 'Pages',
            'auth': 'dcr',
            'state': 'not_connected',
          },
        ],
      },
      // No address to open: the sign-in is the computer's own, and the page only follows it.
      'connect' => {'flow': 'f1'},
      'flow' => {'state': 'connected'},
      _ => {},
    };
  }

  List<String> get actions => [
    for (final payload in asked) payload['action'] as String,
  ];
}

void main() {
  Future<_App> pump(WidgetTester tester, {required bool shared}) async {
    final app = _App(shared: shared);
    addTearDown(app.dispose);
    await tester.pumpWidget(MaterialApp(home: ConnectorsPage(notifier: app)));
    await tester.pumpAndSettle();
    return app;
  }

  /// Tracker's sheet, then its Disconnect: the question it asks, on screen.
  Future<void> askToDisconnect(WidgetTester tester) async {
    await tester.tap(find.text('Tracker'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Disconnect'));
    await tester.pumpAndSettle();
  }

  testWidgets('Disconnect asks first; Cancel leaves the connection alone', (
    tester,
  ) async {
    final app = await pump(tester, shared: true);
    await askToDisconnect(tester);

    expect(find.text('Disconnect Tracker?'), findsOneWidget);
    expect(
      find.text(
        'Agents on all your computers stop using this account. To revoke it '
        'everywhere, use the service’s settings.',
      ),
      findsOneWidget,
    );
    expect(app.actions, isNot(contains('disconnect')));

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.text('Disconnect Tracker?'), findsNothing);
    expect(app.actions, isNot(contains('disconnect')));
    expect(find.textContaining('disconnected'), findsNothing);
  });

  testWidgets('confirmed, it disconnects, and says so on all your computers '
      'when the computer shares its connections', (tester) async {
    final app = await pump(tester, shared: true);
    await askToDisconnect(tester);
    await tester.tap(find.text('Disconnect'));
    await tester.pumpAndSettle();

    expect(
      app.asked,
      contains(
        equals({
          'machine': 'studio',
          'action': 'disconnect',
          'connector': 'tracker',
        }),
      ),
    );
    expect(
      find.text('Tracker disconnected on all your computers.'),
      findsOneWidget,
    );
  });

  testWidgets('a computer that keeps its connections to itself is named, '
      'never "all your computers"', (tester) async {
    final app = await pump(tester, shared: false);
    await askToDisconnect(tester);

    expect(
      find.text(
        'Agents on studio stop using this account. To revoke it everywhere, '
        'use the service’s settings.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Disconnect'));
    await tester.pumpAndSettle();

    expect(app.actions, contains('disconnect'));
    expect(find.text('Tracker disconnected on studio.'), findsOneWidget);
    expect(find.textContaining('all your computers'), findsNothing);
  });

  testWidgets('a connection made says so in the desktop\'s words, whichever '
      'computer it went through', (tester) async {
    final app = await pump(tester, shared: false);
    await tester.tap(find.text('Wiki'));
    // The page asks after the sign-in once a second.
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();

    expect(app.actions, containsAllInOrder(['connect', 'flow']));
    expect(
      find.text('Wiki connected. Your agents can use it now.'),
      findsOneWidget,
    );
    expect(find.textContaining('all your computers'), findsNothing);
  });

  testWidgets('what an action came to goes away on its own', (tester) async {
    await pump(tester, shared: true);
    await askToDisconnect(tester);
    await tester.tap(find.text('Disconnect'));
    await tester.pumpAndSettle();
    expect(
      find.text('Tracker disconnected on all your computers.'),
      findsOneWidget,
    );

    await tester.pump(const Duration(seconds: 19));
    expect(
      find.text('Tracker disconnected on all your computers.'),
      findsOneWidget,
    );
    await tester.pump(const Duration(seconds: 2));
    expect(
      find.text('Tracker disconnected on all your computers.'),
      findsNothing,
    );
  });
}

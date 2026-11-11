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
  _App({required this.shared, this.engines})
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

  /// The engines the computer has (`elsewhere`), with Gmail connected through Codex; null for an
  /// older Harness that does not know the request.
  final Set<String>? engines;

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
          if (engines != null) ...[
            {
              'connector': 'gmail',
              'name': 'Gmail',
              'description': 'Send email',
              'auth': 'app',
              'state': 'not_connected',
              'reason': 'Needs harness login',
            },
            {
              'connector': 'google_drive',
              'name': 'Google Drive',
              'description': 'Files',
              'auth': 'app',
              'state': 'not_connected',
              'reason': 'Needs harness login',
            },
          ],
        ],
      },
      'elsewhere' when engines != null => {
        'engines': {
          for (final e in ['claude', 'codex']) e: engines!.contains(e),
        },
        'connections': {
          'gmail': {
            for (final e in engines!)
              e: e == 'codex' ? 'installed' : 'not_connected',
          },
          'google_drive': {for (final e in engines!) e: 'not_connected'},
          'microsoft_365': {for (final e in engines!) e: 'not_connected'},
        },
        'services': [
          {
            'connector': 'microsoft_365',
            'name': 'Microsoft 365',
            'description': 'Outlook mail, calendar and files.',
          },
        ],
        'scopes': {
          'gmail': {
            'claude': 'Read, search, draft. No sending.',
            'codex': 'Read, search, manage.',
            'harness': 'Send only.',
          },
          'google_drive': {
            'claude': 'Search and read files.',
            'codex': 'Drive, Docs, Sheets, Slides.',
            'harness': 'Only files it creates.',
          },
          'microsoft_365': {
            'claude': 'Outlook mail, calendar and files.',
            'codex': 'Outlook mail, calendar, SharePoint.',
          },
        },
      },
      'elsewhere' => {
        'error': 'CONNECTORS_FAILED',
        'detail': 'Unknown action.',
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

  testWidgets(
    'Gmail and Drive offer only the engines the computer has, and Gmail through Codex reads as connected',
    (tester) async {
      final app = _App(shared: true, engines: {'codex'});
      addTearDown(app.dispose);
      await tester.pumpWidget(MaterialApp(home: ConnectorsPage(notifier: app)));
      await tester.pumpAndSettle();
      expect(app.actions, containsAllInOrder(['list', 'elsewhere']));
      // Gmail is in through Codex, so it is with the connected ones; its row says how.
      expect(find.text('Codex (sign-in on first use)'), findsOneWidget);
      expect(find.text('Manage'), findsOneWidget);
      // Drive needs no Harness sign-in to be added through Codex.
      await tester.tap(find.text('Google Drive'));
      await tester.pumpAndSettle();
      expect(find.text('Connect Google Drive'), findsOneWidget);
      expect(
        find.text('Codex only: Drive, Docs, Sheets, Slides.'),
        findsOneWidget,
      );
      expect(find.textContaining('Claude only'), findsNothing);
      expect(find.text('All agents: Only files it creates.'), findsOneWidget);
      expect(find.text('Needs harness login'), findsWidgets);
      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();

      // Microsoft 365: a card the Harness list does not have, and no Harness way in.
      await tester.tap(find.text('Microsoft 365'));
      await tester.pumpAndSettle();
      expect(find.text('Connect Microsoft 365'), findsOneWidget);
      expect(
        find.text('Codex only: Outlook mail, calendar, SharePoint.'),
        findsOneWidget,
      );
      expect(find.textContaining('All agents'), findsNothing);
    },
  );

  testWidgets(
    'an older Harness that cannot say keeps Gmail to Harness, as before',
    (tester) async {
      final app = _App(shared: true, engines: null);
      addTearDown(app.dispose);
      await tester.pumpWidget(MaterialApp(home: ConnectorsPage(notifier: app)));
      await tester.pumpAndSettle();
      expect(app.actions, containsAllInOrder(['list', 'elsewhere']));
      expect(find.text('Manage'), findsNothing);
      expect(find.text('Gmail'), findsNothing);
    },
  );

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

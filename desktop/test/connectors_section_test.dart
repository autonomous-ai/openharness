import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/connectors/connector_icons.dart';
import 'package:harness/connectors/connectors_controller.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/settings/sections/connectors_section.dart';

import 'support/model_manager.dart';

/// This computer's daemon, as Settings ▸ Connectors sees it over `connectors`
/// (cli/src/services/connectors.ts): a list, a sign-in followed to the end,
/// a disconnect and Add custom, never a token.
class _ConnectorsApp extends ModelManagerTestApp {
  _ConnectorsApp() : super(ModelManagerConnection());
  final requests = <Map<String, dynamic>>[];
  bool gridSignedIn = false;
  final connected = <String>{};
  final flowScript = <Object>[];

  /// The engines that computer has (`elsewhere`), or null for a daemon too old to say.
  Set<String>? engines;

  /// Gmail's state through each engine.
  final via = <String, String>{};

  Map<String, dynamic> _card(String code, String name, String auth) => {
    'connector': code,
    'name': name,
    'description': '$name description',
    'state': connected.contains(code) ? 'connected' : 'not_connected',
    'auth': auth,
    'custom': false,
    'tools': true,
    'reason': auth == 'app' && !gridSignedIn ? 'Needs harness login' : '',
  };

  @override
  Future<Map<String, dynamic>> connectors(
    String machineId,
    Map<String, dynamic> payload, {
    Duration timeout = const Duration(seconds: 20),
  }) async {
    expect(machineId, 'm');
    requests.add(payload);
    switch (payload['action']) {
      case 'list':
        return {
          'signed_in': gridSignedIn,
          'connections': [
            _card('linear', 'Linear', 'dcr'),
            _card('github', 'GitHub', 'app'),
            _card('notion', 'Notion', 'dcr'),
            if (engines != null) _card('gmail', 'Gmail', 'app'),
          ],
        };
      case 'connect':
        return {
          'flow': 'flow-1',
          'authorize_url': 'https://linear.app/oauth/authorize?x=1',
        };
      case 'flow':
        // What each poll meets, in turn: an answer, or the request failing on the way.
        if (flowScript.isNotEmpty) {
          final next = flowScript.removeAt(0);
          if (next is Exception) throw next;
          return next as Map<String, dynamic>;
        }
        connected.add('linear');
        // As the daemon answers: never an `error` key, which WsConn reads as the request failing.
        return {'connector': 'linear', 'state': 'connected'};
      case 'disconnect':
        connected.remove(payload['connector']);
        return {'connector': payload['connector'], 'state': 'not_connected'};
      case 'custom':
        return {'connector': 'mine', 'state': 'connected'};
      case 'elsewhere':
        if (engines == null) break;
        return {
          'engines': {
            for (final e in ['claude', 'codex']) e: engines!.contains(e),
          },
          'connections': {
            'gmail': {for (final e in engines!) e: via[e] ?? 'not_connected'},
            'microsoft_365': {for (final e in engines!) e: 'not_connected'},
          },
          'scopes': {
            'gmail': {
              'claude': 'Read, search and draft email. Cannot send.',
              'codex': 'Read, search and manage email.',
              'harness': 'Send only.',
            },
            // No Harness way in.
            'microsoft_365': {
              'claude': 'Outlook mail, calendar and files.',
              'codex': 'Outlook mail, calendar, SharePoint.',
            },
          },
          'services': [
            {
              'connector': 'microsoft_365',
              'name': 'Microsoft 365',
              'description': 'Outlook mail, calendar and files.',
            },
          ],
        };
      case 'connect_via':
        via[payload['via'] as String] = payload['via'] == 'codex'
            ? 'installed'
            : 'connected';
        return {
          'url': payload['via'] == 'codex'
              ? 'https://chatgpt.com/#settings/Connectors'
              : 'https://claude.ai/settings/connectors',
        };
      case 'disconnect_via':
        via.remove(payload['via']);
        return {'url': 'https://chatgpt.com/#settings/Connectors'};
    }
    return {'error': 'CONNECTORS_FAILED', 'detail': 'Unknown action.'};
  }
}

void main() {
  late List<Uri> opened;
  setUp(() {
    opened = [];
    browserOpener = (url) async {
      opened.add(url);
      return true;
    };
    ConnectorsController.pollEvery = Duration.zero;
  });

  Future<_ConnectorsApp> pump(
    WidgetTester tester, {
    Set<String>? engines,
  }) async {
    final app = _ConnectorsApp()..engines = engines;
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: ConnectorsSection(notifier: app)),
      ),
    );
    await tester.pumpAndSettle();
    return app;
  }

  testWidgets(
    'lists every service; signed out, the Harness account ones wait for harness login',
    (tester) async {
      await pump(tester);
      expect(find.text('Connectors'), findsOneWidget);
      for (final name in ['Linear', 'GitHub', 'Notion']) {
        expect(find.text(name), findsOneWidget);
      }
      expect(find.text('Needs harness login'), findsOneWidget);
      expect(find.textContaining('Run harness login'), findsOneWidget);
      expect(find.text('AVAILABLE  3'), findsOneWidget);
    },
  );

  testWidgets(
    'Gmail offers Claude and Codex only where that computer has them, each with what it can do',
    (tester) async {
      final app = await pump(tester, engines: {'codex'});
      await tester.tap(find.byKey(const ValueKey('connector-choose-gmail')));
      await tester.pumpAndSettle();
      // Codex is on that computer, Claude Code is not; Harness's own way is always there.
      expect(
        find.byKey(const ValueKey('connector-way-row-codex')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('connector-way-row-claude')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('connector-way-row-harness')),
        findsOneWidget,
      );
      expect(find.text('Read, search and manage email.'), findsOneWidget);
      expect(find.textContaining('Codex only'), findsOneWidget);
      expect(find.textContaining('All agents'), findsOneWidget);
      expect(find.textContaining('Your admin may need'), findsOneWidget);

      // Codex installs its plugin and ChatGPT opens; Gmail is connected from then on.
      await tester.tap(
        find.byKey(const ValueKey('connector-way-connect-codex')),
      );
      await tester.pumpAndSettle();
      expect(app.requests.where((r) => r['action'] == 'connect_via').single, {
        'action': 'connect_via',
        'connector': 'gmail',
        'via': 'codex',
      });
      expect(
        opened.last,
        Uri.parse('https://chatgpt.com/#settings/Connectors'),
      );
      expect(find.text('✓ Installed'), findsOneWidget);
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      expect(find.text('CONNECTED  1'), findsOneWidget);
      expect(find.text('✓ Codex · sign-in on first use'), findsOneWidget);
      expect(find.text('Manage'), findsOneWidget);

      // Removed: the plugin goes, and the card goes back to the services to connect.
      await tester.tap(find.byKey(const ValueKey('connector-choose-gmail')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('connector-way-remove-codex')),
      );
      await tester.pumpAndSettle();
      expect(app.requests.last['action'], 'elsewhere');
      expect(
        find.byKey(const ValueKey('connector-way-connect-codex')),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'with neither engine, or a daemon too old to say, Gmail signs in through Harness as before',
    (tester) async {
      final app = await pump(tester, engines: {});
      expect(
        find.byKey(const ValueKey('connector-choose-gmail')),
        findsNothing,
      );
      // GitHub's and Gmail's: both wait for harness login, as before.
      expect(find.byTooltip('Needs harness login'), findsNWidgets(2));
      expect(app.requests.map((r) => r['action']), ['list', 'elsewhere']);
      // Microsoft 365 connects only through an engine: with none, it is not offered at all.
      expect(find.text('Microsoft 365'), findsNothing);
    },
  );

  testWidgets(
    'Microsoft 365 has no Harness card or Harness way: only the engines that computer has',
    (tester) async {
      await pump(tester, engines: {'claude', 'codex'});
      expect(find.text('Microsoft 365'), findsOneWidget);
      await tester.tap(
        find.byKey(const ValueKey('connector-choose-microsoft_365')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Connect Microsoft 365'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('connector-way-row-claude')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('connector-way-row-codex')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('connector-way-row-harness')),
        findsNothing,
      );
      expect(find.text('Outlook mail, calendar, SharePoint.'), findsOneWidget);
    },
  );

  testWidgets(
    'a sign-in opens the service in the browser and is followed until it is connected',
    (tester) async {
      final app = await pump(tester);
      await tester.tap(find.byTooltip('Connect Linear'));
      await tester.pumpAndSettle();
      expect(opened.single.host, 'linear.app');
      expect(
        app.requests.map((r) => r['action']),
        containsAllInOrder(['connect', 'flow', 'list']),
      );
      expect(find.text('CONNECTED  1'), findsOneWidget);
      expect(find.text('Signed in'), findsOneWidget);
      expect(
        find.text('Linear connected. Your agents can use it now.'),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'a poll lost on the way while the person is in the browser does not end following the sign-in',
    (tester) async {
      final app = await pump(tester);
      app.flowScript.addAll([
        {'connector': 'linear', 'state': 'pending'},
        TimeoutException('WS request timed out: connectors'),
        StateError('Reconnect this computer to manage its connections.'),
      ]);
      await tester.tap(find.byTooltip('Connect Linear'));
      await tester.pumpAndSettle();
      expect(app.requests.where((r) => r['action'] == 'flow'), hasLength(4));
      expect(find.text('CONNECTED  1'), findsOneWidget);
      expect(
        find.text('Linear connected. Your agents can use it now.'),
        findsOneWidget,
      );
    },
  );

  testWidgets('a sign-in that failed says why, from `reason`', (tester) async {
    final app = await pump(tester);
    app.flowScript.add({
      'connector': 'linear',
      'state': 'failed',
      'reason': 'The service said no.',
    });
    await tester.tap(find.byTooltip('Connect Linear'));
    await tester.pumpAndSettle();
    expect(find.text('Linear: The service said no.'), findsOneWidget);
    expect(find.text('CONNECTED  0'), findsOneWidget);
  });

  testWidgets('disconnect asks first', (tester) async {
    final app = await pump(tester);
    app.connected.add('notion');
    await tester.tap(find.byTooltip('Refresh'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Disconnect Notion'));
    await tester.pumpAndSettle();
    expect(find.text('Disconnect Notion?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Disconnect'));
    await tester.pumpAndSettle();
    // The list again, then (after it) what Claude Code and Codex hold.
    expect(
      app.requests.lastWhere((r) => r['action'] != 'elsewhere')['action'],
      'list',
    );
    expect(
      app.requests.any(
        (r) => r['action'] == 'disconnect' && r['connector'] == 'notion',
      ),
      isTrue,
    );
    expect(find.text('CONNECTED  0'), findsOneWidget);
  });

  testWidgets('search and the Connected pill narrow the list', (tester) async {
    await pump(tester);
    await tester.enterText(
      find.byKey(const ValueKey('connectors-search')),
      'notion',
    );
    await tester.pumpAndSettle();
    expect(find.text('Linear'), findsNothing);
    expect(find.text('Notion'), findsOneWidget);
    await tester.tap(find.text('Connected'));
    await tester.pumpAndSettle();
    expect(find.text('Notion'), findsNothing);
  });

  testWidgets('Add custom sends a remote server with its headers', (
    tester,
  ) async {
    final app = await pump(tester);
    await tester.tap(find.byKey(const ValueKey('connectors-add-custom')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('custom-name')), 'Mine');
    await tester.enterText(
      find.byKey(const ValueKey('custom-url')),
      'https://mine.example/mcp',
    );
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(app.requests.firstWhere((r) => r['action'] == 'custom'), {
      'action': 'custom',
      'name': 'Mine',
      'url': 'https://mine.example/mcp',
      'headers': <String, String>{},
    });
    expect(
      find.text('Mine added. Your agents can use it now.'),
      findsOneWidget,
    );
  });

  test('bundles an icon for the services', () {
    expect(connectorIcons['linear'], 'assets/connector-icons/linear.png');
    expect(connectorIcons.length, greaterThan(80));
  });
}

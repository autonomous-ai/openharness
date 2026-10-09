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

  Future<_ConnectorsApp> pump(WidgetTester tester) async {
    final app = _ConnectorsApp();
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
    expect(app.requests.last['action'], 'list');
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

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/route_row.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

Map<String, dynamic> routeRow({
  String via = 'jev',
  double? p = 0.82,
  bool belowFloor = false,
  String? fallback,
}) => {
  'id': 'm1',
  'conversationId': 'offline',
  'text': 'Routed to Multiply',
  'replyTo': null,
  'sequence': 4,
  'author': {'kind': 'agent', 'id': 'lead', 'name': 'Lead'},
  'deliveries': const [],
  'source': {
    'kind': 'route',
    'decisionId': 'd1',
    'via': via,
    'p': p,
    'belowFloor': belowFloor,
    'why': 'schema change, high risk',
    'fallback': ?fallback,
    'pick': {'id': 'c0', 'title': 'Multiply · Claude opus high · remote-1'},
    'alternatives': [
      {'id': 'c1', 'title': 'New agent · Claude sonnet medium · mac'},
    ],
  },
};

Map<String, dynamic> decision({String? overrideTo}) => {
  'id': 'd1',
  'conversationId': 'offline',
  'record': {
    'candidates': [
      {
        'id': 'c0',
        'label': 'Opus, deepest review',
        'title': 'Multiply · Claude opus high · remote-1',
      },
      {
        'id': 'c1',
        'label': 'Sonnet, fastest turnaround',
        'title': 'New agent · Claude sonnet medium · mac',
      },
      {
        'id': 'c2',
        'label': 'Codex, cheapest',
        'title': 'New agent · Codex low · mac',
      },
    ],
    'excluded': const [],
    'floor': 3,
    'notes': false,
    'pick': 'c0',
  },
  'override': overrideTo == null ? null : {'candidateId': overrideTo},
};

Widget rowOf(SuperTabMessage message, controller) => MaterialApp(
  home: Scaffold(
    body: SuperTabRouteRow(
      message: message,
      route: message.route!,
      controller: controller,
    ),
  ),
);

void main() {
  test('parses route sources', () {
    final message = SuperTabMessage.fromJson(routeRow());
    expect(message.route!.decisionId, 'd1');
    expect(message.route!.alternatives.single.title, startsWith('New agent'));
    expect(
      SuperTabMessage.fromJson({
        ...routeRow(),
        'source': {'kind': 'route-override', 'decisionId': 'd1', 'by': 'lead'},
      }).routeOverride,
      isTrue,
    );
    expect(
      SuperTabMessage.fromJson({
        ...routeRow(),
        'source': {'kind': 'route', 'decisionId': 'd1'},
      }).route,
      isNull,
    );
  });

  test('wrong-typed route sources never throw', () {
    Map<String, dynamic> source(Map<String, dynamic> extra) => {
      ...routeRow()['source'] as Map<String, dynamic>,
      ...extra,
    };
    SuperTabRoute? parse(Map<String, dynamic> extra) =>
        SuperTabRoute.fromSource(source(extra));
    final odd = parse({'via': 7, 'why': 3, 'p': 'high', 'alternatives': 'x'})!;
    expect(odd.via, 'order');
    expect(odd.why, '');
    expect(odd.p, isNull);
    expect(odd.alternatives, isEmpty);
    expect(parse({'pick': 'c0'}), isNull);
    expect(
      parse({
        'pick': {'id': 1, 'title': 'x'},
      }),
      isNull,
    );
    expect(parse({'decisionId': 4}), isNull);
  });

  for (final c in [
    (via: 'jev', p: 0.82, below: false, fallback: null, text: 'Jev 82%'),
    (
      via: 'order',
      p: null,
      below: false,
      fallback: null,
      text: 'by policy order ·',
    ),
    (
      via: 'order',
      p: null,
      below: false,
      fallback: 'unsure',
      text: 'by policy order (Jev unsure)',
    ),
    (
      via: 'order',
      p: null,
      below: false,
      fallback: 'unavailable',
      text: 'by policy order (Jev unavailable)',
    ),
    (
      via: 'only',
      p: null,
      below: true,
      fallback: null,
      text: 'Below quality floor',
    ),
  ]) {
    testWidgets('renders ${c.via} ${c.fallback ?? ''}', (tester) async {
      final f = SuperTabLaunchFixture();
      final controller = await f.app.superTabs.open(tabId);
      final message = SuperTabMessage.fromJson(
        routeRow(via: c.via, p: c.p, belowFloor: c.below, fallback: c.fallback),
      );
      await tester.pumpWidget(rowOf(message, controller));
      expect(
        find.textContaining('Routed to Multiply · Claude opus high · remote-1'),
        findsOneWidget,
      );
      expect(find.textContaining(c.text), findsOneWidget);
      // The row quotes the Lead's reason, never the verdict's own text.
      expect(find.textContaining('"schema change, high risk"'), findsOneWidget);
      f.app.superTabs.dispose();
    });
  }

  testWidgets('a second Change does not offer the choice just made', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.connection.server.routeDecisions['d1'] = decision();
    final controller = await f.app.superTabs.open(tabId);
    await controller.refresh();
    final message = SuperTabMessage.fromJson(routeRow());
    await tester.pumpWidget(rowOf(message, controller));
    await tester.tap(find.text('Change'));
    await tester.pumpAndSettle();
    expect(find.text('Sonnet, fastest turnaround'), findsOneWidget);
    await tester.tap(find.textContaining('New agent · Claude sonnet medium'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Because.');
    await tester.pump();
    // The backend now names the choice as the decision's override.
    f.connection.server.routeDecisions['d1'] = decision(overrideTo: 'c1');
    await tester.tap(find.widgetWithText(FilledButton, 'Change'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Change'));
    await tester.pumpAndSettle();
    expect(find.text('Sonnet, fastest turnaround'), findsNothing);
    expect(find.text('Codex, cheapest'), findsOneWidget);
    f.app.superTabs.dispose();
  });

  testWidgets('an open details view is read again after a Change', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.connection.server.routeDecisions['d1'] = decision();
    final controller = await f.app.superTabs.open(tabId);
    await controller.refresh();
    final message = SuperTabMessage.fromJson(routeRow());
    await tester.pumpWidget(rowOf(message, controller));
    await tester.tap(find.textContaining('Routed to'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Quality floor 3'), findsOneWidget);
    f.connection.server.routeDecisions['d1'] = {
      ...decision(overrideTo: 'c1'),
      'record': {...(decision()['record'] as Map), 'floor': 2},
    };
    await tester.tap(find.text('Change'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('New agent · Claude sonnet medium'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Because.');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Change'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Quality floor 2'), findsOneWidget);
    f.app.superTabs.dispose();
  });

  testWidgets(
    'Change needs write access and a reason, then sends route.override',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.connection.server.routeDecisions['d1'] = decision();
      final controller = await f.app.superTabs.open(tabId);
      await controller.refresh();
      final message = SuperTabMessage.fromJson(routeRow());
      await tester.pumpWidget(rowOf(message, controller));
      await tester.tap(find.text('Change'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.textContaining('New agent · Claude sonnet medium · mac'),
      );
      await tester.pumpAndSettle();
      final confirm = find.widgetWithText(FilledButton, 'Change');
      expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
      await tester.enterText(
        find.byType(TextField),
        'Opus quota is needed elsewhere.',
      );
      await tester.pump();
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      final sent =
          f.connection.calls
                  .where(
                    (call) =>
                        (call.$2['path'] as String?)?.endsWith('/commands') ==
                        true,
                  )
                  .last
                  .$2['body']
              as Map;
      expect(sent['command'], {
        'type': 'route.override',
        'decisionId': 'd1',
        'candidateId': 'c1',
        'reason': 'Opus quota is needed elsewhere.',
      });
      f.app.superTabs.dispose();
    },
  );

  testWidgets('a viewer sees no Change', (tester) async {
    final f = SuperTabLaunchFixture();
    (f.connection.server.state['people'] as List)[0]['role'] = 'viewer';
    final controller = await f.app.superTabs.open(tabId);
    await controller.refresh();
    final message = SuperTabMessage.fromJson(routeRow());
    await tester.pumpWidget(rowOf(message, controller));
    expect(find.text('Change'), findsNothing);
    f.app.superTabs.dispose();
  });

  testWidgets('Change shows the refusal', (tester) async {
    final f = SuperTabLaunchFixture();
    f.connection.server.routeDecisions['d1'] = decision();
    f.connection.server.refuse = {
      'code': 'ROUTE_CLOSED',
      'message':
          'This routing decision is no longer open. Route the task again.',
    };
    final controller = await f.app.superTabs.open(tabId);
    await controller.refresh();
    final message = SuperTabMessage.fromJson(routeRow());
    await tester.pumpWidget(rowOf(message, controller));
    await tester.tap(find.text('Change'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('New agent · Claude sonnet'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Because.');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Change'));
    await tester.pumpAndSettle();
    expect(find.textContaining('no longer open'), findsOneWidget);
    f.app.superTabs.dispose();
  });

  testWidgets(
    'Change lists alternatives with criterion lines, minus the current choice',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.connection.server.routeDecisions['d1'] = decision();
      final controller = await f.app.superTabs.open(tabId);
      await controller.refresh();
      final message = SuperTabMessage.fromJson(routeRow());
      await tester.pumpWidget(rowOf(message, controller));
      await tester.tap(find.text('Change'));
      await tester.pumpAndSettle();
      expect(find.text('Sonnet, fastest turnaround'), findsOneWidget);
      expect(find.text('Codex, cheapest'), findsOneWidget);
      expect(find.text('Opus, deepest review'), findsNothing);
      final order = [
        tester.getTopLeft(find.text('Sonnet, fastest turnaround')).dy,
        tester.getTopLeft(find.text('Codex, cheapest')).dy,
      ];
      expect(order[0], lessThan(order[1]));
      f.app.superTabs.dispose();
    },
  );

  testWidgets('Change excludes an earlier override target', (tester) async {
    final f = SuperTabLaunchFixture();
    f.connection.server.routeDecisions['d1'] = decision(overrideTo: 'c1');
    final controller = await f.app.superTabs.open(tabId);
    await controller.refresh();
    final message = SuperTabMessage.fromJson(routeRow());
    await tester.pumpWidget(rowOf(message, controller));
    await tester.tap(find.text('Change'));
    await tester.pumpAndSettle();
    expect(find.text('Sonnet, fastest turnaround'), findsNothing);
    expect(find.text('Codex, cheapest'), findsOneWidget);
    f.app.superTabs.dispose();
  });

  testWidgets('Change says so when the decision cannot be loaded', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    final controller = await f.app.superTabs.open(tabId);
    await controller.refresh();
    final message = SuperTabMessage.fromJson(routeRow());
    await tester.pumpWidget(rowOf(message, controller));
    await tester.tap(find.text('Change'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Could not load this decision'), findsOneWidget);
    expect(find.byType(RadioListTile<String>), findsNothing);
    f.app.superTabs.dispose();
  });

  testWidgets(
    'Change while another action is pending is not reported as a refusal',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.connection.server.routeDecisions['d1'] = decision();
      final controller = await f.app.superTabs.open(tabId);
      await controller.refresh();
      f.connection.server.loseReply = true;
      await controller.command({
        'type': 'conversation.create',
        'title': 'Other',
        'brief': '',
        'checks': <dynamic>[],
      });
      expect(controller.hasPendingAction, isTrue);
      final before = f.connection.server.posts.length;
      final message = SuperTabMessage.fromJson(routeRow());
      await tester.pumpWidget(rowOf(message, controller));
      await tester.tap(find.text('Change'));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('New agent · Claude sonnet'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Because.');
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Change'));
      await tester.pumpAndSettle();
      expect(find.text('Finish the pending action first.'), findsOneWidget);
      expect(find.textContaining('not confirmed'), findsNothing);
      expect(f.connection.server.posts.length, before);
      f.app.superTabs.dispose();
    },
  );
}

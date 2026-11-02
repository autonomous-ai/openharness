import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/message_text.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/route_row.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

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

/// The decision's record as the backend keeps it. A record from before
/// floors went still carries `floor` and `notes`, which nothing shows; with
/// [revision] null, a record from before it named the instructions revision.
Map<String, dynamic> decision({String? overrideTo, int? revision = 7}) => {
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
    'notes': true,
    'pick': 'c0',
    'instructionsRevision': ?revision,
  },
  'override': overrideTo == null ? null : {'candidateId': overrideTo},
};

Widget rowOf(
  SuperTabMessage message,
  SuperTabController controller, {
  Brightness brightness = Brightness.dark,
  double scale = 1,
  bool withMessage = false,
}) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: grid.buildAppTheme(brightness: brightness),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(
      context,
    ).copyWith(textScaler: TextScaler.linear(scale), highContrast: scale > 1),
    child: child!,
  ),
  home: Scaffold(
    body: ListView(
      children: [
        if (withMessage)
          SuperTabMessageRow(
            message: SuperTabMessage.fromJson({
              ...routeRow(),
              'source': <String, dynamic>{},
              'text': 'I’ll ask Multiply to review the schema change.',
            }),
            author: 'Lead',
            agent: SuperTabAgent.fromJson({
              'id': 'lead',
              'name': 'Lead',
              'machineId': 'm',
              'harnessId': 'h',
              'contributorId': 'owner',
              'configuration': {'engine': 'codex'},
            }),
            onReturnToComposer: () {},
            receipts: const [],
          ),
        SuperTabRouteRow(
          message: message,
          route: message.route!,
          controller: controller,
        ),
      ],
    ),
  ),
);

void main() {
  final captureDir = Platform.environment['HARNESS_ROUTE_CAPTURE_DIR'];
  setUpAll(() => loadCaptureFonts(captureDir));
  final originalBrightness = grid.AppTheme.brightness.value;
  setUp(() => grid.AppTheme.brightness.value = Brightness.dark);
  tearDown(() => grid.AppTheme.brightness.value = originalBrightness);

  SuperTabController controller(ConversationServer server) {
    final c = server.controller();
    addTearDown(c.dispose);
    return c;
  }

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

  const ranked = 'Ranked by strength, price and quota';
  for (final c in [
    (via: 'jev', fallback: null, text: 'Jev 82%'),
    (via: 'order', fallback: null, text: ranked),
    (via: 'order', fallback: 'unsure', text: ranked),
    (via: 'order', fallback: 'unavailable', text: ranked),
    (via: 'only', fallback: null, text: 'Only available candidate'),
  ]) {
    testWidgets('keeps ${c.via} ${c.fallback ?? ''} explanation in Details', (
      tester,
    ) async {
      final server = ConversationServer();
      server.routeDecisions['d1'] = decision();
      final message = SuperTabMessage.fromJson(
        routeRow(via: c.via, fallback: c.fallback),
      );
      await tester.pumpWidget(rowOf(message, controller(server)));
      expect(find.text('Routed to Multiply'), findsOneWidget);
      expect(find.textContaining('schema change'), findsNothing);
      expect(find.textContaining('Claude opus'), findsNothing);
      expect(find.textContaining('Selection:'), findsNothing);
      expect(find.text('Change'), findsNothing);
      expect(find.text('Reassign'), findsNothing);
      await tester.tap(find.text('Details'));
      await tester.pumpAndSettle();
      expect(find.text('Selection: ${c.text}'), findsOneWidget);
      expect(find.text('schema change, high risk'), findsOneWidget);
      expect(find.text('Relied on instructions revision 7'), findsOneWidget);
      expect(find.textContaining('Opus, deepest review'), findsOneWidget);
      await tester.tap(find.text('Hide details'));
      await tester.pumpAndSettle();
      expect(find.textContaining('schema change'), findsNothing);
      expect(server.posts, isEmpty);
    });
  }

  testWidgets('shows what a route relied on, never floors', (tester) async {
    for (final (revision, line) in [
      (7, 'Relied on instructions revision 7'),
      (0, 'Relied on the built-in instructions'),
      (null, null),
    ]) {
      final server = ConversationServer();
      server.routeDecisions['d1'] = decision(revision: revision);
      // An older backend's route: below the floor, decided by policy order.
      final message = SuperTabMessage.fromJson(
        routeRow(via: 'order', belowFloor: true, fallback: 'unsure'),
      );
      await tester.pumpWidget(rowOf(message, controller(server)));
      expect(find.text('Below quality floor'), findsNothing);
      await tester.tap(find.text('Details'));
      await tester.pumpAndSettle();
      for (final gone in [
        'Below quality floor',
        'Policy order',
        'Quality floor',
        'Policy notes applied',
      ]) {
        expect(find.textContaining(gone), findsNothing, reason: gone);
      }
      expect(find.text('Selection: $ranked'), findsOneWidget);
      if (line == null) {
        expect(find.textContaining('Relied on'), findsNothing);
      } else {
        expect(find.text(line), findsOneWidget);
      }
      await tester.pumpWidget(const SizedBox());
    }
  });

  for (final c in [
    ('New agent · Codex default default · Studio Mac', 'new Codex agent'),
    ('Builder · UI · Claude opus high · Studio Mac', 'Builder · UI'),
    ('Custom route title', 'Custom route title'),
  ]) {
    testWidgets('keeps target identity for ${c.$1}', (tester) async {
      final json = routeRow();
      (json['source'] as Map)['pick'] = {'id': 'c0', 'title': c.$1};
      await tester.pumpWidget(
        rowOf(SuperTabMessage.fromJson(json), controller(ConversationServer())),
      );
      expect(find.text('Routed to ${c.$2}'), findsOneWidget);
    });
  }

  testWidgets('Details opens and closes from the keyboard', (tester) async {
    final server = ConversationServer();
    server.routeDecisions['d1'] = decision();
    await tester.pumpWidget(
      rowOf(SuperTabMessage.fromJson(routeRow()), controller(server)),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('Hide details'), findsOneWidget);
    expect(find.text('schema change, high risk'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('Details'), findsOneWidget);
    expect(server.posts, isEmpty);
  });

  testWidgets('failed details preserve the reason and can retry', (
    tester,
  ) async {
    final server = ConversationServer();
    await tester.pumpWidget(
      rowOf(SuperTabMessage.fromJson(routeRow()), controller(server)),
    );
    await tester.tap(find.text('Details'));
    await tester.pumpAndSettle();
    expect(find.text('Could not load this decision.'), findsOneWidget);
    expect(find.text('schema change, high risk'), findsOneWidget);
    server.routeDecisions['d1'] = decision();
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.text('Could not load this decision.'), findsNothing);
    expect(find.text('Relied on instructions revision 7'), findsOneWidget);
    expect(server.posts, isEmpty);
  });

  testWidgets('a late details response does not reopen a collapsed row', (
    tester,
  ) async {
    final response = Completer<Map<String, dynamic>>();
    var reads = 0;
    final c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      save: (_) async {},
      request: (method, path, {body}) {
        reads++;
        return response.future;
      },
    );
    addTearDown(c.dispose);
    await tester.pumpWidget(rowOf(SuperTabMessage.fromJson(routeRow()), c));
    expect(reads, 0);
    await tester.tap(find.text('Details'));
    await tester.pump();
    expect(find.text('Loading details…'), findsOneWidget);
    await tester.tap(find.text('Hide details'));
    await tester.pump();
    response.complete(decision());
    await tester.pumpAndSettle();
    expect(find.text('Details'), findsOneWidget);
    expect(find.text('Relied on instructions revision 7'), findsNothing);
    await tester.tap(find.text('Details'));
    await tester.pumpAndSettle();
    expect(reads, 1);
    expect(find.text('Relied on instructions revision 7'), findsOneWidget);
  });

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('routing aligns with chat at ${brightness.name} ${scale}x', (
        tester,
      ) async {
        grid.AppTheme.brightness.value = brightness;
        await tester.binding.setSurfaceSize(Size(scale == 1 ? 800 : 400, 900));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final server = ConversationServer();
        server.routeDecisions['d1'] = decision();
        await tester.pumpWidget(
          rowOf(
            SuperTabMessage.fromJson(routeRow()),
            controller(server),
            brightness: brightness,
            scale: scale,
            withMessage: true,
          ),
        );
        await tester.pumpAndSettle();
        final messageX = tester.getTopLeft(find.byType(SuperTabMessageText)).dx;
        final routeX = tester.getTopLeft(find.text('Routed to Multiply')).dx;
        expect(routeX, messageX);
        expect(tester.takeException(), isNull);
        await captureWindow(
          tester,
          captureDir,
          'route-${brightness.name}-${scale}x',
        );
        await tester.tap(find.text('Details'));
        await tester.pumpAndSettle();
        expect(
          tester.getTopLeft(find.text('schema change, high risk')).dx,
          messageX,
        );
        expect(tester.takeException(), isNull);
        await captureWindow(
          tester,
          captureDir,
          'details-${brightness.name}-${scale}x',
        );
        expect(server.posts, isEmpty);
      });
    }
  }
}

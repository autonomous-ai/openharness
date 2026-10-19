import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/phone/new_agent_draft.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/phone/tty_controls.dart' show TtyFormRow;
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import 'edge_fixture.dart';

/// What the machine answers one request with; throwing stands for a reply that never arrived.
typedef _Answer = Map<String, dynamic> Function(Map<String, dynamic> payload);

/// New when the machine answers Start with neither a yes nor a no: the button checks on the
/// request it made, under the same id, and never makes a second harness to find out.
void main() {
  tearDown(() => newAgentDraft = null);

  Map<String, dynamic> created(Map<String, dynamic> payload) => {
    'creationId': payload['creationId'],
    'state': 'created',
    'agent': {
      'id': 'new-agent',
      'name': 'new-agent',
      'engine': 'claude',
      'terminal': {'available': true},
    },
  };

  Map<String, dynamic> pending(Map<String, dynamic> payload) => {
    'creationId': payload['creationId'],
    'state': 'pending',
  };

  Map<String, dynamic> lost(Map<String, dynamic> _) =>
      throw const WsRequestTimeout('agent_create');

  /// Held before anything started, as a machine installing the engine answers.
  Map<String, dynamic> held(Map<String, dynamic> payload) => {
    'creationId': payload['creationId'],
    'state': 'pending',
    'held': {
      'service': 'engine',
      'detail': 'Installing Kilo. The harness starts once it is installed.',
    },
  };

  /// New on `m`, whose agent's folder is the project, answering from [script] — which a test
  /// changes between presses, as the machine's answers change.
  Future<({AppNotifier app, EdgeConn conn})> openNew(
    WidgetTester tester,
    Map<String, _Answer> script,
  ) async {
    setPhone(tester, largePhone);
    final conn = EdgeConn(
      const {},
      (type, payload) => script[type]?.call(payload),
    );
    final app = edgeApp(conn: conn);
    await tester.pumpWidget(
      phoneApp(
        Builder(
          builder: (context) => TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => NewAgentPage(notifier: app, machineId: 'm'),
              ),
            ),
            child: const Text('focus'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('focus'));
    await frames(tester);
    return (app: app, conn: conn);
  }

  Future<void> close(WidgetTester tester, AppNotifier app) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  }

  Future<void> press(WidgetTester tester, String label) async {
    await tapInView(tester, find.text(label));
    await frames(tester, count: 20);
  }

  /// Runs the clock until the harness just made is open. Its terminal is opened before the create
  /// answers, and that open waits for a handshake this fake never finishes (15s) and for a
  /// viewport nothing has measured yet (2s).
  Future<void> opened(WidgetTester tester) async {
    for (
      var i = 0;
      i < 120 && find.byType(AgentSwipeHost).evaluate().isEmpty;
      i++
    ) {
      await tester.pump(const Duration(milliseconds: 250));
    }
    await frames(tester, count: 8);
  }

  /// What the form's [label] row says.
  String row(WidgetTester tester, String label) => tester
      .widget<TtyFormRow>(
        find.byWidgetPredicate(
          (widget) => widget is TtyFormRow && widget.label == label,
        ),
      )
      .value;

  List<Map<String, dynamic>> sent(EdgeConn conn, String type) =>
      conn.payloads[type] ?? const [];

  testWidgets(
    'a lost reply: Check status asks about the same request, and opens what it started',
    (tester) async {
      final script = <String, _Answer>{'agent_create': lost};
      final (:app, :conn) = await openNew(tester, script);

      await press(tester, 'Start');

      expect(
        find.textContaining('has not confirmed the new harness yet'),
        findsOneWidget,
      );
      expect(find.text('Check status'), findsOneWidget);
      expect(find.text('Try Again'), findsNothing);
      expect(find.text('Start'), findsNothing);

      // The choices are held while it is checked on — the request is the one on the form.
      await tapInView(tester, find.text('options'));
      await frames(tester);
      expect(row(tester, 'options'), '[+]');

      script['agent_create_status'] = created;
      await press(tester, 'Check status');
      expect(find.text('Checking…'), findsOneWidget);
      await opened(tester);

      final [first] = sent(conn, 'agent_create');
      final [status] = sent(conn, 'agent_create_status');
      expect(status['creationId'], first['creationId']);
      expect(status.keys, [
        'creationId',
      ], reason: 'a check asks about the request; it does not make it again');
      expect(find.byType(AgentSwipeHost), findsOneWidget);
      expect(find.byType(NewAgentPage), findsNothing);
      await close(tester, app);
    },
  );

  testWidgets('still starting: checked again under the same id until it has '
      'started', (tester) async {
    final script = <String, _Answer>{
      'agent_create': pending,
      'agent_create_status': pending,
    };
    final (:app, :conn) = await openNew(tester, script);

    await press(tester, 'Start');
    expect(find.textContaining('still starting your harness'), findsOneWidget);
    expect(find.text('Check status'), findsOneWidget);

    await press(tester, 'Check status');
    expect(find.textContaining('still starting your harness'), findsOneWidget);
    expect(find.text('Check status'), findsOneWidget);

    script['agent_create_status'] = created;
    await press(tester, 'Check status');
    await opened(tester);

    final [first] = sent(conn, 'agent_create');
    final checks = sent(conn, 'agent_create_status');
    expect(checks, hasLength(2));
    for (final check in checks) {
      expect(check['creationId'], first['creationId']);
    }
    expect(find.byType(AgentSwipeHost), findsOneWidget);
    await close(tester, app);
  });

  testWidgets(
    'refused for good after a check: Try Again is a new request, under a new id',
    (tester) async {
      final script = <String, _Answer>{
        'agent_create': lost,
        'agent_create_status': (payload) => {
          'creationId': payload['creationId'],
          'state': 'failed',
          'failure': {'code': 'CWD_NOT_FOUND'},
        },
      };
      final (:app, :conn) = await openNew(tester, script);

      await press(tester, 'Start');
      await press(tester, 'Check status');

      expect(
        find.textContaining('project folder is unavailable'),
        findsOneWidget,
      );
      expect(find.text('Try Again'), findsOneWidget);
      expect(find.text('Check status'), findsNothing);

      script['agent_create'] = created;
      await press(tester, 'Try Again');
      expect(find.text('Starting…'), findsOneWidget);
      await opened(tester);

      final [first, second] = sent(conn, 'agent_create');
      expect(second['creationId'], isA<String>());
      expect(second['creationId'], isNot(first['creationId']));
      expect(sent(conn, 'agent_create_status'), hasLength(1));
      expect(find.byType(AgentSwipeHost), findsOneWidget);
      await close(tester, app);
    },
  );

  testWidgets('Try Again lasts only while its answer is on screen', (
    tester,
  ) async {
    final script = <String, _Answer>{
      'agent_create': (_) => throw const WsRequestFailure(
        responseType: 'agent_create_result',
        code: 'CWD_NOT_FOUND',
      ),
    };
    final (:app, :conn) = await openNew(tester, script);

    await press(tester, 'Start');
    expect(find.text('Try Again'), findsOneWidget);
    expect(find.text('Check status'), findsNothing);

    // A refusal holds nothing: the rows answer again, and a changed choice is a new request.
    await tapInView(tester, find.text('agent'));
    await frames(tester);
    await tapInView(tester, find.text('Codex', findRichText: true).last);
    await frames(tester);

    expect(row(tester, 'agent'), 'Codex');
    expect(find.textContaining('project folder is unavailable'), findsNothing);
    expect(find.text('Start'), findsOneWidget);
    expect(find.text('Try Again'), findsNothing);

    script['agent_create'] = created;
    await press(tester, 'Start');

    final [first, second] = sent(conn, 'agent_create');
    expect(second['engine'], 'codex');
    expect(second['creationId'], isNot(first['creationId']));
    expect(sent(conn, 'agent_create_status'), isEmpty);
    await close(tester, app);
  });

  testWidgets('held while the engine installs: says on what, and Cancel '
      'request calls it off under the same id', (tester) async {
    final script = <String, _Answer>{
      'agent_create': held,
      'agent_create_cancel': (payload) => {
        'creationId': payload['creationId'],
        'state': 'cancelled',
      },
    };
    final (:app, :conn) = await openNew(tester, script);

    await press(tester, 'Start');
    expect(
      find.textContaining('Installing Kilo. The harness starts once'),
      findsOneWidget,
    );
    expect(find.text('Check status'), findsOneWidget);
    expect(find.text('Cancel request'), findsOneWidget);

    await press(tester, 'Cancel request');

    final [first] = sent(conn, 'agent_create');
    final [cancel] = sent(conn, 'agent_create_cancel');
    expect(cancel, {'creationId': first['creationId']});
    expect(find.text('Creation cancelled.'), findsOneWidget);
    expect(find.text('Cancel request'), findsNothing);
    expect(find.text('Check status'), findsNothing);
    expect(find.text('Start'), findsOneWidget, reason: 'free for a new one');
    expect(
      find.textContaining('Installing Kilo'),
      findsNothing,
      reason: 'the hold is over',
    );
    await close(tester, app);
  });

  testWidgets('a harness already starting has nothing to cancel', (
    tester,
  ) async {
    final script = <String, _Answer>{'agent_create': pending};
    final (:app, :conn) = await openNew(tester, script);

    await press(tester, 'Start');

    expect(find.text('Check status'), findsOneWidget);
    expect(find.text('Cancel request'), findsNothing);
    await close(tester, app);
  });

  testWidgets('a cancel the machine does not confirm keeps the request to '
      'check', (tester) async {
    final script = <String, _Answer>{
      'agent_create': held,
      'agent_create_cancel': (_) =>
          throw const WsRequestTimeout('agent_create_cancel'),
    };
    final (:app, :conn) = await openNew(tester, script);

    await press(tester, 'Start');
    await press(tester, 'Cancel request');

    expect(
      find.textContaining('Cancellation is not confirmed'),
      findsOneWidget,
    );
    expect(find.text('Check status'), findsOneWidget);

    script['agent_create_status'] = created;
    await press(tester, 'Check status');
    await opened(tester);
    final [first] = sent(conn, 'agent_create');
    expect(
      sent(conn, 'agent_create_status').single['creationId'],
      first['creationId'],
    );
    expect(find.byType(AgentSwipeHost), findsOneWidget);
    await close(tester, app);
  });
}

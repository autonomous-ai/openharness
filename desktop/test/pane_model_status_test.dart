// The pane saying what its model is doing (grid-reads-without-waking, issue 03): the chip from a
// message sent to a resting model until its first output, and the note on an agent whose model is
// not answering — and, for an agent whose frame says neither, the header it always had.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/model_start_watch.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';

import 'support/real_fonts.dart';
import 'support/resting_models.dart';
import 'swarm_state_test.dart' show createApp;

void main() {
  setUpAll(loadRealFonts);

  late AppNotifier app;
  late RecordingDaemon daemon;
  late TerminalSession session;

  /// A pane on agent `agent-1`, whose frame's `grid` block is [grid].
  Future<void> pane(
    WidgetTester tester,
    Map<String, Object?> grid, {
    double width = 900,
    String name = 'Desktop',
  }) async {
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    daemon = RecordingDaemon(
      modelsReply([
        section('home', own: true, models: [row('Gemma-4-12B', 'macbook')]),
      ]),
    );
    app = createApp(connectionForTest: (_) => daemon);
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [_agent(grid)];
    session =
        TerminalSession(
            machineId: 'm',
            agentId: 'agent-1',
            agentName: name,
            engineId: 'codex',
            send: (_, _) async => true,
            sendBinary: (_) async => true,
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'stream-1';
    addTearDown(session.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: width,
            height: 320,
            // Rebuilt on every change to the app, as the pane grid rebuilds it.
            child: ListenableBuilder(
              listenable: app,
              builder: (context, _) =>
                  TerminalPanel(notifier: app, session: session, focused: true),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  /// The daemon re-pushing the agent with [grid] (`agent_synced`) — as it does when the state or
  /// the note of its model's grid moves.
  Future<void> agentSays(WidgetTester tester, Map<String, Object?> grid) async {
    await app.handleEventForTest('m', {
      'type': 'agent_synced',
      'payload': {'agent': _json(grid)},
    });
    await tester.pump();
  }

  Future<void> event(
    WidgetTester tester,
    String type, {
    Map<String, Object?> payload = const {},
    bool replay = false,
  }) async {
    await app.handleEventForTest('m', {
      'type': type,
      'agentId': 'agent-1',
      'payload': payload,
      if (replay) 'replay': true,
    });
    await tester.pump();
  }

  /// Let the turn's own watchdog (12 s) run out, so no timer outlives the test.
  Future<void> settle(WidgetTester tester) =>
      tester.pump(const Duration(seconds: 13));

  testWidgets('an agent whose frame says neither keeps the header it had', (
    tester,
  ) async {
    await pane(tester, {'model': 'Qwen3.5-4B', 'webSearch': 'on'});
    // The header as it was drawn before this ticket, nothing added — its order is main's since
    // #329, which put the model after the machine.
    expect(textsUnder(tester), ['Desktop', 'Test host', 'Qwen3.5-4B']);
    await event(tester, 'turn_started', payload: {'userMessage': 'hi'});
    expect(textsUnder(tester), ['Desktop', 'Test host', 'Qwen3.5-4B']);
    await settle(tester);
  });

  testWidgets(
    'a message to a resting model says Starting up… until the first output',
    (tester) async {
      await pane(tester, {'model': 'Qwen3.5-4B', 'state': 'asleep'});
      expect(find.text('Starting up…'), findsNothing);

      await event(tester, 'turn_started', payload: {'userMessage': 'hi'});
      expect(find.text('Starting up…'), findsOneWidget);
      expect(saysGrid, findsNothing);

      // The terminal echoing the prompt and drawing its spinner is not the model answering.
      session.terminal.write('hi\r\n⠋ Working');
      await tester.pump();
      expect(find.text('Starting up…'), findsOneWidget);
      // Nor is the grid coming up: the chip is about THIS message's answer.
      await agentSays(tester, {'model': 'Qwen3.5-4B', 'state': 'awake'});
      expect(find.text('Starting up…'), findsOneWidget);

      await tester.pump(kStillStartingAfter);
      expect(find.text('Starting up…'), findsNothing);
      expect(
        find.text('Still starting — this can take up to a minute'),
        findsOneWidget,
      );
      expect(saysGrid, findsNothing);

      await event(tester, 'text_delta', payload: {'content': 'Hello'});
      expect(
        find.text('Still starting — this can take up to a minute'),
        findsNothing,
      );
      expect(find.text('Starting up…'), findsNothing);
      await settle(tester);
    },
  );

  // A reasoning model's first output is its thinking, long before any text — and every other kind
  // of output the CLI's normalizers emit for a turn counts the same way.
  for (final kind in [
    'thinking_delta',
    'thinking_title',
    'tool_end',
    'subagent_finished',
    'done',
  ]) {
    testWidgets('$kind is the model answering', (tester) async {
      await pane(tester, {'model': 'Qwen3.5-4B', 'state': 'asleep'});
      await event(tester, 'turn_started', payload: {'userMessage': 'hi'});
      expect(find.text('Starting up…'), findsOneWidget);
      await event(tester, kind, payload: {'content': 'Let me think'});
      expect(find.text('Starting up…'), findsNothing);
      await settle(tester);
    });
  }

  testWidgets('a sub-agent starting its own turn is not a message sent here', (
    tester,
  ) async {
    await pane(tester, {'model': 'Qwen3.5-4B', 'state': 'asleep'});
    app.machineStates['m']!.agents = [
      Agent.fromJson({
        ..._json({'model': 'Qwen3.5-4B', 'state': 'asleep'}),
        'sessionId': 'own',
      }),
    ];
    await app.handleEventForTest('m', {
      'type': 'turn_started',
      'agentId': 'agent-1',
      'dbSessionId': 'a-sub-agent',
      'payload': {'userMessage': 'specialist task'},
    });
    await tester.pump();
    expect(find.text('Starting up…'), findsNothing);
    await settle(tester);
  });

  testWidgets('a tool call is output too, and so is the turn ending', (
    tester,
  ) async {
    await pane(tester, {'model': 'Qwen3.5-4B', 'state': 'waking'});
    await event(tester, 'turn_started', payload: {'userMessage': 'hi'});
    expect(find.text('Starting up…'), findsOneWidget);
    await event(tester, 'tool_start', payload: {'id': 't', 'tool': 'Read'});
    expect(find.text('Starting up…'), findsNothing);
    await settle(tester);

    await event(tester, 'turn_started', payload: {'userMessage': 'again'});
    expect(find.text('Starting up…'), findsOneWidget);
    await app.handleEventForTest('m', {
      'type': 'turn_ended',
      'agentId': 'agent-1',
      'payload': const <String, dynamic>{},
    });
    await tester.pump();
    expect(find.text('Starting up…'), findsNothing);
    await tester.pump(const Duration(minutes: 1));
  });

  testWidgets(
    'no chip for an awake model, a daemon that did not say, or a replayed turn',
    (tester) async {
      await pane(tester, {'model': 'Qwen3.5-4B', 'state': 'awake'});
      await event(tester, 'turn_started', payload: {'userMessage': 'hi'});
      expect(find.text('Starting up…'), findsNothing);

      await agentSays(tester, {'model': 'Qwen3.5-4B'});
      await event(tester, 'turn_started', payload: {'userMessage': 'hi'});
      expect(find.text('Starting up…'), findsNothing);

      // A turn picked back up at attach is not a message sent now.
      await agentSays(tester, {'model': 'Qwen3.5-4B', 'state': 'asleep'});
      await event(
        tester,
        'turn_started',
        payload: {'userMessage': 'hi'},
        replay: true,
      );
      expect(find.text('Starting up…'), findsNothing);
      await settle(tester);
    },
  );

  for (final width in [420.0, 600.0, 760.0, 900.0, 1100.0]) {
    testWidgets('the chip fits a header $width wide, beside a long name', (
      tester,
    ) async {
      await pane(
        tester,
        {'model': 'Qwen3.6-35B-A3B-UD-Q5_K_XL', 'state': 'asleep'},
        width: width,
        name: 'A harness with a very long name indeed, for the header',
      );
      await event(tester, 'turn_started', payload: {'userMessage': 'hi'});
      await tester.pump(kStillStartingAfter);
      expect(tester.takeException(), isNull);
      // A narrow header draws the chip's mark and says the words on hover, as it does its status.
      expect(
        width < 560
            ? find.byTooltip(
                'Still starting — this can take up to a minute\n'
                'Resting to save resources. It starts by itself when you send a message.',
              )
            : find.text('Still starting — this can take up to a minute'),
        findsOneWidget,
      );
      await event(tester, 'text_delta', payload: {'content': 'Hello'});
      await settle(tester);
    });
  }

  testWidgets('the chip never outlives its cap', (tester) async {
    await pane(tester, {'model': 'Qwen3.5-4B', 'state': 'asleep'});
    await event(tester, 'turn_started', payload: {'userMessage': 'hi'});
    await tester.pump(kStartWatchCap - const Duration(seconds: 1));
    expect(
      find.text('Still starting — this can take up to a minute'),
      findsOneWidget,
    );
    await tester.pump(const Duration(seconds: 1));
    expect(
      find.text('Still starting — this can take up to a minute'),
      findsNothing,
    );
    expect(find.text('Starting up…'), findsNothing);
  });

  testWidgets(
    "a model no longer served says so, and Pick another opens this pane's picker",
    (tester) async {
      await pane(tester, {
        'model': 'Qwen3.5-4B',
        'state': 'awake',
        'note': {'reason': 'not_served', 'model': 'Qwen3.5-4B'},
      });
      expect(
        find.textContaining("Qwen3.5-4B isn't being served right now"),
        findsOneWidget,
      );
      expect(find.text('Pick another'), findsOneWidget);
      expect(saysGrid, findsNothing);

      await tester.tap(find.text('Pick another'));
      await tester.pumpAndSettle();
      // The pane's own model picker, open on its models.
      expect(find.text('SUBSCRIPTION'), findsOneWidget);
      expect(find.text('Gemma-4-12B'), findsOneWidget);
    },
  );

  testWidgets('a model whose computer seems offline says until when', (
    tester,
  ) async {
    await pane(tester, {
      'model': 'Qwen3.5-4B',
      'state': 'asleep',
      'note': {'reason': 'offline', 'model': 'Qwen3.5-4B', 'machine': 'Studio'},
    });
    expect(
      find.text(
        "Studio seems offline — Qwen3.5-4B won't answer until it's back",
      ),
      findsOneWidget,
    );
    expect(find.text('Pick another'), findsNothing);
    expect(saysGrid, findsNothing);

    // Cleared by the daemon re-pushing the agent once the model is served again.
    await agentSays(tester, {'model': 'Qwen3.5-4B', 'state': 'awake'});
    expect(find.textContaining('seems offline'), findsNothing);
    // The note gave its line back to the terminal, which tells the machine its new size.
    await tester.pump(const Duration(milliseconds: 100));
  });
}

Map<String, Object?> _json(Map<String, Object?> grid) => {
  'id': 'agent-1',
  'name': 'Desktop',
  'engine': 'codex',
  'terminal': {'available': true},
  'grid': grid,
};

Agent _agent(Map<String, Object?> grid) => Agent.fromJson(_json(grid));

// The pane picker saying what a resting computer is doing (grid-reads-without-waking, issue 03):
// each state of the contract's table, the "Show models" wake, and the "Switch anyway?" gate on a
// row whose computers seem offline — and, with a daemon that sends none of it, the menu it always
// drew.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/grid_model_picker.dart';
import 'package:harness/widgets/model_picker_chrome.dart';

import 'support/real_fonts.dart';
import 'support/resting_models.dart';
import 'swarm_state_test.dart' show createApp;

void main() {
  setUpAll(loadRealFonts);

  late RecordingDaemon daemon;
  late AppNotifier app;

  void serve(List<Map<String, Object?>> grids) {
    daemon = RecordingDaemon(modelsReply(grids));
    app = createApp(connectionForTest: (_) => daemon);
    addTearDown(app.dispose);
  }

  Future<void> open(
    WidgetTester tester, {
    String? currentModel,
    ValueChanged<GridModel>? onSelected,
  }) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: GridModelPicker(
              notifier: app,
              machineId: 'm',
              engineLabel: 'claude',
              currentModel: currentModel,
              onSelected: onSelected,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.byType(GridModelPicker));
    await tester.pumpAndSettle();
  }

  double top(WidgetTester tester, Finder finder) =>
      tester.getTopLeft(finder).dy;

  testWidgets('with no new field the menu is exactly the one it always was', (
    tester,
  ) async {
    // What the build before this one drew for this very answer, text for text, captured from it.
    serve([
      section(
        'home',
        own: true,
        models: [
          row('Qwen3.5-4B', 'macbook'),
          // An older daemon folds the label into the node; this build shows it as it comes.
          row('LFM2.5-8B', 'studio · seems offline'),
        ],
      ),
      section('team', models: [row('DeepSeek-V4-Flash', 'scholes-60001')]),
      section('empty-team'),
    ]);
    await open(tester, currentModel: 'Qwen3.5-4B');
    expect(textsUnder(tester), [
      'Qwen3.5-4B',
      'Search models or machines',
      'SUBSCRIPTION',
      'Anthropic',
      'Checking usage…',
      'ON YOUR MACHINES',
      '2',
      'Qwen3.5-4B',
      'macbook',
      'LFM2.5-8B',
      'studio · seems offline',
      'SHARED · TEAM',
      '1',
      'DeepSeek-V4-Flash',
      'scholes-60001',
      '3 models available',
      'Local models',
    ]);
    // No row is greyed and no pick is gated: nothing said any of them was offline.
    for (final row in tester.widgetList<ModelPickerRow>(
      find.byType(ModelPickerRow),
    )) {
      expect(row.dimmed, isFalse);
    }
  });

  testWidgets('every read the picker makes asks for row state', (tester) async {
    serve([
      section('home', own: true, models: [row('Qwen3.5-4B', 'macbook')]),
    ]);
    await open(tester);
    expect(daemon.asks, isNotEmpty);
    for (final ask in daemon.asks) {
      expect(ask, {'rowState': true});
    }
  });

  testWidgets(
    'an asleep section says so under its heading, with the list age and why',
    (tester) async {
      serve([
        section(
          'home',
          own: true,
          state: 'asleep',
          lastKnownAge: 9 * 3600 + 120,
          models: [row('Qwen3.5-4B', 'macbook')],
        ),
      ]);
      await open(tester);
      const subtitle =
          'Asleep · starts when you send a message (about 10–30 s) · list from 9 h ago';
      expect(find.text(subtitle), findsOneWidget);
      expect(
        find.byTooltip(
          'Resting to save resources. It starts by itself when you send a message.',
        ),
        findsOneWidget,
      );
      // Under the heading, above the list it describes — and the list is still there to pick from.
      expect(
        top(tester, find.text('ON YOUR MACHINES')) <
            top(tester, find.text(subtitle)),
        isTrue,
      );
      expect(
        top(tester, find.text(subtitle)) < top(tester, find.text('Qwen3.5-4B')),
        isTrue,
      );
      expect(saysGrid, findsNothing);
    },
  );

  testWidgets(
    'a section with no record offers Show models, and it wakes just that section',
    (tester) async {
      serve([
        section('home', own: true, models: [row('Qwen3.5-4B', 'macbook')]),
        section('team', state: 'asleep'),
      ]);
      await open(tester);
      // A shared section that lists nothing is drawn while it has something to offer.
      expect(find.text('SHARED · TEAM'), findsOneWidget);
      expect(find.text('Show models'), findsOneWidget);
      expect(find.text('usually 15–40 s'), findsOneWidget);
      expect(saysGrid, findsNothing);

      daemon.wakeReply = modelsReply([
        section('home', own: true, models: [row('Qwen3.5-4B', 'macbook')]),
        section('team', state: 'waking'),
      ]);
      daemon.reply = daemon.wakeReply!;
      await tester.tap(find.text('Show models'));
      await tester.pump();
      await tester.pump();

      expect(daemon.asks.last, {
        'rowState': true,
        'wake': ['team'],
      });
      // The menu stays open and says what is happening.
      expect(find.text('Show models'), findsNothing);
      expect(find.text('Starting up… usually 15–40 s'), findsOneWidget);

      // The outcome: the section wakes with its models, found by asking again.
      daemon.reply = modelsReply([
        section('home', own: true, models: [row('Qwen3.5-4B', 'macbook')]),
        section(
          'team',
          state: 'awake',
          models: [row('DeepSeek-V4-Flash', 'scholes-60001')],
        ),
      ]);
      await tester.pump(const Duration(seconds: 5));
      await tester.pump();
      expect(find.text('DeepSeek-V4-Flash'), findsOneWidget);
      expect(find.text('Starting up… usually 15–40 s'), findsNothing);
      // Nothing waking any more: the follow-up ends, leaving no timer behind.
      await tester.pump(const Duration(seconds: 10));
    },
  );

  testWidgets('an empty record says nobody was serving', (tester) async {
    serve([
      section('home', own: true, models: [row('Qwen3.5-4B', 'macbook')]),
      section('team', state: 'asleep', lastKnownAge: 3600),
    ]);
    await open(tester);
    expect(find.text('SHARED · TEAM'), findsOneWidget);
    expect(
      find.text('Nobody was serving here when it went to sleep'),
      findsOneWidget,
    );
    expect(find.text('Show models'), findsNothing);
    expect(saysGrid, findsNothing);
  });

  testWidgets('a section not answering says so above its last known list', (
    tester,
  ) async {
    serve([
      section(
        'home',
        own: true,
        state: 'unknown',
        seenAt: '2026-09-24T08:00:00.000Z',
        lastKnownAge: 600,
        models: [row('Qwen3.5-4B', 'macbook')],
      ),
    ]);
    await open(tester);
    expect(find.text('Not answering right now'), findsOneWidget);
    expect(
      top(tester, find.text('Not answering right now')) <
          top(tester, find.text('Qwen3.5-4B')),
      isTrue,
    );
    expect(saysGrid, findsNothing);
  });

  testWidgets('a section starting up says so', (tester) async {
    serve([section('home', own: true, state: 'waking')]);
    await open(tester);
    expect(find.text('Starting up… usually 15–40 s'), findsOneWidget);
    // Not the empty own section's invitation: this one is not empty, it is starting.
    expect(
      find.text('Set up your first local model on this computer.'),
      findsNothing,
    );
    expect(saysGrid, findsNothing);
  });

  testWidgets('a wake that showed nothing says how it ended', (tester) async {
    serve([
      section('home', own: true, state: 'asleep', wakeOutcome: 'not_started'),
      section('team', state: 'asleep', wakeOutcome: 'not_started'),
      section('lab', state: 'awake', wakeOutcome: 'nobody_serving'),
    ]);
    await open(tester);
    expect(
      find.text(
        "Couldn't start your models right now — it will start on your next message",
      ),
      findsOneWidget,
    );
    expect(
      find.text(
        "Couldn't start team right now — it will start on your next message",
      ),
      findsOneWidget,
    );
    expect(
      find.text('Nobody is serving a model here right now'),
      findsOneWidget,
    );
    // An outcome is the answer to the click; the row that asked is not offered again beside it.
    expect(find.text('Show models'), findsNothing);
    expect(saysGrid, findsNothing);
  });

  group('a row whose computers seem offline', () {
    List<Map<String, Object?>> grids() => [
      section(
        'home',
        own: true,
        state: 'asleep',
        lastKnownAge: 120,
        models: [
          row('Qwen3.5-4B', 'macbook'),
          row('LFM2.5-8B', 'studio', offlineMachine: 'Studio'),
        ],
      ),
    ];

    ModelPickerRow rowOf(WidgetTester tester, String id) =>
        tester.widget<ModelPickerRow>(
          find.ancestor(
            of: find.text(id),
            matching: find.byType(ModelPickerRow),
          ),
        );

    testWidgets('is greyed and says why, and is never removed', (tester) async {
      serve(grids());
      await open(tester);
      expect(find.text('LFM2.5-8B'), findsOneWidget);
      expect(
        find.text('Studio seems offline — its models come back when it does'),
        findsOneWidget,
      );
      expect(rowOf(tester, 'LFM2.5-8B').dimmed, isTrue);
      expect(rowOf(tester, 'Qwen3.5-4B').dimmed, isFalse);
      // The node stays a node: the label is not folded into it.
      expect(find.text('studio'), findsOneWidget);
      expect(saysGrid, findsNothing);
    });

    testWidgets('asks "Switch anyway?" — and Cancel moves nothing', (
      tester,
    ) async {
      serve(grids());
      GridModel? picked;
      await open(tester, onSelected: (model) => picked = model);
      await tester.tap(find.text('LFM2.5-8B'));
      await tester.pumpAndSettle();
      expect(find.text('Switch anyway?'), findsOneWidget);
      expect(saysGrid, findsNothing);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(find.text('Switch anyway?'), findsNothing);
      expect(picked, isNull);
      // The control says nothing moved.
      expect(find.text('Switching…'), findsNothing);
    });

    testWidgets('and Switch moves the agent as any pick does', (tester) async {
      serve(grids());
      GridModel? picked;
      await open(tester, onSelected: (model) => picked = model);
      await tester.tap(find.text('LFM2.5-8B'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Switch'));
      await tester.pumpAndSettle();
      expect(picked?.id, 'LFM2.5-8B');
      expect(picked?.grid, 'home');
      expect(find.text('Switching…'), findsOneWidget);
      // The guess expires on its own when no frame confirms it.
      await tester.pump(const Duration(seconds: 31));
    });

    testWidgets('a row that is fine is picked with no question', (
      tester,
    ) async {
      serve(grids());
      GridModel? picked;
      await open(tester, onSelected: (model) => picked = model);
      await tester.tap(find.text('Qwen3.5-4B'));
      await tester.pumpAndSettle();
      expect(find.text('Switch anyway?'), findsNothing);
      expect(picked?.id, 'Qwen3.5-4B');
      await tester.pump(const Duration(seconds: 31));
    });
  });
}

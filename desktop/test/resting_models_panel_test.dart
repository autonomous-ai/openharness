// The Models panel saying what a resting computer is doing (grid-reads-without-waking, issue 03):
// every state of the contract's table on its shared sections, "Show models", greyed offline rows,
// and the Model Manager's row for a model parked while this computer's models rest — and, with a
// daemon that sends none of it, the panel it always drew.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/model_manager_controller.dart';
import 'package:harness/models/models_panel.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/usage/models_menu_controller.dart';

import 'support/model_manager.dart';
import 'support/real_fonts.dart';
import 'support/resting_models.dart';

class _NoSubscriptions extends ModelsMenuController {
  @override
  List<Map<String, Object?>> get rows => const [];
  @override
  Future<void> refresh() async {}
}

/// This computer's daemon, recording the `grid_models_list` asks that go to it for real — the
/// wake. The panel's plain reads go through [ModelManagerTestApp.gridModels], which answers from
/// its `inventory`.
class _Daemon extends ModelManagerConnection {
  final asks = <Map<String, dynamic>>[];
  Map<String, dynamic> wakeReply = const {};

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'grid_models_list') {
      return super.request(type, payload: payload, timeout: timeout);
    }
    asks.add(Map.of(payload));
    return wakeReply;
  }
}

void main() {
  setUpAll(loadRealFonts);

  late _Daemon daemon;
  late ModelManagerTestApp app;
  late ModelManagerController controller;

  Future<void> show(
    WidgetTester tester,
    List<Map<String, Object?>> grids, {
    Map<String, dynamic>? local,
    ModelsTab tab = ModelsTab.all,
  }) async {
    tester.view.physicalSize = const Size(900, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    daemon = _Daemon();
    app = ModelManagerTestApp(daemon);
    app.inventory = GridModels.fromReply(modelsReply(grids));
    app.localInventory = local ?? modelInventory(scenario: 'ready');
    controller = ModelManagerController(app, poll: false);
    final subscriptions = _NoSubscriptions();
    addTearDown(() {
      controller.dispose();
      subscriptions.dispose();
      app.dispose();
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 640,
              child: ModelsPanel(
                controller: controller,
                subscriptions: subscriptions,
                initialTab: tab,
                onClose: () {},
                onManage: () {},
              ),
            ),
          ),
        ),
      ),
    );
    await controller.refresh(force: true);
    await tester.pump();
  }

  double top(WidgetTester tester, Finder finder) =>
      tester.getTopLeft(finder).dy;

  testWidgets('with no new field the panel is exactly the one it always was', (
    tester,
  ) async {
    // What the build before this one drew for this very answer, text for text, captured from it.
    await show(tester, [
      section(
        'home',
        own: true,
        models: [
          row('Qwen3.5-4B', 'macbook'),
          row('LFM2.5-8B', 'studio · seems offline'),
        ],
      ),
      section('team', models: [row('DeepSeek-V4-Flash', 'scholes-60001')]),
      section('empty-team'),
    ]);
    expect(textsUnder(tester), [
      'Models',
      'Search models…',
      'All 6',
      'Subscriptions 0',
      'Local 5',
      'Shared 1',
      'APIs 0',
      'This computer · 64 GB memory',
      'Qwen3.8-27B',
      '16.2 GB · 17.6 tok/s · 42 requests / 24h',
      'gemma-4-12B',
      '7.3 GB',
      'Qwen3.8-8B',
      '4.8 GB',
      'Qwen3-Coder-30B-A3B',
      '18.6 GB',
      'gpt-oss-20b',
      '12.1 GB',
      'Shared · team',
      'DeepSeek-V4-Flash',
      'scholes-60001',
      'Select models in a session’s model picker.',
      'Manage models',
    ]);
  });

  testWidgets('every state of a shared section reads as the table says', (
    tester,
  ) async {
    await show(tester, [
      section('home', own: true),
      section(
        'team',
        state: 'asleep',
        lastKnownAge: 2 * 3600,
        models: [
          row('DeepSeek-V4-Flash', 'scholes-60001'),
          row('Kimi-K2', 'zeus', offlineMachine: 'Zeus'),
        ],
      ),
      section('lab', state: 'asleep'),
      section('attic', state: 'asleep', lastKnownAge: 60),
      section(
        'garage',
        state: 'unknown',
        seenAt: '2026-09-24T08:00:00.000Z',
        models: [row('Gemma-4-12B', 'garage-box')],
      ),
      section('shed', state: 'waking'),
      section('barn', state: 'asleep', wakeOutcome: 'not_started'),
      section('loft', state: 'awake', wakeOutcome: 'nobody_serving'),
    ]);

    const subtitle =
        'Asleep · starts when you send a message (about 10–30 s) · list from 2 h ago';
    expect(find.text(subtitle), findsOneWidget);
    expect(
      find.byTooltip(
        'Resting to save resources. It starts by itself when you send a message.',
      ),
      findsOneWidget,
    );
    expect(
      top(tester, find.text('Shared · team')) <
          top(tester, find.text(subtitle)),
      isTrue,
    );

    // A section with no record is drawn, with the way to find out what it serves.
    expect(find.text('Shared · lab'), findsOneWidget);
    expect(find.text('Show models'), findsOneWidget);
    expect(find.text('usually 15–40 s'), findsOneWidget);

    expect(find.text('Shared · attic'), findsOneWidget);
    expect(
      find.text('Nobody was serving here when it went to sleep'),
      findsOneWidget,
    );

    expect(find.text('Not answering right now'), findsOneWidget);
    expect(
      top(tester, find.text('Not answering right now')) <
          top(tester, find.text('Gemma-4-12B')),
      isTrue,
    );

    expect(find.text('Starting up… usually 15–40 s'), findsOneWidget);
    expect(
      find.text(
        "Couldn't start barn right now — it will start on your next message",
      ),
      findsOneWidget,
    );
    expect(
      find.text('Nobody is serving a model here right now'),
      findsOneWidget,
    );

    // The offline row: still listed, greyed, and saying why.
    expect(find.text('Kimi-K2'), findsOneWidget);
    expect(
      find.text('Zeus seems offline — its models come back when it does'),
      findsOneWidget,
    );
    Color? ink(String text) =>
        tester.widget<Text>(find.text(text)).style?.color;
    expect(ink('Kimi-K2'), AppPalette.textFaint);
    expect(ink('DeepSeek-V4-Flash'), AppPalette.textPrimary);

    // Counts are models, as they always were.
    expect(find.text('Shared 3'), findsOneWidget);
    expect(saysGrid, findsNothing);

    // A search narrows to what matches; a section with nothing matching says nothing.
    await tester.enterText(
      find.byKey(const ValueKey('models-search')),
      'DeepSeek',
    );
    await tester.pump();
    expect(find.text('Show models'), findsNothing);
    expect(find.text('Shared · lab'), findsNothing);
    expect(find.text('DeepSeek-V4-Flash'), findsOneWidget);
    // …and a section it kept still says what it says about its rows.
    expect(find.text(subtitle), findsOneWidget);
    await tester.enterText(
      find.byKey(const ValueKey('models-search')),
      'Gemma',
    );
    await tester.pump();
    expect(find.text('Not answering right now'), findsOneWidget);
    expect(find.text('Gemma-4-12B'), findsOneWidget);
  });

  testWidgets('the Shared tab draws a speaking section even with no models', (
    tester,
  ) async {
    await show(tester, [
      section('home', own: true),
      section('lab', state: 'asleep'),
    ], tab: ModelsTab.shared);
    expect(find.text('No shared models'), findsNothing);
    expect(find.text('lab'), findsOneWidget);
    expect(find.text('Show models'), findsOneWidget);
  });

  testWidgets('Show models wakes just that section, and says it is starting', (
    tester,
  ) async {
    await show(tester, [
      section('home', own: true),
      section('lab', state: 'asleep'),
    ]);
    daemon.wakeReply = modelsReply([
      section('home', own: true),
      section('lab', state: 'waking'),
    ]);
    await tester.tap(find.text('Show models'));
    await tester.pump();
    await tester.pump();
    expect(daemon.asks.single, {
      'rowState': true,
      'wake': ['lab'],
    });
    expect(find.text('Show models'), findsNothing);
    expect(find.text('Starting up… usually 15–40 s'), findsOneWidget);
    expect(saysGrid, findsNothing);

    // It wakes with its models; the follow-up read finds them, and then stops.
    app.inventory = GridModels.fromReply(
      modelsReply([
        section('home', own: true),
        section(
          'lab',
          state: 'awake',
          models: [row('Qwen3.6-35B-A3B', 'lab-box')],
        ),
      ]),
    );
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(seconds: 10));
  });

  testWidgets('a model parked while this computer rests says so', (
    tester,
  ) async {
    final local = modelInventory(scenario: 'ready');
    final qwen = (local['models'] as List).first as Map<String, dynamic>;
    // What the daemon sends for a parked engine: running, no telemetry, `gridAsleep`.
    qwen
      ..remove('tokensPerSecond')
      ..remove('requests')
      ..remove('windowSeconds')
      ..['gridAsleep'] = true;
    await show(tester, [section('home', own: true)], local: local);
    expect(
      find.text('16.2 GB · Running · resting until your next message'),
      findsOneWidget,
    );
    expect(saysGrid, findsNothing);
    // Still running as far as its controls go: Pause is what it offers.
    expect(
      find.byTooltip(
        'Pause Qwen3.8-27B and free memory. The download is kept.',
      ),
      findsOneWidget,
    );
  });
}

// Your models and the downloads for this machine (Cmd-I / Cmd-P `:`): each row names its model alone,
// lines up its size and speed, and ends with what Enter does — Use, Get — or what is happening to it.
// The model the harness is on says In use. Get on a model the harness can run downloads it, starts
// it and moves the harness onto it in one step; closing the picker stops only the switch.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/model_search_catalog.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/widgets/swarm_resource_preview.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'resource_picker_test.dart' show fixture;
import 'support/model_manager.dart';
import 'support/real_fonts.dart';

final field = find.byKey(const ValueKey('swarm-search-input'));
SwarmSearchController search(WidgetTester tester) =>
    tester.widget<SwarmSearchResults>(find.byType(SwarmSearchResults)).search;

const _gib = 1024 * 1024 * 1024;
const _live = Color(0xFF86E6A3);

/// This Mac as the daemon would describe it: a model running, one downloaded, two versions of one
/// more, and two of the catalog's picks for it.
Map<String, dynamic> _inventory({bool running = true}) => {
  'memoryBytes': 64 * _gib,
  'freeDiskBytes': 114 * _gib,
  'supportsDownload': true,
  'busy': false,
  'models': [
    {
      'id': 'local:Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf',
      'name': 'Qwen3.6-35B-A3B',
      'state': running ? 'running' : 'downloaded',
      'sizeBytes': 27159116064,
      'canStart': !running,
      'canStop': running,
      if (running) 'tokensPerSecond': 21.3,
    },
    {
      'id': 'gemma',
      'name': 'gemma-4-12B',
      'state': 'downloaded',
      'sizeBytes': 7.3 * _gib,
      'canStart': true,
    },
    {
      'id': 'local:Small-Q4_0.gguf',
      'name': 'Small',
      'state': 'downloaded',
      'sizeBytes': 2 * _gib,
      'canStart': true,
    },
    {
      'id': 'local:Small-Q8_0.gguf',
      'name': 'Small',
      'state': 'downloaded',
      'sizeBytes': 4 * _gib,
      'canStart': true,
    },
    {
      'id': 'unsloth/Qwen3.5-9B-GGUF',
      'name': 'Qwen3.5-9B',
      'state': 'available',
      'quant': 'Q4_K_XL',
      'sizeBytes': 5.6 * _gib,
      'canStart': true,
      'recommended': true,
      'contextWindow': 262144,
      'estTokS': 10.2,
      'paramsB': 9,
    },
    {
      'id': 'unsloth/Qwen3.5-4B-GGUF',
      'name': 'Qwen3.5-4B',
      'state': 'available',
      'quant': 'Q4_K_XL',
      'sizeBytes': 2.7 * _gib,
      'canStart': true,
      'contextWindow': 262144,
      'estTokS': 14.5,
    },
  ],
};

class _LocalApp extends ModelManagerTestApp {
  _LocalApp() : super(ModelManagerConnection());

  /// Downloads and starts finish at once, as a fast machine's would; left false, they stay under way.
  bool completeDownloads = false, completeStarts = false;

  /// Stops finish at once: the model is down and off the grid, as a fast machine's would be.
  bool completeStops = false;

  /// Holds each stop until completed: the seconds a real machine takes to bring a model down.
  Completer<void>? stopGate;

  /// A started model runs at once but the grid lists it only on [listHeld]: the gap between running
  /// here and being a model a harness can move onto, which a busy machine took 16s to close.
  bool holdListing = false;
  String? _heldListing;

  void listHeld() {
    final name = _heldListing;
    if (name == null) return;
    inventory = GridModels(
      gridName: 'home',
      models: [
        ...inventory.models,
        GridModel(id: name, node: 'This Mac'),
      ],
    );
    _heldListing = null;
  }

  final selections = <({String agent, String model})>[];

  Map<String, dynamic> _with(
    String modelId,
    Map<String, dynamic> Function(Map<String, dynamic>) change,
  ) {
    final original = inventoryFor('m');
    return {
      ...original,
      'busy': false,
      'models': [
        for (final raw in original['models'] as List)
          if (raw['id'] == modelId)
            change(raw as Map<String, dynamic>)
          else
            raw,
      ],
    };
  }

  @override
  Future<Map<String, dynamic>> downloadLocalModel(
    String machineId,
    String modelId,
  ) async {
    final answer = await super.downloadLocalModel(machineId, modelId);
    if (!completeDownloads) return answer;
    setInventoryFor(
      machineId,
      _with(
        modelId,
        (model) => {...model, 'state': 'downloaded', 'operation': null},
      ),
    );
    return {
      'operation': {...answer['operation'] as Map, 'phase': 'done'},
    };
  }

  @override
  Future<Map<String, dynamic>> controlLocalModel(
    String machineId,
    String modelId, {
    required bool start,
  }) async {
    if (!start) await stopGate?.future;
    final answer = await super.controlLocalModel(
      machineId,
      modelId,
      start: start,
    );
    if (!start && completeStops) {
      late String stopped;
      setInventoryFor(
        machineId,
        _with(modelId, (model) {
          stopped = model['name'] as String;
          return {
            ...model,
            'state': 'downloaded',
            'canStart': true,
            'canStop': false,
            'operation': null,
          };
        }),
      );
      inventory = GridModels(
        gridName: 'home',
        models: [
          for (final model in inventory.models)
            if (model.id != stopped) model,
        ],
      );
      return {
        'operation': {
          ...answer['operation'] as Map<String, dynamic>,
          'phase': 'done',
        },
      };
    }
    if (!start || !completeStarts) return answer;
    late String name;
    setInventoryFor(
      machineId,
      _with(modelId, (model) {
        name = model['name'] as String;
        return {
          ...model,
          'state': 'running',
          'canStart': false,
          'canStop': true,
          'operation': null,
        };
      }),
    );
    if (holdListing) {
      _heldListing = name;
    } else {
      inventory = GridModels(
        gridName: 'home',
        models: [
          ...inventory.models,
          GridModel(id: name, node: 'This Mac'),
        ],
      );
    }
    return {
      'operation': {
        ...answer['operation'] as Map<String, dynamic>,
        'stage': 'verifying',
        'phase': 'done',
      },
    };
  }

  @override
  Future<void> retargetAgentToGridModel(
    String machineId,
    String agentId,
    String modelId, {
    String? gridName,
  }) async {
    selections.add((agent: agentId, model: modelId));
  }
}

Future<_LocalApp> _localFixture({
  String? onModel,
  bool running = true,
  String? alsoOn,
}) async {
  final app = _LocalApp()
    ..inventory = const GridModels(
      gridName: 'home',
      models: [GridModel(id: 'Qwen3.6-35B-A3B', node: 'This Mac')],
    );
  await fixture(provided: app);
  app.localInventory = _inventory(running: running);
  final machine = app.machineStates['m']!
    ..localEndpoint = LocalCliEndpoint(
      computerId: 'fixture',
      wsUri: Uri.parse('ws://fixture.invalid'),
      protocolVersion: 1,
      terminalProtocolVersion: 3,
    )
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded;
  machine.agents.add(
    Agent(
      id: 'a69',
      name: 'Current harness',
      engine: 'claude',
      terminalAvailable: true,
      gridModel: onModel,
    ),
  );
  // Another harness, on [alsoOn]: a stop of that model leaves it without one.
  if (alsoOn != null) {
    machine.agents.add(
      Agent(
        id: 'b70',
        name: 'Review harness',
        engine: 'claude',
        terminalAvailable: true,
        gridModel: alsoOn,
      ),
    );
  }
  await app.modelManager.refresh(force: true);
  return app;
}

SwarmDestination _row(SwarmSearchController picker, String title) =>
    picker.rows.singleWhere((row) => row.title == title);

Finder _inPreview(String text) => find.descendant(
  of: find.byType(SwarmResourcePreview),
  matching: find.text(text),
);

String _status(WidgetTester tester, SwarmDestination row) => tester
    .widget<Text>(find.byKey(ValueKey('model-row-status:${row.id}')))
    .data!;

Color? _statusColor(WidgetTester tester, SwarmDestination row) => tester
    .widget<Text>(find.byKey(ValueKey('model-row-status:${row.id}')))
    .style
    ?.color;

String _facts(WidgetTester tester, SwarmDestination row) => tester
    .widget<Text>(find.byKey(ValueKey('model-row-facts:${row.id}')))
    .data!;

Future<SwarmSearchController> _open(WidgetTester tester, _LocalApp app) async {
  await tester.binding.setSurfaceSize(const Size(1600, 1000));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await configured.mount(tester, app, MemoryKeymap());
  await key(tester, LogicalKeyboardKey.keyI, cmd: true);
  await tester.pumpAndSettle();
  return search(tester);
}

void main() {
  setUpAll(loadRealFonts);

  testWidgets(
    'each model of yours ends with what Enter does, after its size and speed',
    (tester) async {
      final app = await _localFixture();
      try {
        final picker = await _open(tester, app);
        // Named alone: the quantization is in the preview, unless two versions share a name.
        final running = _row(picker, 'Qwen3.6-35B-A3B');
        final downloaded = _row(picker, 'gemma-4-12B');
        final download = _row(picker, 'Qwen3.5-9B');
        expect(_row(picker, 'Small · Q4_0'), isNotNull);
        expect(_row(picker, 'Small · Q8_0'), isNotNull);

        expect(picker.modelSection(running), ModelSearchSection.local);
        expect(picker.modelSection(downloaded), ModelSearchSection.local);
        expect(picker.modelSection(download), ModelSearchSection.catalog);
        picker.move(picker.rows.indexOf(download) - picker.cursor);
        await tester.pumpAndSettle();
        expect(
          find.text('Get for ${thisComputerName()} · 64 GB'),
          findsOneWidget,
        );
        expect(find.text('Your models'), findsOneWidget);
        // Two downloads fit in the list whole: nothing is folded behind "More models".
        expect(picker.rows.where(picker.isModelDownloadsRow), isEmpty);

        // Running: Use, green because it is live. Downloaded: Use, plain. A download: Get, plain.
        expect(_status(tester, running), 'Use');
        expect(_statusColor(tester, running), _live);
        expect(_status(tester, downloaded), 'Use');
        expect(_statusColor(tester, downloaded), isNot(_live));
        expect(_status(tester, download), 'Get');
        expect(_statusColor(tester, download), isNot(_live));
        expect(_statusColor(tester, download), DesktopChrome.selectionDetail);

        // Size, then speed — measured while it runs, else the catalog's estimate for this machine.
        expect(_facts(tester, running), '25 GB · 21 tok/s');
        expect(_facts(tester, download), '5.6 GB · ~10 tok/s');
        expect(_facts(tester, downloaded), '7.3 GB');
        // Every row's columns line up: the size, the speed and the word start where the next row's do.
        final rightEdges = {
          for (final row in [running, downloaded, download])
            tester
                .getTopRight(find.byKey(ValueKey('model-row-status:${row.id}')))
                .dx,
        };
        expect(rightEdges, hasLength(1));
        final factEdges = {
          for (final row in [running, downloaded, download])
            tester
                .getTopLeft(find.byKey(ValueKey('model-row-facts:${row.id}')))
                .dx,
        };
        expect(factEdges, hasLength(1));
        expect(find.text('Suggested'), findsNothing);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets(
    'the model the harness is on says In use, here and in its preview',
    (tester) async {
      final app = await _localFixture(onModel: 'Qwen3.6-35B-A3B');
      try {
        final picker = await _open(tester, app);
        final running = _row(picker, 'Qwen3.6-35B-A3B');
        expect(_status(tester, running), SwarmSearchController.inUseWord);
        expect(_statusColor(tester, running), DesktopChrome.selectionDetail);
        // Cmd-I opens on the model the harness is on.
        expect(picker.selected!.id, running.id);
        expect(_inPreview('Running · this harness is on it'), findsOneWidget);
        // Nothing to do on it, so no sentence about what Enter does.
        expect(find.textContaining('moves this harness onto it'), findsNothing);
        // Another model is not in use.
        expect(_status(tester, _row(picker, 'gemma-4-12B')), 'Use');
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets(
    "a download's preview says what it costs, whether it fits, and what Get does",
    (tester) async {
      final app = await _localFixture();
      try {
        final picker = await _open(tester, app);
        final download = _row(picker, 'Qwen3.5-9B');
        picker.move(picker.rows.indexOf(download) - picker.cursor);
        await tester.pump();
        final here = thisComputerName();
        expect(_inPreview('Not downloaded'), findsOneWidget);
        expect(_inPreview('Download'), findsOneWidget);
        expect(_inPreview('5.6 GB · 114 GB free'), findsOneWidget);
        expect(_inPreview('fits · $here has 64 GB'), findsOneWidget);
        expect(_inPreview('~10 tok/s on $here (estimate)'), findsOneWidget);
        expect(_inPreview('256K'), findsOneWidget);
        expect(_inPreview('9B'), findsOneWidget);
        expect(_inPreview('Q4_K_XL'), findsOneWidget);
        // One local model runs at a time: with Qwen3.6 running, Get stops it to start this one.
        expect(picker.canGetModelForUse(download), isTrue);
        expect(
          _inPreview(
            'Get downloads it, stops Qwen3.6-35B-A3B, starts it, and moves this harness onto it.',
          ),
          findsOneWidget,
        );
        // The old line that read like the model's own size, and the redundant source.
        expect(find.textContaining('✓ fits'), findsNothing);
        expect(_inPreview('Source'), findsNothing);

        // Downloaded weights: a size, not a download, and Use starts them first.
        picker.move(
          picker.rows.indexOf(_row(picker, 'gemma-4-12B')) - picker.cursor,
        );
        await tester.pump();
        expect(_inPreview('Size'), findsOneWidget);
        expect(_inPreview('Download'), findsNothing);
        expect(
          _inPreview(
            'Use stops Qwen3.6-35B-A3B, starts this one, and moves this harness onto it.',
          ),
          findsOneWidget,
        );
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets(
    'Get downloads the model, starts it and moves the harness onto it in one step',
    (tester) async {
      final app = await _localFixture(running: false)
        ..completeDownloads = true
        ..completeStarts = true;
      try {
        final picker = await _open(tester, app);
        final download = _row(picker, 'Qwen3.5-9B');
        picker.move(picker.rows.indexOf(download) - picker.cursor);
        await tester.pump();
        expect(picker.canGetModelForUse(picker.selected), isTrue);
        expect(
          _inPreview(
            'Get downloads it, starts it, and moves this harness onto it.',
          ),
          findsOneWidget,
        );
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(app.downloads, [
          (machine: 'm', model: 'unsloth/Qwen3.5-9B-GGUF'),
        ]);
        expect(app.actions, [
          (machine: 'm', model: 'unsloth/Qwen3.5-9B-GGUF', start: true),
        ]);
        expect(app.selections, [(agent: 'a69', model: 'Qwen3.5-9B')]);
        expect(field, findsNothing);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets(
    'closing the picker during the download stops the switch, not the download',
    (tester) async {
      final app = await _localFixture(running: false);
      try {
        final picker = await _open(tester, app);
        picker.move(
          picker.rows.indexOf(_row(picker, 'Qwen3.5-9B')) - picker.cursor,
        );
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pump();
        expect(app.downloads, hasLength(1));
        // The hint follows the download; the row says so too.
        expect(picker.usingLabel, 'Downloading 42%…');
        expect(find.textContaining('Downloading 42%…'), findsOneWidget);
        expect(_status(tester, _row(picker, 'Qwen3.5-9B')), 'Downloading');
        expect(
          _statusColor(tester, _row(picker, 'Qwen3.5-9B')),
          DesktopChrome.selectionDetail,
        );
        // A longer word does not push its row's columns out of line with a row that says Use.
        double factsLeft(String title) => tester
            .getTopLeft(
              find.byKey(ValueKey('model-row-facts:${_row(picker, title).id}')),
            )
            .dx;
        expect(factsLeft('Qwen3.5-9B'), factsLeft('gemma-4-12B'));
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pump(const Duration(seconds: 5));
        expect(field, findsNothing);
        expect(app.actions, isEmpty);
        expect(app.selections, isEmpty);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  test('sizes read as people say them', () {
    expect(gigabytesLabel(2.7 * _gib), '2.7 GB');
    expect(gigabytesLabel(9.94 * _gib), '9.9 GB');
    expect(gigabytesLabel(9.96 * _gib), '10 GB');
    expect(gigabytesLabel(27159116064), '25 GB');
  });

  testWidgets(
    'a model another app downloaded is one of yours, named with that app, and Use starts it there',
    (tester) async {
      // Nothing else running: this is about the one model, not a switch.
      final app = (await _localFixture(running: false))..completeStarts = true;
      try {
        app.localInventory = {
          ..._inventory(running: false),
          'models': [
            ...(_inventory(running: false)['models'] as List),
            {
              'id': 'app:ollama:llama3.2:3b',
              'name': 'llama3.2:3b',
              'state': 'downloaded',
              'sizeBytes': 2 * _gib,
              'canStart': true,
              'app': 'Ollama',
            },
          ],
        };
        await app.modelManager.refresh(force: true);
        final picker = await _open(tester, app);
        final ollama = _row(picker, 'llama3.2:3b');
        expect(picker.modelSection(ollama), ModelSearchSection.local);
        expect(_status(tester, ollama), 'Use');
        // No speed is known before it runs: the app it came from takes that column.
        expect(_facts(tester, ollama), '2.0 GB · Ollama');
        picker.move(picker.rows.indexOf(ollama) - picker.cursor);
        await tester.pumpAndSettle();
        expect(_inPreview('Runs in'), findsOneWidget);
        expect(_inPreview('Ollama'), findsOneWidget);
        // Use is the same act as for Grid's own: the daemon starts it (in Ollama), and the harness moves on.
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(app.actions, [
          (machine: 'm', model: 'app:ollama:llama3.2:3b', start: true),
        ]);
        expect(app.selections, [(agent: 'a69', model: 'llama3.2:3b')]);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets(
    'one Use: the row says Starting until the harness is on the model, then it moves',
    (tester) async {
      final app = (await _localFixture(running: false))
        ..completeStarts = true
        ..holdListing = true;
      try {
        final picker = await _open(tester, app);
        final gemma = _row(picker, 'gemma-4-12B');
        picker.move(picker.rows.indexOf(gemma) - picker.cursor);
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pump(const Duration(seconds: 3));
        // Running here, not yet a model the harness can move onto: never Use, which read as a second
        // click to make.
        expect(app.actions, [(machine: 'm', model: 'gemma', start: true)]);
        expect(_status(tester, gemma), 'Starting');
        expect(app.selections, isEmpty);
        app.listHeld();
        await tester.pump(const Duration(seconds: 3));
        await tester.pumpAndSettle();
        expect(app.selections, [(agent: 'a69', model: 'gemma-4-12B')]);
        // The one start, and nothing a second time.
        expect(app.actions, [(machine: 'm', model: 'gemma', start: true)]);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets(
    'Use on another model stops the one running, starts this one and moves the harness, in one step',
    (tester) async {
      final app = (await _localFixture(onModel: 'Qwen3.6-35B-A3B'))
        ..completeStarts = true
        ..completeStops = true
        ..stopGate = Completer<void>();
      try {
        final picker = await _open(tester, app);
        final gemma = _row(picker, 'gemma-4-12B');
        picker.move(picker.rows.indexOf(gemma) - picker.cursor);
        await tester.pumpAndSettle();
        expect(
          _inPreview(
            'Use stops Qwen3.6-35B-A3B, starts this one, and moves this harness onto it.',
          ),
          findsOneWidget,
        );
        await key(tester, LogicalKeyboardKey.enter);
        // The host is busy with that stop, which the hint names: no "Host busy" warns about it.
        expect(
          find.textContaining('Stopping Qwen3.6-35B-A3B…'),
          findsOneWidget,
        );
        expect(_inPreview('Host busy'), findsNothing);
        app.stopGate!.complete();
        await tester.pump(const Duration(seconds: 3));
        await tester.pump(const Duration(seconds: 3));
        await tester.pumpAndSettle();
        // The harness on it was this one, so nobody is asked: stop, start, move.
        expect(app.actions, [
          (
            machine: 'm',
            model: 'local:Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf',
            start: false,
          ),
          (machine: 'm', model: 'gemma', start: true),
        ]);
        expect(app.selections, [(agent: 'a69', model: 'gemma-4-12B')]);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets(
    'another harness on the running model is asked about before it stops; Cancel leaves both',
    (tester) async {
      final app = (await _localFixture(alsoOn: 'Qwen3.6-35B-A3B'))
        ..completeStarts = true
        ..completeStops = true;
      try {
        final picker = await _open(tester, app);
        final gemma = _row(picker, 'gemma-4-12B');
        picker.move(picker.rows.indexOf(gemma) - picker.cursor);
        await tester.pumpAndSettle();
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(find.text('Stop Qwen3.6-35B-A3B?'), findsOneWidget);
        expect(
          find.textContaining(
            'Review harness uses it, and will stop answering',
          ),
          findsOneWidget,
        );
        // Cancel holds the focus: a stray Return stops nothing.
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(find.text('Stop Qwen3.6-35B-A3B?'), findsNothing);
        expect(app.actions, isEmpty);
        expect(app.selections, isEmpty);

        // Focus is back on the picker: Enter asks again.
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Stop and switch'));
        await tester.pump(const Duration(seconds: 3));
        await tester.pump(const Duration(seconds: 3));
        await tester.pumpAndSettle();
        expect(app.actions.map((action) => action.start), [false, true]);
        expect(app.selections, [(agent: 'a69', model: 'gemma-4-12B')]);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );
}

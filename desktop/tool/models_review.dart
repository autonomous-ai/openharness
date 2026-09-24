// Interactive native review of the real Models UI, with isolated model responses.
// FLUTTER_TEST=1 flutter run -d macos -t tool/models_review.dart
// F6 theme, F7 connection failure, F8 fail next download, F9 large text.
// No model files, credentials, production daemons, or live sessions are used.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:window_manager/window_manager.dart';

import '../test/support/model_manager.dart';

class ReviewSubscriptions extends ModelsMenuController {
  @override
  List<Map<String, Object?>> get rows => const [
    {
      'title': 'OpenAI',
      'account': 'aabbcc',
      'status': '76% remaining',
      'remainingPercent': 76.0,
      'iconAsset': 'assets/engine-icons/codex.png',
    },
    {'title': 'Anthropic', 'status': 'Usage unavailable'},
  ];
  @override
  Future<void> refresh() async {}
}

class ReviewApp extends ModelManagerTestApp {
  ReviewApp() : super(ModelManagerConnection());
  bool failNextDownload = false;
  int serial = 0;
  final timers = <Timer>[];

  void publish(String id, Map<String, dynamic> fields, {required bool busy}) {
    localInventory = {
      ...localInventory,
      'busy': busy,
      'models': [
        for (final raw in localInventory['models'] as List)
          if (raw['id'] == id)
            {...raw as Map<String, dynamic>, ...fields}
          else
            raw,
      ],
    };
    unawaited(modelManager.refresh());
  }

  @override
  Future<Map<String, dynamic>> controlLocalModel(
    String machineId,
    String modelId, {
    required bool start,
  }) async {
    final rows = (localInventory['models'] as List)
        .cast<Map<String, dynamic>>();
    final current = rows.firstWhere((r) => r['id'] == modelId);
    final other = rows
        .where((r) => r['state'] == 'running' && r['id'] != modelId)
        .firstOrNull;
    final operation = <String, dynamic>{
      'id': 'review-${++serial}',
      'modelId': modelId,
      'action': start ? 'start' : 'stop',
      'phase': 'running',
      'stage': start ? 'checking' : 'stopping',
    };
    publish(modelId, {
      'operation': {...operation},
    }, busy: true);
    void later(int seconds, void Function() action) =>
        timers.add(Timer(Duration(seconds: seconds), action));
    if (start && other != null) {
      later(
        1,
        () => publish(modelId, {
          'operation': {
            ...operation,
            'phase': 'failed',
            'error':
                'Stop ${other['name']} first to start another local model.',
          },
        }, busy: false),
      );
    } else if (!start) {
      later(
        2,
        () => publish(modelId, {
          'state': 'downloaded',
          'canStop': false,
          'canStart': true,
          'operation': {...operation, 'phase': 'done'},
        }, busy: false),
      );
    } else {
      final shouldFail = failNextDownload;
      failNextDownload = false;
      final downloaded = current['state'] == 'downloaded';
      if (!downloaded) {
        later(
          1,
          () => publish(modelId, {
            'operation': {
              ...operation,
              'stage': 'downloading',
              'progress': .42,
            },
          }, busy: true),
        );
      }
      if (shouldFail) {
        later(
          3,
          () => publish(modelId, {
            'operation': {
              ...operation,
              'phase': 'failed',
              'stage': 'downloading',
              'error': 'The download stopped. Start again to resume.',
            },
          }, busy: false),
        );
      } else {
        later(
          downloaded ? 1 : 4,
          () => publish(modelId, {
            'operation': {...operation, 'stage': 'starting'},
          }, busy: true),
        );
        later(
          downloaded ? 3 : 6,
          () => publish(modelId, {
            'operation': {...operation, 'stage': 'verifying'},
          }, busy: true),
        );
        later(
          downloaded ? 5 : 8,
          () => publish(modelId, {
            'state': 'running',
            'canStart': false,
            'canStop': true,
            'tokensPerSecond': 17.6,
            'requests': 1,
            'windowSeconds': 86400,
            'operation': {...operation, 'stage': 'verifying', 'phase': 'done'},
          }, busy: false),
        );
      }
    }
    return {
      'operation': {...operation},
    };
  }

  @override
  Future<GridModels> gridModels(String machineId) async => GridModels(
    gridName: 'home',
    models: [
      for (final raw in localInventory['models'] as List)
        if (raw['state'] == 'running')
          GridModel(
            id: raw['name'] as String,
            node: 'This computer',
            grid: 'home',
          ),
    ],
    gridCli: GridCli.managed,
    grids: [
      GridSection(
        name: 'home',
        own: true,
        models: [
          for (final raw in localInventory['models'] as List)
            if (raw['state'] == 'running')
              GridModel(
                id: raw['name'] as String,
                node: 'This computer',
                grid: 'home',
              ),
        ],
      ),
      const GridSection(
        name: 'Team',
        own: false,
        models: [
          GridModel(
            id: 'Team coding model',
            node: 'Shared computer',
            grid: 'Team',
          ),
        ],
      ),
    ],
  );

  void choose(String? model) {
    stateOf('m')!.agents = [
      for (final agent in stateOf('m')!.agents)
        if (agent.id == 'work')
          Agent(
            id: 'work',
            name: 'Write a README',
            engine: 'codex',
            terminalAvailable: true,
            gridModel: model,
          )
        else
          agent,
    ];
    activeTerminal?.terminal.write('\r\n  Selected ${model ?? 'OpenAI'}.\r\n');
    notifyListeners();
  }

  @override
  Future<void> retargetAgentToGridModel(
    String machineId,
    String agentId,
    String modelId, {
    String? gridName,
  }) async => choose(modelId);
  @override
  Future<void> clearAgentGrid(String machineId, String agentId) async =>
      choose(null);
  @override
  void dispose() {
    for (final timer in timers) {
      timer.cancel();
    }
    super.dispose();
  }
}

Future<void> main() async {
  if (!kUnderTest) {
    throw StateError('Launch this isolated review with FLUTTER_TEST=1.');
  }
  // FLUTTER_TEST defaults Flutter's platform to Android. Keep the native Mac
  // editing shortcuts in this guarded interactive test.
  debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  await const MethodChannel('harness/swarm_tabs').invokeMethod('configure', {
    'palette': grid.AppTheme.palette.value.nativeColors,
  });
  await windowManager.setSize(const Size(1200, 800));
  await windowManager.setTitle('Models user test');
  final app = ReviewApp();
  app.stateOf('m')!.localEndpoint = LocalCliEndpoint(
    computerId: 'review-computer',
    wsUri: Uri.parse('ws://fixture.invalid'),
    protocolVersion: 1,
    terminalProtocolVersion: 3,
  );
  app.stateOf('m')!.agents = [
    const Agent(
      id: 'work',
      name: 'Write a README',
      engine: 'codex',
      terminalAvailable: true,
    ),
  ];
  final session =
      TerminalSession(
          machineId: 'm',
          agentId: 'work',
          agentName: 'Write a README',
          engineId: 'codex',
          send: (_, _) async => true,
          sendBinary: (_) async => true,
        )
        ..status = TerminalSessionStatus.controlling
        ..streamId = 'review-stream';
  session.terminal.write(
    '  Write a concise README for a notes app.\r\n\r\n  This is an isolated UI review. Model responses are fixtures.\r\n',
  );
  // This guarded entry point is an interactive test, with no real session.
  // ignore: invalid_use_of_visible_for_testing_member
  app.adoptSessionForTest(session);
  app.renameSwarm(app.activeSwarmId, 'Models user test');
  final subscriptions = ReviewSubscriptions();
  runApp(ReviewHost(app: app, subscriptions: subscriptions));
  app.modelManager.start();
  await windowManager.show();
  await windowManager.focus();
}

class ReviewHost extends StatefulWidget {
  const ReviewHost({super.key, required this.app, required this.subscriptions});
  final ReviewApp app;
  final ReviewSubscriptions subscriptions;
  @override
  State<ReviewHost> createState() => _ReviewHostState();
}

class _ReviewHostState extends State<ReviewHost> {
  bool large = false;
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
    valueListenable: grid.AppTheme.brightness,
    builder: (context, brightness, _) => MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.f6): () =>
              grid.AppTheme.brightness.value = brightness == Brightness.dark
              ? Brightness.light
              : Brightness.dark,
          const SingleActivator(LogicalKeyboardKey.f7): () {
            widget.app.localReadFails = !widget.app.localReadFails;
            unawaited(widget.app.modelManager.refresh());
          },
          const SingleActivator(LogicalKeyboardKey.f8): () =>
              widget.app.failNextDownload = true,
          const SingleActivator(LogicalKeyboardKey.f9): () =>
              setState(() => large = !large),
        },
        child: MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(large ? 1.7 : 1)),
          child: child!,
        ),
      ),
      home: SwarmScreen(
        notifier: widget.app,
        nativeTabs: true,
        modelsMenu: widget.subscriptions,
      ),
    ),
  );
}

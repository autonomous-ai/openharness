import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/model_manager_controller.dart';
import 'package:harness/models/models_panel.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/usage/usage_controller.dart';
import 'package:harness/usage/usage_source.dart';
import 'package:harness/usage/usage_window.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'support/model_manager.dart';
import 'support/real_fonts.dart';
import 'swarm_screen_test.dart' show terminal;

class _Subscription implements UsageSource {
  @override
  UsageProvider get provider => UsageProvider.codex;
  @override
  Future<ProviderUsage> read() async => ProviderUsage(
    provider: provider,
    status: UsageStatus.ok,
    account: 'aabbccddeeff0011',
    fetchedAt: DateTime.now(),
    windows: const [UsageWindow(label: 'Session', usedPercent: 24)],
  );
}

class _SubscriptionRows extends ModelsMenuController {
  _SubscriptionRows([
    this.entries = const [
      {
        'title': 'OpenAI',
        'account': 'abc123',
        'status': '0% remaining',
        'remainingPercent': 0.0,
      },
      {'title': 'OpenAI', 'account': 'def456', 'status': 'Usage unavailable'},
    ],
  ]);
  final List<Map<String, Object?>> entries;
  @override
  List<Map<String, Object?>> get rows => entries;
  @override
  Future<void> refresh() async {}
}

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide')..addFont(
          rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
        ))
        .load();
  });

  testWidgets(
    'source tabs isolate rows, search each source, and keep counts on refresh',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(700, 800);
      addTearDown(tester.view.reset);
      final app = ModelManagerTestApp(ModelManagerConnection());
      final controller = ModelManagerController(app, poll: false);
      final subscriptions = _SubscriptionRows();
      addTearDown(() {
        controller.dispose();
        subscriptions.dispose();
        app.dispose();
      });
      var closed = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: 640,
                child: ModelsPanel(
                  controller: controller,
                  subscriptions: subscriptions,
                  newModelIds: const {'qwen'},
                  initialTab: ModelsTab.subscriptions,
                  onClose: () => closed++,
                  onManage: () {},
                ),
              ),
            ),
          ),
        ),
      );
      expect(find.text('Subscriptions 2'), findsOneWidget);
      expect(find.text('Local 0'), findsOneWidget);
      expect(find.text('Shared 0'), findsOneWidget);
      expect(find.text('All 2'), findsOneWidget);
      expect(find.textContaining('Running '), findsNothing);
      expect(find.text('Account abc123'), findsOneWidget);
      expect(find.text('Account def456'), findsOneWidget);
      expect(find.text('0% left'), findsOneWidget);
      expect(find.text('This computer'), findsNothing);
      final search = find.byKey(const ValueKey('models-search'));
      await tester.enterText(search, 'ABC123');
      await tester.pump();
      expect(find.text('Account abc123'), findsOneWidget);
      expect(find.text('Account def456'), findsNothing);
      expect(find.text('Subscriptions 2'), findsOneWidget);
      await tester.enterText(search, 'missing');
      await tester.pump();
      expect(find.text('No matching subscriptions'), findsOneWidget);
      await tester.tap(find.byTooltip('Clear search'));
      await tester.tap(find.text('Shared 0'));
      await tester.pump();
      expect(find.text('Finding shared models…'), findsOneWidget);
      await tester.tap(find.text('Local 0'));
      await tester.pump();
      expect(find.text('Finding models that fit…'), findsOneWidget);
      await tester.tap(find.text('Shared 0'));
      app.stateOf('m')!.connectionStatus = ConnectionStatus.disconnected;
      await controller.refresh();
      await tester.pump();
      expect(
        find.text('Connect this computer to see its models.'),
        findsOneWidget,
      );
      expect(find.text('No shared models'), findsNothing);
      app.stateOf('m')!.connectionStatus = ConnectionStatus.connected;
      app.localInventory = {'models': [], 'busy': false};
      await tester.tap(find.text('Try again'));
      await tester.pump();
      expect(find.text('No shared models'), findsOneWidget);
      await tester.tap(find.text('Local 0'));
      await tester.pump();
      expect(find.text('No compatible models found'), findsOneWidget);
      expect(find.text('Account abc123'), findsNothing);
      expect(find.textContaining('Downloaded'), findsNothing);
      await tester.enterText(
        find.byKey(const ValueKey('models-search')),
        'missing',
      );
      await tester.pump();
      expect(find.text('No matching models'), findsOneWidget);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyA);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('models-search')),
      );
      expect(
        field.controller!.selection,
        const TextSelection(baseOffset: 0, extentOffset: 7),
      );
      await tester.tap(find.byTooltip('Clear search'));
      await tester.pump();
      expect(find.byTooltip('Clear search'), findsNothing);
      expect(find.text('No matching models'), findsNothing);
      expect(field.focusNode!.hasFocus, isTrue);
      await tester.tap(find.text('Shared 0'));
      await tester.pump();
      expect(find.text('No shared models'), findsOneWidget);
      app.inventory = const GridModels(
        gridName: 'home',
        models: [],
        grids: [
          GridSection(
            name: 'Team',
            own: false,
            models: [GridModel(id: 'Shared Qwen', node: 'Team computer')],
          ),
        ],
      );
      app.localInventory = modelInventory();
      await controller.refresh(force: true);
      await tester.pump();
      expect(find.text('Local 5'), findsOneWidget);
      expect(find.text('Shared 1'), findsOneWidget);
      expect(find.text('Team'), findsOneWidget);
      expect(find.text('Shared Qwen'), findsOneWidget);
      expect(find.text('Team computer'), findsOneWidget);
      expect(find.text('New'), findsNothing);
      expect(find.text('Qwen3.8-27B'), findsNothing);
      await tester.enterText(search, 'TEAM COMPUTER');
      await tester.pump();
      expect(find.text('Shared Qwen'), findsOneWidget);
      await tester.enterText(search, 'missing');
      await tester.pump();
      expect(find.text('No matching models'), findsOneWidget);
      await tester.tap(find.byTooltip('Clear search'));
      await tester.tap(find.text('Local 5'));
      await tester.pump();
      expect(find.text('gemma-4-12B'), findsOneWidget);
      expect(find.text('Qwen3.8-27B'), findsOneWidget);
      expect(find.text('New'), findsOneWidget);
      expect(find.text('7.3 GB'), findsOneWidget);
      expect(find.text('16.2 GB'), findsOneWidget);
      expect(find.textContaining(' on disk'), findsNothing);
      expect(find.textContaining(' download'), findsNothing);
      expect(find.text('Shared Qwen'), findsNothing);
      app.localReadFails = true;
      await controller.refresh();
      await tester.pump();
      expect(find.text('Models are unavailable. Try again.'), findsOneWidget);
      expect(
        tester
            .widget<IconButton>(
              find.byKey(const ValueKey('model-action-gemma')),
            )
            .onPressed,
        isNull,
      );
      app.localReadFails = false;
      await tester.tap(find.text('Try again'));
      await tester.pump();
      expect(find.text('Models are unavailable. Try again.'), findsNothing);
      app.inventory = const GridModels.unreachable();
      await controller.refresh(force: true);
      await tester.tap(find.byKey(const ValueKey('models-tab-shared')));
      await tester.pump();
      expect(find.text('Shared models are unavailable.'), findsOneWidget);
      expect(find.text('No shared models'), findsNothing);
      app.inventory = const GridModels(gridName: 'home', models: []);
      await tester.tap(find.text('Try again'));
      await tester.pump();
      expect(find.text('No shared models'), findsOneWidget);
      await tester.tap(find.byTooltip('Close Models'));
      expect(closed, 1);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets('download, play and pause reflect file and engine state', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(700, 800);
    addTearDown(tester.view.reset);
    final app = ModelManagerTestApp(ModelManagerConnection());
    final controller = ModelManagerController(app, poll: false);
    final subscriptions = _SubscriptionRows();
    addTearDown(() {
      controller.dispose();
      subscriptions.dispose();
      app.dispose();
    });
    for (final state in ['available', 'downloaded', 'running']) {
      final running = state == 'running';
      app.localInventory = modelInventory(
        scenario: running ? 'ready' : 'first',
      );
      (app.localInventory['models'] as List).first['state'] = state;
      await controller.refresh();
      app.actionReply = Completer<Map<String, dynamic>>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: 640,
                child: ModelsPanel(
                  controller: controller,
                  subscriptions: subscriptions,
                  onClose: () {},
                  onManage: () {},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Local 5'));
      await tester.pump();
      final control = find.byKey(const ValueKey('model-action-qwen'));
      expect(
        find.descendant(
          of: control,
          matching: find.byIcon(switch (state) {
            'running' => LucideIcons.pause,
            'downloaded' => LucideIcons.play,
            _ => LucideIcons.download,
          }),
        ),
        findsOneWidget,
      );
      expect(tester.getSize(control), const Size(40, 40));
      expect(
        find.byTooltip(
          running
              ? 'Pause Qwen3.8-27B and free memory. The download is kept.'
              : state == 'downloaded'
              ? 'Start Qwen3.8-27B'
              : 'Download and start Qwen3.8-27B',
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('model-action-gemma')),
          matching: find.byIcon(LucideIcons.play),
        ),
        findsOneWidget,
      );
      expect(find.byTooltip('Start gemma-4-12B'), findsOneWidget);
      await tester.tap(control);
      await tester.pump();
      expect(find.text(running ? 'Stopping' : 'Starting'), findsOneWidget);
      expect(control, findsNothing);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(
        tester
            .widget<IconButton>(
              find.byKey(const ValueKey('model-action-gemma')),
            )
            .onPressed,
        isNull,
      );
      app.actionReply!.complete({'error': 'Operation refused'});
      await tester.pump();
      expect(app.actions.last.start, !running);
    }
    app.localInventory = modelInventory(scenario: 'ready');
    for (final seconds in [60, 65]) {
      (app.localInventory['models'] as List).first['windowSeconds'] = seconds;
      await controller.refresh();
      await tester.pump();
      expect(
        find.text(
          '16.2 GB · 17.6 tok/s · 42 requests / ${seconds == 60 ? '1m' : '65s'}',
        ),
        findsOneWidget,
      );
    }
    (app.localInventory['models'] as List).first['requests'] = 1;
    await controller.refresh();
    await tester.pump();
    expect(find.text('16.2 GB · 17.6 tok/s · 1 request / 65s'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('source changes preserve downloads and open at the top', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(700, 420);
    addTearDown(tester.view.reset);
    final app = ModelManagerTestApp(ModelManagerConnection());
    final controller = ModelManagerController(app, poll: false);
    final subscriptions = _SubscriptionRows([]);
    addTearDown(() {
      controller.dispose();
      subscriptions.dispose();
      app.dispose();
    });
    await controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ModelsPanel(
            controller: controller,
            subscriptions: subscriptions,
            initialTab: ModelsTab.local,
            onClose: () {},
            onManage: () {},
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('model-action-qwen')));
    await tester.pump();
    expect(find.text('Downloading · 42%'), findsOneWidget);
    await tester.drag(
      find.byKey(const ValueKey(ModelsTab.local)),
      const Offset(0, -500),
    );
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Downloading · 42%').hitTestable(), findsNothing);
    await tester.tap(find.text('Subscriptions 0'));
    await tester.pump();
    expect(find.text('No subscriptions').hitTestable(), findsOneWidget);
    expect(find.text('Downloading · 42%'), findsNothing);
    await tester.tap(find.text('Local 5'));
    await tester.pump();
    expect(find.text('Downloading · 42%').hitTestable(), findsOneWidget);
    expect(app.actions, hasLength(1));
    expect(controller.busy, isTrue);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'the one-time invitation leads to discovery and verified readiness explains selection',
    (tester) async {
      final app = ModelManagerTestApp(ModelManagerConnection());
      app.stateOf('m')!.agents = [
        const Agent(id: 'work', name: 'Work', engine: 'codex'),
      ];
      final controller = ModelManagerController(app, poll: false);
      addTearDown(() {
        controller.dispose();
        app.dispose();
      });
      controller.start();
      await controller.prepare();
      await controller.refresh();
      var opens = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalModelInvitation(
              controller: controller,
              onOpen: () => opens++,
            ),
          ),
        ),
      );
      expect(find.text('Run AI on this computer'), findsOneWidget);
      await tester.tap(find.text('Explore models'));
      expect(opens, 1);
      await tester.tap(find.byTooltip('Dismiss'));
      await tester.pump();
      expect(find.text('Run AI on this computer'), findsNothing);
      app.localInventory = modelInventory(scenario: 'ready');
      await controller.refresh();
      await tester.pump();
      expect(find.text('Qwen3.8-27B is running'), findsOneWidget);
      expect(
        find.text('Select it from the model picker in a session.'),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('Dismiss'));
      await tester.pump();
      expect(find.text('Qwen3.8-27B is running'), findsNothing);
      expect(app.sent, isEmpty);
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final brightness in [Brightness.dark, Brightness.light]) {
    for (final scenario in [
      'first',
      'downloading',
      'ready',
      'error',
      'narrow',
    ]) {
      testWidgets('Models $scenario in ${brightness.name}', (tester) async {
        final narrow = scenario == 'narrow';
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = narrow
            ? const Size(360, 500)
            : const Size(700, 780);
        addTearDown(tester.view.reset);
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        final app = ModelManagerTestApp(ModelManagerConnection());
        final controller = ModelManagerController(app, poll: false);
        final usage = UsageController(
          sources: [_Subscription()],
          autoStart: false,
        );
        final subscriptions = ModelsMenuController(usage: usage);
        addTearDown(() {
          controller.dispose();
          subscriptions.dispose();
          usage.dispose();
          app.dispose();
        });
        await subscriptions.refresh();
        app.localInventory = modelInventory(scenario: scenario);
        await controller.refresh();
        var manages = 0, closes = 0;
        final boundary = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(narrow ? 1.7 : 1)),
                child: child!,
              ),
              home: Scaffold(
                body: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: SizedBox(
                      width: 640,
                      child: ModelsPanel(
                        controller: controller,
                        subscriptions: subscriptions,
                        onClose: () => closes++,
                        onManage: () => manages++,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.ensureVisible(find.text('Local 5'));
        await tester.tap(find.text('Local 5'));
        await tester.pump();
        await tester.runAsync(() async {
          for (final asset in [
            'assets/model-icons/qwen.png',
            'assets/model-icons/gemma.png',
            'assets/model-icons/openai.png',
          ]) {
            await precacheImage(
              AssetImage(asset),
              tester.element(find.byType(ModelsPanel)),
            );
          }
        });
        await tester.pump(const Duration(milliseconds: 300));
        expect(tester.takeException(), isNull);
        expect(find.text('Models'), findsOneWidget);
        expect(find.text('Chat'), findsNothing);
        expect(find.text('Use'), findsNothing);
        expect(find.widgetWithText(TextButton, 'Start'), findsNothing);
        expect(find.widgetWithText(TextButton, 'Stop'), findsNothing);
        expect(find.text('Set up local model'), findsNothing);
        expect(find.textContaining('Downloaded'), findsNothing);
        expect(find.textContaining('Running ·'), findsNothing);
        if (scenario == 'downloading') {
          expect(find.text('Downloading · 42%'), findsOneWidget);
          expect(
            find.byWidgetPredicate(
              (widget) =>
                  widget is LinearProgressIndicator && widget.value == .42,
            ),
            findsOneWidget,
          );
        }
        if (scenario == 'ready') {
          expect(find.byIcon(LucideIcons.pause), findsOneWidget);
          expect(
            find.text('16.2 GB · 17.6 tok/s · 42 requests / 24h'),
            findsOneWidget,
          );
        }
        if (scenario == 'error') {
          expect(
            find.text('The download stopped. Start again to resume.'),
            findsOneWidget,
          );
        }
        final output = Platform.environment['HARNESS_MODELS_CAPTURE_DIR'];
        if (output != null) {
          await tester.runAsync(() async {
            final rendered =
                boundary.currentContext!.findRenderObject()
                    as RenderRepaintBoundary;
            final image = await rendered.toImage(pixelRatio: 2);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(output).create(recursive: true);
            await File('$output/${brightness.name}-$scenario.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }
        if (scenario == 'first') {
          await tester.tap(find.byKey(const ValueKey('model-action-qwen')));
          await tester.pump();
          expect(app.actions.single.start, isTrue);
          expect(app.sent, isEmpty);
          expect(app.panes, isEmpty);
          expect(closes, 0);
          await tester.enterText(
            find.byKey(const ValueKey('models-search')),
            'gpt',
          );
          await tester.pump();
          expect(find.text('gpt-oss-20b'), findsOneWidget);
          expect(find.text('Qwen3.8-27B'), findsNothing);
        }
        if (scenario == 'ready') {
          await tester.tap(find.text('Subscriptions 1'));
          await tester.pump();
          expect(find.text('OpenAI'), findsOneWidget);
          expect(find.text('76% left'), findsOneWidget);
          expect(find.text('Qwen3.8-27B'), findsNothing);
          expect(find.text('gemma-4-12B'), findsNothing);
        }
        await tester.tap(find.text('Manage models'));
        expect(manages, 1);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        expect(closes, 1);
        await tester.pumpWidget(const SizedBox());
      });
    }
  }

  testWidgets('Models opens beside the monitor and preserves the workspace', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1200, 760);
    addTearDown(tester.view.reset);
    final previous = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = Brightness.dark;
    addTearDown(() => grid.AppTheme.brightness.value = previous);
    final app = ModelManagerTestApp(ModelManagerConnection());
    app.stateOf('m')!.localEndpoint = LocalCliEndpoint(
      computerId: 'preview-computer',
      wsUri: Uri.parse('ws://fixture.invalid'),
      protocolVersion: 1,
      terminalProtocolVersion: 3,
    );
    app.stateOf('m')!.agents = [
      const Agent(id: 'work', name: 'Build the next thing', engine: 'codex'),
    ];
    app.localInventory['models'] = [
      ...app.localInventory['models'] as List,
      for (var i = 0; i < 8; i++)
        {
          'id': 'extra-$i',
          'name': 'Additional model $i',
          'state': 'available',
          'sizeBytes': 4 * 1024 * 1024 * 1024,
          'canStart': true,
        },
    ];
    final session = terminal('work', [])..agentName = 'Build the next thing';
    session.terminal.write(
      '  Ready when you are.\r\n\r\n'
      '  Ask me to build, fix, or explore something.\r\n',
    );
    app.adoptSessionForTest(session);
    app.renameSwarm(app.activeSwarmId, 'My project');
    final projects = SwarmProjectStore();
    final usage = UsageController(sources: [_Subscription()], autoStart: false);
    final subscriptions = ModelsMenuController(usage: usage);
    var appDisposed = false;
    addTearDown(() {
      subscriptions.dispose();
      usage.dispose();
      projects.dispose();
      if (!appDisposed) app.dispose();
    });
    final boundary = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundary,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: false,
            projectStore: projects,
            modelsMenu: subscriptions,
          ),
        ),
      ),
    );
    final tab = app.activeSwarmId;
    final panes = app.panes.map((pane) => pane.id).toList();
    final button = find.byKey(const ValueKey('swarm-models-button'));
    app.modelManager.start();
    await app.modelManager.refresh();
    await tester.pump();
    expect(find.text('Explore models'), findsNothing);
    await tester.tap(button);
    await tester.pump();
    await tester.tap(find.textContaining('Local').first);
    await tester.pump();
    expect(find.text('Qwen3.8-27B'), findsOneWidget);
    expect(find.text('Search models…'), findsOneWidget);
    expect(tester.getSize(find.byType(ModelsPanel)).height, greaterThan(620));
    expect(tester.getRect(find.byType(ModelsPanel)).bottom, lessThan(760));
    tester.view.physicalSize = const Size(1200, 480);
    await tester.pump();
    expect(tester.getRect(find.byType(ModelsPanel)).bottom, lessThan(480));
    expect(find.text('Manage models').hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
    tester.view.physicalSize = const Size(1200, 760);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.tap(button);
    await tester.pump();
    await tester.runAsync(() async {
      for (final asset in [
        'assets/engine-icons/codex.png',
        'assets/harnesses.png',
        'assets/models.png',
        'assets/model-icons/qwen.png',
        'assets/model-icons/gemma.png',
        'assets/model-icons/openai.png',
        'assets/store/polymath.png',
      ]) {
        await precacheImage(
          AssetImage(asset),
          tester.element(find.byType(ModelsPanel)),
        );
      }
    });
    await tester.pump(const Duration(milliseconds: 300));
    final panel = tester.getRect(find.byType(ModelsPanel));
    expect(panel.right, 1190);
    expect(panel.top, greaterThan(tester.getRect(button).bottom));
    expect(panel.width, 640);
    expect(
      tester.getRect(button).right,
      lessThan(tester.getRect(find.byTooltip('Harnesses')).left),
    );
    expect(find.byType(Dialog), findsNothing);
    expect(find.text('Search models…'), findsOneWidget);
    expect(find.text('All 14'), findsOneWidget);
    expect(find.text('Subscriptions'), findsOneWidget);
    expect(find.text('Qwen3.8-27B'), findsOneWidget);
    expect(find.text('Run AI on this computer'), findsNothing);
    expect(app.activeSwarmId, tab);
    expect(app.panes.map((pane) => pane.id), panes);
    expect(tester.takeException(), isNull);

    final output = Platform.environment['HARNESS_MODELS_CAPTURE_DIR'];
    if (output != null) {
      await tester.runAsync(() async {
        final rendered =
            boundary.currentContext!.findRenderObject()
                as RenderRepaintBoundary;
        final image = await rendered.toImage(pixelRatio: 2);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$output/workspace.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });
    }
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.byType(ModelsPanel), findsNothing);
    await tester.tap(button);
    await tester.pump();
    await tester.tapAt(const Offset(50, 400));
    await tester.pump();
    expect(find.byType(ModelsPanel), findsNothing);
    expect(app.activeSwarmId, tab);
    expect(app.panes.map((pane) => pane.id), panes);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    appDisposed = true;
  });
}

import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/logging/redact.dart';
import 'package:harness/models/api_connections_controller.dart';
import 'package:harness/models/model_manager_controller.dart';
import 'package:harness/models/models_panel.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;

import 'support/model_manager.dart';
import 'support/real_fonts.dart';

const preset = {
  'provider': 'openrouter',
  'name': 'OpenRouter',
  'baseUrl': 'https://openrouter.ai/api/v1',
  'keyEnv': 'OPENROUTER_API_KEY',
  'authHeader': 'Authorization',
  'authPrefix': 'Bearer',
  'keyUrl': 'https://openrouter.ai/settings/keys',
};

class _ApiApp extends ModelManagerTestApp {
  _ApiApp() : super(ModelManagerConnection());
  final requests = <Map<String, dynamic>>[];
  List<Map<String, dynamic>> rows = [];
  bool allPresets = false;
  Object? failure;
  Completer<Map<String, dynamic>>? held;
  Map<String, dynamic>? response;

  @override
  Future<Map<String, dynamic>> apiConnections(
    String machineId,
    Map<String, dynamic> payload,
  ) async {
    expect(machineId, 'm');
    requests.add(payload);
    if (failure != null) throw failure!;
    if (held != null) {
      final reply = held!;
      held = null;
      return reply.future;
    }
    if (response != null) return response!;
    if (payload['action'] == 'save') {
      final input = Map<String, dynamic>.from(payload['connection'] as Map);
      input.remove('apiKey');
      input['id'] ??= input['provider'] == 'custom'
          ? 'custom-fixture'
          : 'openrouter';
      rows = [...rows.where((row) => row['id'] != input['id']), input];
    } else if (payload['action'] == 'remove') {
      rows = rows.where((row) => row['id'] != payload['id']).toList();
    }
    return {
      'connections': rows,
      'presets': [
        preset,
        if (allPresets) ...[
          {
            ...preset,
            'provider': 'fal',
            'name': 'fal.ai',
            'baseUrl': 'https://queue.fal.run',
            'keyEnv': 'FAL_KEY',
            'authPrefix': 'Key',
          },
          {
            ...preset,
            'provider': 'openai',
            'name': 'OpenAI',
            'baseUrl': 'https://api.openai.com/v1',
          },
          {
            ...preset,
            'provider': 'anthropic',
            'name': 'Anthropic',
            'baseUrl': 'https://api.anthropic.com/v1',
          },
          {
            ...preset,
            'provider': 'replicate',
            'name': 'Replicate',
            'baseUrl': 'https://api.replicate.com/v1',
          },
        ],
      ],
    };
  }
}

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader('packages/lucide_icons_flutter/Lucide')..addFont(
          rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
        ))
        .load();
  });
  test('metadata and frame logging strip credentials', () {
    final value = ApiConnection.fromJson({
      ...preset,
      'id': 'or',
      'apiKey': 'private-key',
    });
    expect(value.data.containsKey('apiKey'), isFalse);
    expect(value.host, 'openrouter.ai');
    expect(
      summariseForLog({
        'connection': {...preset, 'apiKey': 'private-key'},
      }),
      isNot(contains('private-key')),
    );
  });

  test('controller saves, edits, removes and handles old daemons and explicit failures', () async {
    final app = _ApiApp();
    final controller = ApiConnectionsController(app);
    addTearDown(() {
      controller.dispose();
      app.dispose();
    });
    expect(await controller.refresh(), isTrue);
    expect(controller.presets.single.name, 'OpenRouter');
    expect(await controller.save({...preset, 'apiKey': 'fixture-key'}), isTrue);
    expect(controller.connections.single.id, 'openrouter');
    expect(await controller.remove('openrouter'), isTrue);
    expect(controller.connections, isEmpty);
    app.response = {};
    expect(await controller.refresh(), isFalse);
    expect(controller.error, contains('Update Harness'));
    app.response = {
      'error': 'API_CONNECTIONS_FAILED',
      'detail': 'Check the URL.',
    };
    expect(await controller.save(preset), isFalse);
    expect(controller.error, 'Check the URL.');
    app.response = null;
    app.failure = const WsRequestFailure(
      responseType: 'api_connections_result',
      code: 'LOCAL_ONLY',
      detail: 'Manage APIs on this computer.',
    );
    expect(await controller.refresh(), isFalse);
    expect(controller.error, 'Manage APIs on this computer.');
    app.failure = StateError('private-network-detail');
    expect(await controller.save(preset), isFalse);
    expect(
      controller.error,
      'Could not confirm the change. Go back and refresh.',
    );
    expect(await controller.refresh(), isFalse);
    expect(controller.error, 'APIs are unavailable. Try again.');
    app.stateOf('m')!.connectionStatus = ConnectionStatus.disconnected;
    expect(await controller.refresh(), isFalse);
    expect(controller.error, contains('Connect this computer'));
  });

  test('an older inventory cannot overwrite a save and double clicks do not repeat it', () async {
    final app = _ApiApp();
    final controller = ApiConnectionsController(app);
    addTearDown(() {
      controller.dispose();
      app.dispose();
    });
    final read = Completer<Map<String, dynamic>>();
    app.held = read;
    final refreshing = controller.refresh();
    final write = Completer<Map<String, dynamic>>();
    app.held = write;
    final saving = controller.save({...preset, 'apiKey': 'fixture'});
    expect(controller.saving, isTrue);
    expect(await controller.save(preset), isFalse);
    expect(await controller.remove('openrouter'), isFalse);
    expect(await controller.refresh(), isFalse);
    write.complete({
      'connections': [
        {...preset, 'id': 'openrouter'},
      ],
      'presets': [preset],
    });
    expect(await saving, isTrue);
    read.complete({'connections': [], 'presets': []});
    expect(await refreshing, isFalse);
    expect(controller.connections.single.id, 'openrouter');
    expect(
      app.requests.where((request) => request['action'] == 'save'),
      hasLength(1),
    );
  });

  test('disposal and local machine replacement ignore late replies', () async {
    final app = _ApiApp();
    final controller = ApiConnectionsController(app);
    final read = Completer<Map<String, dynamic>>();
    app.held = read;
    final refreshing = controller.refresh();
    app.machineStates.remove('m');
    app.notifyListeners();
    read.complete({
      'connections': [
        {...preset, 'id': 'old'},
      ],
      'presets': [],
    });
    expect(await refreshing, isFalse);
    expect(controller.connections, isEmpty);
    controller.dispose();
    expect(await controller.refresh(), isFalse);
    app.dispose();
  });

  test('reconnect refreshes APIs and reports an offline computer', () async {
    final app = _ApiApp();
    final controller = ApiConnectionsController(app);
    addTearDown(() {
      controller.dispose();
      app.dispose();
    });
    await controller.refresh();
    app.stateOf('m')!.connectionStatus = ConnectionStatus.disconnected;
    app.notifyListeners();
    expect(controller.available, isFalse);
    expect(controller.error, contains('Connect this computer'));
    app.stateOf('m')!.connectionStatus = ConnectionStatus.connected;
    app.notifyListeners();
    await Future<void>.delayed(Duration.zero);
    expect(controller.available, isTrue);
    expect(controller.error, isNull);
  });

  Future<(_ApiApp, ModelManagerController)> mount(
    WidgetTester tester, {
    double width = 640,
    double height = 820,
    ModelsTab initialTab = ModelsTab.apis,
  }) async {
    tester.view.resetPhysicalSize();
    tester.view.physicalSize = const Size(1280, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final app = _ApiApp();
    final controller = ModelManagerController(app, poll: false);
    final subscriptions = ModelsMenuController();
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
              width: width,
              height: height,
              child: ModelsPanel(
                controller: controller,
                subscriptions: subscriptions,
                initialTab: initialTab,
                onClose: () {},
                onManage: () {},
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (app, controller);
  }

  Finder field(String label) => find.byKey(ValueKey('api-field-$label'));

  testWidgets('All groups and searches every source with stable total counts', (
    tester,
  ) async {
    final (app, controller) = await mount(tester, initialTab: ModelsTab.all);
    app.rows = [
      {...preset, 'id': 'openrouter'},
    ];
    app.inventory = const GridModels(
      gridName: 'home',
      models: [],
      grids: [
        GridSection(
          name: 'Team',
          own: false,
          models: [GridModel(id: 'Shared DeepSeek', node: 'Team computer')],
        ),
      ],
    );
    await controller.refresh();
    await controller.apis.refresh();
    await tester.pumpAndSettle();
    expect(find.text('All 9'), findsOneWidget);
    expect(find.text('Subscriptions'), findsOneWidget);
    expect(find.text('Shared · Team'), findsOneWidget);
    expect(find.text('Shared DeepSeek'), findsOneWidget);
    expect(find.text('Qwen3.8-27B'), findsOneWidget);
    expect(find.text('APIs'), findsOneWidget);
    expect(find.byTooltip('Edit OpenRouter'), findsOneWidget);
    expect(find.text('Add API'), findsNothing);
    expect(find.byTooltip('Add OpenRouter'), findsNothing);
    final search = find.byKey(const ValueKey('models-search'));
    for (final (query, match) in [
      ('anthropic', 'Anthropic'),
      ('qwen3.8-27b', 'Qwen3.8-27B'),
      ('TEAM COMPUTER', 'Shared DeepSeek'),
      ('openrouter.ai', 'OpenRouter'),
    ]) {
      await tester.enterText(search, query);
      await tester.pumpAndSettle();
      expect(find.text(match), findsOneWidget);
      expect(find.text('All 9'), findsOneWidget);
      expect(find.text('No matches'), findsNothing);
      expect(find.text('No matching models'), findsNothing);
    }
    await tester.enterText(search, 'no-such-model-or-api');
    await tester.pumpAndSettle();
    expect(find.text('No matches'), findsOneWidget);
    await tester.tap(find.byTooltip('Clear search'));
    await tester.pumpAndSettle();
    final action = find.byKey(const ValueKey('model-action-qwen'));
    await tester.ensureVisible(action);
    await tester.tap(action);
    await tester.pump();
    expect(app.actions.single.start, isTrue);
    expect(find.text('Downloading · 42%'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('models-tab-local')));
    await tester.pump();
    expect(find.text('Downloading · 42%'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('models-tab-all')));
    await tester.pump();
    expect(app.actions, hasLength(1));
    expect(find.text('Downloading · 42%'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('All edits and removes saved APIs without exposing presets', (
    tester,
  ) async {
    final (app, controller) = await mount(tester, initialTab: ModelsTab.all);
    app.rows = [
      {...preset, 'id': 'openrouter'},
    ];
    await controller.refresh();
    await controller.apis.refresh();
    await tester.pumpAndSettle();
    final edit = find.byTooltip('Edit OpenRouter');
    await tester.ensureVisible(edit);
    await tester.tap(edit);
    await tester.pumpAndSettle();
    expect(field('API key'), findsOneWidget);
    expect(find.text('Qwen3.8-27B'), findsNothing);
    expect(find.text('Subscriptions'), findsNothing);
    expect(find.text('Manage models'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('models-tab-all')));
    await tester.pump();
    expect(field('API key'), findsOneWidget);
    expect(find.byKey(const ValueKey('models-search')), findsNothing);
    await tester.tap(find.byTooltip('Back to all models'));
    await tester.pumpAndSettle();
    expect(find.text('Qwen3.8-27B'), findsOneWidget);
    await tester.enterText(
      find.byKey(const ValueKey('models-search')),
      'openrouter',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Remove OpenRouter'));
    await tester.pump();
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    expect(find.text('All 7'), findsOneWidget);
    expect(find.text('No matches'), findsOneWidget);
    expect(find.text('Add API'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('paste button masks the key and recovers from clipboard errors', (
    tester,
  ) async {
    final (app, _) = await mount(tester);
    await tester.tap(find.byTooltip('Add OpenRouter'));
    await tester.pumpAndSettle();
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    String? clipboard;
    bool denied = false;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method != 'Clipboard.getData') return null;
      if (denied) throw PlatformException(code: 'denied');
      return clipboard == null ? null : {'text': clipboard};
    });
    addTearDown(
      () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
    );
    final paste = find.byTooltip('Paste API key');
    await tester.tap(paste);
    await tester.pumpAndSettle();
    expect(find.text('Copy an API key first.'), findsOneWidget);
    await tester.enterText(field('API key'), 'manual-fixture');
    await tester.pump();
    expect(find.text('Copy an API key first.'), findsNothing);
    denied = true;
    await tester.tap(paste);
    await tester.pumpAndSettle();
    expect(find.text('Could not paste. Try again.'), findsOneWidget);
    expect(
      tester.widget<TextFormField>(field('API key')).controller!.text,
      'manual-fixture',
    );
    denied = false;
    clipboard = '  pasted-button-fixture\n';
    await tester.tap(paste);
    await tester.pumpAndSettle();
    expect(find.text('Could not paste. Try again.'), findsNothing);
    final input = tester.widget<TextFormField>(field('API key')).controller!;
    expect(input.text, 'pasted-button-fixture');
    expect(input.selection.extentOffset, input.text.length);
    expect(
      tester
          .widget<TextField>(
            find.descendant(
              of: field('API key'),
              matching: find.byType(TextField),
            ),
          )
          .obscureText,
      isTrue,
    );
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(
      (app.requests.last['connection'] as Map)['apiKey'],
      'pasted-button-fixture',
    );
  });

  testWidgets(
    'late clipboard replies do not replace edits or reopen an editor',
    (tester) async {
      await mount(tester);
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      var clipboard = Completer<Map<String, String>>();
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.getData') return clipboard.future;
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
      );
      await tester.tap(find.byTooltip('Add OpenRouter'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Paste API key'));
      await tester.enterText(field('API key'), 'newer-fixture');
      clipboard.complete({'text': 'stale-fixture'});
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextFormField>(field('API key')).controller!.text,
        'newer-fixture',
      );
      clipboard = Completer<Map<String, String>>();
      await tester.tap(find.byTooltip('Paste API key'));
      await tester.tap(find.byTooltip('Back to APIs'));
      await tester.pumpAndSettle();
      clipboard.complete({'text': 'stale-fixture'});
      await tester.pumpAndSettle();
      expect(find.byTooltip('Add OpenRouter'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'API key supports Mac select-all and paste without revealing it',
    (tester) async {
      final (app, _) = await mount(tester);
      await tester.tap(find.byTooltip('Add OpenRouter'));
      await tester.pumpAndSettle();
      await tester.enterText(field('API key'), 'replace-this-fixture');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.getData') {
          return {'text': 'pasted-test-key'};
        }
        if (call.method == 'Clipboard.hasStrings') return {'value': true};
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
      );
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyA);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pump();
      final input = tester.widget<TextFormField>(field('API key')).controller!;
      expect(input.selection.baseOffset, 0);
      expect(input.selection.extentOffset, input.text.length);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pumpAndSettle();
      expect(input.text, 'pasted-test-key');
      expect(
        tester
            .widget<TextField>(
              find.descendant(
                of: field('API key'),
                matching: find.byType(TextField),
              ),
            )
            .obscureText,
        isTrue,
      );
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(
        (app.requests.last['connection'] as Map)['apiKey'],
        'pasted-test-key',
      );
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets(
    'preset key save, edit without retrieving the key, and reversible remove',
    (tester) async {
      final (app, controller) = await mount(tester);
      expect(find.text('APIs 0'), findsOneWidget);
      expect(find.text('Search APIs…'), findsOneWidget);
      await tester.tap(find.byTooltip('Add OpenRouter'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('models-search')), findsNothing);
      expect(find.text('Get API key'), findsOneWidget);
      await tester.tap(find.text('Save'));
      await tester.pump();
      expect(find.text('Required'), findsOneWidget);
      await tester.enterText(field('API key'), 'private-fixture');
      expect(
        tester
            .widget<TextField>(
              find.descendant(
                of: field('API key'),
                matching: find.byType(TextField),
              ),
            )
            .obscureText,
        isTrue,
      );
      await tester.tap(find.byTooltip('Show API key'));
      await tester.pump();
      expect(
        tester
            .widget<TextField>(
              find.descendant(
                of: field('API key'),
                matching: find.byType(TextField),
              ),
            )
            .obscureText,
        isFalse,
      );
      await tester.tap(find.byTooltip('Hide API key'));
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.text('APIs 1'), findsOneWidget);
      expect(find.byTooltip('Edit OpenRouter'), findsOneWidget);
      expect(
        controller.apis.connections.single.data.values,
        isNot(contains('private-fixture')),
      );
      await tester.tap(find.byTooltip('Edit OpenRouter'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextFormField>(field('API key')).controller!.text,
        isEmpty,
      );
      expect(find.text('Leave blank to keep saved key'), findsOneWidget);
      await tester.tap(find.text('Advanced'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Name'), 'OpenRouter work');
      await tester.ensureVisible(find.text('Save'));
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect((app.requests.last['connection'] as Map)['apiKey'], '');
      await tester.tap(find.byTooltip('Remove OpenRouter work'));
      await tester.pump();
      expect(find.text('Remove this saved key?'), findsOneWidget);
      await tester.tap(find.byTooltip('Keep OpenRouter work'));
      await tester.pump();
      expect(controller.apis.connections, hasLength(1));
      await tester.tap(find.byTooltip('Remove OpenRouter work'));
      await tester.pump();
      await tester.tap(find.text('Remove'));
      await tester.pumpAndSettle();
      expect(controller.apis.connections, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'custom API supports URL, key environment and header with no vendor restriction',
    (tester) async {
      final (app, _) = await mount(tester);
      await tester.tap(find.byTooltip('Add Custom API'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Name'), 'My image service');
      await tester.enterText(
        field('Base URL'),
        'https://images.example.test/v2',
      );
      await tester.enterText(field('API key'), 'fixture-key');
      await tester.tap(find.text('Advanced'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Key environment variable'), 'IMAGES_KEY');
      await tester.enterText(field('Authentication header'), 'x-images-key');
      await tester.enterText(field('Key prefix'), '');
      await tester.ensureVisible(find.text('Save'));
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(app.requests.last['connection'], containsPair('authPrefix', ''));
      expect(
        app.requests.last['connection'],
        containsPair('keyEnv', 'IMAGES_KEY'),
      );
      expect(find.text('My image service'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'search, escape, tabs, short windows and pending saves remain usable',
    (tester) async {
      final (app, controller) = await mount(tester, width: 500, height: 510);
      final search = find.byKey(const ValueKey('models-search'));
      await tester.enterText(search, 'nothing-like-this');
      await tester.pump();
      expect(find.text('No matching APIs'), findsOneWidget);
      await tester.tap(find.byTooltip('Clear search'));
      await tester.pump();
      await tester.tap(find.byTooltip('Add OpenRouter'));
      await tester.pumpAndSettle();
      await tester.enterText(field('API key'), 'not-saved');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('Search APIs…'), findsOneWidget);
      expect(
        app.requests.where((request) => request['action'] == 'save'),
        isEmpty,
      );
      await tester.tap(find.byTooltip('Add OpenRouter'));
      await tester.pumpAndSettle();
      await tester.enterText(field('API key'), 'fixture');
      final held = Completer<Map<String, dynamic>>();
      app.held = held;
      await tester.ensureVisible(find.text('Save'));
      await tester.tap(find.text('Save'));
      await tester.pump();
      expect(find.text('Saving…'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      await tester.tap(find.byKey(const ValueKey('models-tab-subscriptions')));
      await tester.pump();
      held.complete({
        'connections': [
          {...preset, 'id': 'openrouter'},
        ],
        'presets': [preset],
      });
      await tester.pumpAndSettle();
      expect(controller.apis.connections, hasLength(1));
      await tester.tap(find.text('APIs 1'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Edit OpenRouter'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('subscription providers stay editable without API suggestions', (
    tester,
  ) async {
    final (app, controller) = await mount(tester);
    app.allPresets = true;
    app.rows = [
      {
        ...preset,
        'id': 'openai',
        'provider': 'openai',
        'name': 'OpenAI',
        'baseUrl': 'https://api.openai.com/v1',
      },
      {
        ...preset,
        'id': 'anthropic',
        'provider': 'anthropic',
        'name': 'Anthropic',
        'baseUrl': 'https://api.anthropic.com/v1',
      },
    ];
    await controller.apis.refresh();
    await tester.pumpAndSettle();
    for (final provider in ['OpenAI', 'Anthropic']) {
      expect(find.byTooltip('Add $provider'), findsNothing);
      await tester.tap(find.byTooltip('Edit $provider'));
      await tester.pumpAndSettle();
      expect(find.text('Leave blank to keep saved key'), findsOneWidget);
      await tester.tap(find.byTooltip('Back to APIs'));
      await tester.pumpAndSettle();
    }
    expect(find.byTooltip('Add OpenRouter'), findsOneWidget);
    expect(find.byTooltip('Add fal.ai'), findsOneWidget);
    expect(find.byTooltip('Add Replicate'), findsOneWidget);
    expect(find.byTooltip('Add Custom API'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('API list and editor render in the Models panel', (tester) async {
    tester.view.physicalSize = const Size(760, 920);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final previous = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = Brightness.dark;
    addTearDown(() => grid.AppTheme.brightness.value = previous);
    final app = _ApiApp();
    app.rows = [
      {...preset, 'id': 'openrouter', 'name': 'OpenRouter work'},
    ];
    app.allPresets = true;
    final controller = ModelManagerController(app, poll: false);
    final subscriptions = ModelsMenuController();
    addTearDown(() {
      controller.dispose();
      subscriptions.dispose();
      app.dispose();
    });
    final boundary = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundary,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  maxWidth: 640,
                  maxHeight: 820,
                ),
                child: ModelsPanel(
                  controller: controller,
                  subscriptions: subscriptions,
                  initialTab: ModelsTab.apis,
                  onClose: () {},
                  onManage: () {},
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    Future<void> capture(String name) async {
      final output = Platform.environment['HARNESS_APIS_CAPTURE_DIR'];
      if (output == null) return;
      await tester.runAsync(() async {
        final rendered =
            boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await rendered.toImage(pixelRatio: 2);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$output/$name.png').create(recursive: true);
        await File('$output/$name.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });
    }

    expect(find.byTooltip('Add OpenAI'), findsNothing);
    expect(find.byTooltip('Add Anthropic'), findsNothing);
    await capture('apis-list');
    await tester.tap(find.byTooltip('Add Custom API'));
    await tester.pumpAndSettle();
    await tester.enterText(field('Name'), 'My image service');
    await tester.enterText(field('Base URL'), 'https://api.example.com/v1');
    await tester.pumpAndSettle();
    await capture('apis-custom');
    await tester.tap(find.byKey(const ValueKey('models-tab-all')));
    app.localInventory = modelInventory(scenario: 'ready');
    await controller.refresh();
    await tester.pumpAndSettle();
    await capture('models-all');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'duplicate providers, browser failure, failed save, retry and form validation',
    (tester) async {
      final (app, controller) = await mount(tester);
      app.rows = [
        {...preset, 'id': 'openrouter'},
      ];
      await controller.apis.refresh();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Add OpenRouter'));
      await tester.pumpAndSettle();
      expect(find.text('OpenRouter 2'), findsOneWidget);
      const channel = MethodChannel('plugins.flutter.io/url_launcher');
      var opens = 0;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        opens++;
        if (opens == 1) throw PlatformException(code: 'unavailable');
        return opens > 2;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      await tester.tap(find.text('Get API key'));
      await tester.pumpAndSettle();
      expect(
        find.text('Could not open the browser. Try again.'),
        findsOneWidget,
      );
      await tester.tap(find.text('Get API key'));
      await tester.pumpAndSettle();
      expect(
        find.text('Could not open the browser. Try again.'),
        findsOneWidget,
      );
      await tester.tap(find.text('Get API key'));
      await tester.pumpAndSettle();
      expect(find.text('Could not open the browser. Try again.'), findsNothing);
      await tester.enterText(field('API key'), 'fixture');
      app.response = {
        'error': 'API_CONNECTIONS_FAILED',
        'detail': 'Could not save this API.',
      };
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(find.text('Could not save this API.'), findsOneWidget);
      await tester.tap(find.byTooltip('Back to APIs'));
      await tester.pumpAndSettle();
      app.response = null;
      await tester.tap(find.text('Refresh'));
      await tester.pumpAndSettle();
      expect(find.text('Could not save this API.'), findsNothing);
      await tester.tap(find.byTooltip('Add Custom API'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Name'), 'My service');
      await tester.enterText(field('Base URL'), 'file:///not-an-api');
      await tester.enterText(field('API key'), 'fixture');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(
        find.text('Enter an API URL without credentials or query parameters.'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );
}

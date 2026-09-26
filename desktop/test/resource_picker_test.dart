import 'support/open_harness.dart';

import 'dart:io';
import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/api_connections_controller.dart';
import 'package:harness/widgets/api_picker_form.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/swarm_resource_preview.dart';
import 'package:harness/widgets/machine_picker_form.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/widgets/search_result_text.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:xterm/xterm.dart' show TerminalStyle;

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'support/model_manager.dart';
import 'support/real_fonts.dart';
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_search_preview_test.dart' show seedPreviews;

final field = find.byKey(const ValueKey('swarm-search-input'));
SwarmSearchController search(WidgetTester tester) =>
    tester.widget<SwarmSearchResults>(find.byType(SwarmSearchResults)).search;

Future<ModelManagerTestApp> fixture({ModelManagerTestApp? provided}) async {
  final app = provided ?? ModelManagerTestApp(ModelManagerConnection());
  await seedPreviews(app);
  app.adoptSessionForTest(terminal('a69', []));
  app.machineStates['m']!.dsh.replace(const [
    DshEntry(
      id: 'blender',
      name: 'Blender',
      engine: 'codex',
      category: '3D',
      description: 'Create scenes, models, and animation.',
    ),
    DshEntry(
      id: 'marimo',
      name: 'Marimo',
      engine: 'codex',
      category: 'Data',
      description: 'Explore data in a Python notebook.',
    ),
  ]);
  await app.modelManager.refresh();
  app.modelManager.apis
    ..connections = [
      const ApiConnection({
        'id': 'deepseek-api',
        'provider': 'custom',
        'name': 'DeepSeek API',
        'baseUrl': 'https://api.deepseek.com',
        'keyEnv': 'DEEPSEEK_API_KEY',
      }),
    ]
    ..loaded = true;
  return app;
}

class _MachineApp extends ModelManagerTestApp {
  _MachineApp() : super(ModelManagerConnection());
  final edits = <({String action, String id, String value})>[];
  String? editError;
  Completer<String?>? editReply;
  final pending = <String, Future<String?>>{};
  bool passwordSet = false;

  Future<String?> change(String action, String id, String value) {
    if (pending[action] case final request?) return request;
    edits.add((action: action, id: id, value: value));
    final future = (editReply?.future ?? Future<String?>.value(editError)).then(
      (error) {
        pending.remove(action);
        if (error == null) {
          if (action == 'connect') {
            machineStates[id]!
              ..needsLink = false
              ..connectionStatus = ConnectionStatus.connected;
          } else if (action == 'rename') {
            final original = machineStates[id]!.machine;
            machineStates[id]!.machine = Machine(
              machineId: id,
              name: value,
              authMode: original.authMode,
            );
          } else if (action == 'delete') {
            machineStates.remove(id);
          } else if (action == 'password') {
            passwordSet = true;
          } else if (action == 'clear') {
            passwordSet = false;
          }
          notifyListeners();
        }
        return error;
      },
    );
    pending[action] = future;
    return future;
  }

  @override
  Future<String?> connectWithPassword(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
  }) => change('connect', machineId, password);
  @override
  Future<String?>? pendingMachineLink(String machineId) => pending['connect'];
  @override
  Future<String?> renameMachine(String machineId, String name) =>
      change('rename', machineId, name);
  @override
  Future<String?>? pendingMachineRename(String machineId) => pending['rename'];
  @override
  String? pendingMachineName(String machineId) =>
      pending.containsKey('rename') ? edits.last.value : null;
  @override
  Future<String?> deleteMachine(String machineId) =>
      change('delete', machineId, '');
  @override
  Future<RemotePasswordStatus> remotePasswordStatus() async =>
      RemotePasswordStatus(hasPassword: passwordSet);
  @override
  Future<RemotePasswordSetResult> setRemotePassword(String password) async =>
      RemotePasswordSetResult(error: await change('password', 'm', password));
  @override
  Future<String?> clearRemotePassword() => change('clear', 'm', '');
}

class _ModelSelectionApp extends ModelManagerTestApp {
  _ModelSelectionApp() : super(ModelManagerConnection());
  bool completeStarts = false;

  @override
  Future<Map<String, dynamic>> controlLocalModel(
    String machineId,
    String modelId, {
    required bool start,
  }) async {
    final answer = await super.controlLocalModel(
      machineId,
      modelId,
      start: start,
    );
    if (!start || !completeStarts) return answer;
    final original = inventoryFor(machineId);
    final model = (original['models'] as List).singleWhere(
      (model) => model['id'] == modelId,
    );
    setInventoryFor(machineId, {
      ...original,
      'busy': false,
      'models': [
        for (final entry in original['models'] as List)
          if (entry['id'] == modelId)
            {
              ...entry as Map<String, dynamic>,
              'state': 'running',
              'canStart': false,
              'canStop': true,
              'operation': null,
            }
          else
            entry,
      ],
    });
    final host = stateOf(machineId)!.machine;
    inventory = GridModels(
      gridName: 'home',
      models: [
        ...inventory.models,
        GridModel(
          id: model['name'] as String,
          node: host.hostname ?? host.displayName,
        ),
      ],
    );
    return {
      'operation': {
        ...answer['operation'] as Map<String, dynamic>,
        'stage': 'verifying',
        'phase': 'done',
      },
    };
  }

  final selections =
      <({String machine, String agent, String? model, String? grid})>[];

  @override
  Future<void> retargetAgentToGridModel(
    String machineId,
    String agentId,
    String modelId, {
    String? gridName,
  }) async {
    selections.add((
      machine: machineId,
      agent: agentId,
      model: modelId,
      grid: gridName,
    ));
  }

  @override
  Future<void> clearAgentGrid(String machineId, String agentId) async {
    selections.add((
      machine: machineId,
      agent: agentId,
      model: null,
      grid: null,
    ));
  }
}

Future<void> capture(WidgetTester tester, String name) async {
  final directory = Platform.environment['RESOURCE_PICKER_CAPTURE_DIR'];
  if (directory == null) return;
  final view = tester.binding.renderViews.first;
  final layer = view.debugLayer! as OffsetLayer;
  await tester.runAsync(() async {
    final image = await layer.toImage(Offset.zero & view.size);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    final file = File('$directory/$name.png');
    await file.parent.create(recursive: true);
    await file.writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
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
    await (FontLoader('packages/lucide_icons_flutter/Lucide300')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
          ),
        ))
        .load();
  });

  for (final withKeymap in [false, true]) {
    testWidgets('machine editors stay in Cmd P ($withKeymap)', (tester) async {
      final app = _MachineApp();
      await fixture(provided: app);
      final map = MemoryKeymap();
      app.machineStates['other']!
        ..needsLink = true
        ..nodeOnline = true;
      try {
        if (withKeymap) {
          await configured.mount(tester, app, map);
        } else {
          await mount(tester, app);
        }
        await openHarnessPicker(tester);
        await tester.enterText(field, '@');
        await tester.pumpAndSettle();
        final origin = search(tester);
        final editor = tester.widget<TextField>(field).controller;
        expect(origin.selected!.machineId, 'other');
        expect(origin.rows.last.title, 'Add machine');
        await key(tester, LogicalKeyboardKey.enter);
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        final password = find.byKey(
          const ValueKey('remote-password-connect-field'),
        );
        expect(password, findsOneWidget);
        expect(find.byType(Dialog), findsNothing);
        expect(field, findsOneWidget);
        expect(origin.managing, isTrue);
        await tester.enterText(password, 'fixture password');
        await key(tester, LogicalKeyboardKey.tab);
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
        expect(origin.selected!.machineId, 'other');
        expect(app.edits, isEmpty);
        await key(tester, LogicalKeyboardKey.tab, shift: true);
        expect(tester.widget<TextField>(password).focusNode!.hasFocus, isTrue);
        expect(
          tester.widget<TextField>(password).controller!.text,
          'fixture password',
        );
        await key(tester, LogicalKeyboardKey.arrowLeft);
        expect(
          tester.widget<TextField>(password).controller!.selection.extentOffset,
          15,
        );
        expect(origin.selected!.machineId, 'other');
        app.editError = 'Password did not match.';
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(find.text('Password did not match.'), findsOneWidget);
        expect(app.edits.single.action, 'connect');
        await capture(tester, 'machine-connect-inline');
        app.editError = null;
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(find.byType(MachinePickerForm), findsNothing);
        expect(origin.selected!.machineId, 'other');
        expect(origin.query, '@');
        await tester.tap(
          find.byKey(const ValueKey('resource-action:picker.resource_rename')),
        );
        await tester.pumpAndSettle();
        final name = find.byKey(const ValueKey('machine-rename-input'));
        expect(name, findsOneWidget);
        expect(
          tester
              .widget<TextField>(name)
              .controller!
              .selection
              .textInside('Other computer'),
          'Other computer',
        );
        await tester.enterText(name, 'Remote office');
        await capture(tester, 'machine-rename-inline');
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(
          app.machineStates['other']!.machine.displayName,
          'Remote office',
        );
        expect(origin.selected!.machineId, 'other');
        expect(tester.widget<TextField>(field).controller, same(editor));
        await tester.tap(
          find.byKey(const ValueKey('resource-action:picker.resource_remove')),
        );
        await tester.pumpAndSettle();
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(app.edits.where((edit) => edit.action == 'delete'), isEmpty);
        expect(find.byType(MachinePickerForm), findsNothing);
        await tester.tap(
          find.byKey(const ValueKey('resource-action:picker.resource_remove')),
        );
        await tester.pumpAndSettle();
        await key(tester, LogicalKeyboardKey.arrowLeft);
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(
          app.edits.where((edit) => edit.action == 'delete'),
          hasLength(1),
        );
        expect(find.byType(MachinePickerForm), findsNothing);
        expect(origin.query, '@');
        expect(find.byType(Dialog), findsNothing);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      }
    });

    testWidgets('Manage focuses controls without running them ($withKeymap)', (
      tester,
    ) async {
      final app = await fixture();
      final map = MemoryKeymap();
      try {
        if (withKeymap) {
          await configured.mount(tester, app, map);
        } else {
          await mount(tester, app);
        }
        await openHarnessPicker(tester);
        await tester.enterText(field, '@This Mac');
        await tester.pumpAndSettle();
        final controller = search(tester);
        final selectedId = controller.selected!.id;
        final actions = find.byKey(
          const ValueKey('swarm-search-resource-actions'),
        );
        expect(
          find.descendant(of: actions, matching: find.text('[ Password ]')),
          findsOneWidget,
        );
        expect(
          find.descendant(of: actions, matching: find.text('[ Rename ]')),
          findsOneWidget,
        );
        expect(
          find.descendant(of: actions, matching: find.text('[ Actions… ]')),
          findsNothing,
        );
        await key(tester, LogicalKeyboardKey.enter);
        expect(controller.managing, isTrue);
        expect(controller.isMachineMode, isTrue);
        expect(
          find.byKey(const ValueKey('remote-password-field')),
          findsNothing,
        );
        TextButton button(String command) => tester.widget<TextButton>(
          find.descendant(
            of: find.byKey(ValueKey('resource-action:$command')),
            matching: find.byType(TextButton),
          ),
        );
        expect(button('picker.resource_settings').focusNode!.hasFocus, isTrue);
        await key(tester, LogicalKeyboardKey.arrowRight);
        expect(button('picker.resource_rename').focusNode!.hasFocus, isTrue);
        await key(tester, LogicalKeyboardKey.arrowLeft);
        expect(button('picker.resource_settings').focusNode!.hasFocus, isTrue);
        await key(tester, LogicalKeyboardKey.arrowDown);
        expect(button('picker.resource_rename').focusNode!.hasFocus, isTrue);
        await key(tester, LogicalKeyboardKey.arrowUp);
        expect(button('picker.resource_settings').focusNode!.hasFocus, isTrue);
        await key(tester, LogicalKeyboardKey.keyJ, ctrl: true);
        expect(button('picker.resource_rename').focusNode!.hasFocus, isTrue);
        await key(tester, LogicalKeyboardKey.keyK, ctrl: true);
        expect(button('picker.resource_settings').focusNode!.hasFocus, isTrue);
        expect(controller.selected!.id, selectedId);
        expect(controller.managing, isTrue);
        await key(tester, LogicalKeyboardKey.tab);
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
        await key(tester, LogicalKeyboardKey.tab, shift: true);
        expect(button('picker.resource_settings').focusNode!.hasFocus, isTrue);
        await key(tester, LogicalKeyboardKey.escape);
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
        expect(controller.selected!.id, selectedId);
        await capture(tester, 'machine-controls');

        await tester.enterText(field, ':Qwen3.8-27B');
        await tester.pumpAndSettle();
        expect(button('picker.model_download').onPressed, isNotNull);
        expect(
          find.byKey(const ValueKey('resource-action:picker.model_start')),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('resource-action:picker.model_stop')),
          findsNothing,
        );
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
        await key(tester, LogicalKeyboardKey.tab);
        expect(controller.managing, isTrue);
        expect(button('picker.model_download').focusNode!.hasFocus, isTrue);
        expect(app.actions, isEmpty);
        expect(app.downloads, isEmpty);
        await tester.pump(const Duration(milliseconds: 200));
        await capture(tester, 'model-manage-focused');
        await key(tester, LogicalKeyboardKey.space);
        expect(app.downloads, [(machine: 'm', model: 'qwen')]);
        expect(button('picker.model_download').onPressed, isNull);
        await key(tester, LogicalKeyboardKey.enter);
        expect(app.downloads, hasLength(1));
        expect(app.actions, isEmpty);
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
        expect(controller.query, ':Qwen3.8-27B');
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      }
    });
  }

  testWidgets(
    'password edits validate, clear drafts and confirm clearing in place',
    (tester) async {
      final app = _MachineApp();
      await fixture(provided: app);
      final map = MemoryKeymap();
      try {
        await configured.mount(tester, app, map);
        await openHarnessPicker(tester);
        await tester.enterText(field, '@This Mac');
        await tester.pumpAndSettle();
        Future<void> openPassword() async {
          await tester.tap(
            find.byKey(
              const ValueKey('resource-action:picker.resource_settings'),
            ),
          );
          await tester.pumpAndSettle();
        }

        final password = find.byKey(const ValueKey('remote-password-field'));
        final confirm = find.byKey(
          const ValueKey('remote-password-confirm-field'),
        );
        await openPassword();
        await tester.enterText(password, 'fixture password');
        await key(tester, LogicalKeyboardKey.enter);
        expect(tester.widget<TextField>(confirm).focusNode!.hasFocus, isTrue);
        await tester.enterText(confirm, 'different');
        await key(tester, LogicalKeyboardKey.enter);
        expect(find.text('Passwords do not match.'), findsOneWidget);
        expect(app.edits, isEmpty);
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        await openPassword();
        expect(tester.widget<TextField>(password).controller!.text, isEmpty);
        expect(tester.widget<TextField>(confirm).controller!.text, isEmpty);
        await tester.enterText(password, 'fixture password');
        await tester.enterText(confirm, 'fixture password');
        await key(tester, LogicalKeyboardKey.arrowDown);
        await key(tester, LogicalKeyboardKey.arrowDown);
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(tester.widget<TextField>(password).obscureText, isFalse);
        await key(tester, LogicalKeyboardKey.enter);
        expect(tester.widget<TextField>(password).obscureText, isTrue);
        await tester.tap(confirm);
        await capture(tester, 'machine-password-inline');
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(app.edits.single.action, 'password');
        expect(find.text('Password saved.'), findsOneWidget);
        await openPassword();
        expect(find.text('Password is set.'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('machine-form:Clear')));
        await tester.pumpAndSettle();
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(app.edits, hasLength(1));
        await openPassword();
        await tester.tap(find.byKey(const ValueKey('machine-form:Clear')));
        await tester.pumpAndSettle();
        await key(tester, LogicalKeyboardKey.arrowLeft);
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(app.edits.last.action, 'clear');
        expect(find.text('Password cleared.'), findsOneWidget);
        expect(find.byType(Dialog), findsNothing);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      }
    },
  );

  testWidgets(
    'inline rename respects remaps and composition in a narrow pane',
    (tester) async {
      final app = _MachineApp();
      await fixture(provided: app);
      final map = MemoryKeymap();
      try {
        await configured.mount(tester, app, map);
        await tester.binding.setSurfaceSize(const Size(800, 600));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await openHarnessPicker(tester);
        await tester.enterText(field, '@');
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('resource-action:picker.resource_rename')),
        );
        await tester.pumpAndSettle();
        final name = find.byKey(const ValueKey('machine-rename-input'));
        map.apply(
          '{"bindings":[{"keys":"enter","command":null,"when":"picker"},{"keys":"f8","command":"picker.accept","when":"picker"},{"keys":"f9","command":"picker.cancel","when":"picker"}]}',
        );
        const composing = TextEditingValue(
          text: '日本',
          selection: TextSelection.collapsed(offset: 2),
          composing: TextRange(start: 0, end: 2),
        );
        tester.testTextInput.updateEditingValue(composing);
        await tester.pump();
        await key(tester, LogicalKeyboardKey.f8);
        expect(app.edits, isEmpty);
        expect(tester.widget<TextField>(name).controller!.text, '日本');
        tester.testTextInput.updateEditingValue(
          composing.copyWith(composing: TextRange.empty),
        );
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter);
        expect(app.edits, isEmpty);
        await capture(tester, 'machine-rename-inline-narrow');
        await key(tester, LogicalKeyboardKey.f8);
        await tester.pumpAndSettle();
        expect(app.edits.single.value, '日本');
        expect(find.byType(MachinePickerForm), findsNothing);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      }
    },
  );

  testWidgets(
    'pending machine edits survive leaving the form without stealing selection',
    (tester) async {
      final app = _MachineApp();
      await fixture(provided: app);
      final map = MemoryKeymap();
      try {
        await configured.mount(tester, app, map);
        await openHarnessPicker(tester);
        await tester.enterText(field, '@Other');
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('resource-action:picker.resource_rename')),
        );
        await tester.pumpAndSettle();
        final reply = app.editReply = Completer<String?>();
        await tester.enterText(
          find.byKey(const ValueKey('machine-rename-input')),
          'Renamed remote',
        );
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(find.text('Saving…'), findsOneWidget);
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('resource-action:picker.resource_rename')),
        );
        await tester.pumpAndSettle();
        expect(find.text('Saving…'), findsOneWidget);
        expect(app.edits, hasLength(1));
        await tester.enterText(field, '@This Mac');
        await tester.pumpAndSettle();
        expect(find.byType(MachinePickerForm), findsNothing);
        reply.complete(null);
        await tester.pumpAndSettle();
        expect(search(tester).selected!.machineId, 'm');
        expect(search(tester).query, '@This Mac');
        expect(app.edits, hasLength(1));
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      }
    },
  );

  testWidgets(
    'Download stays separate from Start and reports progress in place',
    (tester) async {
      final app = await fixture();
      final map = MemoryKeymap();
      try {
        await configured.mount(tester, app, map);
        await openHarnessPicker(tester);
        await tester.enterText(field, ':Qwen3.8-27B');
        await tester.pumpAndSettle();
        final origin = search(tester);
        expect(find.text('Enter Get  ·  Tab pane'), findsOneWidget);
        await key(tester, LogicalKeyboardKey.enter);
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
        expect(app.downloads, [(machine: 'm', model: 'qwen')]);
        expect(app.actions, isEmpty);
        expect(find.text('Downloading 42%'), findsOneWidget);
        expect(search(tester), same(origin));
        expect(origin.query, ':Qwen3.8-27B');
        await capture(tester, 'model-downloading');
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      }
    },
  );

  testWidgets(
    'Cmd I selects for the pinned pane and Tab manages the model host',
    (tester) async {
      final app = _ModelSelectionApp()
        ..inventory = const GridModels(
          gridName: 'home',
          models: [GridModel(id: 'qwen3.8-27b', node: 'mac.lan')],
          grids: [
            GridSection(
              name: 'home',
              own: true,
              models: [GridModel(id: 'qwen3.8-27b', node: 'mac.lan')],
            ),
            GridSection(
              name: 'Team',
              own: false,
              models: [GridModel(id: 'Gemma-4-E4B', node: 'shared.lan')],
            ),
          ],
        );
      await fixture(provided: app);
      app.machineStates['m']!
        ..localEndpoint = LocalCliEndpoint(
          computerId: 'fixture',
          wsUri: Uri.parse('ws://fixture.invalid'),
          protocolVersion: 1,
          terminalProtocolVersion: 3,
        )
        ..agents.add(
          const Agent(
            id: 'a69',
            name: 'Current harness',
            engine: 'codex',
            terminalAvailable: true,
          ),
        );
      app.machineStates['other']!
        ..machine = const Machine(
          machineId: 'other',
          authMode: MachineAuthMode.remote,
          name: 'M2',
          hostname: 'mac.lan',
        )
        ..connectionStatus = ConnectionStatus.connected
        ..nodeOnline = true;
      app.machineInventories['other'] = {
        'models': [
          {
            'id': 'local:Qwen3.8-27B-Q4_0.gguf',
            'name': 'qwen3.8-27b',
            'state': 'running',
            'canStop': true,
            'sizeBytes': 16056478688,
          },
        ],
      };
      final map = MemoryKeymap();
      try {
        await configured.mount(tester, app, map);
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        expect(search(tester).modelSelectionEngine, 'codex');
        expect(search(tester).selected!.title, 'OpenAI');
        expect(
          search(tester).rows.any((row) => row.modelId == 'model:local:qwen'),
          isFalse,
        );
        for (final heading in [
          'Subscriptions',
          'APIs',
          'Your local AI models',
          'Shared with you',
        ]) {
          expect(
            find.byKey(ValueKey('model-section:$heading')),
            findsOneWidget,
          );
        }
        final browse = search(tester).rows
            .indexWhere(search(tester).isModelDownloadsRow);
        search(tester).move(browse - search(tester).cursor);
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter);
        expect(search(tester).modelDownloadsVisible, isTrue);
        expect(
          search(tester)
              .models!
              .entries[search(tester).selected!.modelId]!
              .needsDownload,
          isTrue,
        );
        expect(search(tester).modelRowAction(search(tester).selected!), 'Get');
        expect(app.actions, isEmpty);
        expect(app.downloads, isEmpty);
        await key(tester, LogicalKeyboardKey.escape);
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        expect(search(tester).modelDownloadsVisible, isFalse);
        final usable = search(tester).rows
            .firstWhere((row) => row.title == 'qwen3.8-27b · Q4_0');
        search(tester)
            .move(search(tester).rows.indexOf(usable) - search(tester).cursor);
        await tester.pump();
        expect(
          find.byKey(ValueKey('model-row-action:${usable.id}')),
          findsOneWidget,
        );
        expect(search(tester).modelRowAction(usable), 'Use');
        await capture(tester, 'four-model-sections');
        await tester.enterText(field, ':mac.lan');
        await tester.pumpAndSettle();
        expect(
          search(tester).rows.where((row) => row.isModel),
          hasLength(1),
          reason: search(tester).rows
              .map((row) => '${row.id}: ${row.title}')
              .join('\n'),
        );
        expect(find.text('Enter Use  ·  Tab pane'), findsOneWidget);
        expect(find.text('M2 · 15.0 GB'), findsOneWidget);
        await capture(tester, 'remote-model-select');
        final origin = search(tester);
        await key(tester, LogicalKeyboardKey.tab);
        expect(origin.managing, isTrue);
        final stop = find.byKey(
          const ValueKey('resource-action:picker.model_stop'),
        );
        final button = tester.widget<TextButton>(
          find.descendant(of: stop, matching: find.byType(TextButton)),
        );
        expect(button.focusNode!.hasFocus, isTrue);
        expect(app.actions, isEmpty);
        expect(app.selections, isEmpty);
        await key(tester, LogicalKeyboardKey.escape);
        expect(origin.managing, isFalse);
        expect(origin.query, ':mac.lan');
        await key(tester, LogicalKeyboardKey.enter);
        expect(field, findsNothing);
        expect(app.selections, [
          (machine: 'm', agent: 'a69', model: 'qwen3.8-27b', grid: 'home'),
        ]);
        expect(app.actions, isEmpty);

        // The same model scope uses Enter consistently from either shortcut.
        await key(tester, LogicalKeyboardKey.keyP, cmd: true);
        await tester.enterText(field, ':mac.lan');
        await tester.pumpAndSettle();
        expect(search(tester).canSelectModel(search(tester).selected), isTrue);
        await key(tester, LogicalKeyboardKey.enter);
        expect(field, findsNothing);
        expect(app.selections, hasLength(2));

        // Enter on downloaded weights starts, waits for serving, then switches.
        app.completeStarts = true;
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        for (final heading in [
          'Subscriptions',
          'APIs',
          'Your local AI models',
          'Shared with you',
        ]) {
          expect(
            find.byKey(ValueKey('model-section:$heading')),
            findsOneWidget,
          );
        }
        await capture(tester, 'model-sections');
        await tester.enterText(field, ':gemma-4-12B');
        await tester.pumpAndSettle();
        expect(search(tester).canSelectModel(search(tester).selected), isTrue);
        await capture(tester, 'downloaded-model-use');
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(field, findsNothing);
        expect(app.selections, hasLength(3));
        expect(app.selections.last, (
          machine: 'm',
          agent: 'a69',
          model: 'gemma-4-12B',
          grid: 'home',
        ));
        expect(app.actions, [(machine: 'm', model: 'gemma', start: true)]);
        expect(app.downloads, isEmpty);

        // The pane can return to its own subscription without changing engine.
        final agents = app.machineStates['m']!.agents;
        agents[agents.indexWhere((agent) => agent.id == 'a69')] = const Agent(
          id: 'a69',
          name: 'Current harness',
          engine: 'codex',
          terminalAvailable: true,
          gridModel: 'qwen3.8-27b',
        );
        app.notifyListeners();
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        expect(search(tester).selected!.title, 'qwen3.8-27b · Q4_0');
        await tester.enterText(field, ':Anthropic');
        await tester.pumpAndSettle();
        expect(search(tester).canSelectModel(search(tester).selected), isFalse);
        await tester.enterText(field, ':OpenAI');
        await tester.pumpAndSettle();
        expect(search(tester).canSelectModel(search(tester).selected), isTrue);
        await key(tester, LogicalKeyboardKey.enter);
        expect(field, findsNothing);
        expect(app.selections.last, (
          machine: 'm',
          agent: 'a69',
          model: null,
          grid: null,
        ));

        // Selection cannot silently jump to a different pane after opening.
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        await tester.enterText(field, ':mac.lan');
        await tester.pumpAndSettle();
        app.adoptSessionForTest(terminal('a0', []));
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter);
        expect(app.selections, hasLength(4));
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      }
    },
  );

  testWidgets(
    'platform picker and command shortcuts',
    (tester) async {
      final provided = ModelManagerTestApp(ModelManagerConnection())
        ..inventory = const GridModels(
          gridName: 'home',
          models: [GridModel(id: 'qwen3.8-27b', node: 'mac.lan')],
        );
      final app = await fixture(provided: provided);
      final keymap = MemoryKeymap();
      try {
        await configured.mount(tester, app, keymap);
        final mac = defaultTargetPlatform == TargetPlatform.macOS;
        final pane = app.focusedPaneId;
        await key(tester, LogicalKeyboardKey.keyI, cmd: mac, ctrl: !mac);
        expect(search(tester).isModelMode, isTrue);
        expect(tester.widget<TextField>(field).controller!.text, ':');
        expect(
          tester.widget<TextField>(field).controller!.selection,
          const TextSelection.collapsed(offset: 1),
        );
        expect(app.focusedPaneId, pane);
        expect(
          search(tester).rows.any((row) => row.title == 'qwen3.8-27b'),
          isTrue,
        );
        await tester.enterText(field, ':mac.lan');
        await tester.pump();
        expect(search(tester).selected!.title, 'qwen3.8-27b');
        expect(find.text('On your machines · mac.lan'), findsOneWidget);
        if (mac) await capture(tester, 'own-machine-model');
        await key(tester, LogicalKeyboardKey.escape);
        await key(tester, LogicalKeyboardKey.keyO, cmd: mac, ctrl: !mac);
        expect(field, findsOneWidget);
        expect(search(tester).scopePrefix, '#');
        final editor = tester.widget<TextField>(field).controller!;
        expect(editor.text, '#');
        expect(editor.selection, const TextSelection.collapsed(offset: 1));
        await key(tester, LogicalKeyboardKey.backspace);
        expect(editor.text, isEmpty);
        expect(search(tester).scopePrefix, '');
        expect(search(tester).hint, 'Search harnesses');
        expect(search(tester).rows.any((row) => row.isCreate), isFalse);
        await key(tester, LogicalKeyboardKey.escape);
        await key(tester, LogicalKeyboardKey.keyP, cmd: mac, ctrl: !mac);
        expect(search(tester).scopePrefix, '');
        expect(tester.widget<TextField>(field).controller!.text, isEmpty);
        expect(tester.widget<TextField>(field).cursorWidth, 2);
        expect(find.byKey(const ValueKey('swarm-search-prompt')), findsNothing);
        final hints = find.byKey(const ValueKey('swarm-search-type-hints'));
        expect(hints, findsOneWidget);
        expect(search(tester).selected, isNull);
        await key(tester, LogicalKeyboardKey.enter);
        expect(field, findsOneWidget);
        expect(search(tester).selected, isNull);
        expect(search(tester).isCommandMode, isFalse);
        expect(search(tester).rows.any((row) => row.agentId != null), isTrue);
        await tester.enterText(field, ':qwen');
        await tester.pump();
        expect(hints, findsNothing);
        expect(search(tester).isModelMode, isTrue);
        await key(tester, LogicalKeyboardKey.escape);
        await key(tester, LogicalKeyboardKey.keyP, cmd: mac, ctrl: !mac);
        final origin = search(tester);
        await key(tester, LogicalKeyboardKey.keyI, cmd: mac, ctrl: !mac);
        expect(search(tester), same(origin));
        expect(search(tester).isModelMode, isTrue);
        expect(tester.widget<TextField>(field).controller!.text, ':');
        await key(tester, LogicalKeyboardKey.escape);
        await key(
          tester,
          LogicalKeyboardKey.keyP,
          cmd: mac,
          ctrl: !mac,
          shift: true,
        );
        expect(search(tester).isCommandMode, isTrue);
        expect(hints, findsNothing);
        await key(tester, LogicalKeyboardKey.escape);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        keymap.dispose();
      }
    },
    variant: const TargetPlatformVariant({
      TargetPlatform.macOS,
      TargetPlatform.linux,
    }),
  );

  testWidgets(
    'empty search shows hints in the preview until a result is selected',
    (tester) async {
      final app = await fixture();
      final originalFont = terminalFontStore.value;
      final originalPalette = grid.AppTheme.palette.value;
      final originalTheme = terminalThemeStore.value;
      addTearDown(() {
        terminalFontStore.value = originalFont;
        grid.AppTheme.palette.value = originalPalette;
        terminalThemeStore.value = originalTheme;
      });
      await mount(tester, app);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      final hints = find.byKey(const ValueKey('swarm-search-type-hints'));
      final input = tester.widget<TextField>(field);
      final inputPosition = tester.getTopLeft(field);
      final listPosition = tester.getTopLeft(
        find.byKey(const ValueKey('swarm-search-result-list')),
      );
      const hintLabels = [
        '@  machines',
        '#  projects',
        ':  models',
        '*  store',
        '>  commands',
      ];
      expect(
        tester
            .widgetList<Text>(
              find.descendant(of: hints, matching: find.byType(Text)),
            )
            .map((text) => text.data),
        hintLabels,
      );
      final controller = search(tester);
      expect(controller.selected, isNull);
      expect(controller.rows.any((row) => row.isCreate), isFalse);
      expect(find.text('New Harness'), findsNothing);
      expect(
        tester.getRect(hints).left,
        greaterThanOrEqualTo(
          tester
              .getRect(find.byKey(const ValueKey('swarm-search-result-list')))
              .right,
        ),
      );
      for (final row in controller.rows) {
        final line = find.byKey(ValueKey('swarm-search-line:${row.id}'));
        if (line.evaluate().isNotEmpty) {
          expect(tester.widget<Container>(line).color, Colors.transparent);
        }
      }
      app.machineStates['m']!.agents.add(
        const Agent(
          id: 'late-result',
          name: 'Discovered session',
          terminalAvailable: true,
        ),
      );
      app.notifyListeners();
      await tester.pump();
      expect(controller.selected, isNull);
      await capture(tester, 'empty-type-hints');

      await key(tester, LogicalKeyboardKey.arrowDown);
      expect(controller.selected, controller.rows.first);
      expect(hints, findsNothing);
      await key(tester, LogicalKeyboardKey.tab);
      expect(controller.selected, controller.rows.first);
      expect(controller.managing, isTrue);
      await key(tester, LogicalKeyboardKey.escape);

      await tester.enterText(field, 'search');
      await tester.pump();
      expect(hints, findsNothing);
      expect(controller.selected!.isCreate, isFalse);
      expect(
        controller.selected,
        controller.rows.firstWhere((row) => !row.isCreate),
      );
      expect(tester.getTopLeft(field), inputPosition);
      expect(
        tester.getTopLeft(
          find.byKey(const ValueKey('swarm-search-result-list')),
        ),
        listPosition,
      );
      expect(
        tester.widget<TextField>(field).controller,
        same(input.controller),
      );
      expect(input.focusNode!.hasFocus, isTrue);
      await capture(tester, 'selected-search');
      await tester.enterText(field, '');
      await tester.pump();
      expect(controller.selected, isNull);
      expect(hints, findsOneWidget);
      await key(tester, LogicalKeyboardKey.arrowUp);
      expect(controller.selected, controller.rows.last);
      for (final prefix in ['@', '#', ':', '*']) {
        await tester.enterText(field, prefix);
        await tester.pump();
        expect(hints, findsNothing);
        expect(controller.selected!.isCreate, isFalse);
        await key(tester, LogicalKeyboardKey.backspace);
        expect(hints, findsOneWidget);
        expect(controller.selected, isNull);
      }

      grid.AppTheme.palette.value = HarnessPalette.slate;
      terminalThemeStore.value = TerminalThemeChoice.tango;
      terminalFontStore.value = const TerminalStyle(
        fontSize: 18,
        fontFamily: 'Menlo',
      );
      tester.view.physicalSize = const Size(480, 600);
      await tester.pumpAndSettle();
      final compact = find
          .descendant(of: hints, matching: find.byType(Text))
          .first;
      final compactStyle = DefaultTextStyle.of(tester.element(compact)).style;
      expect(tester.widget<Text>(compact).data, hintLabels.first);
      expect(compactStyle.fontSize, 18);
      expect(
        compactStyle.color,
        terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        ).foreground.withValues(alpha: .54),
      );
      expect(tester.takeException(), isNull);
      await capture(tester, 'narrow-type-hints');
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  for (final native in [false, true]) {
    testWidgets(
      'harness search keeps Cmd-P and leaves commands on Shift-P (native=$native)',
      (tester) async {
        final app = await fixture();
        final keymap = MemoryKeymap();
        final messenger = tester.binding.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(
          configured.nativeChannel,
          (_) async => null,
        );
        addTearDown(
          () => messenger.setMockMethodCallHandler(
            configured.nativeChannel,
            null,
          ),
        );
        Future<void> harnesses() async {
          if (native) {
            final done = configured.native(tester, 'sessions');
            await tester.pump();
            await tester.pump();
            await done;
          } else {
            await key(tester, LogicalKeyboardKey.keyP, cmd: true);
          }
        }

        try {
          await configured.mount(tester, app, keymap, native: native);
          await key(tester, LogicalKeyboardKey.keyO, cmd: true);
          expect(search(tester).scopePrefix, '#');
          await harnesses();
          expect(search(tester).scopePrefix, '');
          expect(search(tester).setupLayout, isTrue);
          expect(search(tester).rows.any((row) => row.agentId != null), isTrue);
          final original = search(tester);
          await tester.enterText(field, 'a69');
          await tester.pump();
          final selected = original.selected?.id;
          await harnesses();
          expect(search(tester), same(original));
          expect(search(tester).query, 'a69');
          expect(search(tester).selected?.id, selected);
          expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
          await key(tester, LogicalKeyboardKey.escape);
          await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
          expect(search(tester).isCommandMode, isTrue);
          await harnesses();
          expect(search(tester).isCommandMode, isFalse);
          expect(search(tester).setupLayout, isTrue);
          expect(search(tester).query, isEmpty);
          await tester.enterText(field, '#');
          await tester.pump();
          final project = search(tester).rows
              .firstWhere((row) => row.isProject);
          search(tester).submit(project);
          await tester.pump();
          expect(search(tester).canGoBack, isTrue);
          await harnesses();
          expect(search(tester).canGoBack, isFalse);
          expect(search(tester).scopePrefix, '');
        } finally {
          await tester.pumpWidget(const SizedBox());
          app.dispose();
          keymap.dispose();
        }
      },
      variant: const TargetPlatformVariant({TargetPlatform.macOS}),
    );
  }

  testWidgets('prefix editing preserves the full query and IME composition', (
    tester,
  ) async {
    final app = await fixture();
    final keymap = MemoryKeymap();
    await configured.mount(tester, app, keymap);
    await openHarnessPicker(tester);
    final editor = tester.widget<TextField>(field).controller!;
    final editable = find.descendant(
      of: field,
      matching: find.byType(EditableText),
    );
    final originalEditor = tester.state<EditableTextState>(editable);

    await tester.enterText(field, '#openharness');
    await tester.pump();
    expect(editor.text, '#openharness');
    expect(search(tester).isProjectMode, isTrue);
    editor.selection = const TextSelection(baseOffset: 0, extentOffset: 1);
    await key(tester, LogicalKeyboardKey.backspace);
    expect(editor.text, 'openharness');
    expect(search(tester).query, 'openharness');
    expect(search(tester).scopePrefix, '');

    await tester.enterText(field, '  # openharness');
    await tester.pump();
    expect(editor.text, '  # openharness');
    expect(search(tester).isProjectMode, isTrue);
    await tester.enterText(field, '>');
    await tester.pump();
    expect(search(tester).isCommandMode, isTrue);
    expect(tester.state<EditableTextState>(editable), same(originalEditor));
    await key(tester, LogicalKeyboardKey.backspace);
    expect(editor.text, isEmpty);
    expect(search(tester).isCommandMode, isFalse);
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    expect(tester.state<EditableTextState>(editable), same(originalEditor));

    const composing = TextEditingValue(
      text: '#日本',
      selection: TextSelection.collapsed(offset: 3),
      composing: TextRange(start: 1, end: 3),
    );
    tester.testTextInput.updateEditingValue(composing);
    await tester.pump();
    app.notifyListeners();
    await tester.pump();
    expect(editor.value, composing);
    expect(search(tester).query, '#日本');
    expect(search(tester).isProjectMode, isTrue);
    tester.testTextInput.updateEditingValue(
      composing.copyWith(composing: TextRange.empty),
    );
    await tester.pump();
    expect(editor.text, '#日本');
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    keymap.dispose();
  });

  for (final withKeymap in [false, true]) {
    testWidgets(
      'editable prefixes change scope and backspace returns to harnesses ($withKeymap)',
      (tester) async {
        final app = await fixture();
        if (withKeymap) {
          await configured.mount(tester, app, MemoryKeymap());
        } else {
          await mount(tester, app);
        }
        await openHarnessPicker(tester);
        final reads = app.localReads;
        for (final (prefix, label) in [
          ('@', 'Add machine'),
          (':', '[ Add ]'),
        ]) {
          await tester.enterText(field, prefix);
          await tester.pump();
          expect(
            search(tester).rows.singleWhere((row) => row.isCreate).title,
            label,
          );
          expect(search(tester).selected!.isCreate, isFalse);
          expect(tester.widget<TextField>(field).controller!.text, prefix);
          await tester.enterText(field, '${prefix}missing');
          expect(search(tester).scopePrefix, prefix);
          await tester.enterText(field, prefix);
          await key(tester, LogicalKeyboardKey.backspace);
          expect(search(tester).scopePrefix, '');
        }
        await tester.enterText(field, '#');
        await tester.pump();
        expect(search(tester).rows.any((row) => row.isCreate), isFalse);
        await tester.enterText(field, '#missing-project');
        await tester.pump();
        expect(search(tester).rows, isEmpty);
        expect(search(tester).canAccept, isFalse);
        await tester.enterText(field, '*blender');
        await tester.pump();
        expect(search(tester).selected!.storeId, 'blender');
        expect(tester.widget<TextField>(field).controller!.text, '*blender');
        expect(find.byKey(const ValueKey('search-action-list')), findsNothing);
        expect(
          app.localReads,
          reads,
          reason: 'Typing filters the cached inventory',
        );
        expect(app.actions, isEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );

    testWidgets('named model actions return to the same query ($withKeymap)', (
      tester,
    ) async {
      final app = await fixture();
      if (withKeymap) {
        await configured.mount(tester, app, MemoryKeymap());
      } else {
        await mount(tester, app);
      }
      await openHarnessPicker(tester);
      await tester.enterText(field, ':qwen');
      await tester.pump();
      final controller = search(tester);
      final index = controller.rows.indexWhere(
        (row) => row.modelId == 'model:local:qwen',
      );
      controller.move(index - controller.cursor);
      await tester.pump();
      expect(app.actions, isEmpty);
      expect(find.text('ctrl-S'), findsNothing);
      expect(find.byKey(const ValueKey('picker-keyboard-hints')), findsNothing);
      await tester.pumpAndSettle();
      await capture(tester, 'model-actions');
      await key(tester, LogicalKeyboardKey.slash, ctrl: true);
      expect(controller.hasPreview, isFalse);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      final commandField = find.byKey(const ValueKey('resource-command-input'));
      await tester.enterText(commandField, 'get');
      await tester.pump();
      expect(find.text('Get'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      expect(app.actions, isEmpty);
      expect(app.downloads, [(machine: 'm', model: 'qwen')]);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      expect(controller.isModelMode, isTrue);
      await key(tester, LogicalKeyboardKey.escape);
      expect(field, findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }

  testWidgets(
    'resource previews scroll by line and empty searches stay inert',
    (tester) async {
      final app = await fixture();
      app.machineStates['m']!.dsh.replace([
        DshEntry(
          id: 'blender',
          name: 'Blender',
          engine: 'codex',
          description: List.generate(
            90,
            (i) => 'Product description line $i.',
          ).join('\n'),
        ),
      ]);
      app.modelManager.apis.connections = [
        ApiConnection({
          'id': 'deepseek-api',
          'provider': 'custom',
          'name': 'DeepSeek API',
          'baseUrl':
              'https://example.test/${List.filled(500, 'endpoint/').join()}',
          'keyEnv': 'TEST_API_KEY',
        }),
      ];
      final originalFont = terminalFontStore.value;
      addTearDown(() => terminalFontStore.value = originalFont);
      await configured.mount(tester, app, MemoryKeymap());
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      final controller = search(tester);
      ScrollPosition position() => tester
          .widget<ListView>(
            find.descendant(
              of: find.byType(SwarmResourcePreview),
              matching: find.byType(ListView),
            ),
          )
          .controller!
          .position;
      for (final query in ['*blender', ':deepseek']) {
        await tester.enterText(field, query);
        await tester.pumpAndSettle();
        final selected = controller.selected!.id;
        expect(position().pixels, 0);
        expect(position().maxScrollExtent, greaterThan(0));
        final editing = tester.widget<TextField>(field).controller!.value;
        await key(tester, LogicalKeyboardKey.arrowDown, shift: true);
        expect(
          position().pixels,
          closeTo(terminalCellSizeOf(tester.element(field)).height, .01),
        );
        await key(tester, LogicalKeyboardKey.arrowUp, shift: true);
        await key(tester, LogicalKeyboardKey.arrowUp, shift: true);
        expect(position().pixels, 0);
        terminalFontStore.value = const TerminalStyle(
          fontSize: 20,
          fontFamily: 'Menlo',
          height: 1.5,
        );
        await tester.pumpAndSettle();
        await key(tester, LogicalKeyboardKey.arrowDown, shift: true);
        expect(
          position().pixels,
          closeTo(terminalCellSizeOf(tester.element(field)).height, .01),
        );
        controller.scrollPreview(10000);
        await tester.pumpAndSettle();
        expect(position().pixels, position().maxScrollExtent);
        await key(tester, LogicalKeyboardKey.arrowDown, shift: true);
        expect(position().pixels, position().maxScrollExtent);
        expect(controller.selected!.id, selected);
        expect(tester.widget<TextField>(field).controller!.value, editing);
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      }
      await tester.enterText(field, '*no-such-product');
      await tester.pumpAndSettle();
      expect(controller.rows, isEmpty);
      expect(controller.selected, isNull);
      for (final button in [
        LogicalKeyboardKey.arrowUp,
        LogicalKeyboardKey.arrowDown,
        LogicalKeyboardKey.pageUp,
        LogicalKeyboardKey.pageDown,
        LogicalKeyboardKey.enter,
      ]) {
        await key(tester, button);
      }
      await key(tester, LogicalKeyboardKey.arrowDown, shift: true);
      expect(controller.selected, isNull);
      expect(field, findsOneWidget);
      expect(app.actions, isEmpty);
      // A pending scroll cannot act on a later selection or a disposed view.
      controller.setQuery('*blender');
      controller.scrollPreview(1);
      controller.setQuery('');
      await tester.pump();
      expect(controller.selected, isNull);
      expect(
        find.byKey(const ValueKey('swarm-search-type-hints')),
        findsOneWidget,
      );
      controller.setQuery('*blender');
      controller.scrollPreview(1);
      await tester.pumpWidget(const SizedBox());
      expect(tester.takeException(), isNull);
      app.dispose();
    },
  );

  testWidgets('machine Enter manages in place, even before connection', (
    tester,
  ) async {
    final app = await fixture();
    await configured.mount(tester, app, MemoryKeymap());
    await openHarnessPicker(tester);
    for (final online in [false, true]) {
      app.stateOf('m')!
        ..nodeOnline = online
        ..needsLink = true;
      app.notifyListeners();
      await tester.enterText(field, '@');
      await tester.pump();
      final origin = search(tester);
      origin.move(
        origin.rows.indexWhere((row) => row.id == 'machine:m') - origin.cursor,
      );
      await tester.pump();
      final inputPosition = tester.getTopLeft(field);
      await key(tester, LogicalKeyboardKey.enter);
      expect(search(tester), same(origin));
      expect(origin.canGoBack, isFalse);
      expect(origin.isMachineMode, isTrue);
      expect(origin.managing, isTrue);
      expect(origin.scopedMachineId, isNull);
      expect(tester.getTopLeft(field), inputPosition);
      expect(find.text(origin.title), findsNothing);
      expect(find.byType(TextField), findsOneWidget);
      expect(app.actions, isEmpty);
      await capture(tester, 'machine-management');
      await key(tester, LogicalKeyboardKey.escape);
      expect(origin.isMachineMode, isTrue);
    }
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'action cancellation preserves search and stale targets cannot run',
    (tester) async {
      final app = await fixture();
      final keymap = MemoryKeymap();
      await configured.mount(tester, app, keymap);
      final mac = defaultTargetPlatform == TargetPlatform.macOS;
      await openHarnessPicker(tester);
      await tester.enterText(field, ':qwen');
      await tester.pump();
      final origin = search(tester);
      origin.move(
        origin.rows.indexWhere((row) => row.modelId == 'model:local:qwen') -
            origin.cursor,
      );
      await tester.pump();
      final selected = origin.selected!.id;
      final query = origin.query;
      await key(
        tester,
        LogicalKeyboardKey.keyP,
        cmd: mac,
        ctrl: !mac,
        shift: true,
      );
      final commands = find.byKey(const ValueKey('resource-command-input'));
      await tester.enterText(commands, 'get');
      await tester.pump();
      expect(search(tester).rows, hasLength(1));
      await key(tester, LogicalKeyboardKey.escape);
      expect(origin.selected!.id, selected);
      expect(origin.query, query);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      expect(app.actions, isEmpty);
      await key(
        tester,
        LogicalKeyboardKey.keyP,
        cmd: mac,
        ctrl: !mac,
        shift: true,
      );
      await tester.enterText(commands, 'get');
      await tester.pump();
      origin.move(1);
      await tester.pump();
      expect(search(tester).rows, isEmpty);
      await key(tester, LogicalKeyboardKey.enter);
      expect(app.actions, isEmpty);
      await key(tester, LogicalKeyboardKey.escape);
      expect(field, findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      keymap.dispose();
    },
    variant: const TargetPlatformVariant({
      TargetPlatform.macOS,
      TargetPlatform.linux,
    }),
  );

  testWidgets('machine setup and API editor return to the same picker', (
    tester,
  ) async {
    final app = await fixture();
    await configured.mount(tester, app, MemoryKeymap());
    await openHarnessPicker(tester);
    await tester.enterText(field, '@');
    await tester.pump();
    await key(tester, LogicalKeyboardKey.arrowUp);
    await key(tester, LogicalKeyboardKey.enter);
    expect(find.byType(MachinePickerForm), findsNothing);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('Add machine · App'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    await capture(tester, 'machine-setup-app-inline');
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.arrowRight);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('Add machine · CLI'), findsOneWidget);
    await capture(tester, 'machine-setup-cli-inline');
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.escape);
    expect(search(tester).isMachineMode, isTrue);
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    await tester.enterText(field, ':deepseek');
    await tester.pump();
    final controller = search(tester);
    controller.move(
      controller.rows.indexWhere((row) => row.isModel) - controller.cursor,
    );
    await tester.pump();
    await key(tester, LogicalKeyboardKey.enter);
    expect(controller.managing, isFalse);
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    await key(tester, LogicalKeyboardKey.tab);
    expect(controller.managing, isTrue);
    expect(find.byType(ApiPickerForm), findsNothing);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.byType(ApiPickerForm), findsOneWidget);
    expect(find.text('https://api.deepseek.com'), findsWidgets);
    expect(find.byType(Dialog), findsNothing);
    final name = find.byKey(const ValueKey('api-form-input:name'));
    await tester.enterText(name, 'Draft API');
    await key(tester, LogicalKeyboardKey.tab);
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    expect(controller.managing, isFalse);
    await key(tester, LogicalKeyboardKey.enter);
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    await key(tester, LogicalKeyboardKey.tab, shift: true);
    expect(tester.widget<TextField>(name).focusNode!.hasFocus, isTrue);
    expect(tester.widget<TextField>(name).controller!.text, 'Draft API');
    await capture(tester, 'api-edit-inline');
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(search(tester).selected!.modelId, 'model:api:deepseek-api');
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'resource previews and commands preserve state through live appearance changes',
    (tester) async {
      final originalPalette = grid.AppTheme.palette.value;
      final originalTheme = terminalThemeStore.value;
      final originalFont = terminalFontStore.value;
      addTearDown(() {
        grid.AppTheme.palette.value = originalPalette;
        terminalThemeStore.value = originalTheme;
        terminalFontStore.value = originalFont;
      });
      final app = await fixture();
      await mount(tester, app);
      await openHarnessPicker(tester);
      await tester.enterText(field, ':qwen');
      await tester.pump();
      final controller = search(tester);
      controller.move(
        controller.rows.indexWhere((row) => row.modelId == 'model:local:qwen') -
            controller.cursor,
      );
      await tester.pumpAndSettle();
      final selected = controller.selected!.id;
      final editor = tester.widget<TextField>(field).controller!;
      final editing = editor.value;

      grid.AppTheme.palette.value = HarnessPalette.slate;
      terminalThemeStore.value = TerminalThemeChoice.tango;
      terminalFontStore.value = const TerminalStyle(
        fontSize: 18,
        fontFamily: 'Menlo',
        fontFamilyFallback: ['monospace'],
        height: 1.4,
      );
      await tester.pumpAndSettle();
      final theme = terminalThemeFor(
        grid.AppTheme.palette.value,
        terminalThemeStore.value,
      );
      final previewText = find.descendant(
        of: find.byType(SwarmResourcePreview),
        matching: find.byType(Text),
      );
      expect(previewText, findsWidgets);
      for (final element in previewText.evaluate()) {
        final text = element.widget as Text;
        final style = DefaultTextStyle.of(element).style.merge(text.style);
        expect(style.fontSize, 18);
        expect(style.height, 1.4);
        expect(
          style.color,
          isIn([
            theme.foreground,
            theme.foreground.withValues(alpha: .54),
            theme.foreground.withValues(alpha: .28),
          ]),
        );
      }
      expect(controller.selected!.id, selected);
      expect(tester.widget<TextField>(field).controller, same(editor));
      expect(editor.value, editing);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      await capture(tester, 'models-tango-large');

      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      final commandField = find.byKey(const ValueKey('resource-command-input'));
      await tester.enterText(commandField, 'get');
      await tester.pumpAndSettle();
      final commandSearch = search(tester);
      final commandId = commandSearch.selected!.id;
      final commandEditor = tester.widget<TextField>(commandField).controller!;
      terminalThemeStore.value = TerminalThemeChoice.matchApp;
      grid.AppTheme.palette.value = HarnessPalette.midnight;
      terminalFontStore.value = originalFont;
      await tester.pumpAndSettle();
      final commandTheme = terminalThemeFor(
        grid.AppTheme.palette.value,
        terminalThemeStore.value,
      );
      final line = find.byKey(ValueKey('swarm-search-line:$commandId'));
      final cell = terminalCellSizeOf(tester.element(commandField));
      expect(tester.getSize(line).height, closeTo(cell.height, .01));
      expect(tester.widget<Container>(line).color, commandTheme.selection);
      expect(
        tester
            .widget<Dialog>(
              find.byKey(const ValueKey('resource-command-picker')),
            )
            .backgroundColor,
        commandTheme.background,
      );
      expect(commandSearch.selected!.id, commandId);
      expect(
        tester.widget<TextField>(commandField).controller,
        same(commandEditor),
      );
      expect(commandEditor.text, 'get');
      expect(
        tester.widget<TextField>(commandField).focusNode!.hasFocus,
        isTrue,
      );
      await capture(tester, 'commands-midnight');
      tester.view.physicalSize = const Size(400, 600);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await capture(tester, 'commands-narrow');
      await key(tester, LogicalKeyboardKey.escape);
      expect(controller.selected!.id, selected);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      expect(app.actions, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('live store inventory updates and every resource renders', (
    tester,
  ) async {
    final originalFont = terminalFontStore.value;
    final originalTheme = terminalThemeStore.value;
    addTearDown(() {
      terminalFontStore.value = originalFont;
      terminalThemeStore.value = originalTheme;
    });
    final app = await fixture();
    await mount(tester, app);
    await openHarnessPicker(tester);
    for (final narrow in [false, true]) {
      if (narrow) {
        tester.view.physicalSize = const Size(480, 600);
        terminalFontStore.value = const TerminalStyle(
          fontSize: 18,
          fontFamily: 'Menlo',
          height: 1.4,
        );
        terminalThemeStore.value = TerminalThemeChoice.tango;
      }
      for (final (query, kind) in [
        ('Checkout', 'harnesses'),
        ('@', 'machines'),
        ('#', 'projects'),
        (':qwen', 'models'),
        (':deepseek', 'api'),
        ('*', 'store'),
      ]) {
        await tester.enterText(field, query);
        await tester.pump();
        final controller = search(tester);
        final index = controller.rows.indexWhere(
          (row) => switch (kind) {
            'machines' => row.id == 'machine:m',
            'models' => row.modelId == 'model:local:qwen',
            _ => !row.isCreate,
          },
        );
        controller.move(index - controller.cursor);
        await tester.pump(const Duration(milliseconds: 200));
        final preview = find.byType(SwarmResourcePreview);
        expect(preview, findsOneWidget);
        expect(
          find.descendant(
            of: preview,
            matching: find.text(controller.selected!.title),
          ),
          findsWidgets,
        );
        final cell = terminalCellSizeOf(tester.element(field));
        final visibleRows = [
          for (final row in controller.rows)
            if (find.byKey(ValueKey(row.id)).evaluate().isNotEmpty) row,
        ];
        for (final row in visibleRows) {
          final result = find.byKey(ValueKey(row.id));
          expect(tester.getSize(result).height, closeTo(cell.height, .01));
          expect(
            tester
                .widgetList<SearchResultText>(
                  find.descendant(
                    of: result,
                    matching: find.byType(SearchResultText),
                  ),
                )
                .map((text) => text.text),
            row.isCreate ? isEmpty : [row.title],
          );
        }
        for (var i = 1; i < visibleRows.length; i++) {
          final sectionBreak =
              controller.isModelMode &&
              controller.modelSection(visibleRows[i]) !=
                  controller.modelSection(visibleRows[i - 1]);
          expect(
            tester.getTopLeft(find.byKey(ValueKey(visibleRows[i].id))).dy -
                tester
                    .getTopLeft(find.byKey(ValueKey(visibleRows[i - 1].id)))
                    .dy,
            closeTo(cell.height * (sectionBreak ? 3 : 1), .01),
          );
        }
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
        expect(tester.takeException(), isNull);
        await capture(tester, '$kind-single-line${narrow ? '-narrow' : ''}');
        final createIndex = controller.rows.indexWhere((row) => row.isCreate);
        if (createIndex >= 0) {
          controller.move(createIndex - controller.cursor);
          await tester.pump();
          expect(
            find.descendant(
              of: preview,
              matching: find.text(
                controller.createDescription.split('\n').first,
              ),
            ),
            findsOneWidget,
          );
        }
      }
    }
    app.machineStates['m']!.dsh.replace(const [
      DshEntry(id: 'excalidraw', name: 'Excalidraw', engine: 'codex'),
    ]);
    app.notifyListeners();
    await tester.pump();
    expect(search(tester).rows.single.storeId, 'excalidraw');
    for (final size in [const Size(760, 650), const Size(400, 600)]) {
      tester.view.physicalSize = size;
      await tester.enterText(field, ':qwen');
      await tester.pump();
      search(tester).move(1);
      await tester.pump();
      expect(find.byKey(const ValueKey('search-action-list')), findsNothing);
      expect(tester.takeException(), isNull);
    }
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'a single-session group keeps its name and count in the preview',
    (tester) async {
      final app = await fixture();
      final machine = app.machineStates['other']!;
      machine.agents = [app.machineStates['m']!.agents.first];
      await mount(tester, app);
      await openHarnessPicker(tester);
      for (final (query, name) in [
        ('@Other computer', 'Other computer'),
        ('#storefront', 'storefront'),
      ]) {
        // The project is only present on one machine in this case.
        if (query.startsWith('#')) {
          machine.agents = [];
          app.notifyListeners();
        }
        await tester.enterText(field, query);
        await tester.pumpAndSettle();
        final selected = search(tester).selected!;
        expect(selected.members, hasLength(1));
        final preview = find.byType(SwarmResourcePreview);
        expect(
          find.descendant(of: preview, matching: find.text(name)),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: preview,
            matching: find.text(
              selected.isMachine ? '1 harness' : selected.detail,
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: preview, matching: find.text('Checkout retries')),
          selected.isMachine ? findsNothing : findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      }
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}

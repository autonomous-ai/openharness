import 'support/open_harness.dart';
import 'support/resource_picker.dart';
import 'support/agent_picker.dart';
import 'support/new_agent_project.dart';

import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/codex_profiles.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_choice_picker.dart';
import 'package:harness/shared/widgets/app_select_field.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/models/models_panel.dart';
import 'package:harness/widgets/codex_profile_field.dart';
import 'package:harness/widgets/account_menu.dart';
import 'package:harness/widgets/agent_drag.dart' show PaneCloseButton;
import 'package:harness/widgets/new_agent_dialog.dart';
import 'package:harness/widgets/notification_inbox.dart';
import 'package:harness/widgets/swarm_dialogs.dart';
import 'package:harness/widgets/terminal_find_bar.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp, MemoryStore;

class _ProfilesNotifier extends AppNotifier {
  _ProfilesNotifier()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
  final pending = <String, Completer<Map<String, dynamic>>>{};
  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}
  @override
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) => (pending[machineId] = Completer()).future;
}

class _PendingFolder extends FileSelectorPlatform {
  final answer = Completer<String?>();
  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) => answer.future;
}

Future<void> chord(
  WidgetTester tester,
  LogicalKeyboardKey key, {
  bool shift = false,
}) async {
  await tester.sendKeyDownEvent(LogicalKeyboardKey.meta);
  if (shift) await tester.sendKeyDownEvent(LogicalKeyboardKey.shift);
  await tester.sendKeyEvent(key);
  if (shift) await tester.sendKeyUpEvent(LogicalKeyboardKey.shift);
  await tester.sendKeyUpEvent(LogicalKeyboardKey.meta);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  for (final native in [false, true]) {
    testWidgets(
      'every New Tab entry opens a quiet welcome and preserves work (native: $native)',
      (tester) async {
        const channel = MethodChannel('harness/swarm_tabs');
        const codec = StandardMethodCodec();
        final messenger = tester.binding.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(channel, (_) async => true);
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        final app = createApp(connected: true);
        app.adoptSessionForTest(terminal('a0', []));
        final work = app.activeSwarmId;
        app.newSwarm();
        final starter = app.activeSwarmId;
        final projects = SwarmProjectStore(storage: MemoryStore());
        await tester.pumpWidget(
          MaterialApp(
            home: SwarmScreen(
              notifier: app,
              nativeTabs: native,
              projectStore: projects,
            ),
          ),
        );
        await tester.pumpAndSettle();

        Future<void> newFromChrome() async {
          if (!native) {
            await tester.tap(
              find.byKey(const ValueKey('swarm-new-tab-button')),
            );
            return;
          }
          var replied = false;
          messenger.handlePlatformMessage(
            channel.name,
            codec.encodeMethodCall(const MethodCall('new')),
            (_) => replied = true,
          );
          for (var i = 0; i < 5 && !replied; i++) {
            await tester.pump();
          }
          expect(replied, isTrue);
        }

        for (final action in <Future<void> Function()>[
          () => chord(tester, LogicalKeyboardKey.keyT),
          newFromChrome,
          () async {
            await chord(tester, LogicalKeyboardKey.keyP, shift: true);
            await tester.enterText(
              find.byKey(const ValueKey('swarm-search-input')),
              '> New Tab',
            );
            await tester.pump();
            await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          },
        ]) {
          app.selectSwarm(work);
          await tester.pumpAndSettle();
          await action();
          await tester.pumpAndSettle();
          expect(app.activeSwarmId, isNot(work));
          expect(app.activeSwarm.isNewTabPage, isTrue);
          expect(app.swarms, hasLength(3));
          expect(
            find.byKey(const ValueKey('workspace-welcome')),
            findsOneWidget,
          );
          final input = find.byKey(const ValueKey('swarm-search-input'));
          expect(input, findsNothing);
          final created = app.activeSwarmId;
          await openHarnessPicker(tester);
          expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
          await tester.enterText(input, 'Agent 1');
          await tester.pump();
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          await tester.pump();
          expect(input, findsNothing);
          expect(app.activeSwarmId, created);
          await chord(tester, LogicalKeyboardKey.keyW);
          expect(app.swarms, hasLength(2));
        }
        await newFromChrome();
        await tester.pump();
        await openHarnessPicker(tester);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          'Agent 0',
        );
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(app.activeSwarmId, isNot(starter));
        expect(app.swarms, hasLength(3));
        expect(app.panes.single.agentId, 'a0');
        expect(
          app.swarms.firstWhere((tab) => tab.id == work).panes.single.agentId,
          'a0',
        );
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        projects.dispose();
      },
    );
  }

  for (final native in [false, true]) {
    testWidgets(
      'Cmd-W preserves term renamed to office beside another term (native=$native)',
      (tester) async {
        const channel = MethodChannel('harness/swarm_tabs');
        final updates = <Map>[];
        final messenger = tester.binding.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'update') updates.add(call.arguments as Map);
          return true;
        });
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        final app = createApp();
        addTearDown(app.dispose);
        final projects = SwarmProjectStore(storage: MemoryStore());
        addTearDown(projects.dispose);
        final input = <TerminalBinaryFrame>[];
        final session = terminal('a0', input);
        app.machineStates['m']!.nodeOnline = true;
        final pane = app.adoptSessionForTest(session);
        final office = app.activeSwarm;
        app.renameSwarm(office.id, 'term');
        app.newSwarm(name: 'term');
        final term = app.activeSwarm;
        app.adoptSessionForTest(terminal('a1', input));
        app.selectSwarm(office.id);
        await mount(tester, app, projects: projects, nativeTabs: native);

        await chord(tester, LogicalKeyboardKey.keyR, shift: true);
        await tester.enterText(
          find.byKey(const Key('tab-rename-input')),
          'office',
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(office.name, 'office');
        expect(office.nameIsCustom, isTrue);

        app.selectSwarm(term.id);
        await tester.pump();
        await chord(tester, LogicalKeyboardKey.keyW);
        expect(app.swarms, [office]);
        expect(app.activeSwarm, same(office));
        expect(office.name, 'office');
        expect(office.panes.single, same(pane));
        expect(pane.session, same(session));
        expect(input, isEmpty);
        if (native) {
          final tab = (updates.last['tabs'] as List).single as Map;
          expect(tab['id'], office.id);
          expect(tab['label'], 'office');
          expect(tab['shortcutHint'], '⌘1');
        } else {
          expect(find.text('office'), findsOneWidget);
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'welcome opens the shared search and supports readline selection',
    (tester) async {
      final app = createApp(connected: true);
      await mount(tester, app);
      await openHarnessPicker(tester);
      await tester.pump();
      expect(app.panes, isEmpty);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'Agent 1',
      );
      await tester.pump();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.control);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyN);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.control);
      await tester.pump();
      final selected = find.byWidgetPredicate(
        (w) => w is Semantics && w.properties.selected == true,
      );
      expect(
        find.descendant(of: selected, matching: find.text('Agent 10')),
        findsOneWidget,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(app.panes.single.agentId, 'a10');
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('closing the final view or its tab keeps shared sessions alive', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final session = terminal('a0', []);
    app.adoptSessionForTest(session);
    final original = app.activeSwarm;
    app.newSwarm();
    await app.addAgentToSwarm('m', 'a0');
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyW, shift: true);
    expect(app.swarms, [original]);
    expect(app.panes.single.session, same(session));
    app.newSwarm();
    await app.addAgentToSwarm('m', 'a0');
    await tester.pumpAndSettle();
    expect(app.swarms.length, 2);
    await chord(tester, LogicalKeyboardKey.keyW);
    expect(app.swarms.single, same(original));
    expect(app.panes.single.session, same(session));
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'keyboard pane actions replace header controls and keep other views alive',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      app.adoptSessionForTest(session);
      final original = app.activeSwarm;
      app.newSwarm();
      await app.addAgentToSwarm('m', 'a0');
      final pane = app.panes.single;
      app.adoptSessionForTest(terminal('a1', []));
      await mount(tester, app);

      app.focusPane(pane.id);
      await tester.pump();
      for (final label in ['Close Pane', 'Zoom Pane', 'Stop Harness']) {
        expect(find.byTooltip(label), findsNothing);
      }
      await chord(tester, LogicalKeyboardKey.enter);
      expect(app.zoomedPaneId, pane.id);
      await chord(tester, LogicalKeyboardKey.enter);
      expect(app.zoomedPaneId, isNull);
      await chord(tester, LogicalKeyboardKey.keyW, shift: true);
      expect(app.panes.single.agentId, 'a1');
      expect(original.panes.single.session, same(session));
      app.selectSwarm(original.id);
      await tester.pump();
      tester.testTextInput.enterText('x');
      await tester.pump(const Duration(milliseconds: 20));
      expect(
        String.fromCharCodes(
          input.where((f) => f.kind == TerminalBinaryKind.input).single.bytes,
        ),
        'x',
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'native tab replies wait for destination focus and allow rename input',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      const codec = StandardMethodCodec();
      final messenger = tester.binding.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (_) async => true);
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final app = createApp();
      final input = <TerminalBinaryFrame>[];
      app.machineStates['m']!.nodeOnline = true;
      app.adoptSessionForTest(terminal('a0', input));
      final first = app.activeSwarmId;
      app.newSwarm();
      app.adoptSessionForTest(terminal('a1', input));
      final second = app.activeSwarmId;
      app.selectSwarm(first);
      final projects = SwarmProjectStore();
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump();

      Future<void> activate(String method, [Object? args]) async {
        final reply = Completer<void>();
        messenger.handlePlatformMessage(
          channel.name,
          codec.encodeMethodCall(MethodCall(method, args)),
          (bytes) {
            try {
              codec.decodeEnvelope(bytes!);
              reply.complete();
            } catch (error, stack) {
              reply.completeError(error, stack);
            }
          },
        );
        for (var frame = 0; frame < 5 && !reply.isCompleted; frame++) {
          await tester.pump();
        }
        expect(
          reply.isCompleted,
          isTrue,
          reason: '$method must acknowledge its visible result',
        );
        await reply.future;
      }

      await activate('select', {'id': second});
      expect(app.activeSwarmId, second);
      // No extra frame between the native acknowledgement and the first key.
      expect(tester.testTextInput.hasAnyClients, isTrue);
      tester.testTextInput.enterText('x');
      await tester.idle();
      expect(input.single.streamId, 'stream-a1');
      expect(String.fromCharCodes(input.single.bytes), 'x');
      await activate('rename', {'id': second});
      expect(find.text('Rename Tab'), findsOneWidget);
      final name = tester.widget<TextField>(find.byType(TextField));
      expect(name.focusNode!.hasPrimaryFocus, isTrue);
      tester.testTextInput.enterText('Keyboard work');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      expect(app.activeSwarm.name, 'Keyboard work');
      expect(input, hasLength(1));

      await activate('close', {'id': second});
      expect(app.activeSwarmId, first);
      // The closed tab's neighbour is shown; the keyboard waits on the strip.
      expect(app.tabStripFocused, isTrue);
      expect(tester.testTextInput.hasAnyClients, isFalse);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyY);
      expect(input, hasLength(1));
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(tester.testTextInput.hasAnyClients, isTrue);
      tester.testTextInput.enterText('y');
      await tester.idle();
      expect(input.last.streamId, 'stream-a0');
      expect(String.fromCharCodes(input.last.bytes), 'y');
      await activate('close', {'id': first});
      expect(app.swarms, hasLength(1));
      expect(app.panes, isEmpty);
      expect(app.activeSwarmId, isNot(anyOf(first, second)));
      expect(
        find.byKey(const ValueKey('harness-start-search')),
        findsOneWidget,
      );
      final starter = app.activeSwarmId;
      await activate('new');
      expect(app.swarms, hasLength(2));
      expect(app.activeSwarmId, isNot(starter));
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(app.swarms, hasLength(2));
      expect(app.activeSwarmId, isNot(starter));
      expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
      expect(input, hasLength(2));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      projects.dispose();
    },
  );

  testWidgets('native Tab commands cannot mutate the view behind a dialog', (
    tester,
  ) async {
    const channel = MethodChannel('harness/swarm_tabs');
    final updates = <Map>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'update') updates.add(call.arguments as Map);
      return null;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    Future<void> native(String method, [Object? args]) {
      final result = Completer<void>();
      tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(MethodCall(method, args)),
        (_) => result.complete(),
      );
      return result.future;
    }

    final app = createApp();
    final projects = SwarmProjectStore();
    await tester.pumpWidget(
      MaterialApp(
        home: SwarmScreen(
          notifier: app,
          nativeTabs: true,
          projectStore: projects,
        ),
      ),
    );
    await tester.pump();
    final opening = native('settings');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(SettingsScreen), findsOneWidget);
    // Settings alone leaves the tab row live (the next test); menus and
    // shortcuts stay off behind it.
    expect(updates.last['enabled'], isFalse);
    expect(updates.last['stripEnabled'], isTrue);
    // A dialog over Settings is modal: the row waits with everything else.
    final confirm = showDialog<void>(
      context: tester.element(find.byType(SettingsScreen)),
      builder: (_) => const AlertDialog(title: Text('Over Settings')),
    );
    await tester.pump(const Duration(milliseconds: 300));
    expect(updates.last['enabled'], isFalse);
    expect(updates.last['stripEnabled'], isFalse);
    await native('new');
    await native('closeActive');
    await native('notifications');
    await native('rowAction', {'method': 'new'});
    await native('rowAction', {'method': 'notifications'});
    expect(find.text('Needs input'), findsNothing);
    expect(app.swarms.single.id, 'swarm-1');
    expect(find.byType(SettingsScreen), findsOneWidget);
    Navigator.of(tester.element(find.byType(AlertDialog))).pop();
    await tester.pump(const Duration(milliseconds: 300));
    await confirm;
    expect(updates.last['stripEnabled'], isTrue);
    Navigator.of(tester.element(find.byType(SettingsScreen))).pop();
    await tester.pump(const Duration(milliseconds: 300));
    await opening;
    expect(updates.last['enabled'], isTrue);
    app.renameSwarm(app.activeSwarmId, 'Recover me');
    await app.closeSwarm(app.activeSwarmId);
    await tester.pump();
    final beforeExternal = app.activeSwarmId;
    expect(updates.last['canReopen'], isTrue);
    // Root app-menu dialogs enter outside SwarmScreen's own dialog helper.
    final external = showDialog<void>(
      context: tester.element(find.byType(SwarmScreen)),
      builder: (_) => const AlertDialog(title: Text('External menu dialog')),
    );
    await tester.pump(const Duration(milliseconds: 300));
    expect(updates.last['enabled'], isFalse);
    await native('new');
    await native('reopen');
    expect(app.swarms.single.id, beforeExternal);
    Navigator.of(tester.element(find.byType(AlertDialog))).pop();
    await tester.pump(const Duration(milliseconds: 300));
    await external;
    expect(updates.last['enabled'], isTrue);
    await native('reopen');
    await tester.pump();
    expect(app.swarms.single.name, 'Recover me');
    expect(updates.last['canReopen'], isFalse);
    final attention = native('notifications');
    await tester.pump();
    expect(resourceScope(''), findsOneWidget);
    expect(updates.last['sessionsOpen'], isTrue);
    expect(updates.last['enabled'], isTrue);
    final repeatedAttention = native('notifications');
    await tester.pump();
    await repeatedAttention;
    expect(app.swarms.single.name, 'Recover me');
    expect(resourceScope(''), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await attention;
    expect(updates.last['sessionsOpen'], isFalse);
    expect(updates.last['enabled'], isTrue);
    expect(updates.last['canFind'], isFalse);
    app.machineStates['m']!.nodeOnline = true;
    final session = terminal('a0', []);
    session.terminal.write('marker one\r\nmarker two\r\n');
    app.adoptSessionForTest(session);
    app.dismissError();
    await tester.pump();
    expect(updates.last['canFind'], isTrue);
    app.machineStates['m']!.nodeOnline = false;
    app.dismissError();
    await tester.pump();
    expect(
      updates.last['canFind'],
      isTrue,
      reason: 'Retained offline output stays searchable',
    );
    await native('findTerminal');
    await tester.pump();
    expect(find.byType(TerminalFindBar), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'marker');
    await tester.pump(const Duration(milliseconds: 10));
    final search = tester
        .widget<TerminalFindBar>(find.byType(TerminalFindBar))
        .search!;
    expect(search.count, 2);
    await native('findNext');
    await tester.pump();
    expect(search.selected, 1);
    await native('findPrevious');
    await tester.pump();
    expect(search.selected, 0);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.byType(TerminalFindBar), findsNothing);
    await tester.pumpWidget(const SizedBox());
    projects.dispose();
    app.dispose();
  });

  testWidgets(
    'with Settings open, choosing a tab or a title-bar icon closes Settings and acts',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final updates = <Map>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return null;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      Future<void> native(String method, [Map<String, Object?>? args]) {
        final result = Completer<void>();
        tester.binding.defaultBinaryMessenger.handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(
            MethodCall(method, args),
          ),
          (_) => result.complete(),
        );
        return result.future;
      }

      final app = createApp();
      final projects = SwarmProjectStore();
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump();
      final first = app.activeSwarmId;
      app.newSwarm(newTabPage: true);
      await tester.pump();
      final second = app.activeSwarmId;
      expect(second, isNot(first));

      Future<void> openSettings() async {
        unawaited(native('settings'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        expect(find.byType(SettingsScreen), findsOneWidget);
        expect(updates.last['stripEnabled'], isTrue);
      }

      // AppKit sends the row's actions as `rowAction` while the menus are off.
      // Its reply waits for Settings to close and the action to land.
      Future<void> act(String method, [Map<String, Object?>? args]) async {
        final reply = native('rowAction', {
          'method': method,
          'arguments': ?args,
        });
        var answered = false;
        unawaited(reply.then((_) => answered = true));
        for (var frame = 0; frame < 5 && !answered; frame++) {
          await tester.pump();
        }
        expect(answered, isTrue, reason: '$method must answer');
        await tester.pump(const Duration(milliseconds: 300));
      }

      await openSettings();
      await act('select', {'id': first});
      expect(find.byType(SettingsScreen), findsNothing);
      expect(app.activeSwarmId, first);
      expect(updates.last['enabled'], isTrue);

      await openSettings();
      await act('notifications');
      expect(find.byType(SettingsScreen), findsNothing);
      expect(resourceScope(''), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();

      await openSettings();
      await act('close', {'id': second});
      expect(find.byType(SettingsScreen), findsNothing);
      expect(app.swarms.map((swarm) => swarm.id), [first]);

      // Menus stay off behind Settings: a plain menu action is still dropped.
      await openSettings();
      await native('new');
      expect(find.byType(SettingsScreen), findsOneWidget);
      expect(app.swarms, hasLength(1));
      // The pointer over the daemon is not an ask: Settings stays.
      await act('daemonHover', {'hovered': true});
      expect(find.byType(SettingsScreen), findsOneWidget);
      Navigator.of(tester.element(find.byType(SettingsScreen))).pop();
      await tester.pump(const Duration(milliseconds: 300));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      projects.dispose();
      app.dispose();
    },
  );

  testWidgets(
    'titlebar dropdowns are overlays: the row stays live, one click outside closes and acts, Esc returns focus; Settings from anywhere closes on a row action; a modal still blocks',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final updates = <Map>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return null;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      Future<void> native(String method, [Map<String, Object?>? args]) {
        final result = Completer<void>();
        tester.binding.defaultBinaryMessenger.handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(
            MethodCall(method, args),
          ),
          (_) => result.complete(),
        );
        return result.future;
      }

      // As AppKit sends a row click while the menus are off.
      Future<void> act(String method, [Map<String, Object?>? args]) async {
        final reply = native('rowAction', {
          'method': method,
          'arguments': ?args,
        });
        var answered = false;
        unawaited(reply.then((_) => answered = true));
        for (var frame = 0; frame < 5 && !answered; frame++) {
          await tester.pump();
        }
        expect(answered, isTrue, reason: '$method must answer');
        await tester.pump(const Duration(milliseconds: 300));
      }

      // A plain titlebar call, as AppKit sends one while the menus are on.
      Future<void> send(String method, [Map<String, Object?>? args]) async {
        final reply = native(method, args);
        var answered = false;
        unawaited(reply.then((_) => answered = true));
        for (var frame = 0; frame < 5 && !answered; frame++) {
          await tester.pump();
        }
        await tester.pump(const Duration(milliseconds: 300));
      }

      Future<void> open(String method, Finder shown) async {
        unawaited(native(method));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        expect(shown, findsOneWidget);
      }

      // A row lit by focus or pointer draws its glyph in the selection ink.
      Iterable<String> litRows() => [
        for (final choice in AccountMenuChoice.values)
          if (tester
              .widgetList<Icon>(
                find.descendant(
                  of: find.byKey(ValueKey('account-menu-${choice.name}')),
                  matching: find.byType(Icon),
                ),
              )
              .any((icon) => icon.color == grid.AppDesktop.onSelection))
            choice.name,
      ];

      final app = createApp();
      final projects = SwarmProjectStore();
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump();
      final first = app.activeSwarmId;
      app.newSwarm(newTabPage: true);
      await tester.pump();
      final second = app.activeSwarmId;

      // The avatar's menu is a dropdown in the shared overlay, not a route:
      // menus and the row both stay on, and there is no Dialog around it.
      final barriers = find.byType(ModalBarrier).evaluate().length;
      final from = updates.length;
      await open('account', find.byType(AccountMenu));
      expect(updates.last['enabled'], isTrue);
      expect(updates.last['stripEnabled'], isTrue);
      expect(
        find.ancestor(
          of: find.byType(AccountMenu),
          matching: find.byType(Dialog),
        ),
        findsNothing,
      );
      expect(
        find.byType(ModalBarrier),
        findsNWidgets(barriers),
        reason: 'no barrier of its own',
      );
      // One rim, the popover radius (desktop-design-system.md: 16).
      final rims = tester
          .widgetList<Material>(
            find.ancestor(
              of: find.byType(AccountMenu),
              matching: find.byType(Material),
            ),
          )
          .followedBy(
            tester.widgetList<Material>(
              find.descendant(
                of: find.byType(AccountMenu),
                matching: find.byType(Material),
              ),
            ),
          )
          .where(
            (material) =>
                material.shape is RoundedRectangleBorder &&
                (material.shape! as RoundedRectangleBorder).side !=
                    BorderSide.none,
          )
          .toList();
      expect(rims, hasLength(1));
      expect(
        (rims.single.shape! as RoundedRectangleBorder).borderRadius,
        BorderRadius.circular(grid.AppDesktop.menuRadius),
      );
      expect(grid.AppDesktop.menuRadius, 16);
      expect(litRows(), isEmpty, reason: 'a pointer opened it: no row lit');

      // A tab click in the native row closes it and chooses the tab, in one
      // plain call.
      await send('select', {'id': first});
      expect(find.byType(AccountMenu), findsNothing);
      expect(app.activeSwarmId, first);
      // Opening and closing it never turned a titlebar control off, even for
      // a frame: that is what flickered the row like a reload.
      expect(
        updates
            .skip(from)
            .where((u) => u['enabled'] != true || u['stripEnabled'] != true),
        isEmpty,
      );

      // The avatar again closes its own menu, as a dropdown's button does.
      await open('account', find.byType(AccountMenu));
      await send('account');
      expect(find.byType(AccountMenu), findsNothing);

      // Escape closes it and gives the keyboard back to whoever had it.
      final before = FocusManager.instance.primaryFocus;
      await open('account', find.byType(AccountMenu));
      expect(FocusManager.instance.primaryFocus, isNot(before));
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(AccountMenu), findsNothing);
      expect(FocusManager.instance.primaryFocus, before);

      // One click outside closes it AND lands: the start page's field takes it.
      await open('account', find.byType(AccountMenu));
      final field = find.byKey(const ValueKey('harness-start-search'));
      await tester.tap(field);
      await tester.pump();
      expect(find.byType(AccountMenu), findsNothing);
      expect(
        tester
            .widget<EditableText>(
              find.descendant(of: field, matching: find.byType(EditableText)),
            )
            .focusNode
            .hasFocus,
        isTrue,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();

      // The bell's inbox is the same kind of dropdown.
      await open('notificationInbox', find.byType(NotificationInbox));
      expect(updates.last['enabled'], isTrue);
      expect(
        find.ancestor(
          of: find.byType(NotificationInbox),
          matching: find.byType(Dialog),
        ),
        findsNothing,
      );
      // The menu bar's "View all … notifications" opens it; only a titlebar
      // button toggles. Open already, it stays.
      await send('notificationInbox', {'open': true});
      expect(find.byType(NotificationInbox), findsOneWidget);
      await send('select', {'id': second});
      expect(find.byType(NotificationInbox), findsNothing);
      expect(app.activeSwarmId, second);

      // Settings chosen from the avatar's menu, with the pointer.
      await open('account', find.byType(AccountMenu));
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: tester.getCenter(find.text('Settings')));
      await tester.pump();
      await mouse.down(tester.getCenter(find.text('Settings')));
      await mouse.up();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(SettingsScreen), findsOneWidget);
      expect(updates.last['enabled'], isFalse);
      expect(updates.last['stripEnabled'], isTrue);
      await act('select', {'id': first});
      expect(find.byType(SettingsScreen), findsNothing);
      expect(app.activeSwarmId, first);
      // The pointer went to the native row, out of Flutter's view.
      await mouse.removePointer();
      await tester.pump();
      // Opened again, the menu is fresh: nothing kept from the last time.
      await open('account', find.byType(AccountMenu));
      expect(litRows(), isEmpty);
      await send('account');
      expect(find.byType(AccountMenu), findsNothing);

      // Settings opened by someone else (the app menu, Agent Messages).
      unawaited(
        showSettingsScreen(
          tester.element(find.byType(SwarmScreen)),
          app,
          source: 'test',
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(updates.last['stripEnabled'], isTrue);
      await act('select', {'id': second});
      expect(find.byType(SettingsScreen), findsNothing);
      expect(app.activeSwarmId, second);

      // A real dialog (Rename Tab) still holds the row.
      await open('renameActive', find.text('Rename Tab'));
      expect(updates.last['stripEnabled'], isFalse);
      await act('select', {'id': first});
      expect(find.text('Rename Tab'), findsOneWidget);
      expect(app.activeSwarmId, second);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Rename Tab'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      projects.dispose();
      app.dispose();
    },
  );

  testWidgets(
    'late profile discovery cannot cross a machine switch with identical observed paths',
    (tester) async {
      final app = _ProfilesNotifier();
      final selected = <LocalCodexProfile?>[];
      Widget host(String id) => MaterialApp(
        home: Scaffold(
          body: CodexProfileField(
            notifier: app,
            machineId: id,
            machineIsThisComputer: false,
            value: null,
            onChanged: selected.add,
          ),
        ),
      );
      await tester.pumpWidget(host('a'));
      await tester.pump();
      await tester.pumpWidget(host('b'));
      await tester.pump();
      app.pending['a']!.complete({
        'profiles': [
          {'path': '/old', 'label': 'Old'},
        ],
      });
      await tester.pump();
      expect(selected, isEmpty);
      app.pending['b']!.complete({
        'profiles': [
          {'path': '/new', 'label': 'New'},
        ],
      });
      await tester.pump();
      expect(selected.single?.path, '/new');
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'a folder picker result is discarded after switching away and back',
    (tester) async {
      final app = _ProfilesNotifier();
      for (final id in ['a', 'b']) {
        app.machineStates[id] = MachineState(
          Machine(machineId: id, authMode: MachineAuthMode.remote),
        )..localOnly = true;
      }
      final previous = FileSelectorPlatform.instance;
      final folder = _PendingFolder();
      FileSelectorPlatform.instance = folder;
      addTearDown(() => FileSelectorPlatform.instance = previous);
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () =>
                  showNewAgentDialog(context, app, 'a', source: 'test'),
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pump(const Duration(milliseconds: 300));
      await browseNewAgentProject(tester);
      await tester.pump();
      await tester.pump();
      await expandNewAgentAdvanced(tester);
      final field = find.byKey(const Key('new-agent-machine-field'));
      tester.widget<AppChoicePicker<String>>(field).onChanged('b');
      await tester.pump();
      tester.widget<AppChoicePicker<String>>(field).onChanged('a');
      await tester.pump();
      folder.answer.complete('/old-machine-folder');
      await tester.pump();
      expect(find.textContaining('/old-machine-folder'), findsNothing);
      expect(find.text('New project'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'Add project discards an old folder after switching away and back',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.localOnly = true;
      app.machineStates['other'] = MachineState(
        const Machine(machineId: 'other', authMode: MachineAuthMode.remote),
      );
      final previous = FileSelectorPlatform.instance;
      final folder = _PendingFolder();
      FileSelectorPlatform.instance = folder;
      addTearDown(() => FileSelectorPlatform.instance = previous);
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () => showSwarmProjectDialog(context, app),
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.tap(find.text('Choose folder'));
      await tester.pump();
      final field = find.byType(AppSelectField<String>);
      tester.widget<AppSelectField<String>>(field).onChanged('other');
      await tester.pump();
      tester.widget<AppSelectField<String>>(field).onChanged('m');
      await tester.pump();
      folder.answer.complete('/stale-folder');
      await tester.pump();
      expect(find.text('/stale-folder'), findsNothing);
      expect(find.text('Choose folder'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'every titlebar click closes the open dropdown before it acts; a dropdown\'s own button closes it',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        (call) async => null,
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      Future<void> send(String method) async {
        final reply = Completer<void>();
        tester.binding.defaultBinaryMessenger.handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(MethodCall(method)),
          (_) => reply.complete(),
        );
        for (var frame = 0; frame < 5 && !reply.isCompleted; frame++) {
          await tester.pump();
        }
        await tester.pump(const Duration(milliseconds: 300));
      }

      final app = createApp();
      final projects = SwarmProjectStore();
      await app.modelManager.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump();

      // The daemon's button returns early while it has nothing to show; the
      // open menu still closes.
      await send('account');
      expect(find.byType(AccountMenu), findsOneWidget);
      await send('daemon');
      expect(find.byType(AccountMenu), findsNothing);

      // Models: its button opens it and closes it again; the avatar's closes
      // it on the way to its own menu, and the other way round.
      await send('modelControls');
      expect(find.byType(ModelsPanel), findsOneWidget);
      await send('modelControls');
      expect(find.byType(ModelsPanel), findsNothing);
      await send('modelControls');
      await send('account');
      expect(find.byType(ModelsPanel), findsNothing);
      expect(find.byType(AccountMenu), findsOneWidget);
      await send('modelControls');
      expect(find.byType(AccountMenu), findsNothing);
      expect(find.byType(ModelsPanel), findsOneWidget);
      await send('modelControls');
      expect(find.byType(ModelsPanel), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      projects.dispose();
      app.dispose();
    },
  );

  testWidgets('the pane × is full ink at rest, as the tab ×', (tester) async {
    final app = createApp();
    addTearDown(app.dispose);
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app);
    final icon = tester.widget<Icon>(
      find.descendant(
        of: find.byType(PaneCloseButton),
        matching: find.byIcon(AppIcons.close),
      ),
    );
    expect(icon.color!.a, AppIcons.closeInk);
    expect(AppIcons.closeInk, 1);
    await tester.pumpWidget(const SizedBox());
  });
}

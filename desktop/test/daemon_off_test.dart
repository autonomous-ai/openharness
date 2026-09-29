// Daemons off (daemons/README.md, "Off switches"): invisible and free. A
// signed-in window whose `GET /api/zoo` answers 404, or whose harnessd says
// DAEMONS_OFF, and a guest who has not enabled the creature experiment, get the
// window from before daemons existed: the same bar at every width, no frames,
// no habits, no keys taken, no commands, no easter row, no notices.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/daemons/zoo.dart';
import 'package:harness/daemons/zoo_controller.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/sections/account_section.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/shortcuts/keymap_native.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart' show SwarmProjectStore;
import 'package:harness/state/workspace_onboarding.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'support/experimental_settings.dart';

import 'daemons/zoo_test.dart' show FakeZooTransport;
import 'keymap_host_test.dart' show key;
import 'support/status_bar_layout.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show MemoryStore, createApp;

final _tim = Zoo(
  daemons: [ZooDaemon(id: 'tim', hatched: '', egg: 'first')],
  pair: 'tim',
  habits: ['turn', 'split', 'find', 'machine', 'store'],
  firstEgg: true,
  consent: ZooConsent(watching: true, at: '2026-09-26T09:00:00.000Z'),
);

void main() {
  late AppNotifier app;
  late ZooController zoo;
  late FakeZooTransport remote;
  late ValueNotifier<bool> preview;
  late MemoryStore preferences;
  late ExperimentalFeaturesStore experiments;
  late List<(String, Map<String, dynamic>)> frames;
  late List<Map<String, dynamic>> companionFrames;

  setUp(() {
    app = createApp();
    app.currentUser = const CurrentUserProfile(
      id: 'u1',
      email: 'off@example.test',
    );
    // This computer's own harnessd: a daemon_* frame would go here.
    app.stateOf('m')!.localEndpoint = LocalCliEndpoint(
      computerId: 'test-computer',
      wsUri: Uri.parse('ws://fixture.invalid'),
      protocolVersion: 1,
      terminalProtocolVersion: 3,
    );
    frames = [];
    companionFrames = [];
    app.daemonFrameSenderForTest = (type, payload) {
      if (type == 'app_companion') {
        companionFrames.add(payload);
      } else {
        frames.add((type, payload));
      }
      return true;
    };
    preview = ValueNotifier(false);
    preferences = MemoryStore();
    experiments = MemoryExperimentalFeaturesStore(storage: preferences);
  });
  tearDown(() {
    app.dispose();
    preview.dispose();
    experiments.dispose();
  });

  /// [on]: `GET /api/zoo` answers 200 with [seed]; otherwise 404.
  Future<void> mount(
    WidgetTester tester, {
    bool on = false,
    bool? enabled = true,
    FakeZooTransport? server,
    Zoo? seed,
    bool native = false,
    Completer<void>? gate,
    WorkspaceOnboarding? onboarding,
  }) async {
    if (enabled != null) {
      await experiments.set(ExperimentalFeature.focusBarCreature, enabled);
    }
    remote =
        server ??
        (FakeZooTransport(available: on)
          ..zoo = seed ?? _tim
          ..revision = 1
          ..gate = gate);
    zoo = ZooController(random: Random(1));
    addTearDown(zoo.dispose);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 800);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SwarmScreen(
          notifier: app,
          nativeTabs: native,
          projectStore: SwarmProjectStore(),
          zoo: zoo,
          zooTransport: remote,
          daemonClock: () => tester.binding.clock.now(),
          daemonsPreview: preview,
          experimentalFeatures: experiments,
          onboarding: onboarding,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }

  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 11));
  }

  final slot = find.byKey(const ValueKey('daemon-slot'));

  /// ⌘⌥T, and whether anything in the window took it.
  Future<bool> talkChord(WidgetTester tester) async {
    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
    final handled = await tester.sendKeyDownEvent(LogicalKeyboardKey.keyT);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.keyT);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    await tester.pump();
    return handled;
  }

  const feature = ExperimentalFeature.focusBarCreature;
  final experimentSwitch = find.byKey(
    const ValueKey('experimental-focus_bar_creature'),
  );

  Future<void> setCreature(WidgetTester tester, bool on) async {
    await experiments.set(feature, on);
    await tester.pump(const Duration(seconds: 1));
  }

  Future<void> openExperimental(WidgetTester tester) async {
    await key(tester, LogicalKeyboardKey.comma, cmd: true);
    await tester.pump();
    await tester.enterText(
      find.byKey(const Key('settings-search-field')),
      'experimental',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(experimentSwitch, findsOneWidget);
  }

  testWidgets(
    'Experimental off clears the device without erasing its individual',
    (tester) async {
      await mount(tester, on: true);
      final uid = zoo.paired!.uid;
      expect(companionFrames.last['enabled'], true);
      await setCreature(tester, false);
      expect(companionFrames.last['enabled'], false);
      await setCreature(tester, true);
      expect(companionFrames.last['enabled'], true);
      expect(zoo.paired!.uid, uid);
      await unmount(tester);
      expect(companionFrames.last['enabled'], false);
    },
  );

  testWidgets(
    'Settings switches the creature on and off without leaving Settings',
    (tester) async {
      await mount(tester, on: true, enabled: false, seed: Zoo.empty);
      expect(slot, findsNothing);
      expect(remote.fetches, 0);
      final tab = app.activeSwarmId;
      await openExperimental(tester);
      expect(tester.widget<Switch>(experimentSwitch).value, isFalse);
      await tester.tap(experimentSwitch);
      await tester.pump(const Duration(seconds: 1));
      expect(tester.widget<Switch>(experimentSwitch).value, isTrue);
      expect(zoo.isAccount, isTrue);
      expect(zoo.paired, isNull);
      expect(zoo.zoo.daemons, isEmpty);
      expect(zoo.readyEgg, isNull);
      expect(find.byType(SettingsScreen), findsOneWidget);
      expect(app.activeSwarmId, tab);
      expect(
        remote.batches
            .expand((batch) => batch)
            .where((op) => op['op'] == 'zoo.turn'),
        isEmpty,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump(const Duration(seconds: 1));
      expect(slot, findsOneWidget);
      await tester.tap(slot);
      await tester.pump();
      expect(find.byKey(const ValueKey('daemon-preview-label')), findsNothing);
      await openExperimental(tester);
      await tester.tap(experimentSwitch);
      await tester.pump();
      expect(zoo.loaded, isFalse);
      expect(tester.widget<Switch>(experimentSwitch).value, isFalse);
      expect(find.byType(SettingsScreen), findsOneWidget);
      expect(find.byKey(const ValueKey('daemon-panel')), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(slot, findsNothing);
      expect(preferences.values[experimentFixtureKey(feature)], 'off');
      await unmount(tester);
    },
  );

  testWidgets(
    'the account egg earns and saves its first hatch from workspace activity',
    (tester) async {
      await mount(tester, on: true, enabled: false, seed: Zoo.empty);
      await setCreature(tester, true);
      String glyph() => tester
          .widget<Text>(find.byKey(const ValueKey('daemon-slot-glyph')))
          .data!
          .trim();
      expect(glyph(), r'\_(  )_/');
      expect(zoo.zoo.daemons, isEmpty);

      app.adoptSessionForTest(terminal('a0', []));
      await app.handleMachineEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a0',
      });
      await tester.pump();
      expect(glyph(), r'\_(/\)_/');
      app.adoptSessionForTest(terminal('a1', []));
      app.notifyListeners();
      await tester.pump();
      expect(glyph(), r"\_(*')_/");
      app.stateOf('m')!.resumedHarnesses = 1;
      app.notifyListeners();
      await tester.pump();
      expect(zoo.readyEgg!.kind, 'first');
      expect(glyph(), r'\_(oo)_/');
      expect(zoo.paired, isNull, reason: 'the user must open the egg');

      await tester.tap(slot);
      await tester.pump();
      expect(find.byKey(const ValueKey('daemon-hatch')), findsOneWidget);
      expect(glyph(), r'\_(oo)_/', reason: 'no creature before the reveal');
      final card = find.byKey(const ValueKey('daemon-hatch-card'));
      for (var i = 0; i < 180 && card.evaluate().isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(card, findsOneWidget);
      expect(zoo.zoo.daemons, hasLength(1));
      expect(zoo.paired!.version, '0.1');
      expect(glyph(), isNot(r'\_(oo)_/'));
      await tester.enterText(
        find.byKey(const ValueKey('daemon-hatch-name')),
        'Pip',
      );
      final saveName = find.byKey(const ValueKey('daemon-hatch-name-save'));
      await tester.ensureVisible(saveName);
      await tester.tap(saveName);
      await tester.pump();
      expect(zoo.paired!.name, 'Pip');
      expect(zoo.isAccount, isTrue);
      expect(
        remote.batches
            .expand((batch) => batch)
            .where((op) => op['op'] == 'zoo.turn'),
        isEmpty,
      );
      expect(tester.takeException(), isNull);
      await unmount(tester);
    },
  );

  testWidgets(
    'the account collection and its name survive a new window and off/on',
    (tester) async {
      await mount(tester, on: true, seed: Zoo.empty);
      for (final habit in ['turn', 'split', 'find']) {
        zoo.habit(habit);
      }
      await zoo.flush();
      final hatch = (await zoo.hatch(zoo.readyEgg!.id))!;
      expect(zoo.nickname(hatch.uid!, 'Window one'), isTrue);
      await zoo.flush();
      final saved = remote;
      await unmount(tester);
      experiments.dispose();
      experiments = MemoryExperimentalFeaturesStore(storage: preferences);
      await experiments.refresh();
      await mount(tester, server: saved, enabled: null);
      await tester.pump(const Duration(seconds: 1));
      expect(slot, findsOneWidget);
      expect(zoo.isAccount, isTrue);
      expect(zoo.paired!.name, 'Window one');
      expect(zoo.paired!.uid, hatch.uid);
      await setCreature(tester, false);
      expect(slot, findsNothing);
      await setCreature(tester, true);
      expect(zoo.paired!.name, 'Window one');
      await setCreature(tester, false);
      await unmount(tester);
      experiments.dispose();
      experiments = MemoryExperimentalFeaturesStore(storage: preferences);
      await experiments.refresh();
      final fetches = saved.fetches;
      await mount(tester, server: saved, enabled: null);
      expect(slot, findsNothing);
      expect(saved.fetches, fetches);
      expect(saved.zoo.paired!.name, 'Window one');
      await unmount(tester);
    },
  );

  testWidgets('account opt-out stays hidden after pushes and reconnects', (
    tester,
  ) async {
    await mount(tester, on: true);
    await tester.pump();
    expect(slot, findsOneWidget);
    await setCreature(tester, true);
    expect(zoo.isAccount, isTrue);
    await setCreature(tester, false);
    final fetches = remote.fetches;
    zoo.pushed(999);
    zoo.refresh();
    app.notifyListeners();
    await tester.pump(const Duration(seconds: 1));
    expect(zoo.loaded, isFalse);
    expect(slot, findsNothing);
    expect(remote.fetches, fetches);
    await unmount(tester);
  });

  testWidgets('disabling the experiment also closes an egg reveal', (
    tester,
  ) async {
    await mount(tester, on: true, enabled: false, seed: Zoo.empty);
    await setCreature(tester, true);
    for (final habit in ['turn', 'split', 'find']) {
      zoo.habit(habit);
    }
    await zoo.flush();
    await tester.pump();
    await tester.tap(slot);
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-hatch')), findsOneWidget);
    await setCreature(tester, false);
    expect(slot, findsNothing);
    expect(find.byKey(const ValueKey('daemon-panel')), findsNothing);
    await tester.pump(const Duration(seconds: 15));
    expect(
      slot,
      findsNothing,
      reason: 'a late animation cannot reveal it again',
    );
    expect(tester.takeException(), isNull);
    expect(
      remote.batches
          .expand((batch) => batch)
          .where((op) => op['op'] == 'zoo.turn'),
      isEmpty,
    );
    await unmount(tester);
  });

  testWidgets(
    'guests cannot enable account experiments or use an activation shortcut',
    (tester) async {
      app.signedIn = false;
      experiments.bind(null);
      await mount(tester, enabled: null);
      expect(slot, findsNothing);
      await key(
        tester,
        LogicalKeyboardKey.keyD,
        cmd: true,
        alt: true,
        shift: true,
      );
      expect(slot, findsNothing, reason: 'the removed shortcut does nothing');
      await setCreature(tester, true);
      expect(slot, findsNothing);
      expect(remote.fetches, 0);
      final context = tester.element(find.byType(SwarmScreen));
      expect(
        effectiveShortcutRows(
          context,
          KeymapContext.workspace,
        ).map((r) => r.label),
        isNot(contains('Toggle creature preview')),
      );
      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '>creature preview',
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Toggle creature preview'), findsNothing);
      expect(
        remote.batches
            .expand((batch) => batch)
            .where((op) => op['op'] == 'zoo.turn'),
        isEmpty,
      );
      await unmount(tester);
    },
  );

  testWidgets(
    'the experiment updates the native focus bar without a shortcut',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final calls = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        calls.add(call);
        return null;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      await mount(
        tester,
        on: true,
        enabled: false,
        seed: Zoo.empty,
        native: true,
      );
      final keymap = calls.lastWhere((c) => c.method == 'keymapState');
      expect(
        jsonEncode(keymap.arguments),
        isNot(contains('app.daemon_preview')),
      );
      await setCreature(tester, true);
      expect(zoo.paired, isNull);
      final updates = calls.where((c) => c.method == 'update');
      final daemon = (updates.last.arguments as Map)['daemon'] as Map;
      expect(daemon['visible'], isTrue);
      expect(daemon['glyph'], r'\_(  )_/');
      expect(daemon['label'], 'Egg');
      expect(daemon['tooltip'], isNot(contains('Local preview')));
      await setCreature(tester, false);
      expect(zoo.loaded, isFalse);
      expect(calls.lastWhere((c) => c.method == 'daemonState').arguments, {
        'visible': false,
      });
      expect(
        remote.batches
            .expand((batch) => batch)
            .where((op) => op['op'] == 'zoo.turn'),
        isEmpty,
      );
      await unmount(tester);
    },
  );

  testWidgets('a 404 is off: no slot and the bar from before daemons, at '
      'every width', (tester) async {
    seedStatusBarWorkspace(app);
    // This historical layout includes Share; keep its independent experiment
    // enabled while checking that daemons reserve no space.
    await experiments.set(ExperimentalFeature.shareButton, true);
    await mount(tester);
    await tester.pump();
    expect(remote.fetches, 1);
    expect(zoo.daemons, DaemonsSwitch.off);
    expect(slot, findsNothing);
    final before = jsonDecode(
      File('test/fixtures/status_bar_before_daemons.json').readAsStringSync(),
    );
    final now = await measureStatusBar(tester);
    expect(jsonDecode(jsonEncode(now)), before);
    expect(slot, findsNothing);
    await unmount(tester);
  });

  testWidgets('while the first read has no answer nothing is kept for the '
      'slot', (tester) async {
    seedStatusBarWorkspace(app);
    await experiments.set(ExperimentalFeature.shareButton, true);
    final gate = Completer<void>();
    await mount(tester, on: true, gate: gate);
    expect(zoo.daemons, DaemonsSwitch.unknown);
    final before = jsonDecode(
      File('test/fixtures/status_bar_before_daemons.json').readAsStringSync(),
    );
    expect(jsonDecode(jsonEncode(await measureStatusBar(tester))), before);
    gate.complete();
    await tester.pump();
    await tester.pump();
    expect(zoo.daemons, DaemonsSwitch.on);
    expect(slot, findsOneWidget, reason: 'on (200): as today');
    await unmount(tester);
  });

  testWidgets('off: no daemon frame, habit, notice or line, whatever happens '
      'and whatever harnessd says', (tester) async {
    await mount(tester);
    await tester.pump();
    // Everything that would earn a habit, or speak.
    app.adoptSessionForTest(terminal('a0', []));
    app.adoptSessionForTest(terminal('a1', []));
    await app.handleMachineEventForTest('m', {
      'type': 'turn_started',
      'agentId': 'a0',
    });
    await app.handleMachineEventForTest('m', {
      'type': 'turn_ended',
      'agentId': 'a0',
    });
    app.stateOf('m')!.resumedHarnesses = 1;
    app.notifyListeners();
    await tester.pump();
    app.appLifecycleChanged(AppLifecycleState.inactive);
    await tester.pump();
    app.appLifecycleChanged(AppLifecycleState.resumed);
    await tester.pump();
    for (final (type, payload) in [
      (
        'daemon_state',
        {'pair': 'tim', 'needs': [], 'working': 0, 'failing': []},
      ),
      (
        'daemon_say',
        {
          'id': 's1',
          'mood': 'need',
          'line': '[y/n] codex@office wants to run the migration.',
          'actions': [
            {'key': 'y', 'label': 'run it', 'choice': '1'},
          ],
        },
      ),
      ('daemon_brief', {'desk': 'd', 'line': 'welcome back.', 'items': []}),
    ]) {
      await app.handleMachineEventForTest('m', {
        'type': type,
        'payload': payload,
      });
      await tester.pump();
    }
    await tester.pump(const Duration(minutes: 6));
    expect(frames, isEmpty, reason: 'no daemon_* frame, not even presence');
    expect(remote.batches, isEmpty, reason: 'no zoo.habit, no zoo.turn');
    expect(slot, findsNothing);
    expect(find.byKey(const ValueKey('daemon-voice')), findsNothing);
    expect(find.byKey(const ValueKey('daemon-brief')), findsNothing);
    expect(find.byKey(const ValueKey('daemon-arrival-hint')), findsNothing);
    expect(find.byKey(const ValueKey('daemon-habit-notice')), findsNothing);
    expect(find.textContaining('egg'), findsNothing);
    expect(find.textContaining('daemon'), findsNothing);
    await unmount(tester);
  });

  testWidgets('off: ⌘⌥T goes where it went before; no daemon command, '
      'shortcut, native key or xyzzy row', (tester) async {
    await mount(tester);
    await tester.pump();
    expect(daemonCommandsActive.value, isFalse);
    expect(await talkChord(tester), isFalse, reason: 'not swallowed');
    expect(find.byKey(const ValueKey('daemon-panel')), findsNothing);
    // Not in the native keymap, nor in the shortcut list.
    final native = jsonEncode(nativeKeymapSnapshot(AppKeymap()));
    expect(native, isNot(contains('"app.daemon"')));
    expect(native, isNot(contains('"app.daemon_talk"')));
    final context = tester.element(find.byType(SwarmScreen));
    final rows = effectiveShortcutRows(context, KeymapContext.workspace);
    expect(rows.map((r) => r.label), isNot(contains('Talk to daemon')));
    // Not among the commands, and xyzzy is just a word.
    await key(tester, LogicalKeyboardKey.keyO, cmd: true);
    final input = find.byKey(const ValueKey('swarm-search-input'));
    await tester.enterText(input, '>daemon');
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Talk to daemon'), findsNothing);
    expect(find.text('Daemon'), findsNothing);
    await tester.enterText(input, 'xyzzy');
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Nothing happens.'), findsNothing);
    expect(
      find.byKey(const ValueKey('swarm-search-line:note:xyzzy')),
      findsNothing,
    );
    await key(tester, LogicalKeyboardKey.escape);
    await zoo.flush();
    expect(remote.batches, isEmpty, reason: 'no zoo.easter');
    await unmount(tester);
    expect(daemonCommandsActive.value, isFalse);
  });

  testWidgets('on, the same chord is the daemon\'s', (tester) async {
    await mount(tester, on: true);
    await tester.pump();
    expect(daemonCommandsActive.value, isTrue);
    final native = jsonEncode(nativeKeymapSnapshot(AppKeymap()));
    expect(native, contains('app.daemon_talk'));
    expect(await talkChord(tester), isTrue);
    expect(find.byKey(const ValueKey('daemon-panel')), findsOneWidget);
    await unmount(tester);
    expect(daemonCommandsActive.value, isFalse, reason: 'the window is gone');
  });

  testWidgets('off natively: the update has no daemon, daemonState never '
      'runs, and the keymap native gets has no daemon key', (tester) async {
    final calls = <MethodCall>[];
    const channel = MethodChannel('harness/swarm_tabs');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      calls.add(call);
      return null;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    await mount(tester, native: true);
    await tester.pump();
    app.adoptSessionForTest(terminal('a0', []));
    app.notifyListeners();
    await tester.pump();
    final updates = calls.where((c) => c.method == 'update').toList();
    expect(updates, isNotEmpty);
    for (final update in updates) {
      expect((update.arguments as Map).containsKey('daemon'), isFalse);
    }
    expect(calls.where((c) => c.method == 'daemonState'), isEmpty);
    final keymaps = calls.where((c) => c.method == 'keymapState').toList();
    expect(keymaps, isNotEmpty);
    expect(jsonEncode(keymaps.last.arguments), isNot(contains('"app.daemon"')));
    expect(
      jsonEncode(keymaps.last.arguments),
      isNot(contains('"app.daemon_talk"')),
    );
    // A click on a slot that is not there, from a stale native: nothing.
    // The reply waits for the next frame, so it is not awaited.
    unawaited(
      tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        channel.name,
        channel.codec.encodeMethodCall(const MethodCall('daemon')),
        (_) {},
      ),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-panel')), findsNothing);
    await unmount(tester);
  });

  testWidgets('DAEMONS_OFF from harnessd takes everything away at once, and '
      'native hears the slot go', (tester) async {
    final states = <Map>[];
    const channel = MethodChannel('harness/swarm_tabs');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'daemonState') states.add(call.arguments as Map);
      return null;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    await mount(tester, on: true, native: true);
    await tester.pump();
    expect(zoo.daemons, DaemonsSwitch.on);
    expect(daemonCommandsActive.value, isTrue);
    await app.handleMachineEventForTest('m', {
      'type': 'daemon_talk_result',
      'payload': {'requestId': 'r1', 'ok': false, 'error': 'DAEMONS_OFF'},
    });
    await tester.pump();
    expect(zoo.daemons, DaemonsSwitch.off);
    expect(daemonCommandsActive.value, isFalse);
    expect(states.last, {'visible': false});
    frames.clear();
    app.appLifecycleChanged(AppLifecycleState.inactive);
    await tester.pump();
    expect(frames, isEmpty);
    await unmount(tester);
  });

  testWidgets('a guest can still exercise the durable-zoo test seam', (
    tester,
  ) async {
    app.signedIn = false;
    await mount(tester, on: true);
    await tester.pump();
    expect(zoo.daemons, DaemonsSwitch.off);
    expect(slot, findsNothing);
    expect(remote.fetches, 0);
    app.adoptSessionForTest(terminal('a0', []));
    await app.handleMachineEventForTest('m', {
      'type': 'turn_ended',
      'agentId': 'a0',
    });
    await tester.pump();
    expect(zoo.zoo.habits, isEmpty);
    expect(frames, isEmpty);
    expect(await talkChord(tester), isFalse);
    // Turned on: its local zoo, at the next quiet moment.
    preview.value = true;
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(zoo.daemons, DaemonsSwitch.on);
    expect(zoo.source, ZooSource.local);
    expect(slot, findsOneWidget);
    expect(remote.fetches, 0, reason: 'a guest asks no server');
    // And off again: gone.
    preview.value = false;
    await tester.pump();
    expect(zoo.daemons, DaemonsSwitch.off);
    expect(slot, findsNothing);
    await unmount(tester);
  });

  testWidgets('the slot never arrives under a click: it waits for the button, '
      'the pointer off the bar and a quiet moment', (tester) async {
    seedStatusBarWorkspace(app);
    final gate = Completer<void>();
    await mount(tester, on: true, gate: gate);
    final tab = find.byKey(ValueKey(app.swarms.first.id));
    final before = tester.getRect(tab);
    // A press on a tab, held while the answer arrives.
    final gesture = await tester.startGesture(
      tester.getCenter(find.byKey(const ValueKey('workspace-status-bar'))),
    );
    gate.complete();
    await tester.pump();
    await tester.pump();
    expect(zoo.daemons, DaemonsSwitch.on);
    expect(slot, findsNothing);
    await tester.pump(const Duration(seconds: 2));
    expect(slot, findsNothing, reason: 'the button is still held');
    expect(tester.getRect(tab), before);
    // Released, but the pointer is still on the bar.
    await gesture.up();
    await tester.pump(const Duration(seconds: 2));
    expect(slot, findsNothing);
    // Off the bar: a quiet moment later, it takes its place.
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: const Offset(600, 400));
    await tester.pump(const Duration(milliseconds: 400));
    expect(slot, findsNothing, reason: 'not quiet yet');
    await tester.pump(const Duration(milliseconds: 500));
    expect(slot, findsOneWidget);
    await mouse.removePointer();
    await unmount(tester);
  });

  group('the welcome\'s steps are not the daemon\'s habits', () {
    testWidgets('a person who finished onboarding before daemons stays '
        'finished, on or off', (tester) async {
      for (final on in [false, true]) {
        final store = MemoryStore()
          ..values[WorkspaceOnboarding.storageKey('account:u1')] =
              '{"completed":["harnesses","machines"],"dismissed":["models"]}';
        final journey = WorkspaceOnboarding(storage: store);
        addTearDown(journey.dispose);
        await mount(tester, on: on, onboarding: journey);
        await tester.pump();
        expect(journey.loaded, isTrue);
        expect(journey.next, isNull, reason: 'no dot comes back (on: $on)');
        // Work that earns daemon habits changes nothing here.
        app.adoptSessionForTest(terminal('a$on', []));
        await app.handleMachineEventForTest('m', {
          'type': 'turn_ended',
          'agentId': 'a$on',
        });
        await tester.pump();
        expect(journey.next, isNull);
        await unmount(tester);
      }
      expect(OnboardingStep.values.map((s) => s.name), [
        'harnesses',
        'machines',
        'models',
      ]);
    });

    testWidgets('a harness at work completes Harnesses without waiting for a '
        'finished turn', (tester) async {
      final journey = WorkspaceOnboarding(storage: MemoryStore());
      addTearDown(journey.dispose);
      await mount(tester, onboarding: journey);
      await tester.pump();
      expect(journey.completed(OnboardingStep.harnesses), isFalse);
      app.adoptSessionForTest(terminal('a0', []));
      app.notifyListeners();
      await tester.pump();
      expect(journey.completed(OnboardingStep.harnesses), isTrue);
      await unmount(tester);
    });

    test('a completed Machines step still implies Harnesses', () async {
      final store = MemoryStore()
        ..values[WorkspaceOnboarding.storageKey('a')] =
            '{"completed":["machines"]}';
      final journey = WorkspaceOnboarding(storage: store);
      addTearDown(journey.dispose);
      journey.sync(
        scope: 'a',
        observed: const {},
        otherComputer: false,
        modelsAvailable: false,
      );
      await Future<void>.delayed(Duration.zero);
      expect(journey.completed(OnboardingStep.harnesses), isTrue);
      expect(journey.next, isNull);
    });
  });

  testWidgets('Account has no duplicate creature preview switch', (
    tester,
  ) async {
    Future<void> show() => tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(body: AccountSection(notifier: app)),
      ),
    );
    await show();
    expect(find.text('Daemons (preview)'), findsNothing, reason: 'signed in');
    app.signedIn = false;
    await show();
    expect(find.text('Daemons (preview)'), findsNothing, reason: 'guest');
    expect(find.byKey(const Key('settings-daemons-preview')), findsNothing);
  });
}

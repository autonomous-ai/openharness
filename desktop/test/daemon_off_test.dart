// Daemons off (daemons/README.md, "Off switches"): invisible and free. A
// signed-in window whose `GET /api/zoo` answers 404, or whose harnessd says
// DAEMONS_OFF, and a guest who has not enabled the creature experiment, get the
// window from before daemons existed: the same bar at every width, no frames,
// no habits, no keys taken, no commands, no easter row, no notices.
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/daemons/daemon_face.dart';
import 'package:harness/daemons/zoo.dart';
import 'package:harness/widgets/daemon_illustration.dart';
import 'package:harness/widgets/daemon_slot.dart';
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

  setUp(() async {
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
    app.daemonFrameSenderForTest = (type, payload) {
      frames.add((type, payload));
      return true;
    };
    preview = ValueNotifier(false);
    preferences = MemoryStore();
    experiments = MemoryExperimentalFeaturesStore(storage: preferences);
    // Finish the real-zone read before testWidgets enters its fake clock.
    await experiments.refresh();
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

  testWidgets('illustrated Tim lives in the footer and hover preserves focus', (
    tester,
  ) async {
    await mount(tester, on: true);
    expect(
      find.ancestor(
        of: slot,
        matching: find.byKey(const ValueKey('workspace-status-bar')),
      ),
      findsOneWidget,
    );
    expect(
      find.ancestor(
        of: slot,
        matching: find.byKey(const ValueKey('workspace-tab-bar')),
      ),
      findsNothing,
    );
    final footer = find.byKey(const ValueKey('workspace-status-bar'));
    expect(
      tester.getRect(slot).left,
      greaterThanOrEqualTo(tester.getRect(footer).left),
    );
    expect(tester.getSize(slot).width, 44);
    final focus = FocusManager.instance.primaryFocus;
    final before = zoo.zoo.toJson();
    final remoteBefore = remote.zoo.toJson();
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: const Offset(2, 400));
    await mouse.moveTo(tester.getCenter(slot));
    await tester.pump(const Duration(milliseconds: 250));
    final preview = find.byKey(const ValueKey('daemon-hover-preview'));
    expect(preview, findsOneWidget);
    expect(FocusManager.instance.primaryFocus, same(focus));
    expect(
      tester
          .widget<DaemonIllustration>(
            find.descendant(
              of: preview,
              matching: find.byType(DaemonIllustration),
            ),
          )
          .size,
      350,
    );
    expect(
      zoo.zoo.toJson(),
      before,
      reason: 'looking never hatches or changes progress',
    );
    await mouse.moveTo(const Offset(2, 400));
    await tester.pump();
    expect(preview, findsNothing);
    await mouse.moveTo(tester.getCenter(slot));
    await tester.pump(const Duration(milliseconds: 250));
    expect(preview, findsOneWidget);
    await experiments.set(feature, false);
    await tester.pump();
    expect(preview, findsNothing);
    expect(slot, findsNothing);
    expect(remote.zoo.toJson(), remoteBefore);
    await mouse.removePointer();
    await unmount(tester);
  });

  for (final native in [false, true]) {
    for (final shown in [false, true]) {
      testWidgets(
        'Cmd-P dismisses the ${shown ? 'visible' : 'pending'} ${native ? 'native' : 'Flutter'} daemon hover preview',
        (tester) async {
          const channel = MethodChannel('harness/swarm_tabs');
          if (native) {
            tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
              channel,
              (_) async => null,
            );
            addTearDown(
              () => tester.binding.defaultBinaryMessenger
                  .setMockMethodCallHandler(channel, null),
            );
          }
          await mount(tester, on: true, native: native);
          final mouse = native
              ? null
              : await tester.createGesture(kind: PointerDeviceKind.mouse);
          if (mouse != null) {
            await mouse.addPointer(location: const Offset(2, 400));
            await mouse.moveTo(tester.getCenter(slot));
          } else {
            unawaited(
              tester.binding.defaultBinaryMessenger.handlePlatformMessage(
                channel.name,
                channel.codec.encodeMethodCall(
                  const MethodCall('daemonHover', {'hovered': true}),
                ),
                (_) {},
              ),
            );
            await tester.pump();
          }
          await tester.pump(Duration(milliseconds: shown ? 250 : 100));
          final hover = find.byKey(const ValueKey('daemon-hover-preview'));
          expect(hover, shown ? findsOneWidget : findsNothing);

          // Keep the pointer over Tim: keyboard navigation must dismiss the
          // preview and cancel its delay without relying on a mouse-exit event.
          await key(tester, LogicalKeyboardKey.keyP, cmd: true);
          expect(
            find.byKey(const ValueKey('swarm-search-input')),
            findsOneWidget,
          );
          expect(hover, findsNothing);
          if (mouse != null) {
            await tester.pump(const Duration(milliseconds: 400));
            expect(
              hover,
              findsNothing,
              reason: 'search suppresses hover previews',
            );
            // Removing a Flutter overlay synthesizes a new onEnter under a
            // stationary pointer. Test cancellation without that fresh hover.
            await mouse.moveTo(const Offset(2, 400));
          }
          await key(tester, LogicalKeyboardKey.escape);
          await tester.pump(const Duration(milliseconds: 400));
          expect(
            hover,
            findsNothing,
            reason: 'a cancelled hover must not reopen',
          );
          await mouse?.removePointer();
          await unmount(tester);
        },
      );
    }
  }

  testWidgets(
    'disabling a hovered slot closes its preview and ignores later looks',
    (tester) async {
      final storage = MemoryStore()
        ..values[ZooController.localZooKey] = jsonEncode({
          'zoo': _tim.toJson(),
          'seeded': true,
        });
      final buttonZoo = ZooController(storage: storage);
      final face = DaemonFace(buttonZoo, now: () => tester.binding.clock.now());
      final enabled = ValueNotifier(true);
      addTearDown(() {
        face.dispose();
        buttonZoo.dispose();
        enabled.dispose();
      });
      buttonZoo.bind('guest');
      await tester.pump();
      face.sync(const DaemonWatch(doneCount: 1));
      var seen = 0;
      var pressed = 0;
      face.onSeen = () => seen++;
      final hover = <bool>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Center(
            child: ValueListenableBuilder<bool>(
              valueListenable: enabled,
              builder: (context, active, _) => DaemonSlotButton(
                face: face,
                enabled: active,
                onPressed: () => pressed++,
                onHover: hover.add,
              ),
            ),
          ),
        ),
      );
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: const Offset(2, 400));
      await mouse.moveTo(tester.getCenter(slot));
      await tester.pump();
      expect(hover, [true]);
      expect(seen, 1);
      expect(face.doneCount, 0);

      enabled.value = false;
      await tester.pump();
      expect(hover, [
        true,
        false,
      ], reason: 'disable closes hover without a pointer exit');
      face.sync(const DaemonWatch(doneCount: 2));
      await mouse.moveTo(const Offset(2, 400));
      await mouse.moveTo(tester.getCenter(slot));
      await tester.tap(slot);
      await tester.pump();
      expect(hover, [true, false]);
      expect(
        seen,
        1,
        reason: 'a disabled slot must not mark finished work as seen',
      );
      expect(face.doneCount, 2);
      expect(pressed, 0);
      await mouse.removePointer();
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    },
  );

  testWidgets(
    'the account egg earns and saves its first hatch from workspace activity',
    (tester) async {
      await mount(tester, on: true, enabled: false, seed: Zoo.empty);
      await setCreature(tester, true);
      String glyph() {
        final art = find.byKey(const ValueKey('daemon-slot-art'));
        return art.evaluate().isNotEmpty
            ? tester.widget<DaemonIllustration>(art).art.stem
            : 'legacy-species';
      }

      expect(glyph(), 'egg_first_p0');
      expect(zoo.zoo.daemons, isEmpty);

      app.adoptSessionForTest(terminal('a0', []));
      await app.handleMachineEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a0',
      });
      await tester.pump();
      expect(glyph(), 'egg_first_p2');
      app.adoptSessionForTest(terminal('a1', []));
      app.notifyListeners();
      await tester.pump();
      expect(glyph(), 'egg_first_p3');
      app.stateOf('m')!.resumedHarnesses = 1;
      app.notifyListeners();
      await tester.pump();
      expect(zoo.readyEgg!.kind, 'first');
      expect(glyph(), 'egg_first_p4');
      expect(zoo.paired, isNull, reason: 'the user must open the egg');

      await tester.tap(slot);
      await tester.pump();
      expect(find.byKey(const ValueKey('daemon-hatch')), findsOneWidget);
      expect(glyph(), 'egg_first_p4', reason: 'no creature before the reveal');
      final card = find.byKey(const ValueKey('daemon-hatch-card'));
      for (var i = 0; i < 180 && card.evaluate().isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(card, findsOneWidget);
      expect(zoo.zoo.daemons, hasLength(1));
      expect(zoo.paired!.version, '0.1');
      expect(glyph(), isNot('egg_first_p4'));
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

  testWidgets('a saved companion tab stays inert while the experiment is off', (
    tester,
  ) async {
    // The same utility tab can return from the saved account workspace.
    app.openCompanions();
    await mount(tester, on: true, enabled: false);
    expect(app.activeSwarm.isCompanions, isTrue);
    expect(find.byKey(const ValueKey('companion-home')), findsNothing);
    expect(
      find.text('Companions is available in Settings → Experimental.'),
      findsOneWidget,
    );
    expect(remote.fetches, 0);
    expect(frames, isEmpty);

    await setCreature(tester, true);
    await tester.pump();
    expect(find.byKey(const ValueKey('companion-home')), findsOneWidget);
    expect(remote.fetches, greaterThan(0));
    expect(frames.where((frame) => frame.$1 == 'daemon_talk'), isEmpty);

    await setCreature(tester, false);
    final fetches = remote.fetches;
    expect(find.byKey(const ValueKey('companion-home')), findsNothing);
    zoo.pushed(999);
    app.notifyListeners();
    await tester.pump(const Duration(seconds: 1));
    expect(remote.fetches, fetches);
    expect(frames.where((frame) => frame.$1 == 'daemon_talk'), isEmpty);
    await unmount(tester);
  });

  testWidgets(
    'Companions opens its own DSH terminal and switches identities without an extra tab',
    (tester) async {
      app.stateOf('m')!.nodeOnline = true;
      final seed = Zoo(
        daemons: [
          ZooDaemon(uid: 'tim-one', id: 'tim', hatched: '', egg: 'first'),
          ZooDaemon(uid: 'gnu-one', id: 'gnu', hatched: '', egg: 'turn'),
        ],
        pair: 'tim-one',
        firstEgg: true,
      );
      await mount(tester, on: true, seed: seed);
      await app.handleEventForTest('m', {
        'type': 'daemon_state',
        'payload': {'pair': 'tim'},
      });
      await tester.pump();
      expect(frames.where((f) => f.$1 == 'daemon_open'), isEmpty);
      app.openCompanions();
      await tester.pump();
      await tester.pump();
      final requests = frames.where((f) => f.$1 == 'daemon_open').toList();
      expect(requests, hasLength(1));
      expect(requests.single.$2['companionUid'], 'tim-one');
      expect(requests.single.$2.containsKey('text'), isFalse);
      app
          .stateOf('m')!
          .agents
          .add(
            const Agent(
              id: 'pair-tim',
              name: 'Tim',
              engine: 'claude',
              dsh: 'autonomous/pair',
              terminalAvailable: true,
              project: AgentProject(
                name: 'Pair',
                cwd: '/pair/workspace/tim-one',
              ),
            ),
          );
      await app.handleEventForTest('m', {
        'type': 'daemon_open_result',
        'payload': {
          'requestId': requests.single.$2['requestId'],
          'ok': true,
          'agentId': 'pair-tim',
        },
      });
      await tester.pump();
      await tester.pump();
      expect(app.swarms, hasLength(1));
      expect(app.activeSwarm.name, 'Companions');
      expect(app.panes, hasLength(2));
      expect(app.panes.first.isCompanion, isTrue);
      expect(app.panes.last.agentId, 'pair-tim');
      expect(app.panes.first.ownerAgentId, 'pair-tim');
      expect(frames.where((f) => f.$1 == 'daemon_talk'), isEmpty);

      zoo.pair('gnu-one');
      await tester.pump();
      await tester.pump();
      final terminalPane = app.panes.last;
      expect(terminalPane.agentId, 'pair-tim');
      expect(app.panes.first.ownerAgentId, 'pair-tim');
      final next = frames.where((f) => f.$1 == 'daemon_open').last;
      expect(next.$2['companionUid'], 'gnu-one');
      await app.handleEventForTest('m', {
        'type': 'daemon_open_result',
        'payload': {
          'requestId': next.$2['requestId'],
          'ok': true,
          'agentId': 'pair-tim',
        },
      });
      await tester.pump();
      await tester.pump();
      expect(app.panes.last, same(terminalPane));
      expect(app.swarms, hasLength(1));
      expect(frames.where((f) => f.$1 == 'daemon_talk'), isEmpty);
      await setCreature(tester, false);
      await tester.pump();
      expect(app.activeSwarm.panes, isEmpty);
      final opens = frames.where((f) => f.$1 == 'daemon_open').length;
      app.notifyListeners();
      await tester.pump();
      expect(frames.where((f) => f.$1 == 'daemon_open'), hasLength(opens));
      await unmount(tester);
    },
  );

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

  testWidgets('a 404 is off: no slot and the disabled-feature bar, at '
      'every width', (tester) async {
    seedStatusBarWorkspace(app);
    // Compare the same workspace with the creature feature disabled. The
    // independent Share control may change appearance without granting an
    // absent daemon any space in either bar.
    await experiments.set(ExperimentalFeature.shareButton, true);
    await mount(tester, enabled: false);
    expect(remote.fetches, 0);
    expect(slot, findsNothing);
    final before = await measureStatusBar(tester);
    await setCreature(tester, true);
    expect(remote.fetches, 1);
    expect(zoo.daemons, DaemonsSwitch.off);
    expect(slot, findsNothing);
    expect(await measureStatusBar(tester), before);
    expect(slot, findsNothing);
    await unmount(tester);
  });

  testWidgets('while the first read has no answer nothing is kept for the '
      'slot', (tester) async {
    seedStatusBarWorkspace(app);
    await experiments.set(ExperimentalFeature.shareButton, true);
    final gate = Completer<void>();
    await mount(tester, on: true, enabled: false, gate: gate);
    expect(remote.fetches, 0);
    expect(slot, findsNothing);
    final before = await measureStatusBar(tester);
    await setCreature(tester, true);
    expect(remote.fetches, 1);
    expect(zoo.daemons, DaemonsSwitch.unknown);
    expect(slot, findsNothing);
    expect(await measureStatusBar(tester), before);
    gate.complete();
    await tester.pump();
    await tester.pump();
    expect(zoo.daemons, DaemonsSwitch.on);
    expect(slot, findsOneWidget, reason: 'on (200): as today');
    expect(
      await measureStatusBar(tester),
      isNot(before),
      reason: 'a present daemon is the state that may take bar space',
    );
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
    await tester.pump();
    expect(find.byKey(const ValueKey('companion-home')), findsOneWidget);
    expect(app.activeSwarm.isCompanions, isTrue);
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
      tester.getCenter(find.byKey(const ValueKey('workspace-tab-bar'))),
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

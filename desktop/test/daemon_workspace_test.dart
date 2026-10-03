// The daemon in the workspace: when it may appear, the habits the window
// reports, the hatch and its reveal, the panel, and what native hears.
import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/daemons/daemon_brain.dart';
import 'package:harness/daemons/roster.dart';
import 'package:harness/widgets/daemon_slot.dart';
import 'package:harness/daemons/zoo.dart';
import 'package:harness/daemons/zoo_controller.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/state/swarm_catalog.dart' show SwarmProjectStore;

import 'support/experimental_settings.dart';
import 'daemons/zoo_test.dart' show FakeZooTransport;
import 'keymap_host_test.dart' show key;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp, MemoryStore;

const _habits5 = ['turn', 'split', 'find', 'machine', 'store'];

Future<void> skipName(WidgetTester tester) async {
  final skip = find.byKey(const ValueKey('daemon-hatch-name-skip'));
  if (skip.evaluate().isNotEmpty) {
    await tester.ensureVisible(skip);
    await tester.tap(skip);
    await tester.pump();
  }
}

void main() {
  late AppNotifier app;
  late ZooController zoo;
  late FakeZooTransport remote;

  setUp(() {
    app = createApp();
    app.currentUser = const CurrentUserProfile(
      id: 'u1',
      email: 'review@example.test',
    );
  });
  tearDown(() => app.dispose());

  Future<void> mount(
    WidgetTester tester, {
    Zoo seed = Zoo.empty,
    bool native = false,
    bool reduceMotion = false,
    Completer<void>? gate,
    // These tests are about daemons that are on: a guest here has turned on
    // Daemons (preview). The off cases are in daemon_off_test.dart.
    bool guestPreview = true,
  }) async {
    final experiments = MemoryExperimentalFeaturesStore(storage: MemoryStore());
    addTearDown(experiments.dispose);
    await experiments.set(ExperimentalFeature.focusBarCreature, true);
    remote = FakeZooTransport()
      ..zoo = seed
      ..revision = 1
      ..gate = gate;
    zoo = ZooController(random: Random(1));
    addTearDown(zoo.dispose);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 800);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(disableAnimations: reduceMotion),
          child: child!,
        ),
        home: SwarmScreen(
          notifier: app,
          nativeTabs: native,
          projectStore: SwarmProjectStore(),
          experimentalFeatures: experiments,
          zoo: zoo,
          zooTransport: remote,
          daemonClock: () => tester.binding.clock.now(),
          daemonsPreview: ValueNotifier(guestPreview),
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

  // Advanced activity, consent, and lesson approvals keep their guarded quick
  // controls. The top-bar click now opens the companion's full viewer first.
  Future<void> openControls(
    WidgetTester tester, {
    String section = 'now',
  }) async {
    await tester.tap(slot);
    await tester.pump();
    // The DSH's pane layout is attached after the tab's first frame.
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('companion-settings')));
    await tester.pump();
    final tab = find.byKey(ValueKey('daemon-tab-$section'));
    if (tab.evaluate().isNotEmpty) {
      await tester.tap(tab);
      await tester.pump();
    }
  }

  /// The semantic pose driving the illustrated slot. Pixel assets have their own render tests.
  String glyph(WidgetTester tester) => tester
      .widget<DaemonSlotButton>(find.byType(DaemonSlotButton))
      .face
      .cell
      .trim();

  testWidgets('nothing shows until the profile and the zoo have loaded', (
    tester,
  ) async {
    app.currentUser = null;
    final gate = Completer<void>();
    await mount(tester, gate: gate);
    expect(slot, findsNothing);
    expect(zoo.scope, isNull, reason: 'no temporary scope before the profile');
    app.currentUser = const CurrentUserProfile(id: 'u1', email: 'a@b.test');
    app.notifyListeners();
    await tester.pump();
    expect(zoo.scope, 'account:u1');
    expect(slot, findsNothing, reason: 'the first read is still in flight');
    gate.complete();
    await tester.pump();
    await tester.pump();
    expect(slot, findsOneWidget);
    expect(glyph(tester), r'\_(  )_/');
    await unmount(tester);
  });

  testWidgets('a guest who turned on the preview has a local zoo at once', (
    tester,
  ) async {
    app.signedIn = false;
    await mount(tester);
    await tester.pump();
    expect(zoo.source, ZooSource.local);
    expect(slot, findsOneWidget);
    expect(remote.fetches, 0);
    await unmount(tester);
  });

  testWidgets('habits come from real signals and are reported once', (
    tester,
  ) async {
    await mount(tester);
    await tester.pump();
    expect(remote.zoo.habits, isEmpty);
    // A finished turn in a harness open here.
    app.adoptSessionForTest(terminal('a0', []));
    await app.handleMachineEventForTest('m', {
      'type': 'turn_ended',
      'agentId': 'a0',
    });
    await tester.pump();
    // Two harnesses side by side.
    app.adoptSessionForTest(terminal('a1', []));
    app.notifyListeners();
    await tester.pump();
    // A paused harness resumed from this window.
    app.stateOf('m')!.resumedHarnesses = 1;
    app.notifyListeners();
    await tester.pump();
    await zoo.flush();
    await tester.pump();
    expect(remote.zoo.habits, containsAll(['turn', 'split', 'resume']));
    expect(remote.zoo.habits, isNot(contains('elsewhere')));
    final sent = remote.batches
        .expand((b) => b)
        .where((op) => op['op'] == 'zoo.habit')
        .map((op) => op['key'])
        .toList();
    expect(sent.toSet().length, sent.length, reason: 'each habit once');
    // A finished turn and two more: the first egg is ready.
    expect(glyph(tester), r'\_(oo)_/');
    await unmount(tester);
  });

  testWidgets('the nest says how far along it is, and a ready egg hatches '
      'into a reveal that returns focus when closed', (tester) async {
    await mount(
      tester,
      seed: Zoo(
        habits: _habits5,
        firstEgg: true,
        eggs: const [ZooEgg(id: 'egg1', kind: 'first', grantedAt: '')],
      ),
    );
    await tester.pump();
    expect(glyph(tester), r'\_(oo)_/');
    final before = FocusManager.instance.primaryFocus;
    await tester.tap(slot);
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-hatch')), findsOneWidget);
    expect(find.byKey(const ValueKey('daemon-hatch-egg')), findsOneWidget);
    expect(glyph(tester), r'\_(oo)_/', reason: 'the slot keeps the egg');
    for (
      var i = 0;
      i < 180 &&
          find.byKey(const ValueKey('daemon-hatch-card')).evaluate().isEmpty;
      i++
    ) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    final id = remote.zoo.daemons.single.id;
    final def = daemonRoster.byId(id)!;
    expect(find.byKey(const ValueKey('daemon-hatch-card')), findsOneWidget);
    expect(find.textContaining("Meet $id."), findsOneWidget);
    expect(glyph(tester), isNot(r'\_(oo)_/'), reason: 'revealed');
    // Copy puts a fenced code block on the clipboard.
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String;
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    await skipName(tester);
    await tester.ensureVisible(find.byKey(const ValueKey('daemon-hatch-copy')));
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-copy')));
    await tester.pump();
    expect(copied, startsWith('#01/09'));
    expect(copied, isNot(contains('```')));
    expect(copied, contains('${def.id} 0.1'));
    expect(copied, contains("first egg"));
    await skipName(tester);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-hatch')), findsNothing);
    expect(
      FocusManager.instance.primaryFocus?.debugLabel,
      isNot(contains('Hatch')),
    );
    expect(before, isNotNull);
    await unmount(tester);
  });

  testWidgets('after the first hatch: what the daemon sees, "Let it watch" '
      'or "Not now", then suggest as a second step', (tester) async {
    await mount(
      tester,
      reduceMotion: true,
      seed: Zoo(
        habits: _habits5,
        firstEgg: true,
        eggs: const [ZooEgg(id: 'egg1', kind: 'first', grantedAt: '')],
      ),
    );
    await tester.pump();
    await tester.tap(slot);
    await tester.pump();
    await tester.pump();
    final id = remote.zoo.daemons.single.id;
    expect(find.byKey(const ValueKey('daemon-hatch-card')), findsOneWidget);
    // Nobody has said yet whether it may watch: [ next ], not [ close ].
    expect(find.text('Close'), findsNothing);
    await skipName(tester);
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-next')));
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-consent')), findsOneWidget);
    expect(find.text('What $id sees'), findsOneWidget);
    for (final what in ['reads', 'writes', 'runs', 'does']) {
      expect(
        find.text('${what[0].toUpperCase()}${what.substring(1)}'),
        findsOneWidget,
      );
    }
    expect(find.textContaining('your next prompt'), findsOneWidget);
    expect(find.textContaining('never a plain terminal'), findsOneWidget);
    expect(find.textContaining('a lesson only with your yes'), findsOneWidget);
    expect(remote.zoo.consent, isNull, reason: 'nothing until an answer');
    await tester.ensureVisible(
      find.byKey(const ValueKey('daemon-consent-watch')),
    );
    await tester.tap(find.byKey(const ValueKey('daemon-consent-watch')));
    await tester.pump();
    await zoo.flush();
    expect(remote.zoo.watching, isTrue);
    expect(remote.zoo.autonomy, 'watch', reason: 'a yes starts at watch');
    // Suggest is its own step.
    expect(find.text('Let $id suggest answers?'), findsOneWidget);
    await tester.ensureVisible(
      find.byKey(const ValueKey('daemon-consent-suggest-yes')),
    );
    await tester.tap(find.byKey(const ValueKey('daemon-consent-suggest-yes')));
    await tester.pump();
    await zoo.flush();
    expect(remote.zoo.autonomy, 'suggest');
    expect(find.byKey(const ValueKey('daemon-hatch')), findsNothing);
    expect(
      remote.batches.expand((b) => b).map((op) => op['op']),
      containsAllInOrder(['zoo.consent', 'zoo.autonomy']),
    );
    await unmount(tester);
  });

  testWidgets('"Not now" watches nothing; the now tab asks again, and '
      'settings says so', (tester) async {
    await mount(
      tester,
      reduceMotion: true,
      seed: Zoo(
        habits: _habits5,
        firstEgg: true,
        eggs: const [ZooEgg(id: 'egg1', kind: 'first', grantedAt: '')],
      ),
    );
    await tester.pump();
    await tester.tap(slot);
    await tester.pump();
    await tester.pump();
    final id = remote.zoo.daemons.single.id;
    await skipName(tester);
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-next')));
    await tester.pump();
    await tester.ensureVisible(
      find.byKey(const ValueKey('daemon-consent-not-now')),
    );
    await tester.tap(find.byKey(const ValueKey('daemon-consent-not-now')));
    await tester.pump();
    await zoo.flush();
    expect(remote.zoo.consent!.watching, isFalse);
    expect(find.byKey(const ValueKey('daemon-hatch')), findsNothing);
    await openControls(tester);
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('daemon-panel-consent')))
          .data,
      '$id does not watch: nothing is sensed, journaled or learned.',
    );
    await tester.tap(find.byKey(const ValueKey('daemon-consent')));
    await tester.pump();
    await tester.ensureVisible(
      find.byKey(const ValueKey('daemon-consent-watch')),
    );
    await tester.tap(find.byKey(const ValueKey('daemon-consent-watch')));
    await tester.pump();
    await zoo.flush();
    expect(remote.zoo.watching, isTrue);
    await tester.ensureVisible(
      find.byKey(const ValueKey('daemon-consent-keep-watch')),
    );
    await tester.tap(find.byKey(const ValueKey('daemon-consent-keep-watch')));
    await tester.pump();
    expect(remote.zoo.autonomy, 'watch');
    await key(tester, LogicalKeyboardKey.digit4);
    await tester.pump();
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('daemon-panel-consent')))
          .data,
      startsWith('$id watches your harnesses since '),
    );
    await skipName(tester);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pump();
    await unmount(tester);
  });

  testWidgets('the nest lists what this computer can do first; a second '
      'computer is never needed', (tester) async {
    await mount(tester);
    await tester.pump();
    await openControls(tester);
    expect(find.text('all of it can happen on this computer.'), findsOneWidget);
    double top(String key) =>
        tester.getTopLeft(find.byKey(ValueKey('daemon-habit-$key'))).dy;
    final divider = tester
        .getTopLeft(find.byKey(const ValueKey('daemon-panel-elsewhere')))
        .dy;
    for (final here in ['turn', 'split', 'find', 'store', 'resume', 'days']) {
      expect(top(here), lessThan(divider), reason: here);
    }
    for (final there in ['machine', 'elsewhere']) {
      expect(top(there), greaterThan(divider), reason: there);
    }
    expect(
      find.text('with another computer or device (never needed):'),
      findsOneWidget,
    );
    await skipName(tester);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pump();
    await unmount(tester);
  });

  testWidgets('Reduce Motion goes straight to the card', (tester) async {
    await mount(
      tester,
      reduceMotion: true,
      seed: Zoo(
        habits: _habits5,
        firstEgg: true,
        eggs: const [ZooEgg(id: 'egg1', kind: 'first', grantedAt: '')],
      ),
    );
    await tester.pump();
    await tester.tap(slot);
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-hatch-card')), findsOneWidget);
    expect(find.byKey(const ValueKey('daemon-hatch-egg')), findsNothing);
    await skipName(tester);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-hatch')), findsNothing);
    await unmount(tester);
  });

  testWidgets('native never hears the hatchling before the reveal ends', (
    tester,
  ) async {
    final states = <Map>[];
    const channel = MethodChannel('harness/swarm_tabs');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'daemonState') states.add(call.arguments as Map);
      if (call.method == 'update') {
        final daemon = (call.arguments as Map?)?['daemon'];
        if (daemon is Map) states.add(daemon);
      }
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
      native: true,
      seed: Zoo(
        habits: _habits5,
        firstEgg: true,
        eggs: const [ZooEgg(id: 'egg1', kind: 'first', grantedAt: '')],
      ),
    );
    await tester.pump();
    expect(states.last['glyph'], r'\_(oo)_/');
    expect(states.last['label'], 'Egg, ready to hatch');
    const codec = StandardMethodCodec();
    // Native's click; the reply waits for the next frame, so it is not awaited.
    unawaited(
      tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        'harness/swarm_tabs',
        codec.encodeMethodCall(const MethodCall('daemon')),
        (_) {},
      ),
    );
    await tester.pump();
    final start = states.length;
    // Up to just before the card: every frame of the reveal.
    for (var i = 0; i < 180; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      if (find
          .byKey(const ValueKey('daemon-hatch-card'))
          .evaluate()
          .isNotEmpty) {
        break;
      }
      final id = remote.zoo.daemons.firstOrNull?.id;
      for (final state in states.skip(start)) {
        expect((state['glyph'] as String).length, lessThanOrEqualTo(8));
        expect(state['glyph'], isNotEmpty);
        expect(state['busy'], isTrue);
        if (id != null) {
          expect(
            '${state['label']} ${state['tooltip']} ${state['detail']}',
            isNot(contains(id)),
          );
        }
      }
    }
    expect(find.byKey(const ValueKey('daemon-hatch-card')), findsOneWidget);
    await tester.pump();
    final id = remote.zoo.daemons.single.id;
    expect(states.last['label'], id, reason: 'named once the card is up');
    expect(states.last['busy'], isFalse);
    await skipName(tester);
    await key(tester, LogicalKeyboardKey.escape);
    await unmount(tester);
  });

  testWidgets('the panel: portrait, lore, zoo, pair, rename and nap by '
      'keyboard', (tester) async {
    await mount(
      tester,
      seed: Zoo(
        daemons: [
          ZooDaemon(id: 'tim', hatched: '2026-09-26T09:00:00Z', egg: 'first'),
          ZooDaemon(
            id: 'tux',
            hatched: '2026-09-26T10:00:00Z',
            egg: 'turn',
            version: '2.0',
            xp: 600,
          ),
        ],
        pair: legacyZooUid('tim'),
        habits: _habits5,
        firstEgg: true,
      ),
    );
    await tester.pump();
    expect(glyph(tester), '(o o)');
    await openControls(tester);
    expect(find.byKey(const ValueKey('daemon-panel')), findsOneWidget);
    // Four tabs, tmux's window list; now is first. 2 is the zoo.
    expect(find.text('Now'), findsOneWidget);
    expect(find.text('Zoo'), findsOneWidget);
    expect(find.byKey(const ValueKey('daemon-panel-line')), findsOneWidget);
    expect(find.byKey(const ValueKey('daemon-portrait')), findsNothing);
    await key(tester, LogicalKeyboardKey.digit2);
    await tester.pump();
    expect(find.text('Zoo'), findsOneWidget);
    expect(find.byKey(const ValueKey('daemon-portrait')), findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey('daemon-details')));
    await tester.tap(find.byKey(const ValueKey('daemon-details')));
    await tester.pump();
    expect(find.textContaining('screen -> tmux -> tim'), findsOneWidget);
    expect(find.textContaining('Named the way vim was'), findsOneWidget);
    // The zoo's box back: two owned, the rest numbered and unknown, the
    // secret marked.
    expect(find.text('[ ? ]'), findsNWidgets(7));
    expect(find.text('[ ! ]'), findsOneWidget);
    expect(find.text('#08 Tux'), findsOneWidget);
    // Move to tux and pair it.
    await key(tester, LogicalKeyboardKey.keyJ);
    await tester.pump();
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pump();
    expect(
      find.text(daemonRoster.byId('tux')!.lore),
      findsOneWidget,
      reason: 'the panel now shows tux',
    );
    await tester.tap(find.byKey(const ValueKey('daemon-pair')));
    await tester.pump();
    expect(zoo.zoo.pair, legacyZooUid('tux'));
    await zoo.flush();
    expect(remote.zoo.pair, legacyZooUid('tux'));
    // Rename it.
    await tester.tap(find.byKey(const ValueKey('daemon-rename')));
    await tester.pump();
    await tester.enterText(
      find.byKey(const ValueKey('daemon-name-input')),
      'Scout',
    );
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    await zoo.flush();
    expect(remote.zoo.daemons.last.name, 'Scout');
    expect(find.text('Scout the tux'), findsOneWidget);
    // Nap is a setting, then Escape closes and the slot shows the nap.
    await tester.ensureVisible(
      find.byKey(const ValueKey('daemon-tab-settings')),
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('daemon-tab-settings')));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const ValueKey('daemon-nap')));
    await tester.tap(find.byKey(const ValueKey('daemon-nap')));
    // The click that opened the panel was a boop; it wins for 900 ms.
    await tester.pump(const Duration(seconds: 1));
    expect(glyph(tester), r'<(- -)/z');
    await skipName(tester);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-panel')), findsNothing);
    // It opens again where it was left.
    await openControls(tester, section: 'settings');
    expect(find.text('Settings'), findsOneWidget);
    await skipName(tester);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pump();
    await unmount(tester);
  });

  testWidgets('command search opens the companion home as "Daemon"', (
    tester,
  ) async {
    await mount(tester);
    await tester.pump();
    await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
    await tester.pump();
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      '> Daemon',
    );
    await tester.pump(const Duration(milliseconds: 100));
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byKey(const ValueKey('companion-home')), findsOneWidget);
    expect(app.activeSwarm.isCompanions, isTrue);
    expect(find.text('Someone little\nis on their way.'), findsOneWidget);
    await app.closeSwarm(app.activeSwarmId);
    await tester.pump();
    expect(find.byKey(const ValueKey('companion-home')), findsNothing);
    await unmount(tester);
  });

  testWidgets('zoo_changed refetches; the voice replaces the context', (
    tester,
  ) async {
    await mount(tester);
    await tester.pump();
    remote
      ..zoo = Zoo(
        daemons: [ZooDaemon(id: 'tim', hatched: '', egg: 'first')],
        pair: legacyZooUid('tim'),
      )
      ..revision = 5;
    await app.handleMachineEventForTest('m', {
      'type': 'zoo_changed',
      'payload': {'revision': 5},
    });
    await tester.pump();
    await tester.pump();
    expect(glyph(tester), '(o o)');
    await tester.tap(slot);
    await tester.pump();
    await skipName(tester);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pump(const Duration(seconds: 3));
    expect(
      find.byKey(const ValueKey('daemon-voice')),
      findsOneWidget,
      reason: "the boop's line, after the typing pause",
    );
    expect(find.text("tim: hey. that's my status line. (ink)"), findsOneWidget);
    await tester.pump(const Duration(seconds: 6));
    expect(find.byKey(const ValueKey('daemon-voice')), findsNothing);
    await unmount(tester);
  });
  for (final guest in [true, false]) {
    testWidgets(
      guest
          ? 'a guest earns from its own live turns'
          : 'signed in, turns are left to harnessd: no zoo.turn is sent',
      (tester) async {
        if (guest) app.signedIn = false;
        await mount(tester);
        await tester.pump();
        app.adoptSessionForTest(terminal('a0', []));
        Future<void> turn({bool live = true, bool aborted = false}) async {
          if (live) {
            await app.handleMachineEventForTest('m', {
              'type': 'turn_started',
              'agentId': 'a0',
            });
          }
          await app.handleMachineEventForTest('m', {
            'type': 'turn_ended',
            'agentId': 'a0',
            if (aborted) 'payload': {'aborted': true},
          });
          await tester.pump();
        }

        await turn();
        await turn(live: false); // picked up at attach: never counts
        await turn(aborted: true); // interrupted: never counts
        await turn();
        await zoo.flush();
        if (guest) {
          expect(zoo.zoo.progress.turns, 2);
        } else {
          expect(
            remote.batches.expand((b) => b).map((op) => op['op']),
            isNot(contains('zoo.turn')),
          );
          expect(zoo.zoo.progress.turns, 0);
        }
        await unmount(tester);
      },
    );
  }
  final zooOfTim = Zoo(
    daemons: [ZooDaemon(id: 'tim', hatched: '', egg: 'first')],
    pair: legacyZooUid('tim'),
    habits: _habits5,
    firstEgg: true,
  );

  testWidgets('a machine that is asleep or out of reach is calm: the face '
      'never fails for it, the panel says so', (tester) async {
    await mount(tester, seed: zooOfTim);
    await tester.pump();
    // The fixture's machine is not connected: an open harness on it is away.
    app.adoptSessionForTest(terminal('a0', []));
    app.notifyListeners();
    await tester.pump();
    expect(glyph(tester), '(o o)', reason: 'not x eyes');
    await openControls(tester);
    expect(
      find.text('Test host is asleep or unreachable. its harnesses wait.'),
      findsOneWidget,
    );
    await skipName(tester);
    await key(tester, LogicalKeyboardKey.escape);
    await unmount(tester);
  });

  testWidgets('a failed turn in an open harness is a failure', (tester) async {
    app.stateOf('m')!
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    await mount(tester, seed: zooOfTim);
    await tester.pump();
    app.adoptSessionForTest(terminal('a0', []));
    await app.handleMachineEventForTest('m', {
      'type': 'turn_started',
      'agentId': 'a0',
    });
    await app.handleMachineEventForTest('m', {
      'type': 'turn_ended',
      'agentId': 'a0',
      'payload': {'error': 'exit 1'},
    });
    await tester.pump();
    expect(glyph(tester), '(x x)');
    await tester.pump(const Duration(seconds: 5));
    expect(glyph(tester), '(x x)', reason: 'its last turn failed');
    await app.handleMachineEventForTest('m', {
      'type': 'turn_started',
      'agentId': 'a0',
    });
    await tester.pump();
    expect(glyph(tester), startsWith('(= =)'), reason: 'a new turn');
    await app.handleMachineEventForTest('m', {
      'type': 'turn_ended',
      'agentId': 'a0',
    });
    await tester.pump();
    expect(glyph(tester), '(^ ^)', reason: 'it ended well');
    await unmount(tester);
  });

  testWidgets('agent events step the work frame, at most twice a second; '
      'a quiet agent is a still baton', (tester) async {
    app.stateOf('m')!
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    await mount(tester, seed: zooOfTim);
    await tester.pump();
    app.adoptSessionForTest(terminal('a0', []));
    await app.handleMachineEventForTest('m', {
      'type': 'turn_started',
      'agentId': 'a0',
    });
    await tester.pump();
    final first = glyph(tester);
    expect(first, startsWith('(= =)'));
    await tester.pump(const Duration(seconds: 3));
    expect(glyph(tester), first, reason: 'no events, no motion');
    await app.handleMachineEventForTest('m', {
      'type': 'tool_start',
      'agentId': 'a0',
      'payload': {'tool': 'Bash'},
    });
    await tester.pump();
    final second = glyph(tester);
    expect(second, isNot(first), reason: 'one event, one step');
    for (var i = 0; i < 5; i++) {
      await app.handleMachineEventForTest('m', {
        'type': 'text_delta',
        'agentId': 'a0',
        'payload': {'content': 'x'},
      });
    }
    await tester.pump(const Duration(milliseconds: 100));
    expect(glyph(tester), second, reason: 'at most two steps a second');
    await tester.pump(const Duration(milliseconds: 500));
    expect(glyph(tester), isNot(second));
    await app.handleMachineEventForTest('m', {
      'type': 'turn_ended',
      'agentId': 'a0',
    });
    await tester.pump();
    await unmount(tester);
  });

  testWidgets('finished turns keep the creature alone and still in the bar; '
      'Quiet and Motion are switches in the panel', (tester) async {
    app.stateOf('m')!
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    await mount(tester, seed: zooOfTim);
    await tester.pump();
    app.adoptSessionForTest(terminal('a0', []));
    app.adoptSessionForTest(terminal('a1', []));
    // The adoption seam does not notify. Lay out the focused pane and its
    // model control before comparing the bar against subsequent turn events.
    app.notifyListeners();
    await tester.pump();
    final beforeTurns = tester.getRect(slot);
    // a1 is in front: its turn is seen already; a0's is not.
    for (final id in ['a0', 'a1']) {
      await app.handleMachineEventForTest('m', {
        'type': 'turn_started',
        'agentId': id,
      });
      await app.handleMachineEventForTest('m', {
        'type': 'turn_ended',
        'agentId': id,
      });
    }
    await tester.pump();
    final focused = app.focusedPane!.agentId;
    expect(focused, isNotNull);
    expect(
      tester.getRect(slot),
      beforeTurns,
      reason: 'finished turns do not take more focus-bar space',
    );
    expect(
      find.descendant(
        of: slot,
        matching: find.byKey(const ValueKey('daemon-slot-art')),
      ),
      findsOneWidget,
      reason: 'only the creature is drawn, without labels or counts',
    );
    expect(find.byKey(const ValueKey('daemon-voice')), findsNothing);
    final glyphTarget = find.byKey(const ValueKey('daemon-slot-art'));
    final beforeHover = tester.getRect(glyphTarget);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    await mouse.moveTo(beforeHover.center);
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-slot-tally')), findsNothing);
    expect(
      tester.getRect(glyphTarget),
      beforeHover,
      reason: 'hover must not move the creature away from the click',
    );
    await tester.tapAt(beforeHover.center);
    await tester.pump();
    await mouse.moveTo(Offset.zero);
    await tester.pump();
    expect(
      tester.getRect(glyphTarget),
      beforeHover,
      reason: 'leaving the creature keeps the same fixed slot',
    );
    expect(find.byKey(const ValueKey('daemon-slot-tally')), findsNothing);
    // The switches are on the settings tab: 4.
    await tester.tap(find.byKey(const ValueKey('companion-settings')));
    await tester.pump();
    expect(find.text('Settings'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('daemon-quiet')));
    await tester.pump();
    expect(find.text('Quiet on'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('daemon-motion')));
    await tester.pump();
    expect(find.text('Motion off'), findsOneWidget);
    await skipName(tester);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pump(const Duration(seconds: 3));
    expect(
      find.byKey(const ValueKey('daemon-voice')),
      findsNothing,
      reason: "Quiet: not even the boop's reply",
    );
    await unmount(tester);
  });

  testWidgets('xyzzy in Cmd-O: "Nothing happens." and one zoo.easter', (
    tester,
  ) async {
    await mount(tester, seed: zooOfTim);
    await tester.pump();
    await key(tester, LogicalKeyboardKey.keyO, cmd: true);
    await tester.pump();
    final input = find.byKey(const ValueKey('swarm-search-input'));
    await tester.enterText(input, 'xyzzy');
    await tester.pump(const Duration(milliseconds: 100));
    // A result row, not a place to go.
    final note = find.byKey(const ValueKey('swarm-search-line:note:xyzzy'));
    expect(note, findsOneWidget);
    expect(
      find.descendant(of: note, matching: find.text('Nothing happens.')),
      findsOneWidget,
    );
    await tester.enterText(input, 'xyzz');
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Nothing happens.'), findsNothing);
    await tester.enterText(input, 'XYZZY');
    await tester.pump(const Duration(milliseconds: 100));
    expect(note, findsOneWidget);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pump();
    expect(
      find.byKey(const ValueKey('swarm-search-input')),
      findsOneWidget,
      reason: 'Return never takes the note',
    );
    await zoo.flush();
    final easter = remote.batches
        .expand((b) => b)
        .where((op) => op['op'] == 'zoo.easter')
        .toList();
    expect(easter, [
      {'op': 'zoo.easter', 'word': 'xyzzy'},
    ]);
    await skipName(tester);
    await key(tester, LogicalKeyboardKey.escape);
    await unmount(tester);
  });

  testWidgets('after the third hatch, any key skips to the card', (
    tester,
  ) async {
    await mount(
      tester,
      seed: Zoo(
        daemons: [
          ZooDaemon(id: 'tim', hatched: '', egg: 'first'),
          ZooDaemon(id: 'gnu', hatched: '', egg: 'turn'),
          ZooDaemon(id: 'lynx', hatched: '', egg: 'turn'),
        ],
        pair: legacyZooUid('tim'),
        habits: _habits5,
        firstEgg: true,
        eggs: [ZooEgg(id: 'egg4', kind: 'turn', grantedAt: '')],
      ),
    );
    await tester.pump();
    expect(
      find.descendant(
        of: slot,
        matching: find.byKey(const ValueKey('daemon-slot-art')),
      ),
      findsOneWidget,
      reason: 'additional eggs wait in the panel, without a bar count',
    );
    await openControls(tester);
    await tester.tap(find.byKey(const ValueKey('daemon-egg:turn')));
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-hatch')), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 200));
    await key(tester, LogicalKeyboardKey.space);
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-hatch-card')), findsOneWidget);
    await skipName(tester);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-slot-tally')), findsNothing);
    await unmount(tester);
  });

  testWidgets('native hears only the ten cells, without count labels', (
    tester,
  ) async {
    final states = <Map>[];
    const channel = MethodChannel('harness/swarm_tabs');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'daemonState') states.add(call.arguments as Map);
      if (call.method == 'update') {
        final daemon = (call.arguments as Map?)?['daemon'];
        if (daemon is Map) states.add(daemon);
      }
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
      native: true,
      seed: Zoo(
        daemons: [ZooDaemon(id: 'tim', hatched: '', egg: 'first', shiny: true)],
        pair: legacyZooUid('tim'),
        habits: _habits5,
        firstEgg: true,
        eggs: [ZooEgg(id: 'e1', kind: 'week', grantedAt: '')],
      ),
    );
    await tester.pump();
    expect(states.last['cell'], '* (o o)   ');
    expect(states.last.containsKey('tally'), isFalse);
    expect(states.last.containsKey('tallyCells'), isFalse);
    expect(states.last.containsKey('tallyColor'), isFalse);
    expect(states.last['patch'], isNull, reason: 'a dark theme');
    await unmount(tester);
  });

  group('the pair brain', () {
    late List<(String, Map<String, dynamic>)> frames;
    setUp(() {
      frames = [];
      // This computer's own harnessd: the only socket daemon_* frames use.
      app.stateOf('m')!.localEndpoint = LocalCliEndpoint(
        computerId: 'test-computer',
        wsUri: Uri.parse('ws://fixture.invalid'),
        protocolVersion: 1,
        terminalProtocolVersion: 3,
      );
      app.daemonFrameSenderForTest = (type, payload) {
        frames.add((type, payload));
        return true;
      };
    });

    Future<void> frame(
      WidgetTester tester,
      String type,
      Map<String, dynamic> payload, {
      String machine = 'm',
    }) async {
      await app.handleMachineEventForTest(machine, {
        'type': type,
        'payload': payload,
      });
      await tester.pump();
    }

    final zooWithTim = Zoo(
      daemons: [ZooDaemon(id: 'tim', hatched: '', egg: 'first')],
      pair: legacyZooUid('tim'),
      habits: _habits5,
      firstEgg: true,
      // The person said yes on the first day.
      consent: ZooConsent(watching: true, at: '2026-09-26T09:00:00.000Z'),
    );

    /// A line drawn a moment ago is armed: its keys count.
    Future<void> arm(WidgetTester tester) async {
      await tester.pump();
      await tester.pump(DaemonBrain.armAfter);
    }

    Iterable<String> shownIds() =>
        frames.where((f) => f.$1 == 'daemon_shown').map((f) => f.$2['id']);
    final question = {
      'id': 'q1',
      'about': {'machineId': 'office', 'agentId': 'a1', 'requestId': 'r1'},
      'mood': 'need',
      'line': '[y/n] codex@office wants to run the migration.',
      'actions': [
        {'key': 'y', 'label': 'run it', 'choice': '1'},
        {'key': 'n', 'label': 'not now', 'choice': '3'},
      ],
      'ttlMs': 5200,
    };

    /// A daemon_state as `cli/src/pair/brain.ts` sends it.
    Map<String, dynamic> state({
      List<Map<String, dynamic>> needs = const [],
      List<Map<String, dynamic>> asks = const [],
      List<Map<String, dynamic>> acted = const [],
      List<Map<String, dynamic>> machines = const [],
      int done = 0,
    }) => {
      'pair': 'tim',
      'needs': needs,
      'working': 0,
      'failing': [],
      'machines': machines,
      'done': {
        'count': done,
        'last': [
          if (done > 0)
            {
              'machineId': 'office',
              'machine': 'office',
              'agentId': 'a9',
              'name': 'api@office',
              'recap': 'tests pass.',
              'at': 0,
            },
        ],
      },
      'asks': asks,
      'acted': acted,
    };

    Future<void> openPanel(WidgetTester tester) async {
      await openControls(tester);
      expect(find.byKey(const ValueKey('daemon-panel')), findsOneWidget);
    }

    Future<void> tapIn(WidgetTester tester, Finder finder) async {
      await tester.ensureVisible(finder);
      await tester.pump();
      await tester.tap(finder);
      await tester.pump();
    }

    testWidgets(
      'Talk opens the collection viewer and real terminal without sending a model turn',
      (tester) async {
        await mount(tester, seed: zooWithTim);
        app.stateOf('m')!.nodeOnline = true;
        await frame(tester, 'daemon_state', state());
        app
            .stateOf('m')!
            .agents
            .add(
              const Agent(
                id: 'pair1',
                name: 'Companions',
                engine: 'claude',
                dsh: 'autonomous/pair',
                terminalAvailable: true,
              ),
            );
        app.adoptSessionForTest(terminal('pair1', []));
        await key(tester, LogicalKeyboardKey.keyT, cmd: true, alt: true);
        await tester.pump();
        await tester.pump();
        final opening = frames.lastWhere((f) => f.$1 == 'daemon_open');
        expect(opening.$2.containsKey('text'), isFalse);
        await frame(tester, 'daemon_open_result', {
          'requestId': opening.$2['requestId'],
          'ok': true,
          'agentId': 'pair1',
          'setupRequired': true,
        });
        await tester.pump();
        expect(app.activeSwarm.isCompanions, isTrue);
        expect(app.panes, hasLength(2));
        expect(app.panes.first.isCompanion, isTrue);
        expect(app.panes.first.ownerAgentId, 'pair1');
        expect(app.panes.last.agentId, 'pair1');
        expect(app.focusedPane!.agentId, 'pair1');
        expect(find.byKey(const ValueKey('companion-home')), findsOneWidget);
        expect(
          find.byKey(const ValueKey('companion-chat-input')),
          findsNothing,
        );
        expect(frames.where((f) => f.$1 == 'daemon_talk'), isEmpty);
        await unmount(tester);
      },
    );

    testWidgets('keys first: [g] opens the harness here; the asks list keeps '
        'what waits, and y answers it', (tester) async {
      await mount(tester, seed: zooWithTim);
      await tester.pump();
      app.adoptSessionForTest(terminal('a1', []));
      app.adoptSessionForTest(terminal('a3', []));
      app.notifyListeners();
      await tester.pump();
      await frame(
        tester,
        'daemon_state',
        state(
          asks: [
            {
              'id': 'ask:7',
              'line': '[y/n] start codex in ~/api?',
              'actions': [
                {'key': 'y', 'label': 'do it', 'choice': 'y'},
                {'key': 'n', 'label': 'skip', 'choice': 'n'},
              ],
            },
          ],
          needs: [
            {
              'machineId': 'm',
              'machine': 'laptop',
              'agentId': 'a1',
              'name': 'migration',
              'requestId': 'r1',
              'question': 'Run npm test?',
            },
          ],
        ),
      );
      expect(glyph(tester), '(? ?)', reason: 'it asks you something');
      await frame(tester, 'daemon_say', {
        'id': 'need:m:e:1',
        'about': {'machineId': 'm', 'agentId': 'a1', 'requestId': 'r1'},
        'mood': 'need',
        'line': '[y/n/g] migration: Run npm test?',
        'actions': [
          {'key': 'y', 'label': 'Yes', 'choice': '1. Yes'},
          {'key': 'n', 'label': 'No', 'choice': '3. No'},
          {'key': 'g', 'label': 'open', 'choice': 'open'},
        ],
        'ttlMs': 5200,
      });
      // The pane in front is a3: the line is about a1, so it speaks.
      expect(find.text('migration: Run npm test?'), findsOneWidget);
      final acts = frames.where((f) => f.$1 == 'daemon_act').length;
      await tester.tap(find.byKey(const ValueKey('daemon-answer-g')));
      await tester.pump();
      expect(app.focusedPane!.agentId, 'a1', reason: '[g] opened it');
      expect(
        frames.where((f) => f.$1 == 'daemon_act').length,
        acts,
        reason: 'opening is the window\'s to do',
      );
      // After its time the line goes; the asks list keeps both.
      await tester.pump(const Duration(seconds: 6));
      expect(find.byKey(const ValueKey('daemon-voice')), findsNothing);
      await openPanel(tester);
      expect(find.text('start codex in ~/api?'), findsOneWidget);
      expect(find.text('migration@laptop: Run npm test?'), findsOneWidget);
      // Its keys are faint until the row has been on screen a moment.
      expect(
        find.byKey(const ValueKey('daemon-key-ask:ask:7-y-arming')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('daemon-key-ask:ask:7-y')),
        findsNothing,
      );
      await arm(tester);
      expect(shownIds(), contains('ask:7'));
      await tapIn(tester, find.byKey(const ValueKey('daemon-key-ask:ask:7-y')));
      expect(frames.last.$1, 'daemon_act');
      expect(frames.last.$2['id'], 'ask:7');
      expect(frames.last.$2['choice'], 'y');
      // A focused row answers from the keyboard too: n.
      _focusRow(tester, 'ask:ask:7');
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyN);
      expect(frames.last.$2['choice'], 'n');
      await tester.pump(const Duration(minutes: 3));
      await unmount(tester);
    });

    testWidgets('done is the brain\'s count of finished turns; a look sends '
        'doneSeen; auto is done and journaled; asleep is calm', (tester) async {
      await mount(tester, seed: zooWithTim);
      await tester.pump();
      await frame(
        tester,
        'daemon_state',
        state(
          done: 3,
          machines: [
            {'machineId': 'm', 'name': 'laptop', 'status': 'ok', 'local': true},
            {'machineId': 'o', 'name': 'office', 'status': 'asleep'},
            {'machineId': 's', 'name': 'studio', 'status': 'unreachable'},
          ],
          acted: [
            {
              'machineId': 'o',
              'machine': 'office',
              'agentId': 'a2',
              'name': 'web@office',
              'by': 'rule',
              'action': 'answer',
              'text': 'answered "1. Yes"',
              'at': DateTime.now().millisecondsSinceEpoch,
            },
          ],
        ),
      );
      expect(
        find.descendant(
          of: slot,
          matching: find.byKey(const ValueKey('daemon-slot-art')),
        ),
        findsOneWidget,
        reason: 'remote completions do not add a focus-bar count',
      );
      expect(glyph(tester), '(o o)', reason: 'asleep is never a failure');
      // It acted within rules: drawn like done.
      await frame(tester, 'daemon_say', {
        'id': 'auto:o:e:2',
        'about': {'machineId': 'o', 'agentId': 'a2'},
        'mood': 'auto',
        'line': 'rule: web@office answered "1. Yes"',
        'actions': [],
        'ttlMs': 5200,
      });
      expect(glyph(tester), '(^ ^)');
      await openPanel(tester);
      expect(
        frames.where((f) => f.$2['doneSeen'] == true),
        hasLength(2),
        reason:
            'opening the viewer and then its controls each acknowledges a look',
      );
      expect(find.byKey(const ValueKey('daemon-slot-tally')), findsNothing);
      expect(
        find.textContaining('rule: web@office answered "1. Yes"'),
        findsWidgets,
      );
      final away = tester
          .widget<Text>(find.byKey(const ValueKey('daemon-panel-away')))
          .data!;
      expect(away, contains('office is asleep. its harnesses wait.'));
      expect(away, contains('studio is out of reach.'));
      await tester.pump(const Duration(minutes: 3));
      await unmount(tester);
    });

    testWidgets('autonomy: four levels, the floor, the rules file; a raise '
        'waits for a yes the panel asks, and the badge shows above suggest', (
      tester,
    ) async {
      await mount(tester, seed: zooWithTim);
      await tester.pump();
      await frame(tester, 'daemon_state', {...state(), 'autonomy': 'watch'});
      await openPanel(tester);
      await key(tester, LogicalKeyboardKey.digit4);
      await tester.pump();
      for (final level in zooAutonomyLevels) {
        expect(find.byKey(ValueKey('daemon-autonomy:$level')), findsOneWidget);
      }
      expect(find.text('watch'), findsOneWidget, reason: 'the default');
      expect(
        find.textContaining('your key approves one waiting answer at a time'),
        findsOneWidget,
        reason: 'no batches',
      );
      expect(
        find.textContaining(
          'nothing is deleted, restarted, forked or bypassed',
        ),
        findsOneWidget,
      );
      expect(find.text('Open rules file'), findsOneWidget);
      await tapIn(
        tester,
        find.byKey(const ValueKey('daemon-autonomy:suggest')),
      );
      await zoo.flush();
      expect(remote.zoo.autonomy, 'suggest');
      await frame(tester, 'daemon_state', {...state(), 'autonomy': 'suggest'});
      expect(find.text('suggest'), findsOneWidget);
      // A raise above suggest is a request: harnessd asks for a yes here.
      await tapIn(
        tester,
        find.byKey(const ValueKey('daemon-autonomy:act-on-key')),
      );
      await zoo.flush();
      expect(remote.zoo.autonomy, 'act-on-key');
      const confirm = {
        'id': 'confirm:autonomy:k1',
        'kind': 'autonomy',
        'nonce': 'k1',
        'line':
            '[y/n] let your daemon act at act-on-key? it stays at suggest '
            'until you say yes',
        'detail':
            'autonomy suggest -> act-on-key\nact-on-key: it drives harnesses '
            'it started without asking (the floor still holds); the rest '
            'wait for your key.',
        'actions': [
          {'key': 'y', 'label': 'confirm', 'choice': 'y'},
          {'key': 'n', 'label': 'keep it as it is', 'choice': 'n'},
        ],
        'at': 1790000000000,
        'level': 'act-on-key',
      };
      await frame(tester, 'daemon_state', {
        ...state(),
        'autonomy': 'suggest',
        'autonomyRequested': 'act-on-key',
        'confirms': [confirm],
      });
      expect(find.text('act on key · waits for your yes'), findsOneWidget);
      expect(
        find.textContaining('it drives harnesses it started without asking'),
        findsOneWidget,
        reason: 'exactly what changes, in full',
      );
      final yes = find.byKey(
        const ValueKey('daemon-key-confirm:confirm:autonomy:k1-y'),
      );
      expect(yes, findsNothing, reason: 'not armed yet');
      await arm(tester);
      expect(shownIds(), contains('confirm:autonomy:k1'));
      await tapIn(tester, yes);
      expect(frames.last.$1, 'daemon_confirm');
      expect(frames.last.$2, {
        'requestId': frames.last.$2['requestId'],
        'kind': 'autonomy',
        'nonce': 'k1',
        'accept': true,
      });
      await frame(tester, 'daemon_confirm_result', {
        'requestId': frames.last.$2['requestId'],
        'kind': 'autonomy',
        'nonce': 'k1',
        'ok': true,
        'accepted': true,
      });
      await frame(tester, 'daemon_state', {
        ...state(),
        'autonomy': 'act-on-key',
      });
      // Above suggest: a badge in the panel and the illustrated hover preview.
      expect(
        find.byKey(const ValueKey('daemon-panel-autonomy-badge')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('daemon-panel-autonomy-badge')),
        findsOneWidget,
      );
      await skipName(tester);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pump();
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      addTearDown(mouse.removePointer);
      await mouse.moveTo(tester.getCenter(slot));
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Autonomy: act on key'), findsOneWidget);
      await tester.pump(const Duration(minutes: 3));
      await unmount(tester);
    });

    testWidgets('a pair.jsonc waiting for a yes lists what it turns on, '
        'learning opt-ins included', (tester) async {
      await mount(tester, seed: zooWithTim);
      await tester.pump();
      await frame(tester, 'daemon_state', {
        ...state(),
        'autonomy': 'suggest',
        'confirms': [
          {
            'id': 'confirm:rules:n2',
            'kind': 'rules',
            'nonce': 'n2',
            'line':
                '[y/n] use pair.jsonc as it is now? 0 rules, model off, '
                'learn borrow + export claude; until you say yes, none of it',
            'detail':
                'pair.jsonc (0 rules, model off, learn borrow + export '
                'claude):\n{ "learn": { "borrow": true, "export": ["claude"] } }',
            'actions': [
              {'key': 'y', 'label': 'confirm', 'choice': 'y'},
              {'key': 'n', 'label': 'keep it as it is', 'choice': 'n'},
            ],
          },
        ],
      });
      await openPanel(tester);
      // On now, with what waits for you; and on settings under the rules.
      expect(find.textContaining('learn.borrow: what Hermes'), findsOneWidget);
      expect(
        find.text(
          '- learn.export: approved skills also written to ~/.claude/skills',
        ),
        findsOneWidget,
      );
      await arm(tester);
      await tapIn(
        tester,
        find.byKey(const ValueKey('daemon-key-confirm:confirm:rules:n2-n')),
      );
      expect(frames.last.$1, 'daemon_confirm');
      expect(frames.last.$2['kind'], 'rules');
      expect(frames.last.$2['accept'], isFalse);
      await key(tester, LogicalKeyboardKey.digit4);
      await tester.pump();
      expect(find.textContaining('learn.borrow: what Hermes'), findsOneWidget);
      await tester.pump(const Duration(minutes: 3));
      await unmount(tester);
    });

    testWidgets('lessons: listed through the pair request; taught only by '
        'the live line\'s key after its whole text; skip and revert', (
      tester,
    ) async {
      await mount(tester, seed: zooWithTim);
      await tester.pump();
      await frame(tester, 'daemon_state', state());
      await openPanel(tester);
      Map<String, dynamic> lastPair() =>
          frames.lastWhere((f) => f.$1 == 'pair').$2;
      expect(lastPair()['verb'], 'lessons');
      expect(lastPair()['action'], 'list');
      Future<void> answer(Map<String, dynamic> reply) => frame(
        tester,
        'pair_result',
        {'requestId': lastPair()['requestId'], ...reply},
      );
      final lessons = {
        'ok': true,
        'git': true,
        'lessons': [
          {
            'id': 'l1',
            'kind': 'skill',
            'name': 'run-migrations-safely',
            'status': 'pending',
            'description': 'Back up before migrating.',
            'learnedBy': 'tim',
          },
          {
            'id': 'l0',
            'kind': 'note',
            'name': 'note-l0',
            'status': 'approved',
            'approved': '2026-09-25',
            'project': 'api',
            'learnedBy': 'tim',
          },
        ],
      };
      await answer(lessons);
      await tester.pump();
      await key(tester, LogicalKeyboardKey.digit3);
      await tester.pump();
      expect(find.text('Lessons'), findsOneWidget);
      expect(find.text('pending "run-migrations-safely"'), findsOneWidget);
      expect(find.text('learned note for api · 2026-09-25'), findsOneWidget);
      // No approve here: a window's own say-so is never the person's yes.
      expect(
        find.byKey(const ValueKey('daemon-lesson-approve:l1')),
        findsNothing,
      );
      expect(
        find.textContaining('harness pair lessons approve l1'),
        findsOneWidget,
      );
      // Show: its whole text.
      await tapIn(tester, find.byKey(const ValueKey('daemon-lesson-show:l1')));
      expect(lastPair()['action'], 'show');
      await answer({'ok': true, 'text': 'SKILL.md: back up, then migrate.'});
      await tester.pump();
      expect(find.text('SKILL.md: back up, then migrate.'), findsOneWidget);
      // The daemon proposes it: its line, with the whole text, in the asks.
      const nonce = 'lesson:l1:0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
      await frame(
        tester,
        'daemon_state',
        state(
          asks: [
            {
              'id': nonce,
              'line':
                  '[y/n/s] teach your agents "run-migrations-safely"? you '
                  'corrected codex.',
              'detail': '---\nname: run-migrations-safely\n---\nBack up first.',
              'actions': [
                {'key': 'y', 'label': 'teach', 'choice': 'y'},
                {'key': 'n', 'label': 'skip', 'choice': 'n'},
                {'key': 's', 'label': 'show', 'choice': 's'},
              ],
            },
          ],
        ),
      );
      expect(find.textContaining('Back up first.'), findsOneWidget);
      expect(
        find.byKey(ValueKey('daemon-key-lesson-ask:$nonce-y')),
        findsNothing,
        reason: 'not until its text has been on screen a moment',
      );
      await arm(tester);
      expect(shownIds(), contains(nonce));
      await tapIn(
        tester,
        find.byKey(ValueKey('daemon-key-lesson-ask:$nonce-y')),
      );
      expect(frames.last.$1, 'daemon_act');
      expect(frames.last.$2['id'], nonce, reason: 'the nonce, whole');
      expect(frames.last.$2['choice'], 'y');
      await frame(tester, 'daemon_act_result', {
        'requestId': frames.last.$2['requestId'],
        'id': nonce,
        'ok': true,
        'learned': 'run-migrations-safely',
      });
      await frame(tester, 'daemon_state', state());
      expect(lastPair()['action'], 'list', reason: 'read again');
      await answer(lessons);
      await tester.pump();
      expect(
        find.text(
          'learned "run-migrations-safely". every harness will load it.',
        ),
        findsOneWidget,
      );
      await tapIn(
        tester,
        find.byKey(const ValueKey('daemon-lesson-revert:l0')),
      );
      expect(lastPair()['action'], 'revert');
      expect(lastPair()['id'], 'l0');
      expect(lastPair().containsKey('confirmed'), isFalse);
      await answer({'ok': true});
      await tester.pump();
      await answer(lessons);
      await tester.pump();
      await tapIn(tester, find.byKey(const ValueKey('daemon-lesson-skip:l1')));
      expect(lastPair()['action'], 'skip');
      await answer({
        'ok': false,
        'error': 'NOT_PENDING',
        'detail': 'lesson l1 is approved',
      });
      await tester.pump();
      await answer(lessons);
      await tester.pump();
      expect(find.text('lesson l1 is approved'), findsOneWidget);
      expect(
        frames.where((f) => f.$1 == 'pair' && f.$2['action'] == 'approve'),
        isEmpty,
        reason: 'never approved through the pair request',
      );
      await tester.pump(const Duration(minutes: 3));
      await unmount(tester);
    });

    testWidgets('what tim did: its journal and the lessons it taught; a '
        'lesson reverts, an answer cannot', (tester) async {
      await mount(tester, seed: zooWithTim);
      await tester.pump();
      await frame(
        tester,
        'daemon_state',
        state(
          acted: [
            {
              'machineId': 'o',
              'machine': 'office',
              'agentId': 'a2',
              'name': 'web@office',
              'by': 'rule',
              'action': 'answer',
              'text': 'answered "1. Yes"',
              'at': DateTime.now().millisecondsSinceEpoch,
            },
          ],
        ),
      );
      await openPanel(tester);
      await frame(tester, 'pair_result', {
        'requestId': frames.lastWhere((f) => f.$1 == 'pair').$2['requestId'],
        'ok': true,
        'lessons': [
          {
            'id': 'l0',
            'kind': 'skill',
            'name': 'run-migrations-safely',
            'status': 'approved',
            'approved': '2026-09-25',
          },
        ],
      });
      await tester.pump();
      expect(find.byKey(const ValueKey('daemon-panel-did')), findsOneWidget);
      expect(find.text('what tim did'), findsOneWidget);
      expect(
        find.textContaining('a rule: web@office answered "1. Yes"'),
        findsOneWidget,
      );
      expect(
        find.text('an answer typed into a harness cannot be taken back.'),
        findsOneWidget,
      );
      expect(
        find.text('taught "run-migrations-safely" · 2026-09-25'),
        findsOneWidget,
      );
      await tapIn(tester, find.byKey(const ValueKey('daemon-did-revert:l0')));
      final revert = frames.lastWhere((f) => f.$1 == 'pair').$2;
      expect(revert['action'], 'revert');
      expect(revert['id'], 'l0');
      await tester.pump(const Duration(minutes: 3));
      await unmount(tester);
    });

    testWidgets('a lesson proposal is keys first with [s]; its whole text '
        'shows under the line before its keys arm; show is a brief', (
      tester,
    ) async {
      await mount(tester, seed: zooWithTim);
      await tester.pump();
      await frame(tester, 'daemon_state', state());
      const nonce = 'lesson:l1:0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
      await frame(tester, 'daemon_say', {
        'id': nonce,
        'about': {'machineId': 'm', 'agentId': 'a7'},
        'mood': 'ask',
        'line': '[y/n/s] teach your agents "run-migrations-safely"? you corrected codex.',
        'detail': '---\nname: run-migrations-safely\n---\nBack up first.',
        'actions': [
          {'key': 'y', 'label': 'teach', 'choice': 'y'},
          {'key': 'n', 'label': 'skip', 'choice': 'n'},
          {'key': 's', 'label': 'show', 'choice': 's'},
        ],
        'ttlMs': 5200,
      });
      expect(
        find.text(
          'teach your agents "run-migrations-safely"? you corrected codex.',
        ),
        findsOneWidget,
      );
      await tester.pump();
      // The disclosure under the status line: the lesson, in full.
      expect(find.byKey(const ValueKey('daemon-detail')), findsOneWidget);
      expect(find.textContaining('Back up first.'), findsOneWidget);
      expect(find.textContaining('the lesson, in full'), findsOneWidget);
      // Before it arms, ⌘⌥S does nothing.
      await key(tester, LogicalKeyboardKey.keyS, cmd: true, alt: true);
      expect(frames.where((f) => f.$1 == 'daemon_act'), isEmpty);
      await arm(tester);
      expect(shownIds(), [nonce], reason: 'after the text was drawn');
      await key(tester, LogicalKeyboardKey.keyS, cmd: true, alt: true);
      expect(frames.last.$1, 'daemon_act');
      expect(frames.last.$2['choice'], 's');
      await frame(tester, 'daemon_brief', {
        'desk': 'local',
        'line': 'lesson "run-migrations-safely", pending',
        'items': [
          {
            'id': nonce,
            'kind': 'lesson',
            'machineId': 'm',
            'line': '[y/n] teach your agents "run-migrations-safely"?',
            'actions': [
              {'key': 'y', 'label': 'teach', 'choice': 'y'},
              {'key': 'n', 'label': 'skip', 'choice': 'n'},
            ],
            'text': '---\nname: run-migrations-safely\n---\nBack up first.',
          },
        ],
      });
      await tester.pump();
      expect(find.textContaining('Back up first.'), findsWidgets);
      // Shown already on this connection: its keys are armed.
      await tester.tap(find.byKey(const ValueKey('daemon-brief-key-0-y')));
      await tester.pump();
      expect(frames.last.$2['id'], nonce);
      expect(frames.last.$2['choice'], 'y');
      await tester.pump(const Duration(minutes: 3));
      await unmount(tester);
    });

    testWidgets('a line with a detail shows the harness and the exact command '
        'under the status line; the pair speaking is its nick, keyless', (
      tester,
    ) async {
      await mount(tester, seed: zooWithTim);
      await tester.pump();
      await frame(tester, 'daemon_state', state());
      app.adoptSessionForTest(terminal('a3', []));
      app.notifyListeners();
      await tester.pump();
      await frame(tester, 'daemon_say', {
        'id': 'need:office:e:1',
        'about': {'machineId': 'office', 'agentId': 'a1', 'requestId': 'r1'},
        'mood': 'need',
        'line': '[y/n/g] api@office Bash: npm test',
        'detail':
            'Bash command\n\n  npm test -- --runInBand\n\nDo you want '
            'to proceed?\n  1. Yes\n  3. No',
        'harness': {
          'machineId': 'office',
          'machine': 'office',
          'agentId': 'a1',
          'name': 'api',
        },
        'actions': [
          {'key': 'y', 'label': 'Yes', 'choice': '1. Yes'},
          {'key': 'n', 'label': 'No', 'choice': '3. No'},
          {'key': 'g', 'label': 'open', 'choice': 'open'},
        ],
        'ttlMs': 5200,
      });
      await tester.pump();
      expect(find.byKey(const ValueKey('daemon-detail')), findsOneWidget);
      expect(
        find.textContaining('api@office · exactly what a key does'),
        findsOneWidget,
      );
      expect(find.textContaining('npm test -- --runInBand'), findsOneWidget);
      expect(find.text('y Yes · n No · g open'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('daemon-answer-y-arming')),
        findsOneWidget,
        reason: 'faint until armed',
      );
      await arm(tester);
      expect(shownIds(), ['need:office:e:1']);
      expect(find.byKey(const ValueKey('daemon-answer-y')), findsOneWidget);
      // The disclosure folds, and the line keeps its keys.
      await tester.tap(find.byKey(const ValueKey('daemon-detail-toggle')));
      await tester.pump();
      expect(find.textContaining('npm test -- --runInBand'), findsNothing);
      await tester.pump(const Duration(seconds: 6));
      expect(find.byKey(const ValueKey('daemon-detail')), findsNothing);
      // The pair harness speaking: its <nick>, no keys, whatever it sent.
      await frame(tester, 'daemon_say', {
        'id': 'say:9',
        'about': {'machineId': 'm', 'agentId': ''},
        'mood': 'say',
        'from': 'pair',
        'line': 'api waits on you, 40m.',
        'actions': [
          {'key': 'y', 'label': 'yes', 'choice': 'y'},
        ],
        'ttlMs': 5200,
      });
      await tester.pump();
      final voice = tester.widget<Text>(
        find.byKey(const ValueKey('daemon-voice-text')),
      );
      expect(voice.textSpan!.toPlainText(), '<tim> api waits on you, 40m.');
      expect(find.byKey(const ValueKey('daemon-answer-y')), findsNothing);
      expect(find.byKey(const ValueKey('daemon-detail')), findsNothing);
      await tester.pump(const Duration(minutes: 3));
      await unmount(tester);
    });

    testWidgets('a second line in the same words is still a new line: it is '
        'acknowledged and arms on its own', (tester) async {
      await mount(tester, seed: zooWithTim);
      await tester.pump();
      await frame(tester, 'daemon_state', state());
      Map<String, dynamic> ask(String id) => {
        'id': id,
        'about': {'machineId': 'm', 'agentId': ''},
        'mood': 'ask',
        'from': 'pair',
        'line': '[y/n] run the tests in api?',
        'actions': [
          {'key': 'y', 'label': 'do it', 'choice': 'y'},
          {'key': 'n', 'label': 'skip', 'choice': 'n'},
        ],
        'ttlMs': 5200,
      };
      await frame(tester, 'daemon_say', ask('ask:1'));
      await arm(tester);
      await frame(tester, 'daemon_say', ask('ask:2'));
      await tester.pump();
      expect(shownIds(), ['ask:1', 'ask:2']);
      expect(
        find.byKey(const ValueKey('daemon-answer-y-arming')),
        findsOneWidget,
        reason: 'the new line has not armed yet',
      );
      await arm(tester);
      await tester.tap(find.byKey(const ValueKey('daemon-answer-y')));
      await tester.pump();
      expect(frames.last.$1, 'daemon_act');
      expect(frames.last.$2['id'], 'ask:2');
      await tester.pump(const Duration(minutes: 3));
      await unmount(tester);
    });

    testWidgets(
      'an unavailable companion engine explains setup and retries in the same DSH',
      (tester) async {
        await mount(tester, seed: zooWithTim);
        await frame(tester, 'daemon_state', state());
        await key(tester, LogicalKeyboardKey.keyT, cmd: true, alt: true);
        await tester.pump();
        await tester.pump();
        final opening = frames.lastWhere((f) => f.$1 == 'daemon_open');
        final tab = app.activeSwarm.id;
        await frame(tester, 'daemon_open_result', {
          'requestId': opening.$2['requestId'],
          'ok': false,
          'error': 'NO_ENGINE',
        });
        await tester.pump();
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('companion-conversation-setup')),
            matching: find.text(
              'Install OpenCode, Codex, or Claude Code to talk with your companion.',
            ),
          ),
          findsOneWidget,
        );
        await tester.tap(find.text('Open terminal'));
        await tester.pump();
        await tester.pump();
        expect(frames.where((f) => f.$1 == 'daemon_open'), hasLength(2));
        expect(frames.where((f) => f.$1 == 'daemon_talk'), isEmpty);
        expect(app.activeSwarm.id, tab);
        await unmount(tester);
      },
    );

    testWidgets('presence: the pane in front (none clears it), and idle is '
        'away with how long', (tester) async {
      await mount(tester, seed: zooWithTim);
      await tester.pump();
      await frame(tester, 'daemon_state', state());
      app.adoptSessionForTest(terminal('a3', []));
      app.notifyListeners();
      await tester.pump();
      expect(frames.last.$2, {
        'desk': frames.last.$2['desk'],
        'focusMachineId': 'm',
        'focusAgentId': 'a3',
      }, reason: 'a focus change only');
      app.panes.clear();
      app.notifyListeners();
      await tester.pump();
      expect(frames.last.$2['focusAgentId'], isNull);
      expect(frames.last.$2.containsKey('focusAgentId'), isTrue);
      // Five minutes with no key or pointer in front of the window: away.
      await key(tester, LogicalKeyboardKey.shiftLeft);
      await tester.pump(const Duration(minutes: 5, seconds: 1));
      final idle = frames.last.$2;
      expect(idle['active'], isFalse);
      expect(idle['awayMs'], greaterThanOrEqualTo(5 * 60 * 1000));
      await tester.pump(const Duration(minutes: 10));
      await key(tester, LogicalKeyboardKey.shiftLeft);
      expect(frames.last.$2['active'], isTrue);
      expect(frames.last.$2['awayMs'], greaterThanOrEqualTo(15 * 60 * 1000));
      await unmount(tester);
    });

    testWidgets('its state drives the face; its line offers answers', (
      tester,
    ) async {
      await mount(tester, seed: zooWithTim);
      await tester.pump();
      expect(glyph(tester), '(o o)');
      await frame(tester, 'daemon_state', {
        'pair': 'tim',
        'needs': [
          {
            'machineId': 'office',
            'agentId': 'a1',
            'requestId': 'r1',
            'name': 'migration',
          },
        ],
        'working': 0,
        'failing': [],
        'machines': [],
        'done': {'count': 0, 'last': []},
        'asks': [],
        'acted': [],
      });
      expect(glyph(tester), '(? ?)', reason: 'a harness on another machine');
      expect(frames.first.$1, 'daemon_presence');
      expect(frames.first.$2['active'], isTrue);
      expect(frames.first.$2['desk'], isA<String>());
      expect(frames.first.$2.containsKey('pair'), isFalse, reason: 'signed in');
      // The pane in front of you is never spoken about: the brain hears it.
      app.adoptSessionForTest(terminal('a3', []));
      app.notifyListeners();
      await tester.pump();
      expect(frames.last.$1, 'daemon_presence');
      expect(frames.last.$2['focusAgentId'], 'a3');
      expect(frames.last.$2['focusMachineId'], 'm');
      await frame(tester, 'daemon_say', question);
      // Exactly as sent, keys first; each key its own button, once armed.
      expect(
        find.text('codex@office wants to run the migration.'),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('daemon-answer-n')), findsNothing);
      await arm(tester);
      expect(shownIds(), contains('q1'));
      expect(find.byKey(const ValueKey('daemon-answer-n')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('daemon-answer-y')));
      await tester.pump();
      expect(frames.last.$1, 'daemon_act');
      expect(frames.last.$2['id'], 'q1');
      expect(frames.last.$2['choice'], '1');
      expect(find.byKey(const ValueKey('daemon-voice')), findsNothing);
      // The chord answers too: ⌘⌥N, once armed.
      await frame(tester, 'daemon_say', {...question, 'id': 'q2'});
      await arm(tester);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyN);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pump();
      expect(frames.last.$2['id'], 'q2');
      expect(frames.last.$2['choice'], '3');
      // A stale answer is explained in one line.
      await frame(tester, 'daemon_act_result', {
        'requestId': frames.last.$2['requestId'],
        'id': 'q2',
        'ok': false,
        'error': 'STALE_QUESTION',
      });
      await tester.pump(const Duration(seconds: 3));
      expect(
        find.text(
          'tim: that question changed before the answer landed. nothing was '
          'typed.',
        ),
        findsOneWidget,
      );
      // Withdrawn lines go; frames from a relayed socket are never heard.
      await tester.pump(const Duration(seconds: 6));
      await frame(tester, 'daemon_say', {...question, 'id': 'q3'});
      await tester.pump(const Duration(seconds: 3));
      await frame(tester, 'daemon_unsay', {'id': 'q3', 'reason': 'answered'});
      expect(find.byKey(const ValueKey('daemon-voice')), findsNothing);
      app.machineStates['r'] = MachineState(
        const Machine(
          machineId: 'r',
          name: 'office',
          authMode: MachineAuthMode.remote,
        ),
      );
      await frame(tester, 'daemon_say', {
        ...question,
        'id': 'q4',
      }, machine: 'r');
      await tester.pump(const Duration(seconds: 3));
      expect(find.byKey(const ValueKey('daemon-voice')), findsNothing);
      await unmount(tester);
    });

    testWidgets('presence follows the window; the brief shows on return', (
      tester,
    ) async {
      app.signedIn = false;
      await mount(tester);
      await tester.pump();
      await frame(tester, 'daemon_state', {'pair': null, 'needs': []});
      expect(frames.single.$2['active'], isTrue);
      expect(
        frames.single.$2.containsKey('pair'),
        isTrue,
        reason: 'an empty guest pair explicitly clears an older connection',
      );
      // A guest's pair lives in its local zoo: the brain hears it paired.
      for (final key in _habits5) {
        zoo.habit(key);
      }
      final hatched = await zoo.hatch(zoo.readyEgg!.id);
      await tester.pump();
      expect(frames.last.$2['pair'], hatched!.daemonId);
      app.appLifecycleChanged(AppLifecycleState.inactive);
      await tester.pump();
      expect(frames.last.$2['active'], isFalse);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(frames.last.$2['active'], isTrue);
      expect(frames.last.$2['awayMs'], isA<int>());
      expect(frames.last.$2['pair'], hatched.daemonId, reason: 'a guest');
      await frame(tester, 'daemon_brief', {
        'desk': frames.last.$2['desk'],
        'line': 'welcome back. 2 done, 1 waiting 40m.',
        'items': [
          {
            'id': 'brief:office:r1:1',
            'kind': 'waiting',
            'machineId': 'office',
            'machine': 'office',
            'agentId': 'a1',
            'name': 'migration',
            'line': '[y/n/g] migration@office: Run npm test? (40m)',
            'actions': [
              {'key': 'y', 'label': 'Yes', 'choice': '1. Yes'},
              {'key': 'n', 'label': 'No', 'choice': '3. No'},
              {'key': 'g', 'label': 'open', 'choice': 'open'},
            ],
          },
          {
            'id': 'asleep:laptop',
            'kind': 'asleep',
            'machineId': 'laptop',
            'machine': 'laptop',
            'line': 'laptop is asleep.',
          },
        ],
      });
      await tester.pump();
      expect(find.byKey(const ValueKey('daemon-brief')), findsOneWidget);
      // Each item exactly as sent, keys first.
      expect(
        find.text('migration@office: Run npm test? (40m)'),
        findsOneWidget,
      );
      expect(find.text('laptop is asleep.'), findsOneWidget);
      // Its keys work while the brief is up, once it has been on screen a
      // moment: [y] is daemon_act on the item.
      expect(
        find.byKey(const ValueKey('daemon-brief-key-0-y-arming')),
        findsOneWidget,
      );
      await arm(tester);
      expect(shownIds(), contains('brief:office:r1:1'));
      await tester.tap(find.byKey(const ValueKey('daemon-brief-key-0-y')));
      await tester.pump();
      expect(frames.last.$1, 'daemon_act');
      expect(frames.last.$2['id'], 'brief:office:r1:1');
      expect(frames.last.$2['choice'], '1. Yes');
      await unmount(tester);
    });
  });
}

/// Focus a panel row (its keys answer from the keyboard).
void _focusRow(WidgetTester tester, String key) {
  final focus = tester.widget<Focus>(find.byKey(ValueKey('daemon-row-$key')));
  focus.focusNode!.requestFocus();
}

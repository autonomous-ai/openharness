// The pane header's model picker: two sections, the way back always offered, and a marked row that
// says where the agent actually is.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:harness/widgets/box_chrome.dart';
import 'package:harness/widgets/transient_menus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/grid_model_picker.dart';
import 'package:harness/widgets/model_picker_chrome.dart';
import 'package:harness/ws/ws_conn.dart';

/// A connection that answers the picker's one RPC immediately. Without it the menu waits out the
/// request's own 12-second timeout, and a spinner that never stops means `pumpAndSettle` never
/// returns — the test would be measuring the timeout rather than the menu.
class _Conn extends WsConn {
  _Conn(
    this.models, {
    this.localModelEngines,
    this.gridName,
    this.gridCli,
    this.grids,
    this.fails = false,
  }) : super(
         wsBaseUrl: 'ws://fixture.invalid',
         autonomousEnv: 'test',
         machineId: 'local',
         accessTokenProvider: (_, _) async => '',
         onAuthFailure: (_) {},
         onEvent: (_) {},
         onStatus: (_) {},
       );

  final List<Map<String, Object?>> models;

  /// The daemon's list of engines a Local model can be offered to; null = an older daemon that
  /// sends no such field.
  final List<String>? localModelEngines;

  /// The grid this account has, independent of what it is serving — so "a grid serving nothing" can
  /// be told apart from "no grid".
  final String? gridName;

  /// Which `grid` the machine would run — `managed`, `path` or `missing`; null = an older daemon
  /// that does not say.
  final String? gridCli;

  /// Every grid the machine is signed into, in sections (`grids`); null = an older daemon that
  /// sends only the own grid's `models`.
  final List<Map<String, Object?>>? grids;

  /// Make the request FAIL, the way an offline machine or a daemon too old for the call does.
  final bool fails;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (fails) throw StateError('grid_models_list_result: UNSUPPORTED');
    return {
      'gridName': gridName ?? (models.isEmpty ? null : 'someone-7f3a91c4'),
      'models': models,
      if (localModelEngines != null) 'localModelEngines': localModelEngines,
      if (gridCli != null) 'gridCli': gridCli,
      if (grids != null) 'grids': grids,
    };
  }
}

void main() {
  late AppNotifier notifier;

  void build({
    List<Map<String, Object?>> models = const [],
    List<String>? localModelEngines,
    String? gridName,
    String? gridCli,
    List<Map<String, Object?>>? grids,
    bool fails = false,
  }) {
    notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (_) => _Conn(
        models,
        localModelEngines: localModelEngines,
        gridName: gridName,
        gridCli: gridCli,
        grids: grids,
        fails: fails,
      ),
    );
  }

  setUp(() => build());
  tearDown(() => notifier.dispose());

  Future<void> open(
    WidgetTester tester, {
    String? currentModel,
    GridWebSearch? webSearch,
    String engine = 'claude',
    VoidCallback? onOwnLogin,
    ValueChanged<GridModel>? onSelected,
    VoidCallback? onRunLocalModel,
  }) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: GridModelPicker(
              notifier: notifier,
              machineId: 'local',
              engineLabel: engine,
              currentModel: currentModel,
              webSearch: webSearch,
              onUseOwnLogin: onOwnLogin,
              onSelected: onSelected,
              onRunLocalModel: onRunLocalModel,
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byType(GridModelPicker));
    // The menu waits on the grid read AND the usage read; settle covers both plus the open animation.
    await tester.pumpAndSettle();
  }

  testWidgets('shows both sections, and the way back is in the first one', (
    tester,
  ) async {
    await open(tester);

    // The two sections this picker has, and NOT the API section the window's own Models menu
    // carries — this control cannot put an agent on an API provider, so offering one would be a
    // choice that goes nowhere.
    expect(find.text('SUBSCRIPTION'), findsOneWidget);
    expect(find.text('ON YOUR MACHINES'), findsOneWidget);
    expect(find.text('API'), findsNothing);

    // A picker that can only move an agent ONTO a grid is a one-way door, so the engine's own login
    // is always the first row. It is named the way the window's own Models menu names it — by
    // PROVIDER ('Anthropic'), not by engine ('Claude') — so the two controls agree about what the
    // thing is called, and it carries that menu's status text beside it.
    expect(find.text('Anthropic').last, findsOneWidget);
    expect(find.textContaining('usage'), findsOneWidget);
  });

  testWidgets('compact model menu stays on screen, and Escape closes it', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(380, 300);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 1.7;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    var ownLogin = 0;
    var manage = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: GridModelPicker(
              notifier: notifier,
              machineId: 'local',
              compact: true,
              currentModel: 'fixture-model',
              engineLabel: 'claude',
              onUseOwnLogin: () => ownLogin++,
              onRunLocalModel: () => manage++,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final trigger = Focus.of(tester.element(find.text('fixture-model')));
    trigger.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('SUBSCRIPTION'), findsOneWidget);
    final bounds = tester.getRect(find.byType(TerminalBox));
    expect(bounds.left, greaterThanOrEqualTo(8));
    expect(bounds.right, lessThanOrEqualTo(372));
    expect(bounds.bottom, lessThanOrEqualTo(292));
    expect(tester.takeException(), isNull);
    // Escape closes it and gives the trigger its focus back — still true, and the half of the
    // keyboard contract that survived the panel.
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('SUBSCRIPTION'), findsNothing);
    expect(trigger.hasFocus, isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    dismissTransientMenus();
    await tester.pumpAndSettle();
    expect(find.text('SUBSCRIPTION'), findsNothing);
    expect(ownLogin, 0);
    expect(manage, 0);
  });

  testWidgets('rows can be reached and activated from the keyboard', (
    tester,
  ) async {
    // Start on a local model: choosing an already selected subscription intentionally does
    // nothing. Down must leave search and Enter must switch to the subscription row.
    var ownLogin = 0;
    build(
      models: const [
        {'id': 'Qwen-Test', 'node': 'macbook'},
      ],
    );
    await open(tester, currentModel: 'Qwen-Test', onOwnLogin: () => ownLogin++);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(ownLogin, 1);
  });

  // THREE situations, two sentences and one silence, one test each — a single test cannot cover
  // them, because re-pumping the same widget reuses the State and the picker answers from the memo
  // it already has. Only the middle one is about the ACCOUNT, and folding the first two together is
  // what told a signed-in user to "sign in again" when the real problem was a daemon that had not
  // answered: advice that was wrong, and useless even if the diagnosis had been right. The third
  // says nothing: the invitation that closes the Local section is what a person does about it.
  testWidgets(
    'a machine that did not answer says so, and does not blame the account',
    (tester) async {
      build(fails: true);
      await open(tester);
      expect(find.text('Could not reach this machine.'), findsOneWidget);
      expect(find.textContaining('sign in'), findsNothing);
    },
  );

  testWidgets('an account with no grid says there are no local models yet', (
    tester,
  ) async {
    await open(tester);
    expect(
      find.text('Set up your first local model on this computer.'),
      findsOneWidget,
    );
    // The user's vocabulary is "Local models", never "grid" — the grid is how a Local model is
    // served, not a thing the picker asks anyone to know about.
    expect(find.textContaining('grid'), findsNothing);
  });

  testWidgets(
    'a machine without the CLI says so, ahead of anything about the account',
    (tester) async {
      // The account has a grid; the machine has no `grid` to serve it with. The machine's sentence
      // wins — it is the one thing a person can act on — and, like the rest, names the feature and
      // never the binary.
      build(gridName: 'someone-7f3a91c4', gridCli: 'missing');
      await open(tester);
      expect(
        find.text('Model Manager can finish setting up this computer.'),
        findsOneWidget,
      );
      expect(
        find.text('Set up your first local model on this computer.'),
        findsNothing,
      );
      expect(find.textContaining('grid'), findsNothing);
    },
  );

  testWidgets(
    'a grid serving nothing says nothing — the run row is the answer',
    (tester) async {
      build(gridName: 'someone-7f3a91c4');
      await open(tester);
      expect(find.text('Nothing is being served yet.'), findsNothing);
      expect(find.text('Could not reach this machine.'), findsNothing);
      expect(find.text('Local models'), findsOneWidget);
    },
  );

  // `Positioned` hands down unbounded width, so a stretching Column takes every pixel its constraints
  // allow — a two-line menu wore the width of the longest model id it could ever hold. The minimum is
  // what keeps a status off a model id; the maximum is a CEILING, not a target. One test each, because
  // re-pumping reuses the State and the second open would answer from the first one's memo.
  testWidgets('a model that came up since the last open appears in THIS open', (
    tester,
  ) async {
    // A warm open draws the memo at once — that is what makes the click free — and used to leave
    // the refresh for the NEXT open. A person who has just started a model and opens the picker is
    // looking for exactly that row, so the refresh has to land in the menu that is showing.
    final served = <Map<String, Object?>>[
      {'id': 'Qwen3.5-4B', 'node': 'macbook'},
    ];
    notifier.dispose();
    notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (_) => _Conn(served),
    );
    await open(tester);
    expect(find.text('Qwen3.5-4B'), findsOneWidget);
    expect(find.text('LFM2.5-8B'), findsNothing);

    // Close, start another model on the grid, open again: the memo still says one model.
    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();
    served.add({'id': 'LFM2.5-8B', 'node': 'macbook'});
    await tester.tap(find.byType(GridModelPicker));
    await tester.pumpAndSettle();

    expect(find.text('Qwen3.5-4B'), findsOneWidget);
    expect(find.text('LFM2.5-8B'), findsOneWidget);
    // Still one menu, redrawn — not a second one over the first.
    expect(find.text('ON YOUR MACHINES'), findsOneWidget);
  });

  testWidgets('shared model changes refresh the open picker', (tester) async {
    final grids = <Map<String, Object?>>[
      {'name': 'home', 'own': true, 'models': <Object?>[]},
      {
        'name': 'Team',
        'own': false,
        'models': <Object?>[
          {'id': 'Old model', 'node': 'Team computer'},
        ],
      },
    ];
    notifier.dispose();
    build(gridName: 'home', grids: grids);
    await open(tester);
    expect(find.text('Old model'), findsOneWidget);
    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();
    grids[1]['models'] = <Object?>[
      {'id': 'New model', 'node': 'Team computer'},
    ];
    await tester.tap(find.byType(GridModelPicker));
    await tester.pumpAndSettle();
    expect(find.text('Old model'), findsNothing);
    expect(find.text('New model'), findsOneWidget);
    expect(find.text('SHARED · TEAM'), findsOneWidget);
  });

  testWidgets(
    'every grid the machine is in gets a section, own first as Local',
    (tester) async {
      // A person in a team's grid has models there they can switch to just the same; the daemon
      // now lists every grid, and the picker draws one section each — the account's own as
      // "Local", the shared ones by name — and a pick carries the grid it came from.
      GridModel? picked;
      build(
        gridName: 'someone-7f3a91c4',
        models: const [
          {'id': 'Qwen3.5-4B', 'node': 'macbook'},
        ],
        grids: const [
          {
            'name': 'someone-7f3a91c4',
            'own': true,
            'models': [
              {'id': 'Qwen3.5-4B', 'node': 'macbook'},
            ],
          },
          {
            'name': 'autonomous.ai',
            'own': false,
            'models': [
              {'id': 'DeepSeek-V4-Flash', 'node': 'scholes-60001'},
            ],
          },
          {'name': 'BBB', 'own': false, 'models': <Object?>[]},
        ],
      );
      await open(tester, onSelected: (m) => picked = m);

      expect(find.text('ON YOUR MACHINES'), findsOneWidget);
      expect(find.text('SHARED · AUTONOMOUS.AI'), findsOneWidget);
      // The grid's name is folded INTO its heading now, not hung on a line beneath it —
      // where it read as an entry of the same kind as the models under it.
      expect(find.text('Qwen3.5-4B'), findsOneWidget);
      expect(find.text('DeepSeek-V4-Flash'), findsOneWidget);
      // Own first: Local sits above the shared grids.
      expect(
        tester.getTopLeft(find.text('ON YOUR MACHINES')).dy <
            tester.getTopLeft(find.text('SHARED · AUTONOMOUS.AI')).dy,
        isTrue,
      );
      // The grid's name is folded INTO its heading now rather than hung on a line beneath it,
      // where it read as an entry of the same kind as the models under it.
      expect(find.text('autonomous.ai'), findsNothing);
      // A shared grid serving nothing is not listed: nothing on it can be picked.
      expect(find.text('BBB'), findsNothing);
      expect(find.textContaining('BBB'), findsNothing);
      // Never the word "grid" for the person.
      expect(find.textContaining('grid'), findsNothing);

      await tester.tap(find.text('DeepSeek-V4-Flash'));
      await tester.pumpAndSettle();
      expect(picked?.id, 'DeepSeek-V4-Flash');
      expect(picked?.grid, 'autonomous.ai');
    },
  );

  testWidgets('a short menu is not as wide as the widest menu could be', (
    tester,
  ) async {
    await open(tester);
    final width = tester.getSize(find.byType(Material).last).width;
    expect(
      width,
      greaterThanOrEqualTo(340),
      reason: 'a status still clears a model id',
    );
    expect(
      width,
      lessThan(540),
      reason: 'and nothing is padded out to the ceiling',
    );
  });

  testWidgets('a long model id is given room, up to the ceiling', (
    tester,
  ) async {
    build(
      models: [
        {
          'id': 'Qwen3.6-35B-A3B-UD-Q5_K_XL-with-a-deliberately-long-tail',
          'node': 'macbook-m1max',
        },
      ],
    );
    await open(tester);
    final width = tester.getSize(find.byType(Material).last).width;
    expect(
      width,
      greaterThan(340),
      reason: 'a row longer than the minimum asks for more',
    );
    expect(
      width,
      lessThanOrEqualTo(540),
      reason: 'and never more than the ceiling',
    );
  });

  testWidgets(
    'a click outside closes the menu AND reaches what it was aimed at',
    (tester) async {
      // `showMenu` puts a modal barrier under the menu and that barrier EATS the dismissing click, so
      // closing the menu and then pressing a button took two clicks with the first going nowhere.
      var pressed = 0;
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Stack(
              children: [
                Positioned(
                  left: 20,
                  top: 400,
                  child: ElevatedButton(
                    onPressed: () => pressed += 1,
                    child: const Text('underneath'),
                  ),
                ),
                Align(
                  alignment: Alignment.topRight,
                  child: GridModelPicker(
                    notifier: notifier,
                    machineId: 'local',
                    engineLabel: 'claude',
                  ),
                ),
              ],
            ),
          ),
        ),
      );
      await tester.tap(find.byType(GridModelPicker));
      await tester.pumpAndSettle();
      expect(find.text('SUBSCRIPTION'), findsOneWidget);

      await tester.tap(find.text('underneath'));
      await tester.pumpAndSettle();

      expect(
        find.text('SUBSCRIPTION'),
        findsNothing,
        reason: 'the menu closes',
      );
      expect(
        pressed,
        1,
        reason: 'and the same click lands on the button under it',
      );
    },
  );

  testWidgets('the control says it is clickable before it is clicked', (
    tester,
  ) async {
    // The pane header sits over a terminal, and without this the cursor over the control was
    // whatever the surface underneath asked for — so a menu control did not look like one.
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: GridModelPicker(
              notifier: notifier,
              machineId: 'local',
              engineLabel: 'claude',
            ),
          ),
        ),
      ),
    );
    // The control prefetches on mount; settle so the test is not measuring that work's timers.
    await tester.pumpAndSettle();

    // BOTH annotations, because the innermost one under the pointer is what a person actually sees:
    // InkWell installs its own MouseRegion, so an ancestor asking for a hand does not decide alone.
    //
    // ⚠️ This asserts the widgets' contract, NOT the cursor the OS ends up drawing. Reading that back
    // through `MouseTracker.debugDeviceActiveCursor` does not work in this harness — a bare
    // `MouseRegion(cursor: click)` over a plain box resolves to `basic` there — so a test written
    // that way would have been measuring the harness rather than the app.
    final region = tester.widget<MouseRegion>(
      find
          .ancestor(
            of: find.byType(InkWell),
            matching: find.byType(MouseRegion),
          )
          .first,
    );
    expect(region.cursor, SystemMouseCursors.click);
    expect(
      tester.widget<InkWell>(find.byType(InkWell)).mouseCursor,
      SystemMouseCursors.click,
    );
  });

  testWidgets(
    'a served model shows under Local with the machine answering it',
    (tester) async {
      build(
        models: [
          {'id': 'Qwen3.6-35B-A3B-UD-Q5_K_XL', 'node': 'macbook-m1max'},
        ],
      );
      GridModel? picked;
      await open(tester, onSelected: (m) => picked = m);

      expect(find.text('Qwen3.6-35B-A3B-UD-Q5_K_XL'), findsOneWidget);
      // The node is what makes a PRIVATE grid legible: it names which of the user's own machines
      // answers, which is the whole difference from a model on somebody else's grid.
      expect(find.text('macbook-m1max'), findsOneWidget);

      await tester.tap(find.text('Qwen3.6-35B-A3B-UD-Q5_K_XL'));
      await tester.pumpAndSettle();
      expect(picked?.id, 'Qwen3.6-35B-A3B-UD-Q5_K_XL');
    },
  );

  testWidgets('a long model id is not truncated while space sits beside it', (
    tester,
  ) async {
    // ⚠️ REGRESSION. The status column used to take the flexible half, which cut
    // `Qwen3.6-35B-A3B-UD-Q5_K_XL` down to `Qwen3.6-35B-A3B-UD-Q5_K…` with empty menu beside it.
    // The long string in this menu is the model id, so the model id is what gets the room.
    build(
      models: [
        {'id': 'Qwen3.6-35B-A3B-UD-Q5_K_XL', 'node': 'macbook-m1max'},
      ],
    );
    await open(tester);

    final title = tester.widget<Text>(find.text('Qwen3.6-35B-A3B-UD-Q5_K_XL'));
    expect(
      title.overflow,
      TextOverflow.ellipsis,
    ); // still guarded for a truly absurd name
    final rendered = tester.renderObject<RenderBox>(
      find.text('Qwen3.6-35B-A3B-UD-Q5_K_XL'),
    );
    // Laid out at its natural width rather than clipped: the painted box is as wide as the string
    // wants, which is the thing that was failing.
    expect(rendered.size.width, greaterThan(160));
  });

  testWidgets(
    'choosing the engine login only fires when the agent is NOT already on it',
    (tester) async {
      var calls = 0;
      // Already on its own login: re-selecting it would respawn the pane for nothing.
      await open(tester, currentModel: null, onOwnLogin: () => calls++);
      await tester.tap(find.text('Anthropic').last);
      await tester.pumpAndSettle();
      expect(calls, 0);

      // On a grid model: now it has somewhere to go.
      await open(tester, currentModel: 'Qwen-Test', onOwnLogin: () => calls++);
      await tester.tap(find.text('Anthropic').last);
      await tester.pumpAndSettle();
      expect(calls, 1);
    },
  );

  testWidgets('every row a person can pick says so under the pointer', (
    tester,
  ) async {
    // A pane menu is drawn over a terminal, and the cursor a person saw while hovering a row was
    // whatever the surface underneath asked for — an arrow over the rows that are the whole point of
    // the menu. The subscription row and each Local model are choices; they should look like it
    // before they are clicked.
    build(
      models: [
        {'id': 'Qwen-Test', 'node': 'macbook-m1max'},
      ],
    );
    await open(tester);

    for (final row in ['Anthropic', 'Qwen-Test']) {
      final inkWell = tester.widget<InkWell>(
        find.ancestor(of: find.text(row), matching: find.byType(InkWell)).first,
      );
      expect(inkWell.mouseCursor, SystemMouseCursors.click, reason: row);
      // BOTH annotations, because the innermost one under the pointer is what decides: InkWell
      // installs a MouseRegion of its own, so an ancestor asking for a hand does not settle it.
      //
      // ⚠️ Counted, not read off `.first`. The nearest MouseRegion ancestor of a row IS the one
      // InkWell made, so asserting on it twice looked like two checks and was one — the wrapper
      // could be set to `basic` and this test still passed. Two carrying it is what proves both.
      final asking = tester
          .widgetList<MouseRegion>(
            find.ancestor(
              of: find.text(row),
              matching: find.byType(MouseRegion),
            ),
          )
          .where((region) => region.cursor == SystemMouseCursors.click)
          .length;
      expect(asking, greaterThanOrEqualTo(2), reason: row);
    }

    // ⚠️ This asserts the widgets' contract, NOT the cursor the OS draws. Reading that back through
    // `MouseTracker.debugDeviceActiveCursor` does not work in this harness — a bare
    // `MouseRegion(cursor: click)` over a plain box answers `basic` there — so a test written that
    // way would be measuring the harness rather than the app.
  });

  group('which engines are offered a picker at all', () {
    test('the three whose switching has been driven end to end', () {
      // Not the daemon's `localModelEngines`, which is the wider "could a Local model be handed to
      // this engine" — seven carry a launch contract. This is which ones a person is OFFERED the
      // switch on, and it is the three that have been watched work: Claude Code and Codex move by
      // environment, OpenCode by a config file plus its own `/models` picker.
      expect(kModelPickerEngines, {'claude', 'codex', 'opencode'});
      for (final engine in ['claude', 'codex', 'opencode']) {
        expect(modelPickerSupports(engine), isTrue, reason: engine);
      }
    });

    test('everything else keeps the header it had', () {
      // A picker on an engine whose move has never been watched work is a menu that looks like a
      // choice and may not be one — and the cost of finding out is an agent answering on a model
      // nobody asked for.
      for (final engine in [
        'cursor',
        'hermes',
        'grok',
        'pi',
        'kilo',
        'amp',
        'devin',
      ]) {
        expect(modelPickerSupports(engine), isFalse, reason: engine);
      }
      // Unknown and absent are NO, not "probably fine".
      expect(modelPickerSupports(null), isFalse);
      expect(modelPickerSupports(''), isFalse);
      expect(modelPickerSupports('something-new'), isFalse);
    });

    test('an engine id is matched however it is spelled', () {
      expect(modelPickerSupports('Claude'), isTrue);
      expect(modelPickerSupports('  OpenCode '), isTrue);
    });
  });

  group('the footer that closes the panel', () {
    const served = [
      {'id': 'Qwen-Test', 'node': 'macbook-m1max'},
    ];

    testWidgets('counts what the list is showing, and offers the one action', (
      tester,
    ) async {
      // It replaced a captioned rule and a bordered button inside the list. The panel pins it
      // below a scrolling middle instead, which is where an action that is NOT one of the rows
      // belongs: everything above is a place the agent can go, and this starts something.
      build(models: served);
      await open(tester);

      expect(find.text('1 model available'), findsOneWidget);
      expect(find.text('Local models'), findsOneWidget);
    });

    testWidgets('is never the marked row, whatever is selected', (
      tester,
    ) async {
      build(models: served);
      await open(tester, currentModel: 'Qwen-Test');

      // It is not a ModelPickerRow at all, so it cannot wear the fill that says where the agent
      // is.
      final rows = tester.widgetList<ModelPickerRow>(
        find.byType(ModelPickerRow),
      );
      expect(rows.map((r) => r.title), isNot(contains('Local models')));
      expect(rows.where((r) => r.selected).map((r) => r.title), ['Qwen-Test']);
    });

    testWidgets('fires onRunLocalModel and nothing else', (tester) async {
      var ran = 0;
      GridModel? picked;
      build(models: served);
      await open(
        tester,
        onRunLocalModel: () => ran++,
        onSelected: (model) => picked = model,
      );
      await tester.tap(find.text('Local models'));
      await tester.pumpAndSettle();
      expect(ran, 1);
      expect(picked, isNull);
    });
  });

  group('web search on the current Local model', () {
    const served = [
      {'id': 'Qwen-Test', 'node': 'macbook-m1max'},
      {'id': 'Other-Model', 'node': 'macbook-m1max'},
    ];

    testWidgets('says nothing when it is on', (tester) async {
      build(models: served);
      await open(
        tester,
        currentModel: 'Qwen-Test',
        webSearch: GridWebSearch.on,
      );
      expect(find.textContaining('Web search'), findsNothing);
      expect(
        tester
            .widget<Tooltip>(
              find
                  .ancestor(
                    of: find.text('Qwen-Test'),
                    matching: find.byType(Tooltip),
                  )
                  .first,
            )
            .message,
        'Model: Qwen-Test · Click to switch',
      );
    });

    testWidgets('says nothing when the daemon said nothing', (tester) async {
      build(models: served);
      await open(tester, currentModel: 'Qwen-Test');
      expect(find.textContaining('Web search'), findsNothing);
    });

    testWidgets(
      'a subtitle under the current row, and the tooltip, when it is unavailable',
      (tester) async {
        build(models: served);
        await open(
          tester,
          currentModel: 'Qwen-Test',
          webSearch: GridWebSearch.unavailable,
        );
        expect(find.text('Web search unavailable'), findsOneWidget);
        // Under the CURRENT model, not every model: the status is about this agent's launch, and the
        // other rows are places it could go, about which nothing is yet known.
        final subtitle = tester.getTopLeft(find.text('Web search unavailable'));
        final current = tester.getTopLeft(find.text('Qwen-Test').last);
        final other = tester.getTopLeft(find.text('Other-Model'));
        expect(subtitle.dy, greaterThan(current.dy));
        expect(subtitle.dy, lessThan(other.dy));
        expect(
          tester
              .widget<Tooltip>(
                find
                    .ancestor(
                      of: find.text('Qwen-Test'),
                      matching: find.byType(Tooltip),
                    )
                    .first,
              )
              .message,
          'Model: Qwen-Test · Click to switch\nWeb search unavailable',
        );
      },
    );

    testWidgets('the other sentence when the engine cannot take it', (
      tester,
    ) async {
      build(models: served);
      await open(
        tester,
        currentModel: 'Qwen-Test',
        webSearch: GridWebSearch.unsupported,
      );
      expect(
        find.text('Web search not supported by this engine'),
        findsOneWidget,
      );
      expect(
        tester
            .widget<Tooltip>(
              find
                  .ancestor(
                    of: find.text('Qwen-Test'),
                    matching: find.byType(Tooltip),
                  )
                  .first,
            )
            .message,
        'Model: Qwen-Test · Click to switch\nWeb search not supported by this engine',
      );
    });

    testWidgets(
      'never under the Subscription row, which has its own web tools',
      (tester) async {
        // A stale status with no current model (the agent came home, the frame has not caught up):
        // the subscription row must not inherit a sentence about a launch it was never part of.
        build(models: served);
        await open(
          tester,
          currentModel: null,
          webSearch: GridWebSearch.unavailable,
        );
        expect(find.textContaining('Web search'), findsNothing);
      },
    );
  });

  group('an engine that cannot run on a Local model', () {
    const served = [
      {'id': 'qwen/qwen3.6-35b-a3b', 'node': 'macbook-m1max'},
    ];
    const capable = [
      'claude',
      'codex',
      'opencode',
      'hermes',
      'grok',
      'pi',
      'copilot',
    ];

    testWidgets('is told so under Local, and offered no rows', (tester) async {
      // The daemon refuses a Cursor retarget (`GRID_ENGINE_UNSUPPORTED`): Cursor Agent can only be
      // re-pointed at another Cursor API. Offering the row anyway was a dead end that said nothing.
      build(models: served, localModelEngines: capable);
      GridModel? picked;
      await open(tester, engine: 'cursor', onSelected: (m) => picked = m);
      expect(
        find.text('Cursor can only run on its own login.'),
        findsOneWidget,
      );
      expect(find.text('qwen/qwen3.6-35b-a3b'), findsNothing);
      expect(picked, isNull);
    });

    testWidgets('a capable engine still gets the rows', (tester) async {
      build(models: served, localModelEngines: capable);
      await open(tester, engine: 'codex');
      expect(find.text('qwen/qwen3.6-35b-a3b'), findsOneWidget);
      expect(find.textContaining('own login'), findsNothing);
    });

    testWidgets(
      'an older daemon that names no engines offers everything, as before',
      (tester) async {
        build(models: served);
        await open(tester, engine: 'cursor');
        expect(find.text('qwen/qwen3.6-35b-a3b'), findsOneWidget);
      },
    );
  });

  // ── which row is the current one ─────────────────────────────────────────────────────────────
  //
  // The mark is the fill and its accent border, and nothing else: the tick it used to carry sat
  // beside the quota figure and crowded it, and was taken out on request. Hover paints a fill too,
  // but never the border, which is what keeps the two apart. What is asked here is which ROW gets
  // the mark, and that a screen reader is told which one it is.

  ModelPickerRow rowFor(WidgetTester tester, String title) => tester
      .widgetList<ModelPickerRow>(find.byType(ModelPickerRow))
      .firstWhere((r) => r.title == title);

  testWidgets('exactly one row is marked, with no tick beside it', (
    tester,
  ) async {
    build(
      models: [
        {'id': 'Qwen-Test', 'node': 'macbook'},
        {'id': 'DeepSeek-Test', 'node': 'zeus'},
      ],
    );
    await open(tester, currentModel: 'Qwen-Test');

    expect(rowFor(tester, 'Qwen-Test').selected, isTrue);
    expect(rowFor(tester, 'DeepSeek-Test').selected, isFalse);
    expect(rowFor(tester, 'Anthropic').selected, isFalse);
    expect(find.byIcon(Icons.check), findsNothing);
    expect(
      // `.last`: the header control names the current model too.
      tester.getSemantics(find.text('Qwen-Test').last),
      containsSemantics(isSelected: true),
    );
    expect(
      tester.getSemantics(find.text('DeepSeek-Test')),
      isNot(containsSemantics(isSelected: true)),
    );
  });

  testWidgets('the subscription row is the marked one when no model is set', (
    tester,
  ) async {
    build(
      models: [
        {'id': 'Qwen-Test', 'node': 'macbook'},
      ],
    );
    await open(tester);

    expect(rowFor(tester, 'Anthropic').selected, isTrue);
    expect(rowFor(tester, 'Qwen-Test').selected, isFalse);
    expect(find.byIcon(Icons.check), findsNothing);
  });

  // ── the selection has to land before the machine confirms it ──────────────────────────────────
  //
  // Picking a model RESPAWNS the pane, so `agent.gridModel` — what `currentModel` carries — only
  // changes once the daemon has done the work. The menu reopened with the tick still on the row
  // the person had just left, which reads as the click having done nothing.

  testWidgets(
    'a fresh currentModel while the menu is open does not crash the frame',
    (tester) async {
      // The first attempt at this redrew the overlay from `didUpdateWidget`, which runs mid-build:
      // "setState() or markNeedsBuild() called during build" across the whole window.
      build(
        models: [
          {'id': 'Qwen-Test', 'node': 'macbook'},
          {'id': 'DeepSeek-Test', 'node': 'zeus'},
        ],
      );

      Widget app(String? current) => MaterialApp(
        home: Scaffold(
          body: Center(
            child: GridModelPicker(
              notifier: notifier,
              machineId: 'local',
              engineLabel: 'claude',
              currentModel: current,
            ),
          ),
        ),
      );

      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(app(null));
      await tester.tap(find.byType(GridModelPicker));
      await tester.pumpAndSettle();
      expect(find.text('Qwen-Test'), findsOneWidget);

      // The daemon's frame lands while the menu is still open.
      await tester.pumpWidget(app('Qwen-Test'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    },
  );

  /// Open the picker as a rebuildable host, so a test can change `currentModel` under it the way
  /// the daemon's frames do.
  Future<void Function(String?)> openLive(
    WidgetTester tester, {
    String? currentModel,
    ValueChanged<GridModel>? onSelected,
    VoidCallback? onOwnLogin,
  }) async {
    var current = currentModel;
    late StateSetter setHost;
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: StatefulBuilder(
              builder: (context, setState) {
                setHost = setState;
                return GridModelPicker(
                  notifier: notifier,
                  machineId: 'local',
                  engineLabel: 'claude',
                  currentModel: current,
                  onSelected: onSelected,
                  onUseOwnLogin: onOwnLogin,
                );
              },
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byType(GridModelPicker));
    await tester.pumpAndSettle();
    return (String? next) => setHost(() => current = next);
  }

  bool ticked(WidgetTester tester, String title) => tester
      .widgetList<ModelPickerRow>(find.byType(ModelPickerRow))
      .any((r) => r.title == title && r.selected);

  testWidgets('the tick stays on the picked model through the respawn', (
    tester,
  ) async {
    // A retarget restarts the pane, and a restarting pane reports NO model for a moment. Taking
    // that null as the answer put the tick back on Subscription mid-move, and the row the person
    // clicked only claimed it once the respawn finished — the flicker between two answers.
    build(
      models: [
        {'id': 'gemma-4-31B-it', 'node': '3d-artist-diego'},
      ],
    );
    final report = await openLive(tester, currentModel: 'Qwen-Old');

    await tester.tap(find.text('gemma-4-31B-it'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(GridModelPicker));
    await tester.pumpAndSettle();
    expect(ticked(tester, 'gemma-4-31B-it'), isTrue);

    // The pane goes down: no model at all.
    report(null);
    await tester.pumpAndSettle();
    expect(
      ticked(tester, 'gemma-4-31B-it'),
      isTrue,
      reason: 'a restarting pane is not an answer',
    );
    expect(ticked(tester, 'Anthropic'), isFalse);

    // And comes back up on what was asked for.
    report('gemma-4-31B-it');
    await tester.pumpAndSettle();
    expect(ticked(tester, 'gemma-4-31B-it'), isTrue);
  });

  testWidgets('a model the menu did not ask for wins over the guess', (
    tester,
  ) async {
    build(
      models: [
        {'id': 'gemma-4-31B-it', 'node': '3d-artist-diego'},
        {'id': 'Qwen-Test', 'node': 'macbook'},
      ],
    );
    // Starts on the engine's own login, so the report below is a real CHANGE. A daemon that
    // re-sends the value it already held is not a new answer, and the guess then waits out its
    // own timer rather than being contradicted.
    final report = await openLive(tester, currentModel: null);

    await tester.tap(find.text('gemma-4-31B-it'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(GridModelPicker));
    await tester.pumpAndSettle();
    expect(ticked(tester, 'gemma-4-31B-it'), isTrue);

    // The machine says the agent ended up somewhere else. What it says beats what this menu hoped.
    report('Qwen-Test');
    await tester.pumpAndSettle();
    expect(ticked(tester, 'Qwen-Test'), isTrue);
    expect(ticked(tester, 'gemma-4-31B-it'), isFalse);
  });

  testWidgets(
    'choosing the own login is confirmed BY a null, not broken by one',
    (tester) async {
      build(
        models: [
          {'id': 'gemma-4-31B-it', 'node': '3d-artist-diego'},
        ],
      );
      final report = await openLive(tester, currentModel: 'gemma-4-31B-it');

      await tester.tap(find.text('Anthropic').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byType(GridModelPicker));
      await tester.pumpAndSettle();
      expect(ticked(tester, 'Anthropic'), isTrue);

      report(null);
      await tester.pumpAndSettle();
      expect(ticked(tester, 'Anthropic'), isTrue);
      expect(ticked(tester, 'gemma-4-31B-it'), isFalse);

      // And the guess is RELEASED by that confirmation, not merely agreed with: the next thing the
      // machine says has to land. A guess that only ever expired on its clock would hold the tick on
      // Subscription for another half minute after the agent had moved on.
      report('gemma-4-31B-it');
      await tester.pumpAndSettle();
      expect(ticked(tester, 'gemma-4-31B-it'), isTrue);
      expect(ticked(tester, 'Anthropic'), isFalse);
    },
  );

  // ── the subscription row agrees with the window's Models menu ─────────────────────────────────
  //
  // The picker used to own its own usage reader, read at a different moment from the menu's, and
  // said "Not signed in" beside a menu showing the same Anthropic account with 8% left.

  testWidgets('reads the app\'s shared usage controller and leaves it alive', (
    tester,
  ) async {
    build(
      models: [
        {'id': 'Qwen-Test', 'node': 'macbook'},
      ],
    );
    final shared = notifier.modelsMenu;
    await open(tester);
    await tester.pumpWidget(const SizedBox());

    expect(notifier.modelsMenu, same(shared));
    // A controller the picker had disposed would throw here.
    expect(() => shared.addListener(() {}), returnsNormally);
  });

  group('which subscription row the picker shows', () {
    Map<String, Object?> row(String account, {double? percent}) => {
      'title': 'Anthropic',
      'engine': 'claude',
      'account': account,
      'status': percent == null ? 'Not signed in' : '$percent% remaining',
      'remainingPercent': percent,
    };

    test('prefers a live account over this Mac signed out', () {
      final rows = [row(''), row('ed8a75', percent: 8)];
      expect(subscriptionRowFor('claude', rows)?['account'], 'ed8a75');
    });

    test('falls back to the first row when none has a figure', () {
      final rows = [row(''), row('ed8a75')];
      expect(subscriptionRowFor('claude', rows)?['account'], '');
    });

    test('keeps the first live row when several have figures', () {
      final rows = [row('aaaaaa', percent: 50), row('bbbbbb', percent: 8)];
      expect(subscriptionRowFor('Claude ', rows)?['account'], 'aaaaaa');
    });

    test('says nothing for another engine or no engine', () {
      final rows = [row('ed8a75', percent: 8)];
      expect(subscriptionRowFor('codex', rows), isNull);
      expect(subscriptionRowFor(null, rows), isNull);
    });
  });
}

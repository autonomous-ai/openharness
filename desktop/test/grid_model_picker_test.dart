// The pane header's model picker: two sections, the way back always offered, and a tick that says
// where the agent actually is.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:harness/widgets/box_chrome.dart';
import 'package:harness/widgets/transient_menus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/theme/app_theme.dart';
import 'package:harness/widgets/grid_model_picker.dart';
import 'package:harness/widgets/model_picker_chrome.dart';
import 'package:harness/widgets/pane_menu.dart';
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
    await tester.tap(find.text('Model'));
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
    expect(find.text('Subscription'), findsOneWidget);
    expect(find.text('Local models on your machines'), findsOneWidget);
    expect(find.text('API'), findsNothing);

    // A picker that can only move an agent ONTO a grid is a one-way door, so the engine's own login
    // is always the first row. It is named the way the window's own Models menu names it — by
    // PROVIDER ('Anthropic'), not by engine ('Claude') — so the two controls agree about what the
    // thing is called, and it carries that menu's status text beside it.
    expect(find.text('Anthropic'), findsOneWidget);
    expect(find.textContaining('usage'), findsOneWidget);
  });

  testWidgets('compact model menu stays on screen and is keyboard navigable', (
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
    final trigger = Focus.of(tester.element(find.byIcon(Icons.tune)));
    trigger.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('Subscription'), findsOneWidget);
    final bounds = tester.getRect(find.byType(TerminalBox));
    expect(bounds.left, greaterThanOrEqualTo(8));
    expect(bounds.right, lessThanOrEqualTo(372));
    expect(bounds.bottom, lessThanOrEqualTo(292));
    expect(tester.takeException(), isNull);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(ownLogin, 1);
    expect(trigger.hasFocus, isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(manage, 1);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('Subscription'), findsNothing);
    expect(trigger.hasFocus, isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    dismissTransientMenus();
    await tester.pumpAndSettle();
    expect(find.text('Subscription'), findsNothing);
    expect(ownLogin, 1);
    expect(manage, 1);
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
    expect(find.text('No local models on this account yet.'), findsOneWidget);
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
        find.text("Harness Compute isn't installed on this machine."),
        findsOneWidget,
      );
      expect(find.text('No local models on this account yet.'), findsNothing);
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
      expect(find.text('Open Grid'), findsOneWidget);
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
    await tester.tap(find.text('Model'));
    await tester.pumpAndSettle();

    expect(find.text('Qwen3.5-4B'), findsOneWidget);
    expect(find.text('LFM2.5-8B'), findsOneWidget);
    // Still one menu, redrawn — not a second one over the first.
    expect(find.text('Local models on your machines'), findsOneWidget);
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

      expect(find.text('Local models on your machines'), findsOneWidget);
      expect(find.text('Models shared with you'), findsOneWidget);
      expect(find.text('autonomous.ai'), findsOneWidget);
      expect(find.text('Qwen3.5-4B'), findsOneWidget);
      expect(find.text('DeepSeek-V4-Flash'), findsOneWidget);
      // Own first: Local sits above the shared grids.
      expect(
        tester.getTopLeft(find.text('Local models on your machines')).dy <
            tester.getTopLeft(find.text('Models shared with you')).dy,
        isTrue,
      );
      // The general fact is the heading; the specific grid is the name under it, not the same
      // line — "Models shared with you" reads once, "autonomous.ai" reads as which one.
      expect(
        tester.getTopLeft(find.text('Models shared with you')).dy <
            tester.getTopLeft(find.text('autonomous.ai')).dy,
        isTrue,
      );
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
      await tester.tap(find.text('Model'));
      await tester.pumpAndSettle();
      expect(find.text('Subscription'), findsOneWidget);

      await tester.tap(find.text('underneath'));
      await tester.pumpAndSettle();

      expect(
        find.text('Subscription'),
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
    'the current row is marked by a highlight, and nothing else is',
    (tester) async {
      // A tick was tried twice and dropped twice: it costs a column on every row to say what the
      // fill already says. What actually lit two rows at once was FOCUS — the menu focuses its
      // first row as it opens so Enter has a target, and an InkWell paints focus with a fill.
      // Focus paints nothing now, so the fill means exactly one thing.
      build(
        models: [
          {'id': 'Qwen3.6-35B-A3B-UD-Q5_K_XL', 'node': 'macbook-m1max'},
        ],
      );
      await open(tester, currentModel: 'Qwen3.6-35B-A3B-UD-Q5_K_XL');

      expect(find.byIcon(Icons.check), findsNothing);

      Container rowFor(String text) => tester.widget<Container>(
        find
            .ancestor(of: find.text(text), matching: find.byType(Container))
            .first,
      );
      // The selected row is filled; the other is not.
      expect(
        (rowFor('Qwen3.6-35B-A3B-UD-Q5_K_XL').decoration as BoxDecoration?)
            ?.color,
        isNotNull,
      );
      expect(rowFor('Anthropic').decoration, isNull);
    },
  );

  testWidgets(
    'choosing the engine login only fires when the agent is NOT already on it',
    (tester) async {
      var calls = 0;
      // Already on its own login: re-selecting it would respawn the pane for nothing.
      await open(tester, currentModel: null, onOwnLogin: () => calls++);
      await tester.tap(find.text('Anthropic'));
      await tester.pumpAndSettle();
      expect(calls, 0);

      // On a grid model: now it has somewhere to go.
      await open(tester, currentModel: 'Qwen-Test', onOwnLogin: () => calls++);
      await tester.tap(find.text('Anthropic'));
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

  group('the invitation that closes the Local section', () {
    const served = [
      {'id': 'Qwen-Test', 'node': 'macbook-m1max'},
    ];

    testWidgets('a captioned rule, then the button, under the models', (
      tester,
    ) async {
      build(models: served);
      await open(tester);
      final caption = tester.getTopLeft(
        find.text('Manage the models on your machines'),
      );
      final button = tester.getTopLeft(find.text('Open Grid'));
      final model = tester.getBottomLeft(find.text('Qwen-Test'));

      // Under the list, not among it: the models are places this agent can go and this starts
      // something, so the rule is what says a different question begins here.
      expect(caption.dy, greaterThan(model.dy));
      expect(button.dy, greaterThan(caption.dy));
      // And the rule is a rule — a line either side of the caption, not just a label.
      expect(
        find.descendant(of: find.byType(Row), matching: find.byType(Container)),
        findsWidgets,
      );
    });

    testWidgets('has room to breathe, above and below the caption', (
      tester,
    ) async {
      // The gaps are the point as much as the parts: a rule tight against the last model reads as a
      // separator between two rows rather than the end of a list, and a button pressed against its
      // own caption reads as one block of chrome. Both were tried.
      build(models: served);
      await open(tester);
      final model = tester.getBottomLeft(find.text('Qwen-Test'));
      final caption = tester.getTopLeft(
        find.text('Manage the models on your machines'),
      );
      final captionBottom = tester.getBottomLeft(
        find.text('Manage the models on your machines'),
      );
      final button = tester.getTopLeft(find.text('Open Grid'));
      expect(caption.dy - model.dy, greaterThan(8));
      expect(button.dy - captionBottom.dy, greaterThan(8));
    });

    testWidgets('spans the menu, so it reads as the section action', (
      tester,
    ) async {
      build(models: served);
      await open(tester);
      final surface = tester.getSize(find.byType(Material).last).width;
      final box = tester.getSize(
        find
            .ancestor(
              of: find.text('Open Grid'),
              matching: find.byType(Container),
            )
            .first,
      );
      // Full width less its own inset — a button the width of its label would read as a row.
      expect(box.width, greaterThan(surface - 40));
    });

    testWidgets(
      'is there when nothing is served, and when there is no grid at all',
      (tester) async {
        // A person with no Local models is exactly who needs it, so it does not wait for a list.
        await open(tester);
        expect(find.text('Open Grid'), findsOneWidget);
        // Never the plumbing's name, in this block as in the rest of the menu.
        expect(find.textContaining('grid'), findsNothing);
      },
    );

    testWidgets(
      'is a button, not a row: it can never wear the current-model fill',
      (tester) async {
        build(models: served);
        await open(tester, currentModel: 'Qwen-Test');
        expect(find.byIcon(Icons.check), findsNothing);
        final model = tester.widget<Container>(
          find
              .ancestor(
                of: find.text('Qwen-Test'),
                matching: find.byType(Container),
              )
              .first,
        );
        expect((model.decoration as BoxDecoration?)?.color, isNotNull);
        // Its own shape — a border, no fill — so the eye does not read it as the selected row.
        final button = tester.widget<Container>(
          find
              .ancestor(
                of: find.text('Open Grid'),
                matching: find.byType(Container),
              )
              .first,
        );
        final decoration = button.decoration as BoxDecoration?;
        expect(decoration?.border, isNotNull);
        expect(decoration?.color, Colors.transparent);
      },
    );

    testWidgets('fires onRunLocalModel and nothing else', (tester) async {
      build(models: served);
      var runs = 0;
      var logins = 0;
      GridModel? picked;
      await open(
        tester,
        currentModel: 'Qwen-Test',
        onRunLocalModel: () => runs++,
        onOwnLogin: () => logins++,
        onSelected: (m) => picked = m,
      );
      await tester.tap(find.text('Open Grid'));
      await tester.pumpAndSettle();
      expect(runs, 1);
      // Not a move: the agent stays where it was. `currentModel` is set so a stray own-login call
      // would have fired — the case where it is silent for its own reason is not the one tested.
      expect(logins, 0);
      expect(picked, isNull);
      // The menu closed on the press, as it does on any choice.
      expect(find.text('Open Grid'), findsNothing);
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
        tester.widget<Tooltip>(find.byType(Tooltip)).message,
        'Where this agent runs',
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
        final current = tester.getTopLeft(find.text('Qwen-Test'));
        final other = tester.getTopLeft(find.text('Other-Model'));
        expect(subtitle.dy, greaterThan(current.dy));
        expect(subtitle.dy, lessThan(other.dy));
        expect(
          tester.widget<Tooltip>(find.byType(Tooltip)).message,
          'Where this agent runs\nWeb search unavailable',
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
        tester.widget<Tooltip>(find.byType(Tooltip)).message,
        'Where this agent runs\nWeb search not supported by this engine',
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

  // ── two rows highlighted at once ──────────────────────────────────────────────────────────────
  //
  // The subscription row and a model row appeared equally chosen. Neither was wrong about itself:
  // one was SELECTED and the other was merely under the pointer, and both were painted the same
  // fill, so the menu said "you are here" twice.

  testWidgets('hover is its own colour, weaker than the selected fill', (tester) async {
    build(models: [{'id': 'Qwen-Test', 'node': 'macbook'}]);
    await open(tester, currentModel: 'Qwen-Test');

    // The ROW items specifically — the menu also holds a button, which is its own shape and has no
    // business wearing a row's hover.
    final wells = tester
        .widgetList<InkWell>(
          find.ancestor(of: find.byType(PaneMenuRow), matching: find.byType(InkWell)),
        )
        .toList();
    expect(wells, isNotEmpty);
    for (final well in wells) {
      // Stated, not inherited: the Material default sat close enough to the selected fill to be
      // indistinguishable, which is the whole of the reported bug.
      expect(well.hoverColor, AppColors.rowHover);
      // An ink ripple is a THIRD fill on the same rectangle and it lingers past the tap.
      expect(well.splashColor, Colors.transparent);
      expect(well.highlightColor, Colors.transparent);
      // The one that lit the top row before the pointer had moved: the menu focuses its first row
      // on open, and an InkWell paints focus with a fill unless told otherwise.
      expect(well.focusColor, Colors.transparent);
    }
    expect(AppColors.rowHover, isNot(AppColors.selected));
    expect(AppColors.rowHover.a, lessThan(AppColors.selected.a));
  });

  testWidgets('exactly one row wears the selected fill', (tester) async {
    build(models: [
      {'id': 'Qwen-Test', 'node': 'macbook'},
      {'id': 'DeepSeek-Test', 'node': 'zeus'},
    ]);
    await open(tester, currentModel: 'Qwen-Test');

    BoxDecoration? fillOf(String text) => tester
        .widget<Container>(find.ancestor(of: find.text(text), matching: find.byType(Container)).first)
        .decoration as BoxDecoration?;
    expect(fillOf('Qwen-Test')?.color, AppColors.selected);
    expect(fillOf('DeepSeek-Test')?.color, isNull);
    expect(fillOf('Anthropic')?.color, isNull);
    expect(find.byIcon(Icons.check), findsNothing);
  });

  testWidgets('the subscription row is the selected one when no model is set', (tester) async {
    build(models: [{'id': 'Qwen-Test', 'node': 'macbook'}]);
    await open(tester);

    BoxDecoration? fillOf(String text) => tester
        .widget<Container>(find.ancestor(of: find.text(text), matching: find.byType(Container)).first)
        .decoration as BoxDecoration?;
    expect(fillOf('Anthropic')?.color, AppColors.selected);
    expect(fillOf('Qwen-Test')?.color, isNull);
    expect(find.byIcon(Icons.check), findsNothing);
  });

  // ── the metadata columns ──────────────────────────────────────────────────────────────────────
  //
  // Every trailing field was a `Flexible`, whose flex is ONE — so the row's spare width was split
  // evenly between the title and each field beside it. A subscription row with two fields put them
  // a third and two thirds across; a model row with one put it halfway. Three columns, three
  // offsets, one menu.

  testWidgets('trailing metadata shares one right edge, whatever the row', (tester) async {
    build(models: [
      {'id': 'Qwen-Test', 'node': 'a'},
      {'id': 'DeepSeek-V4-Flash-0731-Vision', 'node': 'firmware-engineer-daniel'},
    ]);
    await open(tester, currentModel: 'Qwen-Test');

    final short = tester.getRect(find.text('a')).right;
    final long = tester.getRect(find.text('firmware-engineer-daniel')).right;
    // Node names of wildly different lengths, one right edge.
    expect((short - long).abs(), lessThan(0.5));

    // And the subscription row's own trailing field lands on that same edge, though its row is
    // built from different parts.
    final subscription = tester.getRect(find.textContaining('usage')).right;
    expect((subscription - short).abs(), lessThan(0.5));
  });

  testWidgets('a long machine name ellipsizes rather than crowding out the model id', (tester) async {
    build(models: [
      {'id': 'Qwen-Test', 'node': 'a-machine-name-far-longer-than-any-column-should-ever-be-allowed-to-grow'},
    ]);
    await open(tester, currentModel: 'Qwen-Test');

    final node = tester.getRect(
      find.text('a-machine-name-far-longer-than-any-column-should-ever-be-allowed-to-grow'),
    );
    expect(node.width, lessThanOrEqualTo(kPaneMenuMetaMaxWidth + 0.5));
    // The row is named after its model, so that is the text that keeps its width.
    expect(tester.getRect(find.text('Qwen-Test')).width, greaterThan(0));
    expect(tester.takeException(), isNull);
  });

  // ── the selection has to land before the machine confirms it ──────────────────────────────────
  //
  // Picking a model RESPAWNS the pane, so `agent.gridModel` — what `currentModel` carries — only
  // changes once the daemon has done the work. The menu reopened with the tick still on the row
  // the person had just left, which reads as the click having done nothing.

  testWidgets('a fresh currentModel while the menu is open does not crash the frame', (tester) async {
    // The first attempt at this redrew the overlay from `didUpdateWidget`, which runs mid-build:
    // "setState() or markNeedsBuild() called during build" across the whole window.
    build(models: [
      {'id': 'Qwen-Test', 'node': 'macbook'},
      {'id': 'DeepSeek-Test', 'node': 'zeus'},
    ]);

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
    await tester.tap(find.text('Model'));
    await tester.pumpAndSettle();
    expect(find.text('Qwen-Test'), findsOneWidget);

    // The daemon's frame lands while the menu is still open.
    await tester.pumpWidget(app('Qwen-Test'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

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
    await tester.tap(find.text('Model'));
    await tester.pumpAndSettle();
    return (String? next) => setHost(() => current = next);
  }

  bool ticked(WidgetTester tester, String title) => tester
      .widgetList<ModelPickerRow>(find.byType(ModelPickerRow))
      .any((r) => r.title == title && r.selected);

  testWidgets('the tick stays on the picked model through the respawn', (tester) async {
    // A retarget restarts the pane, and a restarting pane reports NO model for a moment. Taking
    // that null as the answer put the tick back on Subscription mid-move, and the row the person
    // clicked only claimed it once the respawn finished — the flicker between two answers.
    build(models: [
      {'id': 'gemma-4-31B-it', 'node': '3d-artist-diego'},
    ]);
    final report = await openLive(tester, currentModel: 'Qwen-Old');

    await tester.tap(find.text('gemma-4-31B-it'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Model'));
    await tester.pumpAndSettle();
    expect(ticked(tester, 'gemma-4-31B-it'), isTrue);

    // The pane goes down: no model at all.
    report(null);
    await tester.pumpAndSettle();
    expect(ticked(tester, 'gemma-4-31B-it'), isTrue, reason: 'a restarting pane is not an answer');
    expect(ticked(tester, 'Anthropic'), isFalse);

    // And comes back up on what was asked for.
    report('gemma-4-31B-it');
    await tester.pumpAndSettle();
    expect(ticked(tester, 'gemma-4-31B-it'), isTrue);
  });

  testWidgets('a model the menu did not ask for wins over the guess', (tester) async {
    build(models: [
      {'id': 'gemma-4-31B-it', 'node': '3d-artist-diego'},
      {'id': 'Qwen-Test', 'node': 'macbook'},
    ]);
    // Starts on the engine's own login, so the report below is a real CHANGE. A daemon that
    // re-sends the value it already held is not a new answer, and the guess then waits out its
    // own timer rather than being contradicted.
    final report = await openLive(tester, currentModel: null);

    await tester.tap(find.text('gemma-4-31B-it'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Model'));
    await tester.pumpAndSettle();
    expect(ticked(tester, 'gemma-4-31B-it'), isTrue);

    // The machine says the agent ended up somewhere else. What it says beats what this menu hoped.
    report('Qwen-Test');
    await tester.pumpAndSettle();
    expect(ticked(tester, 'Qwen-Test'), isTrue);
    expect(ticked(tester, 'gemma-4-31B-it'), isFalse);
  });

  testWidgets('choosing the own login is confirmed BY a null, not broken by one', (tester) async {
    build(models: [
      {'id': 'gemma-4-31B-it', 'node': '3d-artist-diego'},
    ]);
    final report = await openLive(tester, currentModel: 'gemma-4-31B-it');

    await tester.tap(find.text('Anthropic'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Model'));
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
  });
}

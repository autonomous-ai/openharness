// The Harness Store: the shelf is this computer's catalog as cards, a page is
// one harness with local Get/Open/Remove, and ratings and reviews come
// from the store API. Pinned: viewers have a quiet dependency view, Get and
// Remove reach the notifier for the right machine, Remove asks first, and a
// posted review goes to the API with what was typed.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/store/store_controller.dart';
import 'package:harness/store/store_models.dart';
import 'package:harness/store/store_screen.dart';

const _marp = DshEntry(
  id: 'autonomous/marp',
  name: 'Marp',
  engine: 'claude',
  category: 'Slides',
  author: 'Yuki Hattori',
  description: 'Describe a talk; get a keynote.',
  installed: true,
  viewer: true,
  tier: 2,
  repo: 'https://github.com/autonomous-ai/autonomous-marp',
  homepage: 'https://marp.app',
  license: 'MIT',
);
const _typst = DshEntry(
  id: 'autonomous/typst',
  name: 'Typst',
  engine: 'claude',
  viewer: true,
  viewerUse: 'autonomous/doc-viewer',
  category: 'Documents',
  author: 'Typst GmbH',
  description: 'Describe a document; watch the PDF take shape.',
  tier: 2,
);
const _docViewer = DshEntry(
  id: 'autonomous/doc-viewer',
  name: 'Doc Viewer',
  engine: '',
  kind: 'viewer',
  installed: true,
  category: 'Documents',
  author: 'Autonomous',
  tier: 2,
);

class _Notifier extends AppNotifier {
  _Notifier()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  final installs = <(String, String)>[];
  final removals = <(String, String)>[];
  int probes = 0;
  int engineProbes = 0;
  final probedMachines = <String>[];

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {
    engineProbes++;
    probedMachines.add(machineId);
  }

  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {
    probes++;
    probedMachines.add(machineId);
  }

  @override
  Future<String?> installDsh(String machineId, String id) async {
    installs.add((machineId, id));
    return null;
  }

  @override
  Future<String?> removeDsh(String machineId, String id) async {
    removals.add((machineId, id));
    return null;
  }
}

class _FakeStore implements StoreApi {
  final puts = <(String, int, String?, String?)>[];
  final deletes = <String>[];
  int ratingReads = 0;

  @override
  Future<List<StoreRating>> ratings() async {
    ratingReads++;
    return const [
      StoreRating(
        harnessId: 'autonomous/marp',
        average: 4.5,
        count: 2,
        histogram: [0, 0, 0, 1, 1],
      ),
    ];
  }

  @override
  Future<StoreReviews> reviews(String harnessId) async {
    if (harnessId != 'autonomous/marp') {
      return StoreReviews(
        rating: StoreRating.none(harnessId),
        reviews: const [],
        mine: null,
      );
    }
    return StoreReviews(
      rating: const StoreRating(
        harnessId: 'autonomous/marp',
        average: 4.5,
        count: 2,
        histogram: [0, 0, 0, 1, 1],
      ),
      reviews: [
        StoreReview(
          id: 'r1',
          harnessId: 'autonomous/marp',
          rating: 5,
          title: 'Keynote in a minute',
          body: 'The pane is the deck.',
          authorName: 'Ann Lee',
          mine: false,
          updatedAt: DateTime.now(),
        ),
      ],
      mine: null,
    );
  }

  @override
  Future<StoreReview> putReview(
    String harnessId, {
    required int rating,
    String? title,
    String? body,
  }) async {
    puts.add((harnessId, rating, title, body));
    return StoreReview(
      id: 'mine',
      harnessId: harnessId,
      rating: rating,
      title: title,
      body: body,
      authorName: 'You',
      mine: true,
      updatedAt: DateTime.now(),
    );
  }

  @override
  Future<void> deleteReview(String harnessId) async => deletes.add(harnessId);
}

const _machine = Machine(
  machineId: 'machine-1',
  authMode: MachineAuthMode.remote,
  name: 'studio-mac',
);

Future<(_Notifier, _FakeStore)> open(
  WidgetTester tester, {
  String? initialHarness,
}) async {
  final notifier = _Notifier();
  addTearDown(notifier.dispose);
  final state = MachineState(_machine)..localOnly = true;
  state.dsh.replace(const [_marp, _typst, _docViewer]);
  state.engines.replace(const [
    EngineAvailability(engine: 'claude', installed: true),
    EngineAvailability(
      engine: 'codex',
      installed: false,
      installable: true,
      installCommand: 'npm install -g @openai/codex',
    ),
  ]);
  notifier.machineStates['machine-1'] = state;
  final store = _FakeStore();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: StoreTab(
          notifier: notifier,
          api: store,
          source: 'test',
          initialHarness: initialHarness,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (notifier, store);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'the bottom sidebar icon shows viewers and their dependent agents',
    (tester) async {
      await open(tester);
      final button = find.byKey(const ValueKey('store-viewers-button'));
      expect(button, findsOneWidget);
      expect(
        tester.getBottomLeft(button).dy,
        greaterThan(
          tester.view.physicalSize.height / tester.view.devicePixelRatio - 50,
        ),
      );
      await tester.tap(button);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('store-viewers')), findsOneWidget);
      expect(find.text('Doc Viewer'), findsOneWidget);
      expect(find.text('Installed on studio-mac'), findsOneWidget);
      expect(find.text('Used by'), findsOneWidget);
      final dependent = find.byKey(
        const ValueKey(
          'store-viewer-agent:autonomous/doc-viewer:autonomous/typst',
        ),
      );
      expect(dependent, findsOneWidget);
      expect(
        find.text('Marp'),
        findsNothing,
        reason: 'its own viewer is not a shared Doc Viewer dependency',
      );
      await tester.tap(dependent);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-page:autonomous/typst')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a machine that connects after the store opened is asked for its harnesses then',
    (tester) async {
      final (notifier, _) = await open(tester);
      final state = notifier.machineStates['machine-1']!;
      expect(state.connectionStatus, ConnectionStatus.disconnected);
      expect(
        notifier.probes,
        1,
        reason: 'asked once on open, before it connected',
      );

      // The launch race: the store tab was restored first, the machine connects later.
      state.connectionStatus = ConnectionStatus.connected;
      notifier.notifyListeners();
      await tester.pump();
      expect(notifier.probes, 2);
      expect(notifier.engineProbes, 2);

      // Once per connection, not on every change while it stays connected.
      notifier.notifyListeners();
      await tester.pump();
      expect(notifier.probes, 2);

      // A reconnect asks again.
      state.connectionStatus = ConnectionStatus.reconnecting;
      notifier.notifyListeners();
      await tester.pump();
      state.connectionStatus = ConnectionStatus.connected;
      notifier.notifyListeners();
      await tester.pump();
      expect(notifier.probes, 3);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'an open Store refreshes its catalog and stops polling when closed',
    (tester) async {
      final (notifier, _) = await open(tester);
      notifier.machineStates['machine-1']!.connectionStatus =
          ConnectionStatus.connected;
      notifier.notifyListeners();
      await tester.pump();
      final probes = notifier.probes;
      final engines = notifier.engineProbes;
      await tester.pump(const Duration(minutes: 1));
      expect(notifier.probes, probes + 1);
      expect(notifier.engineProbes, engines);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 2));
      expect(notifier.probes, probes + 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'the Store never probes or shows remote machines, including reconnects and refreshes',
    (tester) async {
      final notifier = _Notifier();
      addTearDown(notifier.dispose);
      final local = MachineState(_machine)
        ..localOnly = true
        ..connectionStatus = ConnectionStatus.connected
        ..dsh.replace(const [_marp, _typst]);
      notifier.machineStates['machine-1'] = local;
      final remote = MachineState(
        const Machine(
          machineId: 'machine-2',
          authMode: MachineAuthMode.remote,
          name: 'office-imac',
        ),
      )..connectionStatus = ConnectionStatus.connected;
      notifier.machineStates['machine-2'] = remote;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StoreTab(
              notifier: notifier,
              api: _FakeStore(),
              initialHarness: _typst.id,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-machine:machine-1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('store-machine:machine-2')),
        findsNothing,
      );
      expect(notifier.probedMachines, ['machine-1', 'machine-1']);
      remote.connectionStatus = ConnectionStatus.reconnecting;
      notifier.notifyListeners();
      await tester.pump();
      remote.connectionStatus = ConnectionStatus.connected;
      notifier.notifyListeners();
      await tester.pump();
      await tester.pump(const Duration(minutes: 1));
      expect(notifier.probedMachines, ['machine-1', 'machine-1', 'machine-1']);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'leaving the store tab and coming back keeps the search and the open page',
    (tester) async {
      final (notifier, store) = await open(tester);
      Future<void> mountAgain() async {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: StoreTab(notifier: notifier, api: store, source: 'test'),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      await tester.enterText(find.byKey(const ValueKey('store-search')), 'typ');
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('store-card:autonomous/typst')).first,
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-page:autonomous/typst')),
        findsOneWidget,
      );

      // Another tab is shown: the store tab is not built at all.
      await tester.pumpWidget(const SizedBox());
      await mountAgain();
      expect(
        find.byKey(const ValueKey('store-page:autonomous/typst')),
        findsOneWidget,
      );
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('store-search')))
            .controller!
            .text,
        'typ',
      );
      await tester.tap(find.byKey(const ValueKey('store-back')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-page:autonomous/typst')),
        findsNothing,
      );
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('store-search')))
            .controller!
            .text,
        'typ',
      );
      await tester.tap(find.byKey(const ValueKey('store-back')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const PageStorageKey('store-discover-scroll')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('store-nav-forward')));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('store-search')))
            .controller!
            .text,
        'typ',
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('the catalog keeps real ratings and hides viewer dependencies', (
    tester,
  ) async {
    final (notifier, store) = await open(tester);
    expect(notifier.probes, 1, reason: 'this computer is asked again on open');
    expect(
      notifier.engineProbes,
      1,
      reason: 'and about its engines, for the Coding shelf',
    );
    expect(store.ratingReads, 1);
    await tester.tap(
      find.byKey(const ValueKey('store-shelf-category:Productivity')),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('store-card:autonomous/marp')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('store-card:autonomous/typst')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('store-card:autonomous/doc-viewer')),
      findsNothing,
      reason: 'a viewer is not a tile',
    );
    expect(find.text('4.5 · 2'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('store-card:autonomous/typst')),
        matching: find.text('No ratings yet'),
      ),
      findsNothing,
    );

    expect(find.byKey(const ValueKey('store-nav-manage')), findsNothing);
    expect(find.byKey(const ValueKey('store-shelf-viewers')), findsNothing);

    await tester.enterText(
      find.byKey(const ValueKey('store-search')),
      'Doc Viewer',
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('store-card:autonomous/doc-viewer')),
      findsNothing,
    );
    expect(find.textContaining('No matching harnesses'), findsOneWidget);
  });

  testWidgets(
    'a harness not installed here gets Get, and Get installs on that machine',
    (tester) async {
      final (notifier, _) = await open(tester);
      // The shelf scrolls (the engines sit above the harnesses); settle the
      // scroll before the tap, or the tap lands where the card was.
      final card = find.byKey(const ValueKey('store-card:autonomous/typst'));
      await tester.ensureVisible(card);
      await tester.pumpAndSettle();
      await tester.tap(card);
      await tester.pumpAndSettle();
      expect(
        find.text('Typst GmbH · Documents · Runs on Claude'),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('store-primary-action')),
          matching: find.text('Get'),
        ),
        findsOneWidget,
      );
      expect(find.text('studio-mac · this computer'), findsOneWidget);
      expect(find.text('Not installed'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('store-primary-action')));
      await tester.pumpAndSettle();
      expect(notifier.installs, [('machine-1', 'autonomous/typst')]);
    },
  );

  testWidgets(
    'an installed harness offers Open and Remove; Remove asks, then reaches the daemon',
    (tester) async {
      final (notifier, _) = await open(
        tester,
        initialHarness: 'autonomous/marp',
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('store-primary-action')),
          matching: find.text('New Harness'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('store-machine:machine-1')),
          matching: find.text('Installed'),
        ),
        findsOneWidget,
      );
      expect(find.text('Website'), findsOneWidget);
      expect(find.text('MIT licence'), findsOneWidget);

      await tester.ensureVisible(
        find.byKey(const ValueKey('store-remove:machine-1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('store-remove:machine-1')));
      await tester.pumpAndSettle();
      expect(find.text('Remove Marp from studio-mac?'), findsOneWidget);
      expect(
        notifier.removals,
        isEmpty,
        reason: 'nothing goes before the person says so',
      );
      await tester.tap(find.byKey(const ValueKey('store-confirm')));
      await tester.pumpAndSettle();
      expect(notifier.removals, [('machine-1', 'autonomous/marp')]);
    },
  );

  testWidgets(
    'reviews load with the page, and a posted review carries the stars and words typed',
    (tester) async {
      final (_, store) = await open(tester, initialHarness: 'autonomous/marp');
      expect(find.byKey(const ValueKey('store-review:r1')), findsOneWidget);
      expect(find.text('Keynote in a minute'), findsOneWidget);
      expect(find.text('4.5 · 2 ratings'), findsOneWidget);

      await tester.ensureVisible(
        find.byKey(const ValueKey('store-write-review')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('store-write-review')));
      await tester.pumpAndSettle();
      expect(find.text('Rate Marp'), findsOneWidget);
      final post = find.byKey(const ValueKey('store-review-post'));
      expect(
        tester.widget<FilledButton>(post).onPressed,
        isNull,
        reason: 'no stars, no post',
      );
      // The fourth star.
      final stars = find.descendant(
        of: find.byKey(const ValueKey('store-review-stars')),
        matching: find.byType(Icon),
      );
      await tester.tap(stars.at(3));
      await tester.pump();
      await tester.enterText(
        find.byKey(const ValueKey('store-review-title')),
        'Sharp decks',
      );
      await tester.enterText(
        find.byKey(const ValueKey('store-review-body')),
        'Art takes a while.',
      );
      await tester.tap(post);
      await tester.pumpAndSettle();
      expect(store.puts, [
        ('autonomous/marp', 4, 'Sharp decks', 'Art takes a while.'),
      ]);
    },
  );

  testWidgets(
    'the built-in engines are on the shelf too, under Coding, as the machines probed them',
    (tester) async {
      await open(tester);
      expect(find.byKey(const ValueKey('store-card:claude')), findsOneWidget);
      expect(find.byKey(const ValueKey('store-card:codex')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('store-shelf-category:Coding')),
        findsOneWidget,
        reason: 'categories are always visible',
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('store-card:claude')),
          matching: find.text('New Harness'),
        ),
        findsNothing,
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('store-card:codex')),
          matching: find.text('Get'),
        ),
        findsNothing,
      );

      await tester.ensureVisible(
        find.byKey(const ValueKey('store-card:codex')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('store-card:codex')));
      await tester.pumpAndSettle();
      expect(find.text('OpenAI · Code · Coding agent'), findsOneWidget);
      expect(find.textContaining('npm install'), findsNothing);
      expect(find.text('Not installed'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('store-primary-action')),
          matching: find.text('Get'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('store-remove:machine-1')),
        findsNothing,
        reason: 'a vendor CLI is not ours to uninstall',
      );
      expect(find.text('Website'), findsOneWidget);
    },
  );

  testWidgets(
    'the store takes over the New Tab it was opened from, as a first agent does',
    (tester) async {
      final (notifier, _) = await open(tester);
      // The app starts on one empty New Tab: its start page is where the card is.
      final starter = notifier.activeSwarm;
      expect(starter.isEmptyStarter, isTrue);
      final before = notifier.swarms.length;
      notifier.openStore();
      expect(notifier.swarms.length, before, reason: 'no second tab');
      expect(identical(notifier.activeSwarm, starter), isTrue);
      expect(starter.isStore, isTrue);
      expect(starter.name, 'Harness Store');
      // Again from the store tab: nothing moves.
      notifier.openStore();
      expect(notifier.swarms.length, before);
      // New Tab from here makes a fresh starter, since this one is the store now.
      notifier.newSwarm();
      expect(notifier.activeSwarm.isStore, isFalse);
      expect(notifier.swarms.length, before + 1);
      // The card on that fresh New Tab goes to the store that is already open —
      // one store tab, as one New Tab — rather than making a second.
      notifier.openStore();
      expect(notifier.swarms.where((s) => s.isStore).length, 1);
      expect(identical(notifier.activeSwarm, starter), isTrue);
      expect(notifier.swarms.length, before + 1);
    },
  );
}

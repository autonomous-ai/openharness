// The Store on a phone (audit finding B1): below the web chrome's compactBelow
// its rail becomes a row of chips above full-width content, the row scrolls
// with a mouse wheel and fades where chips are hidden, and every Store control
// keeps a 44 px hit area. Desktop, which has no chrome, keeps its rail at any
// window width, and so does the web at tablet width. In a browser, which runs
// no harness, the Store never says "this computer" (finding P3).
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/store/store_controller.dart';
import 'package:harness/store/store_discover.dart';
import 'package:harness/store/store_models.dart';
import 'package:harness/store/store_screen.dart';
import 'package:harness/web/shell/web_chrome.dart';

final _catalog = [
  for (final (id, name, category) in [
    ('blender', 'Blender', '3D'),
    ('autonomous-circuit', 'Autonomous Circuit', 'PCB'),
    ('phaser', 'Phaser', 'Games'),
    ('strudel', 'Strudel', 'Music'),
    ('mujoco', 'MuJoCo', 'Simulation'),
    ('marp', 'Marp', 'Slides'),
    ('manim', 'Manim', 'Math animation'),
    ('marimo', 'marimo', 'Notebooks'),
    ('ollama', 'Ollama', 'Local AI'),
  ])
    DshEntry(
      id: 'autonomous/$id',
      name: name,
      engine: 'claude',
      category: category,
    ),
];

class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  @override
  Future<void> probeDsh(
    String machineId, {
    bool force = false,
    bool userAction = false,
  }) async {}

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}
}

class _Api implements StoreApi {
  @override
  Future<List<StoreRating>> ratings() async => const [];

  @override
  Future<StoreReviews> reviews(String harnessId) async => StoreReviews(
    rating: StoreRating.none(harnessId),
    reviews: const [],
    mine: null,
  );

  @override
  Future<void> deleteReview(String harnessId) async {}

  @override
  Future<StoreReview> putReview(
    String harnessId, {
    required int rating,
    String? title,
    String? body,
  }) => throw UnimplementedError();
}

/// The Store at [size], inside the web's workspace chrome when [web], else
/// with none, as on Desktop. [local] gives it a computer with the catalogue;
/// a browser has none.
Future<void> _open(
  WidgetTester tester, {
  required Size size,
  required bool web,
  bool local = true,
  String? initialHarness,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final app = _App();
  addTearDown(app.dispose);
  if (local) {
    final machine =
        MachineState(
            const Machine(
              machineId: 'local',
              authMode: MachineAuthMode.remote,
              name: 'Studio',
            ),
          )
          ..localOnly = true
          ..nodeOnline = true;
    machine.dsh.replace(_catalog);
    app.machineStates['local'] = machine;
  }
  final store = StoreTab(
    notifier: app,
    api: _Api(),
    initialHarness: initialHarness,
  );
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: web
            ? WorkspaceChromeScope(
                chrome: webWorkspaceChrome(app),
                child: store,
              )
            : store,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

const _phone = Size(390, 844);
const _smallPhone = Size(360, 740);

/// Narrower than any real Desktop window (its minimum is 880) and than the
/// web's 720 px phone threshold, so a layout keyed on width would go compact.
const _narrowDesktop = Size(700, 560);

final _rail = find.byKey(const ValueKey('store-shelf-discover'));
final _chips = find.byKey(const ValueKey('store-chips'));
Finder _chip(String id) => find.byKey(ValueKey('store-chip:$id'));

ScrollPosition _chipScroll(WidgetTester tester) => tester
    .state<ScrollableState>(
      find.descendant(of: _chips, matching: find.byType(Scrollable)),
    )
    .position;

final _thisComputer = find.textContaining(
  RegExp('this computer', caseSensitive: false),
);

void main() {
  testWidgets('on a phone the Store trades its rail for chips above full-width '
      'content', (tester) async {
    await _open(tester, size: _phone, web: true);

    expect(_rail, findsNothing);
    expect(_chips, findsOneWidget);
    expect(tester.getSize(find.byType(StoreDiscover)).width, _phone.width);
    expect(
      tester.getTopLeft(find.byType(StoreDiscover)).dy,
      greaterThanOrEqualTo(tester.getBottomLeft(_chips).dy),
    );
    for (final id in ['discover', 'all', 'category:Design', 'viewers']) {
      expect(_chip(id), findsOneWidget, reason: id);
    }
    expect(
      tester.getSemantics(_chip('discover')),
      isSemantics(isSelected: true, isButton: true),
    );

    await tester.tap(_chip('all'));
    await tester.pumpAndSettle();

    expect(
      find.text('Find something you have always wanted to make.'),
      findsOneWidget,
    );
    expect(tester.getSemantics(_chip('all')), isSemantics(isSelected: true));
    expect(
      tester.getSemantics(_chip('discover')),
      isSemantics(isSelected: false),
    );
  });

  testWidgets('a product page on a phone selects its discipline chip and '
      'takes the full width', (tester) async {
    await _open(
      tester,
      size: _smallPhone,
      web: true,
      initialHarness: 'autonomous/strudel',
    );

    expect(_rail, findsNothing);
    expect(
      tester.getSemantics(_chip('category:Music')),
      isSemantics(isSelected: true),
    );
    final page = find.byKey(const ValueKey('store-page:autonomous/strudel'));
    expect(tester.getSize(page).width, _smallPhone.width);
  });

  testWidgets('Desktop keeps its rail in a window narrower than the web\'s '
      'phone layout', (tester) async {
    await _open(tester, size: _narrowDesktop, web: false);

    expect(_rail, findsOneWidget);
    expect(_chips, findsNothing);
  });

  testWidgets('the web keeps the rail at tablet width', (tester) async {
    await _open(tester, size: const Size(768, 1024), web: true);

    expect(_rail, findsOneWidget);
    expect(_chips, findsNothing);
  });

  testWidgets('a mouse wheel scrolls the chip row sideways, and its edges '
      'fade only where chips are hidden', (tester) async {
    await _open(tester, size: _smallPhone, web: true);
    final start = find.byKey(const ValueKey('store-chips-fade-start'));
    final end = find.byKey(const ValueKey('store-chips-fade-end'));

    expect(_chipScroll(tester).pixels, 0);
    expect(_chipScroll(tester).maxScrollExtent, greaterThan(0));
    expect(start, findsNothing);
    expect(end, findsOneWidget);

    final mouse = TestPointer(1, PointerDeviceKind.mouse);
    await tester.sendEventToBinding(mouse.hover(tester.getCenter(_chips)));
    await tester.sendEventToBinding(mouse.scroll(const Offset(0, 120)));
    await tester.pumpAndSettle();

    expect(_chipScroll(tester).pixels, 120);
    expect(start, findsOneWidget);

    await tester.sendEventToBinding(mouse.scroll(const Offset(0, 5000)));
    await tester.pumpAndSettle();

    expect(_chipScroll(tester).pixels, _chipScroll(tester).maxScrollExtent);
    expect(end, findsNothing);
  });

  testWidgets('on a phone every chip and toolbar button has a 44 px hit area', (
    tester,
  ) async {
    await _open(tester, size: _phone, web: true);

    for (final target in [
      _chip('discover'),
      _chip('all'),
      find.byKey(const ValueKey('store-back-hit')),
      find.byKey(const ValueKey('store-forward-hit')),
      find.byKey(const ValueKey('store-create-hit')),
    ]) {
      final rect = tester.getSemantics(target).rect;
      expect(rect.width, greaterThanOrEqualTo(44), reason: '$target');
      expect(rect.height, greaterThanOrEqualTo(44), reason: '$target');
    }
  });

  testWidgets('the outer edge of a phone Back hit area goes back', (
    tester,
  ) async {
    await _open(tester, size: _phone, web: true);
    await tester.tap(_chip('all'));
    await tester.pumpAndSettle();

    await tester.tapAt(
      tester.getTopLeft(find.byKey(const ValueKey('store-back-hit'))) +
          const Offset(2, 2),
    );
    await tester.pumpAndSettle();

    expect(
      tester.getSemantics(_chip('discover')),
      isSemantics(isSelected: true),
    );
  });

  testWidgets('Desktop keeps its toolbar buttons as they are', (tester) async {
    await _open(tester, size: _narrowDesktop, web: false);

    expect(find.byKey(const ValueKey('store-back-hit')), findsNothing);
    expect(tester.getSize(find.byKey(const ValueKey('store-back'))).height, 30);
  });

  testWidgets('in a browser the Viewers shelf does not name this computer', (
    tester,
  ) async {
    await _open(tester, size: const Size(1440, 900), web: true, local: false);
    await tester.tap(find.byKey(const ValueKey('store-viewers-button')));
    await tester.pumpAndSettle();

    expect(_thisComputer, findsNothing);
    expect(
      find.text('Viewers appear here in the Harness app on a computer.'),
      findsOneWidget,
    );
  });

  testWidgets('in a browser a product page says where to get it, not that it '
      'is connecting to this computer', (tester) async {
    await _open(
      tester,
      size: const Size(1440, 900),
      web: true,
      local: false,
      initialHarness: 'claude',
    );

    expect(_thisComputer, findsNothing);
    expect(
      find.text('Get it in the Harness app on a computer.'),
      findsOneWidget,
    );
  });

  testWidgets('Desktop still says it is connecting to this computer', (
    tester,
  ) async {
    await _open(
      tester,
      size: const Size(1440, 900),
      web: false,
      local: false,
      initialHarness: 'claude',
    );

    expect(find.text('Connecting to this computer…'), findsOneWidget);
  });
}

import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/agent_picker.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/store/store_controller.dart';
import 'package:harness/store/store_editorial.dart';
import 'package:harness/store/store_exploration.dart';
import 'package:harness/store/store_models.dart';
import 'package:harness/store/store_screen.dart';

import 'support/real_fonts.dart';

final _catalog = [
  for (final (id, name, category) in [
    ('blender', 'Blender', '3D'),
    ('copper', 'Copper', 'PCB'),
    ('text-to-cad', 'text-to-cad', 'CAD'),
    ('phaser', 'Phaser', 'Games'),
    ('strudel', 'Strudel', 'Music'),
    ('mujoco', 'MuJoCo', 'Simulation'),
    ('marp', 'Marp', 'Slides'),
    ('manim', 'Manim', 'Math animation'),
    ('excalidraw', 'Excalidraw', 'Diagrams'),
    ('marimo', 'marimo', 'Notebooks'),
    ('typst', 'Typst', 'Documents'),
    ('remotion', 'Remotion', 'Video'),
    ('circuitjs', 'CircuitJS', 'Circuits'),
    ('rdkit', 'RDKit', 'Chemistry'),
    ('yosys', 'Yosys', 'Chips'),
    ('ollama', 'Ollama', 'Local AI'),
  ])
    DshEntry(
      id: 'autonomous/$id',
      name: name,
      engine: 'claude',
      category: category,
      installed: ['blender', 'copper', 'marp'].contains(id),
      viewerUse: switch (id) {
        'blender' => 'autonomous/model-viewer',
        'text-to-cad' => 'autonomous/cad-viewer',
        'typst' => 'autonomous/doc-viewer',
        _ => null,
      },
    ),
  for (final (id, name) in [
    ('cad-viewer', 'CAD Viewer'),
    ('doc-viewer', 'Doc Viewer'),
    ('model-viewer', '3D Viewer'),
    ('web-viewer', 'Web Viewer'),
  ])
    DshEntry(
      id: 'autonomous/$id',
      name: name,
      engine: '',
      kind: 'viewer',
      installed: true,
    ),
];

List<DshEntry> _listedCatalog() => [
  for (final directory in Directory(
    '../store/agents',
  ).listSync().whereType<Directory>())
    if ((jsonDecode(File('${directory.path}/store.json').readAsStringSync())
            as Map)['listed'] !=
        false)
      DshEntry.fromJson(
        jsonDecode(File('${directory.path}/harness.json').readAsStringSync()),
      )!,
];

class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {}
  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}
}

class _Api implements StoreApi {
  _Api({this.unavailable = false});
  final bool unavailable;
  @override
  Future<List<StoreRating>> ratings() async {
    if (unavailable) throw StateError('service unavailable');
    return [];
  }

  @override
  Future<StoreReviews> reviews(String harnessId) async {
    if (unavailable) throw StateError('service unavailable');
    return StoreReviews(
      rating: StoreRating.none(harnessId),
      reviews: [],
      mine: null,
    );
  }

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

Future<(_App, GlobalKey)> _open(
  WidgetTester tester, {
  List<DshEntry>? entries,
  String? initialHarness,
  bool unavailable = false,
  double width = 1440,
  double height = 1000,
  double scale = 1,
  Brightness brightness = Brightness.dark,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, height);
  addTearDown(tester.view.reset);
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  final app = _App();
  addTearDown(app.dispose);
  final local =
      MachineState(
          const Machine(
            machineId: 'local',
            authMode: MachineAuthMode.remote,
            name: 'Studio',
          ),
        )
        ..localOnly = true
        ..nodeOnline = true;
  local.dsh.replace(entries ?? _catalog);
  local.engines.replace(const [
    EngineAvailability(engine: 'codex', installed: true),
    EngineAvailability(engine: 'claude', installed: true),
  ]);
  app.machineStates['local'] = local;
  app.openStore();
  final key = GlobalKey();
  await tester.pumpWidget(
    RepaintBoundary(
      key: key,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: Scaffold(
          body: StoreTab(
            notifier: app,
            api: _Api(unavailable: unavailable),
            initialHarness: initialHarness,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.runAsync(() async {
    final context = tester.element(find.byType(StoreTab));
    for (final asset in {
      for (final identity in [
        ...allEngines,
        for (final entry in entries ?? _catalog) engineIdentity(entry.id),
      ])
        ?identity.asset,
    }) {
      await precacheImage(AssetImage(asset), context);
    }
    for (final asset in {
      ...storeProjectAssets.values,
      'assets/store/blender-studio.png',
    }) {
      await precacheImage(AssetImage(asset), context);
    }
  });
  await tester.pumpAndSettle();
  return (app, key);
}

Future<void> _capture(WidgetTester tester, GlobalKey key, String name) async {
  final output = Platform.environment['HARNESS_STORE_CAPTURE_DIR'];
  if (output == null) return;
  // Categories can decode new artwork after the initial Store frame. Wait for
  // those image providers as well before capturing, outside the fake test clock.
  final context = key.currentContext!;
  final images = tester
      .widgetList<Image>(find.byType(Image))
      .map((image) => image.image)
      .toSet();
  await tester.runAsync(() async {
    for (final provider in images) {
      await precacheImage(provider, context, onError: (_, _) {});
    }
  });
  await tester.pumpAndSettle();
  await tester.runAsync(() async {
    final image =
        await (key.currentContext!.findRenderObject()! as RenderRepaintBoundary)
            .toImage(pixelRatio: 1);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(output).create(recursive: true);
    await File('$output/$name.png').writeAsBytes(data!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  test(
    'every listed harness has a browsing category and a discovery collection',
    () {
      final entries = _listedCatalog();
      expect(entries, isNotEmpty);
      for (final entry in entries) {
        expect(
          storeCategoryFor(entry),
          isNot('Other'),
          reason: '${entry.id}: ${entry.category}',
        );
        expect(
          storeCollections.where((collection) => collection.includes(entry)),
          isNotEmpty,
          reason: '${entry.id} must be discoverable beyond search',
        );
      }
      expect(
        storeCategoryFor(
          const DshEntry(
            id: 'community/new-craft',
            name: 'New craft',
            engine: 'claude',
            category: 'Uncharted',
          ),
        ),
        'Other',
      );
    },
  );

  test('Local AI groups Grid and current and future local runtimes', () {
    for (final (id, domain) in [
      ('autonomous/autonomous-grid', 'Compute'),
      ('local/ollama', 'Compute'),
      ('local/mlx-lm', 'Local AI'),
      ('local/vllm', 'Local AI'),
      ('community/next-runtime', 'local ai'),
    ]) {
      expect(
        storeCategoryFor(
          DshEntry(id: id, name: id, engine: 'codex', category: domain),
        ),
        'Local AI',
      );
    }
    expect(
      storeCategoryFor(
        const DshEntry(
          id: 'codex',
          name: 'Codex',
          engine: 'codex',
          kind: 'engine',
          category: 'Code',
        ),
      ),
      'Coding',
    );
  });

  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide300')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
          ),
        ))
        .load();
  });

  testWidgets(
    'search is ready on arrival and stays at the top while browsing',
    (tester) async {
      final (_, key) = await _open(tester);
      final search = find.byKey(const ValueKey('store-search'));
      final field = tester.widget<TextField>(search);
      expect(field.focusNode!.hasFocus, isTrue);
      final initialRect = tester.getRect(search);
      expect(initialRect.width, greaterThan(1000));
      await tester.drag(
        find.byKey(const PageStorageKey('store-discover-scroll')),
        const Offset(0, -700),
      );
      await tester.pumpAndSettle();
      expect(tester.getRect(search), initialRect);
      await _capture(tester, key, 'discover-exploration');

      await tester.tap(
        find.byKey(const ValueKey('store-shelf-category:Engineering')),
      );
      await tester.pumpAndSettle();
      expect(tester.getRect(search), initialRect);
      await tester.drag(
        find.byKey(const ValueKey('store-catalog:Engineering')),
        const Offset(0, -550),
      );
      await tester.pumpAndSettle();
      expect(tester.getRect(search), initialRect);
      await tester.enterText(search, 'mounting holes');
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-card:autonomous/text-to-cad')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('store-card:autonomous/copper')),
        findsNothing,
      );
      expect(tester.getRect(search), initialRect);
      await tester.tap(find.byTooltip('Clear search'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-curiosity-hero')),
        findsOneWidget,
      );
      expect(tester.widget<TextField>(search).focusNode!.hasFocus, isTrue);
      expect(tester.takeException(), isNull);
    },
  );

  test('search finds ideas in published examples as well as names', () {
    const entry = DshEntry(
      id: 'community/plotter',
      name: 'Plotter',
      engine: 'codex',
      tagline: 'Turn observations into pictures.',
      examples: [
        StoreExample(prompt: 'Visualize rainfall over the last decade.'),
      ],
    );
    expect(storeMatches(entry, 'rainfall decade'), isTrue);
    expect(storeMatches(entry, 'observations'), isTrue);
    expect(storeMatches(entry, 'rainfall circuit'), isFalse);
  });

  for (final (width, height, scale, brightness) in [
    (1440.0, 1080.0, 1.0, Brightness.dark),
    (1440.0, 1080.0, 1.0, Brightness.light),
    (1000.0, 850.0, 1.0, Brightness.dark),
    (760.0, 900.0, 1.5, Brightness.dark),
  ]) {
    testWidgets('Discover fits $width with scale $scale in ${brightness.name}', (
      tester,
    ) async {
      final (_, key) = await _open(
        tester,
        width: width,
        height: height,
        scale: scale,
        brightness: brightness,
      );
      expect(
        find.byKey(const ValueKey('store-feature:autonomous/blender')),
        findsOneWidget,
      );
      expect(find.text('No ratings yet'), findsNothing);
      expect(
        find.byKey(const ValueKey('store-shelf-category:3D')),
        findsNothing,
      );
      expect(find.byKey(const ValueKey('store-nav-categories')), findsNothing);
      expect(find.byKey(const ValueKey('store-shelf-all')), findsNothing);
      expect(find.byKey(const ValueKey('store-shelf-installed')), findsNothing);
      expect(find.text('Harness Store'), findsNothing);
      expect(
        tester.getTopLeft(find.byKey(const ValueKey('store-card:codex'))).dy,
        lessThan(
          tester
              .getTopLeft(find.byKey(const ValueKey('store-collection:shape')))
              .dy,
        ),
        reason: 'Coding is the starting point before the other disciplines',
      );
      expect(
        tester
            .getTopLeft(
              find.byKey(const ValueKey('store-shelf-category:Coding')),
            )
            .dy,
        lessThan(
          tester
              .getTopLeft(
                find.byKey(const ValueKey('store-shelf-category:Design')),
              )
              .dy,
        ),
      );
      for (final category in [
        'Design',
        'Engineering',
        'Media',
        'Music',
        'Productivity',
        'Science & Data',
        'Simulation',
        'Games',
        'Local AI',
        'Coding',
      ]) {
        expect(
          find.byKey(ValueKey('store-shelf-category:$category')),
          findsOneWidget,
        );
      }
      expect(tester.takeException(), isNull);
      await _capture(
        tester,
        key,
        'discover-${width.toInt()}-${brightness.name}-${scale.toStringAsFixed(1)}',
      );
      await tester.tap(
        find.byKey(const ValueKey('store-shelf-category:Engineering')),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('store-category-hero')), findsOneWidget);
      expect(tester.takeException(), isNull);
      await _capture(
        tester,
        key,
        'engineering-${width.toInt()}-${brightness.name}-${scale.toStringAsFixed(1)}',
      );
      await tester.tap(find.byKey(const ValueKey('store-viewers-button')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('store-viewers')), findsOneWidget);
      expect(tester.takeException(), isNull);
      await _capture(
        tester,
        key,
        'viewers-${width.toInt()}-${brightness.name}-${scale.toStringAsFixed(1)}',
      );
    });
  }

  testWidgets(
    'the complete listed catalog browses every craft without an Other bucket',
    (tester) async {
      final entries = _listedCatalog();
      final (_, key) = await _open(tester, entries: entries);
      expect(
        find.byKey(const ValueKey('store-shelf-category:Other')),
        findsNothing,
      );
      await _capture(tester, key, 'discover-full-catalog');
      for (final category in storeCategoryDomains.keys) {
        final matches =
            entries.where((e) => storeCategoryFor(e) == category).toList()
              ..sort(
                (a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()),
              );
        if (matches.isEmpty) continue;
        final tab = find.byKey(ValueKey('store-shelf-category:$category'));
        await tester.ensureVisible(tab);
        await tester.tap(tab);
        await tester.pumpAndSettle();
        expect(
          find.byKey(ValueKey('store-card:${matches.first.id}')),
          findsOneWidget,
          reason: '$category must show its actual catalog entries',
        );
        expect(tester.takeException(), isNull);
        if (['Research', 'Music', 'Engineering', 'Design'].contains(category)) {
          await _capture(tester, key, 'category-${category.toLowerCase()}');
        }
      }
    },
  );

  testWidgets(
    'categories group domains, collections open and search finds capabilities',
    (tester) async {
      await _open(tester);
      await tester.tap(
        find.byKey(const ValueKey('store-shelf-category:Design')),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-card:autonomous/blender')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('store-card:autonomous/text-to-cad')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('store-card:autonomous/copper')),
        findsNothing,
      );
      await tester.tap(find.byKey(const ValueKey('store-shelf-discover')));
      await tester.pumpAndSettle();
      await tester.ensureVisible(
        find.byKey(const ValueKey('store-collection:hardware')),
      );
      await tester.tap(find.byKey(const ValueKey('store-collection:hardware')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-card:autonomous/copper')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('store-card:autonomous/blender')),
        findsNothing,
      );
      await tester.enterText(
        find.byKey(const ValueKey('store-search')),
        'circuit board',
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-card:autonomous/copper')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('store-card:codex')), findsNothing);
      await tester.enterText(
        find.byKey(const ValueKey('store-search')),
        'does-not-exist',
      );
      await tester.pumpAndSettle();
      expect(
        find.text(
          'No matching harnesses. Try a name or something you want to make.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('Clear search'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-feature:autonomous/blender')),
        findsOneWidget,
      );
    },
  );

  testWidgets('feature opens its page and a starter prompt can be copied', (
    tester,
  ) async {
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
    final (_, key) = await _open(tester);
    await tester.tap(
      find.byKey(const ValueKey('store-feature:autonomous/blender')),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('store-page:autonomous/blender')),
      findsOneWidget,
    );
    // Before Blender ships its own examples, its editorial prompts lead the page.
    expect(find.byKey(const ValueKey('store-example:0')), findsOneWidget);
    await _capture(tester, key, 'blender-detail');
    final copy = find.byKey(const ValueKey('store-copy-prompt:0'));
    await tester.ensureVisible(copy);
    await tester.pumpAndSettle();
    await tester.tap(copy);
    await tester.pumpAndSettle();
    expect(copied, storeStories['autonomous/blender']!.prompts.first);
    expect(find.text('Prompt copied'), findsOneWidget);
  });

  testWidgets(
    'unavailable reviews do not become a release notice in discovery or detail',
    (tester) async {
      await _open(tester, unavailable: true);
      expect(find.textContaining('not available'), findsNothing);
      await tester.tap(
        find.byKey(const ValueKey('store-feature:autonomous/blender')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Ratings and reviews'), findsNothing);
      expect(find.text('No ratings yet'), findsNothing);
      expect(
        find.byKey(const ValueKey('store-primary-action')),
        findsOneWidget,
      );
    },
  );

  testWidgets('missing featured packages are not advertised', (tester) async {
    await _open(tester, entries: []);
    expect(
      find.byKey(const ValueKey('store-feature:autonomous/blender')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('store-collection:hardware')),
      findsNothing,
    );
    expect(find.text('Your starting point: code.'), findsOneWidget);
    expect(find.byKey(const ValueKey('store-card:codex')), findsOneWidget);
  });

  testWidgets(
    'Open launches the installed harness and cancel abandons only its draft',
    (tester) async {
      final (app, _) = await _open(tester);
      await tester.tap(
        find.byKey(const ValueKey('store-shelf-category:Design')),
      );
      await tester.pumpAndSettle();
      final count = app.swarms.length;
      await tester.ensureVisible(
        find.byKey(const ValueKey('store-action:autonomous/blender')),
      );
      await tester.tap(
        find.byKey(const ValueKey('store-action:autonomous/blender')),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('create-agent-submit')), findsOneWidget);
      expect(
        tester.widget<AgentPicker>(find.byType(AgentPicker)).value,
        'autonomous/blender',
      );
      expect(app.swarms.length, count + 1);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(app.swarms.length, count);
    },
  );
}

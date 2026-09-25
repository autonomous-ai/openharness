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
import 'package:harness/shared/layouts/widgets/sidebar_item.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/widgets/agent_picker.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/store/store_controller.dart';
import 'package:harness/store/store_demo_dialog.dart';
import 'package:harness/store/store_cover_art.dart';
import 'package:harness/store/store_explore_widgets.dart';
import 'package:harness/store/store_editorial.dart';
import 'package:harness/store/store_exploration.dart';
import 'package:harness/store/store_featured_art.dart';
import 'package:harness/store/store_models.dart';
import 'package:harness/store/store_screen.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'support/real_fonts.dart';

final _catalog = [
  for (final (id, name, category) in [
    ('blender', 'Blender', '3D'),
    ('autonomous-circuit', 'Autonomous Circuit', 'PCB'),
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
      installed: ['blender', 'autonomous-circuit', 'marp'].contains(id),
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

List<DshEntry> _recordedCatalog() => [
  for (final item
      in jsonDecode(File('../store/hands-on.json').readAsStringSync()) as List)
    DshEntry.fromJson({
      ...jsonDecode(
        File('../store/agents/${item['id']}/harness.json').readAsStringSync(),
      ) as Map<String, dynamic>,
      ...jsonDecode(
        File('../store/agents/${item['id']}/store.json').readAsStringSync(),
      ) as Map<String, dynamic>,
    })!,
];

// Seed NetworkImage's cache with the exact published posters for visual review.
// No replacement art, network connection or production account is needed.
Future<void> _cacheRecordingPosters(
  WidgetTester tester,
  List<DshEntry> entries,
) async {
  await tester.runAsync(() async {
    for (final entry in entries) {
      final url = entry.examples.first.image!;
      final path = Uri.parse(url).path.split('/main/').last;
      final codec = await ui.instantiateImageCodec(
        await File('../$path').readAsBytes(),
      );
      final frame = await codec.getNextFrame();
      PaintingBinding.instance.imageCache.putIfAbsent(
        NetworkImage(url),
        () => OneFrameImageStreamCompleter(
          Future.value(ImageInfo(image: frame.image)),
        ),
      );
      codec.dispose();
    }
  });
}

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

  void publishCatalog(List<DshEntry> entries) {
    localMachineState!.dsh.replace(entries);
    notifyListeners();
  }
}

class _Api implements StoreApi {
  _Api({this.unavailable = false, this.items = const []});
  final bool unavailable;
  final List<StoreRating> items;
  @override
  Future<List<StoreRating>> ratings() async {
    if (unavailable) throw StateError('service unavailable');
    return items;
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
  List<StoreRating> ratings = const [],
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
  final keymap = AppKeymap();
  addTearDown(keymap.dispose);
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
          body: KeymapProvider(
            keymap: keymap,
            child: KeymapHost(
              keymap: keymap,
              actions: const {},
              enabled: () => true,
              child: StoreTab(
                notifier: app,
                api: _Api(unavailable: unavailable, items: ratings),
                initialHarness: initialHarness,
              ),
            ),
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
      ...storeCoverArt.values.map((cover) => cover.asset),
      ...storeFeaturedArt.values,
      'assets/store/blender-studio.jpg',
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
  test('every listed harness has a bundled cover and source record', () {
    final listed = _listedCatalog().map((entry) => entry.id).toSet();
    expect(storeCoverArt.keys.toSet(), listed);
    final sources = (jsonDecode(
      File('assets/store/covers/sources.json').readAsStringSync(),
    ) as List).cast<Map>();
    expect(sources.map((source) => source['harness']).toSet(), listed);
    expect(sources.length, listed.length);
    for (final entry in storeCoverArt.entries) {
      final source = sources.singleWhere(
        (source) => source['harness'] == entry.key,
      );
      expect(entry.value.asset, 'assets/store/covers/${source['asset']}');
      expect(File(entry.value.asset).existsSync(), isTrue, reason: entry.key);
      expect(source['source'], isNotEmpty, reason: entry.key);
      if (entry.value.credit != null) {
        expect(source['license'], isNotEmpty, reason: entry.key);
        expect(
          File('assets/store/covers/${source['licenseFile']}').existsSync(),
          isTrue,
          reason: entry.key,
        );
      }
    }
  });

  testWidgets('bundled covers decode and fit thumbnail frames', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1180, 980);
    addTearDown(tester.view.reset);
    final ids = storeCoverArt.keys.toList();
    for (var start = 0; start < ids.length; start += 25) {
      final pageIds = ids.skip(start).take(25).toList();
      final key = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              body: Padding(
                padding: const EdgeInsets.all(24),
                child: Wrap(
                  spacing: 16,
                  runSpacing: 18,
                  children: [
                    for (final id in pageIds)
                      SizedBox(
                        width: 212,
                        child: Column(
                          children: [
                            ClipRRect(
                              borderRadius: BorderRadius.circular(12),
                              child: AspectRatio(
                                aspectRatio: 1.65,
                                child: StoreProjectArt(
                                  entry: DshEntry(
                                    id: id,
                                    name: id.split('/').last,
                                    engine: 'codex',
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(height: 8),
                            Text(id.split('/').last),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      await tester.runAsync(() async {
        for (final id in pageIds) {
          final cover = storeCoverArt[id]!;
          final bytes = await rootBundle.load(cover.asset);
          final codec = await ui.instantiateImageCodec(
            bytes.buffer.asUint8List(),
          );
          final frame = await codec.getNextFrame();
          expect(
            frame.image.width,
            greaterThanOrEqualTo(400),
            reason: cover.asset,
          );
          if (cover.viewport case final viewport?) {
            expect(
              cover.imageSize,
              Size(frame.image.width.toDouble(), frame.image.height.toDouble()),
              reason: cover.asset,
            );
            expect(viewport.left, greaterThanOrEqualTo(0), reason: cover.asset);
            expect(viewport.top, greaterThanOrEqualTo(0), reason: cover.asset);
            expect(
              viewport.right,
              lessThanOrEqualTo(frame.image.width),
              reason: cover.asset,
            );
            expect(
              viewport.bottom,
              lessThanOrEqualTo(frame.image.height),
              reason: cover.asset,
            );
            expect(viewport.shortestSide, greaterThan(0), reason: cover.asset);
          }
          frame.image.dispose();
          codec.dispose();
          await precacheImage(AssetImage(cover.asset), key.currentContext!);
        }
      });
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await _capture(tester, key, 'cover-selection-${start ~/ 25 + 1}');
    }
  });

  testWidgets('covers stay separate from prompt examples', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Row(
          children: [
            for (final showExample in [false, true])
              SizedBox(
                width: 300,
                height: 190,
                child: StoreProjectArt(
                  key: ValueKey(showExample ? 'proof' : 'cover'),
                  entry: _catalog.first,
                  showExample: showExample,
                ),
              ),
          ],
        ),
      ),
    );
    await tester.runAsync(() async {
      final context = tester.element(find.byKey(const ValueKey('cover')));
      await precacheImage(
        const AssetImage('assets/store/covers/blender.jpg'),
        context,
      );
      await precacheImage(
        const AssetImage('assets/store/projects/blender.jpg'),
        context,
      );
    });
    await tester.pumpAndSettle();
    final coverImage = tester.widget<Image>(
      find.descendant(
        of: find.byKey(const ValueKey('cover')),
        matching: find.byType(Image),
      ),
    );
    final proofImage = tester.widget<Image>(
      find.descendant(
        of: find.byKey(const ValueKey('proof')),
        matching: find.byType(Image),
      ),
    );
    expect(
      (coverImage.image as AssetImage).assetName,
      'assets/store/covers/blender.jpg',
    );
    expect(
      (proofImage.image as AssetImage).assetName,
      'assets/store/projects/blender.jpg',
    );
    expect(
      find.byTooltip(
        'DOGWALK: a snowy world made in Blender\nBlender Foundation · DOGWALK · CC BY 4.0\nView source',
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  test(
    'every listed harness has a browsing category and a discipline invitation',
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
          storeDiscipline(storeCategoryFor(entry)).headline,
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

  for (final (width, scale, brightness) in [
    (1440.0, 1.0, Brightness.dark),
    (1440.0, 1.0, Brightness.light),
    (760.0, 1.5, Brightness.dark),
  ]) {
    testWidgets(
      'illustrated Discover and Featured fit $width at $scale in ${brightness.name}',
      (tester) async {
        final entries = _recordedCatalog();
        await _cacheRecordingPosters(tester, entries);
        final (_, key) = await _open(
          tester,
          entries: [
            ..._catalog.where(
              (entry) => !entries.any((recorded) => recorded.id == entry.id),
            ),
            ...entries,
          ],
          width: width,
          height: 1080,
          scale: scale,
          brightness: brightness,
        );
        expect(find.text('Featured harnesses'), findsNothing);
        expect(find.text('See all 8'), findsNothing);
        expect(find.byType(StoreFeaturedArt), findsNWidgets(3));
        expect(
          find.byKey(const ValueKey('store-session:autonomous/blender')),
          findsNothing,
        );
        expect(find.byType(WebViewWidget), findsNothing);
        await _capture(
          tester,
          key,
          'restored-discover-${width.toInt()}-${brightness.name}-${scale.toStringAsFixed(1)}',
        );
        // Discover's illustrations may evict posters that are not visible yet.
        await _cacheRecordingPosters(tester, entries);
        await tester.tap(find.byKey(const ValueKey('store-shelf-sessions')));
        await tester.pumpAndSettle();
        expect(find.text('Featured harnesses'), findsOneWidget);
        expect(find.text('Preview unavailable'), findsNothing);
        expect(find.byType(StoreFeaturedArt), findsNothing);
        for (final entry in entries) {
          final card = find.byKey(ValueKey('store-session:${entry.id}'));
          if (card.evaluate().isEmpty) continue;
          final poster = tester.widget<Image>(
            find.descendant(
              of: card,
              matching: find.byWidgetPredicate(
                (widget) => widget is Image && widget.image is NetworkImage,
              ),
            ),
          );
          expect(
            (poster.image as NetworkImage).url,
            entry.examples.first.image,
          );
          expect(poster.fit, BoxFit.contain);
        }
        for (final entry in entries) {
          expect(
            find.byKey(ValueKey('store-session:${entry.id}')),
            findsOneWidget,
          );
          expect(find.text(entry.examples.first.caption!), findsOneWidget);
        }
        expect(
          tester
              .widget<SidebarItem>(
                find.byKey(const ValueKey('store-shelf-sessions')),
              )
              .selected,
          isTrue,
        );
        await _capture(
          tester,
          key,
          'featured-all-${width.toInt()}-${brightness.name}-${scale.toStringAsFixed(1)}',
        );
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('featured recordings play on demand and open the right harness', (
    tester,
  ) async {
    final entries = _recordedCatalog();
    final (app, _) = await _open(tester, entries: entries);
    final initialSwarms = app.swarms.length;
    await tester.tap(find.byKey(const ValueKey('store-shelf-sessions')));
    await tester.pumpAndSettle();
    expect(find.byType(StoreDemoDialog), findsNothing);
    await tester.tap(
      find.byKey(const ValueKey('store-session-watch:autonomous/blender')),
    );
    await tester.pumpAndSettle();
    final dialog = tester.widget<StoreDemoDialog>(find.byType(StoreDemoDialog));
    final example = entries
        .singleWhere((entry) => entry.id == 'autonomous/blender')
        .examples
        .first;
    expect(dialog.video, example.video);
    expect(dialog.caption, example.caption);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byType(StoreDemoDialog), findsNothing);
    await tester.tap(
      find.byKey(const ValueKey('store-session-open:autonomous/blender')),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('store-page:autonomous/blender')),
      findsOneWidget,
    );
    expect(find.text('“${example.prompt}”'), findsOneWidget);
    expect(app.swarms.length, initialSwarms);
    await tester.tap(find.byKey(const ValueKey('store-back')));
    await tester.pumpAndSettle();
    expect(find.text('Featured harnesses'), findsOneWidget);
    await tester.ensureVisible(
      find.byKey(const ValueKey('store-session-open:autonomous/rdkit')),
    );
    await tester.tap(
      find.byKey(const ValueKey('store-session-open:autonomous/rdkit')),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('store-page:autonomous/rdkit')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('store-back')));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<SidebarItem>(
            find.byKey(const ValueKey('store-shelf-sessions')),
          )
          .selected,
      isTrue,
    );
    expect(
      find.byKey(const ValueKey('store-session:autonomous/rdkit')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'featured shelf follows catalog publications and removals while open',
    (tester) async {
      final (app, _) = await _open(tester, entries: _recordedCatalog());
      await tester.tap(find.byKey(const ValueKey('store-shelf-sessions')));
      await tester.pumpAndSettle();
      const newcomer = DshEntry(
        id: 'community/after-release',
        name: 'After release',
        engine: 'codex',
        examples: [
          StoreExample(
            prompt: 'Make a new thing.',
            image: 'https://example.com/new-poster.png',
            video: 'https://example.com/new-recording.mp4',
          ),
        ],
      );
      app.publishCatalog([newcomer]);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-session:community/after-release')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('store-session:autonomous/blender')),
        findsNothing,
      );
      // Failed remote artwork keeps the recording and detail actions usable.
      expect(find.text('Preview unavailable'), findsOneWidget);
      expect(
        find.byKey(
          const ValueKey('store-session-watch:community/after-release'),
        ),
        findsOneWidget,
      );
      await tester.tap(
        find.byKey(
          const ValueKey('store-session-open:community/after-release'),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-page:community/after-release')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('store-back')));
      await tester.pumpAndSettle();
      app.publishCatalog([]);
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Recorded sessions will appear here when they are available in your catalog.',
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'search is ready on arrival and stays at the top while browsing',
    (tester) async {
      final (_, key) = await _open(tester);
      final search = find.byKey(const ValueKey('store-search'));
      final field = tester.widget<TextField>(search);
      expect(field.focusNode!.hasFocus, isTrue);
      // The outline, not the TextField: the clear button and the ⌘F hint
      // trade places inside it as text comes and goes.
      final outline = find.byKey(const ValueKey('store-search-field'));
      final initialRect = tester.getRect(outline);
      // One Safari-shaped row: history left, a compact field centred on the
      // pane, and the way to build your own on the right.
      final bar = initialRect;
      final header = tester.getRect(
        find.byKey(const ValueKey('store-search-header')),
      );
      expect(bar.width, lessThanOrEqualTo(560));
      expect(bar.center.dx, moreOrLessEquals(header.center.dx, epsilon: 0.5));
      final back = tester.getRect(find.byKey(const ValueKey('store-back')));
      final create = tester.getRect(
        find.byKey(const ValueKey('store-create-harness')),
      );
      expect(back.right, lessThan(bar.left));
      expect(create.left, greaterThan(bar.right));
      expect(back.center.dy, moreOrLessEquals(bar.center.dy, epsilon: 0.5));
      expect(create.center.dy, moreOrLessEquals(bar.center.dy, epsilon: 0.5));
      expect(find.text('Create Harness'), findsOneWidget);
      expect(find.text('Search harnesses'), findsOneWidget);
      await tester.drag(
        find.byKey(const PageStorageKey('store-discover-scroll')),
        const Offset(0, -700),
      );
      await tester.pumpAndSettle();
      expect(tester.getRect(outline), initialRect);
      await _capture(tester, key, 'discover-exploration');

      await tester.tap(
        find.byKey(const ValueKey('store-shelf-category:Engineering')),
      );
      await tester.pumpAndSettle();
      expect(tester.getRect(outline), initialRect);
      await tester.drag(
        find.byKey(const ValueKey('store-catalog:Engineering')),
        const Offset(0, -550),
      );
      await tester.pumpAndSettle();
      expect(tester.getRect(outline), initialRect);
      await tester.enterText(search, 'mounting holes');
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-card:autonomous/text-to-cad')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('store-card:autonomous/autonomous-circuit')),
        findsNothing,
      );
      expect(tester.getRect(outline), initialRect);
      await tester.tap(find.byTooltip('Clear search'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('store-category-hero')), findsOneWidget);
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
        StoreExample(
          prompt: 'Visualize rainfall over the last decade.',
          caption: 'Monsoon seasons in Sri Lanka',
        ),
      ],
    );
    expect(storeMatches(entry, 'rainfall decade'), isTrue);
    expect(storeMatches(entry, 'observations'), isTrue);
    expect(storeMatches(entry, 'monsoon sri lanka'), isTrue);
    expect(storeMatches(entry, 'rainfall circuit'), isFalse);
  });

  test('search puts a requested tool before mentions in another tool', () {
    const entries = [
      DshEntry(
        id: 'a',
        name: 'Animator',
        engine: 'codex',
        description: 'Use Blender scenes.',
      ),
      DshEntry(id: 'b', name: 'Blender', engine: 'codex'),
      DshEntry(id: 'c', name: 'Blender Helper', engine: 'codex'),
      DshEntry(id: 'd', name: 'Unrelated', engine: 'codex'),
    ];
    expect(storeSearch(entries, ' BLENDER ').map((e) => e.id), ['b', 'c', 'a']);
    expect(storeSearch(entries, 'nothing'), isEmpty);
  });

  testWidgets('an empty search offers a way into a discipline', (tester) async {
    await _open(tester);
    final search = find.byKey(const ValueKey('store-search'));
    await tester.enterText(search, 'unfindabletool');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('store-search-explore:Design')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('store-catalog:Design')), findsOneWidget);
    expect(tester.widget<TextField>(search).controller!.text, isEmpty);
    expect(
      tester
          .widget<SidebarItem>(
            find.byKey(const ValueKey('store-shelf-category:Design')),
          )
          .selected,
      isTrue,
    );
    await tester.tap(find.byKey(const ValueKey('store-back')));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(search).controller!.text, 'unfindabletool');
  });

  testWidgets(
    'category navigation highlights the rail and restores scroll through back and forward',
    (tester) async {
      await _open(tester, height: 850);
      final discover = find.byKey(
        const PageStorageKey('store-discover-scroll'),
      );
      final categoryCard = find.byKey(
        const ValueKey('store-category:Engineering'),
      );
      await tester.ensureVisible(categoryCard);
      await tester.pumpAndSettle();
      final homeY = tester.getTopLeft(categoryCard).dy;
      await tester.tap(categoryCard);
      await tester.pumpAndSettle();
      final nav = find.byKey(
        const ValueKey('store-shelf-category:Engineering'),
      );
      expect(tester.widget<SidebarItem>(nav).selected, isTrue);
      final harness = find.byKey(
        const ValueKey('store-card:autonomous/autonomous-circuit'),
      );
      await tester.ensureVisible(harness);
      await tester.pumpAndSettle();
      final categoryY = tester.getTopLeft(harness).dy;
      await tester.tap(harness);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-page:autonomous/autonomous-circuit')),
        findsOneWidget,
      );
      expect(tester.widget<SidebarItem>(nav).selected, isTrue);
      await tester.tap(find.byKey(const ValueKey('store-back')));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(harness).dy, closeTo(categoryY, 1));
      await tester.tap(find.byKey(const ValueKey('store-back')));
      await tester.pumpAndSettle();
      expect(discover, findsOneWidget);
      expect(tester.getTopLeft(categoryCard).dy, closeTo(homeY, 1));
      await tester.tap(find.byKey(const ValueKey('store-nav-forward')));
      await tester.pumpAndSettle();
      expect(tester.widget<SidebarItem>(nav).selected, isTrue);
      expect(tester.getTopLeft(harness).dy, closeTo(categoryY, 1));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'search history is one stop and clearing returns to the originating category',
    (tester) async {
      await _open(tester);
      await tester.tap(
        find.byKey(const ValueKey('store-shelf-category:Engineering')),
      );
      await tester.pumpAndSettle();
      final search = find.byKey(const ValueKey('store-search'));
      for (final query in ['cop', 'copp', 'copper']) {
        await tester.enterText(search, query);
        await tester.pumpAndSettle();
      }
      await tester.tap(find.byKey(const ValueKey('store-back')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-catalog:Engineering')),
        findsOneWidget,
      );
      expect(tester.widget<TextField>(search).controller!.text, isEmpty);
      await tester.tap(find.byKey(const ValueKey('store-nav-forward')));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(search).controller!.text, 'copper');
      await tester.tap(
        find.byKey(const ValueKey('store-card:autonomous/autonomous-circuit')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('store-back')));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(search).controller!.text, 'copper');
      await tester.tap(find.byTooltip('Clear search'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-catalog:Engineering')),
        findsOneWidget,
      );
      expect(tester.widget<TextField>(search).focusNode!.hasFocus, isTrue);
    },
  );

  testWidgets('installed filter survives opening a harness and returning', (
    tester,
  ) async {
    await _open(tester);
    await tester.tap(find.byKey(const ValueKey('store-shelf-category:Design')));
    await tester.pumpAndSettle();
    final filter = find.byKey(const ValueKey('store-filter-installed'));
    await tester.ensureVisible(filter);
    await tester.tap(filter);
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('store-card:autonomous/text-to-cad')),
      findsNothing,
    );
    final blender = find.byKey(const ValueKey('store-card:autonomous/blender'));
    await tester.ensureVisible(blender);
    await tester.tap(blender);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('store-back')));
    await tester.pumpAndSettle();
    expect(tester.widget<ChoiceChip>(filter).selected, isTrue);
    expect(
      find.byKey(const ValueKey('store-card:autonomous/text-to-cad')),
      findsNothing,
    );
    await tester.ensureVisible(find.byKey(const ValueKey('store-filter-all')));
    await tester.tap(find.byKey(const ValueKey('store-filter-all')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('store-card:autonomous/text-to-cad')),
      findsOneWidget,
    );
  });

  testWidgets(
    'the existing Find command focuses Store search instead of a terminal',
    (tester) async {
      await _open(tester);
      await tester.tap(
        find.byKey(const ValueKey('store-shelf-category:Design')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('store-category-feature')));
      await tester.pumpAndSettle();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.bracketLeft);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-catalog:Design')),
        findsOneWidget,
      );
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.bracketRight);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-page:autonomous/blender')),
        findsOneWidget,
      );
      // Mouse navigation must keep keyboard commands inside the Store.
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyF);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('store-search')))
            .focusNode!
            .hasFocus,
        isTrue,
      );
      expect(tester.takeException(), isNull);
    },
  );

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
      expect(find.byKey(const ValueKey('store-shelf-all')), findsOneWidget);
      expect(find.byKey(const ValueKey('store-shelf-installed')), findsNothing);
      expect(find.text('Harness Store'), findsNothing);
      expect(
        tester.getTopLeft(find.byKey(const ValueKey('store-card:codex'))).dy,
        lessThan(
          tester
              .getTopLeft(find.byKey(const ValueKey('store-category:Design')))
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
    'discovery cards open the same category as the sidebar and search finds ideas',
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
        find.byKey(const ValueKey('store-card:autonomous/autonomous-circuit')),
        findsNothing,
      );
      await tester.tap(find.byKey(const ValueKey('store-shelf-discover')));
      await tester.pumpAndSettle();
      await tester.ensureVisible(
        find.byKey(const ValueKey('store-category:Engineering')),
      );
      await tester.tap(
        find.byKey(const ValueKey('store-category:Engineering')),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-card:autonomous/autonomous-circuit')),
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
        find.byKey(const ValueKey('store-card:autonomous/autonomous-circuit')),
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
        find.byKey(const ValueKey('store-catalog:Engineering')),
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
    'discovery has three illustrated features and categories have one',
    (tester) async {
      final (_, key) = await _open(tester);
      expect(find.byType(StoreProjectArt), findsNothing);
      expect(find.byType(StoreFeaturedArt), findsNWidgets(3));
      expect(
        find.byKey(const ValueKey('store-feature-art:codex')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('store-feature-art:autonomous/blender')),
        findsOneWidget,
      );
      expect(
        find.byKey(
          const ValueKey('store-feature-art:autonomous/autonomous-circuit'),
        ),
        findsOneWidget,
      );
      final category = find.byKey(const ValueKey('store-category:Design'));
      expect(
        find.descendant(of: category, matching: find.byType(EngineMark)),
        findsOneWidget,
      );
      await tester.ensureVisible(category);
      await _capture(tester, key, 'discover-disciplines');
      await tester.tap(category);
      await tester.pumpAndSettle();
      expect(find.byType(StoreProjectArt), findsNothing);
      expect(find.byType(StoreFeaturedArt), findsOneWidget);
      for (final entry in _catalog.where(
        (entry) =>
            storeCategoryFor(entry) == 'Design' && !entry.isViewerPackage,
      )) {
        final row = find.byKey(ValueKey('store-card:${entry.id}'));
        expect(row, findsOneWidget);
        expect(
          find.descendant(of: row, matching: find.byType(EngineMark)),
          findsOneWidget,
        );
      }
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('top rated appears only with enough community reviews', (
    tester,
  ) async {
    final (_, key) = await _open(
      tester,
      ratings: [
        for (final (id, average, count) in [
          ('autonomous/blender', 4.8, 5),
          ('autonomous/strudel', 4.5, 8),
          ('autonomous/marp', 5.0, 1),
        ])
          StoreRating(
            harnessId: id,
            average: average,
            count: count,
            histogram: const [],
          ),
      ],
    );
    expect(
      find.byKey(const ValueKey('store-recent-collection')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('store-top-rated-collection')),
      findsOneWidget,
    );
    final first = find.byKey(
      const ValueKey('store-top-rated:autonomous/blender'),
    );
    expect(first, findsOneWidget);
    expect(
      find.descendant(of: first, matching: find.text('1')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('store-top-rated:autonomous/strudel')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('store-top-rated:autonomous/marp')),
      findsNothing,
    );
    await tester.ensureVisible(find.text('Top rated'));
    await _capture(tester, key, 'discover-top-rated');
    await tester.tap(first);
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('store-page:autonomous/blender')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'unavailable reviews do not become a release notice in discovery or detail',
    (tester) async {
      await _open(tester, unavailable: true);
      expect(
        find.byKey(const ValueKey('store-top-rated-collection')),
        findsNothing,
      );
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
      find.byKey(const ValueKey('store-category:Engineering')),
      findsNothing,
    );
    expect(find.text('Start with code.'), findsOneWidget);
    expect(find.byKey(const ValueKey('store-card:codex')), findsOneWidget);
  });

  testWidgets(
    'a browse row opens details; New Harness starts work from the page',
    (tester) async {
      final (app, _) = await _open(tester);
      await tester.tap(
        find.byKey(const ValueKey('store-shelf-category:Design')),
      );
      await tester.pumpAndSettle();
      final count = app.swarms.length;
      await tester.ensureVisible(
        find.byKey(const ValueKey('store-card:autonomous/blender')),
      );
      await tester.tap(
        find.byKey(const ValueKey('store-card:autonomous/blender')),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-page:autonomous/blender')),
        findsOneWidget,
      );
      expect(app.swarms.length, count);
      expect(find.text('Resume Harness'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('store-primary-action')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('create-agent-submit')), findsOneWidget);
      expect(
        tester
            .widget<AgentPicker>(
              find.byKey(const Key('new-agent-harness-picker')),
            )
            .value,
        'autonomous/blender',
      );
      expect(app.swarms.length, count + 1);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(app.swarms.length, count);
    },
  );
}

import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/browser/browser_panel.dart';
import 'package:harness/browser/browser_settings.dart';
import 'package:harness/browser/browser_settings_page.dart';
import 'package:harness/browser/browser_setup_dialog.dart';
import 'package:harness/browser/browser_stream.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/app_type.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_typography.dart';
import 'package:harness/widgets/desktop_workspace_tab.dart';
import 'package:harness/widgets/web_pane_panel.dart';

import 'support/fake_browser_view.dart';

/// The elements gallery (desktop-design-system.md, Elements gallery): each
/// element drawn in light and dark, each section against its own checked-in
/// image, `test/goldens/elements/<section>-<light|dark>.png`, so a pull request
/// that changes one element changes only its section's two images. A new or
/// changed element updates the doc and this gallery in the same pull request.
///
/// Update the images with
/// `flutter test --no-pub --update-goldens test/elements_gallery_test.dart`
/// and look at them before committing.
void main() {
  late GoldenFileComparator previous;
  setUpAll(() async {
    // One font file on every host, so the images match on macOS, Linux and
    // Windows; text is set in the bundled Roboto Mono, icons in Lucide.
    final mono = rootBundle.load('assets/fonts/roboto-mono/RobotoMono.ttf');
    for (final family in {AppType.sansFamily, terminalFontFamily, 'Roboto'}) {
      await (FontLoader(family)..addFont(mono)).load();
    }
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
    previous = goldenFileComparator;
    goldenFileComparator = _NearlyComparator(
      (previous as LocalFileComparator).basedir.resolve(
        'elements_gallery_test.dart',
      ),
    );
  });
  tearDownAll(() => goldenFileComparator = previous);

  for (final brightness in Brightness.values) {
    testWidgets(
      'every element matches its section\'s image in ${brightness.name}',
      (tester) async {
        await _show(tester, brightness);
        final sections = _sections();
        expect(sections, isNotEmpty);
        final words = _words(tester);
        // Every section is compared, so one run names every image that moved.
        final problems = <String>[];
        for (final id in sections) {
          final section = find.byKey(_Gallery.section(id));
          (goldenFileComparator as _NearlyComparator).words = _within(
            words,
            tester.getRect(section),
          );
          try {
            await expectLater(
              section,
              matchesGoldenFile(_image(id, brightness)),
            );
          } on TestFailure catch (e) {
            problems.add(e.message ?? id);
          }
        }
        await tester.pumpWidget(const SizedBox());
        expect(problems, isEmpty);
      },
    );
  }

  // A renamed or removed section would leave its old images behind, compared by nothing.
  testWidgets('the images are exactly the sections\' images', (tester) async {
    await _show(tester, Brightness.light);
    final images = {
      for (final f in Directory('test/goldens/elements').listSync())
        if (f.path.endsWith('.png'))
          'goldens/elements/${f.uri.pathSegments.last}',
    };
    expect(images, {
      for (final id in _sections())
        for (final brightness in Brightness.values) _image(id, brightness),
    });
    await tester.pumpWidget(const SizedBox());
  });
}

/// The gallery's sections on screen, in order.
List<String> _sections() => [
  for (final e in find.byType(RepaintBoundary).evaluate())
    if (e.widget.key case ValueKey<String>(:final value)
        when value.startsWith(_Gallery.sectionPrefix))
      value.substring(_Gallery.sectionPrefix.length),
];

/// A section's image in [brightness], relative to the test folder.
String _image(String id, Brightness brightness) =>
    'goldens/elements/$id-${brightness.name}.png';

Future<void> _show(WidgetTester tester, Brightness brightness) async {
  final old = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = old);
  // Faye's Browser settings, as her computer keeps them, and her running browser's screen.
  final browserApp = _BrowserSettingsApp();
  addTearDown(browserApp.dispose);
  WebPanePanel.webviewAvailableForTest = true;
  addTearDown(() => WebPanePanel.webviewAvailableForTest = null);
  tester.view.devicePixelRatio = 1;
  // Taller than the gallery needs: each section is its own image, so the page's height is in none of them.
  tester.view.physicalSize = const Size(760, 2400);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      // A still spinner, so the image holds one frame.
      home: MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: _Gallery(browserApp: browserApp),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  // One browser is being stopped, as a person presses its Stop.
  await tester.tap(
    find.descendant(
      of: find.byKey(const ValueKey('gallery-browser-faye-stopping')),
      matching: find.byKey(const ValueKey('swarm-browser-stop')),
    ),
  );
  await tester.pump();
  expect(tester.takeException(), isNull);
}

/// Everything but words is drawn alike on every host (fills, pills, borders,
/// where each element sits): at most 38 pixels of a section's image may
/// differ, so a lost element fails. Words are left out: macOS and Linux smooth
/// their edges too differently to compare by pixel, and their copy is tested
/// where they are written.
const _rest = 38;

/// The words the gallery draws, each a little past its box, where a glyph's
/// smoothed edge reaches. A field draws its words through an editable, not a
/// RichText.
List<Rect> _words(WidgetTester tester) => [
  for (final text in [
    ...find.byType(RichText).evaluate(),
    ...find.byType(EditableText).evaluate(),
  ])
    tester.getRect(find.byElementPredicate((e) => e == text)).inflate(2),
];

/// The [words] inside [section], in its image's coordinates.
List<Rect> _within(List<Rect> words, Rect section) => [
  for (final w in words)
    if (section.overlaps(w)) w.shift(-section.topLeft),
];

/// Why [actual] does not match [expected], or null when it does. A pixel
/// differs when a channel moves by more than a quarter; the image outside the
/// [words] may hold [_rest] such pixels.
Future<String?> galleryDifference(
  Uint8List actual,
  Uint8List expected,
  List<Rect> words,
) async {
  final (a, b) = (await _pixels(actual), await _pixels(expected));
  if (a.width != b.width || a.height != b.height) {
    return 'size ${a.width}x${a.height}, expected ${b.width}x${b.height}';
  }
  var n = 0;
  for (var y = 0; y < a.height; y++) {
    for (var x = 0; x < a.width; x++) {
      final at = Offset(x + .5, y + .5);
      if (words.any((w) => w.contains(at))) continue;
      final i = (y * a.width + x) * 4;
      for (var c = 0; c < 4; c++) {
        if ((a.bytes[i + c] - b.bytes[i + c]).abs() > 64) {
          n++;
          break;
        }
      }
    }
  }
  return n > _rest
      ? 'the image outside its words: $n pixels differ (limit $_rest)'
      : null;
}

Future<({int width, int height, Uint8List bytes})> _pixels(
  Uint8List png,
) async {
  final codec = await ui.instantiateImageCodec(png);
  final image = (await codec.getNextFrame()).image;
  final data = await image.toByteData();
  final pixels = (
    width: image.width,
    height: image.height,
    bytes: data!.buffer.asUint8List(),
  );
  image.dispose();
  codec.dispose();
  return pixels;
}

class _Gallery extends StatelessWidget {
  const _Gallery({required this.browserApp});

  /// Where Browser settings reads Faye's.
  final AppNotifier browserApp;

  /// Each section's boundary is keyed this prefix and its id, the name of its images.
  static const sectionPrefix = 'elements/';
  static ValueKey<String> section(String id) => ValueKey('$sectionPrefix$id');

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    Widget title(String text) => Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 8),
      child: Text(text, style: Theme.of(context).textTheme.labelLarge),
    );
    Widget gap() => const SizedBox(width: 16);
    // Each section is its own image, with its own ground, so a pull request that changes one element changes only
    // its section's images.
    Widget section(String id, String text, List<Widget> children) =>
        RepaintBoundary(
          key: _Gallery.section(id),
          child: ColoredBox(
            color: Theme.of(context).colorScheme.surface,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 6),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [title(text), ...children],
              ),
            ),
          ),
        );
    return Material(
      color: Theme.of(context).colorScheme.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          section('browser-setup', 'Set up Browser', [
            const SizedBox(
              width: 500,
              child: BrowserSetupPrompt(ownMachine: false),
            ),
          ]),
          section(
            'browser-settings',
            'Browser settings: a proxy with a saved password',
            [
              SizedBox(
                width: 420,
                height: 420,
                child: BrowserSettingsPage(
                  app: browserApp,
                  machineId: 'm',
                  agentId: 'faye',
                  onBack: () {},
                ),
              ),
            ],
          ),
          section(
            'browser-bar',
            'Browser in an agent\'s bar, plain, open and running; its panel off, running, failed and stopping',
            [
              Row(
                children: [
                  BrowserButton(open: false, onPressed: () {}),
                  gap(),
                  BrowserButton(open: true, onPressed: () {}),
                  gap(),
                  BrowserButton(open: false, running: true, onPressed: () {}),
                ],
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 16,
                runSpacing: 8,
                children: [
                  for (final agent in [
                    'faye-off',
                    'faye-ready',
                    'faye-failed',
                    'faye-stopping',
                  ])
                    SizedBox(
                      key: ValueKey('gallery-browser-$agent'),
                      width: 340,
                      height: 230,
                      child: BrowserPanel(
                        app: browserApp,
                        machineId: 'm',
                        agentId: agent,
                        thisComputer: true,
                        onClose: () {},
                        newView: _Screen.new,
                      ),
                    ),
                ],
              ),
            ],
          ),
          section('hachi-tab', 'Hachi\'s tab: first, with no ×, beside a tab', [
            Padding(
              padding: const EdgeInsets.all(8),
              child: Row(
                children: [
                  for (final (hachi, label, hint) in [
                    (true, 'Hachi', '⇧⌘H'),
                    (false, 'api', '⌘1'),
                  ])
                    SizedBox(
                      width: 180,
                      height: 34,
                      child: DesktopWorkspaceTab(
                        id: label,
                        label: label,
                        selected: hachi,
                        fixed: hachi,
                        showShortcuts: const AlwaysStoppedAnimation(true),
                        shortcutHint: hint,
                        onSelect: () {},
                        onClose: hachi ? null : () {},
                      ),
                    ),
                ],
              ),
            ),
          ]),
        ],
      ),
    );
  }
}

/// Faye's computer as Browser settings and her Browser panels ask it: a SOCKS5 proxy whose password it keeps.
class _BrowserSettingsApp extends AppNotifier {
  _BrowserSettingsApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    // Her computer, with one agent's browser off, one's running, one's whose Podman is down, and one's she is stopping.
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Ken Mac',
    );
    machines = [machine];
    machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = const [
        Agent(id: 'faye-off', name: 'Faye', engine: 'claude'),
        Agent(
          id: 'faye-ready',
          name: 'Faye',
          engine: 'claude',
          browser: AgentBrowser(state: 'ready'),
        ),
        Agent(
          id: 'faye-failed',
          name: 'Faye',
          engine: 'claude',
          browser: AgentBrowser(state: 'failed', error: 'podman_down'),
        ),
        Agent(
          id: 'faye-stopping',
          name: 'Faye',
          engine: 'claude',
          browser: AgentBrowser(state: 'ready'),
        ),
      ];
  }

  /// A Stop her computer has taken and not yet finished: the browser is still on.
  @override
  Future<void> agentBrowserStop(String machineId, String agentId) =>
      Completer<void>().future;

  /// The running browser's stream, opened as soon as it is asked for.
  @override
  BrowserStream browserStream(String machineId, String agentId) {
    late final BrowserStream stream;
    stream = BrowserStream(
      machineId: machineId,
      agentId: agentId,
      send: (type, payload) async {
        if (type == 'agent_browser_open') {
          scheduleMicrotask(
            () => stream.handleFrame('agent_browser_open_result', {
              'requestId': payload['requestId'],
              'streamId': '0f8fad5b-d9cb-469f-a165-70867728950e',
            }),
          );
        }
        return true;
      },
      sendBinary: (_) async => true,
    );
    return stream;
  }

  @override
  Future<BrowserSettings> agentBrowserSettings(
    String machineId,
    String agentId,
  ) async => const BrowserSettings(
    proxy: BrowserProxy(
      scheme: 'socks5',
      host: 'proxy.example',
      port: 1080,
      username: 'faye',
      passwordSet: true,
    ),
    languages: 'vi-VN, en-US',
  );
}

/// A running browser's screen, as its page would draw a site: a page under an address bar.
class _Screen extends FakeBrowserView {
  _Screen() : super(ready: true);

  @override
  Widget build(BuildContext context) => const ColoredBox(
    key: ValueKey('browser-screen'),
    color: Color(0xFFFFFFFF),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ColoredBox(color: Color(0xFFDEE1E6), child: SizedBox(height: 28)),
      ],
    ),
  );
}

/// Matches when [galleryDifference] finds none. A mismatch fails with what
/// differs and saves the image it drew to the system temp folder, never into
/// the source tree, where CI's runner would count it as a changed source.
class _NearlyComparator extends LocalFileComparator {
  _NearlyComparator(super.testFile);

  /// The words of the image being compared.
  List<Rect> words = const [];

  @override
  Future<bool> compare(Uint8List imageBytes, Uri golden) async {
    final file = File.fromUri(basedir.resolveUri(golden));
    final problem = file.existsSync()
        ? await galleryDifference(imageBytes, file.readAsBytesSync(), words)
        : 'no image yet; make it with --update-goldens';
    if (problem == null) return true;
    final drawn = File(
      '${Directory.systemTemp.createTempSync('elements-gallery-').path}/'
      '${golden.pathSegments.last}',
    )..writeAsBytesSync(imageBytes);
    throw FlutterError('$golden: $problem. What it drew: ${drawn.path}');
  }
}

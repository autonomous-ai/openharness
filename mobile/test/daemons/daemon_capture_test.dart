// Real-font review captures of the phone's daemon: the chip in the terminal's
// title in its states and with large text, the sheet (with a daemon, before
// one, and on a small phone with large text), the hatch reveal's frames, and
// economy v2 (`v2-*`: a duplicate's reveal, serial and shiny cards, the setup
// egg and its habits, a drop announced but not released), and round 4
// (`r4-*`: the consent screen, the sheet's consent and dial, a need line in
// voice v3, a level-up's morph), and drop init (`plate-*`: every filled
// daemon's plate in the reveal and the sheet). Always checks that nothing
// overflows; writes PNGs only when asked:
//
//   HARNESS_DAEMON_CAPTURE_DIR=/tmp/daemon-phone \
//     flutter test test/daemons/daemon_capture_test.dart
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/daemons/daemon_face.dart';
import 'package:harness_mobile/daemons/daemon_lines.dart';
import 'package:harness_mobile/daemons/plates.dart';
import 'package:harness_mobile/daemons/render.dart';
import 'package:harness_mobile/daemons/roster.dart';
import 'package:harness_mobile/daemons/zoo.dart';
import 'package:harness_mobile/daemons/zoo_client.dart';
import 'package:harness_mobile/phone/daemon_chip.dart';
import 'package:harness_mobile/phone/daemon_consent.dart';
import 'package:harness_mobile/phone/daemon_hatch.dart';
import 'package:harness_mobile/phone/daemon_plate.dart';
import 'package:harness_mobile/phone/daemon_scope.dart';
import 'package:harness_mobile/phone/daemon_sheet.dart';
import 'package:harness_mobile/phone/daemon_style.dart';
import 'package:harness_mobile/phone/terminal_title.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/state/app_state.dart';

import '../agent_pager_fixture.dart';
import 'zoo_fixture.dart';

final _output = Platform.environment['HARNESS_DAEMON_CAPTURE_DIR'];
final _roster = daemonRoster;

/// A real monospace face was found, so widths in cells mean what they will on
/// a phone.
var _realMono = false;

Future<void> _fonts() async {
  Future<bool> load(List<String> families, List<String> paths) async {
    final path = paths.where((p) => File(p).existsSync()).firstOrNull;
    if (path == null) return false;
    final bytes = ByteData.sublistView(await File(path).readAsBytes());
    for (final family in families) {
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }
    return true;
  }

  await load(
    ['.AppleSystemUIFont', 'SF Pro Text', 'Ubuntu Sans', 'Roboto'],
    [
      '/System/Library/Fonts/SFNS.ttf',
      '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    ],
  );
  // The icons, so a capture shows them rather than tofu.
  for (final (family, asset) in [
    ('MaterialIcons', 'fonts/MaterialIcons-Regular.otf'),
    (
      'packages/lucide_icons_flutter/Lucide300',
      'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
    ),
  ]) {
    try {
      final bytes = rootBundle.load(asset);
      await (FontLoader(family)..addFont(bytes)).load();
    } catch (_) {
      // Not bundled in this build: the capture shows a box instead.
    }
  }
  _realMono = await load(
    ['.AppleSystemUIFontMonospaced', 'SF Mono', 'Menlo', 'DejaVu Sans Mono'],
    [
      '/System/Library/Fonts/SFNSMono.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
    ],
  );
}

Map<String, dynamic> _daemon(
  String id, {
  int xp = 600,
  bool shiny = false,
  int? serial,
  int? dupes,
}) => {
  'id': id,
  'hatchedAt': '2026-09-26T09:42:00Z',
  'egg': 'first',
  'xp': xp,
  'shiny': shiny,
  'serial': ?serial,
  'dupes': ?dupes,
};

/// A signed-in app whose zoo is [zoo], and a host for it.
Future<AppNotifier> _app(Map<String, dynamic> zoo) async {
  final backend = FakeZooBackend()..zoo = zoo;
  final app = pagerApp(PagerConn());
  addTearDown(app.dispose);
  app.api = ZooApi(backend);
  app.zoo.ensure();
  return app;
}

Future<void> _capture(
  WidgetTester tester,
  String name,
  Size size,
  Widget child, {
  double textScale = 1,
  Future<void> Function()? then,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final before = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = Brightness.dark;
  addTearDown(() => grid.AppTheme.brightness.value = before);
  final boundary = GlobalKey();
  await tester.pumpWidget(
    RepaintBoundary(
      key: boundary,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: child,
      ),
    ),
  );
  await tester.pump();
  await then?.call();
  await tester.pump(const Duration(milliseconds: 50));
  expect(tester.takeException(), isNull, reason: name);
  final output = _output;
  if (output == null) return;
  final render =
      boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  await tester.runAsync(() async {
    final image = await render.toImage(pixelRatio: 3);
    try {
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(output).create(recursive: true);
      await File('$output/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    } finally {
      image.dispose();
    }
  });
}

/// The terminal page's title with the chip at its right end, over a little
/// terminal — laid as the page lays it: the title floats over the output.
///
/// The title's TYPE is held at [_titleScale] at most. Its three lines sit in
/// four fixed terminal rows (`TerminalTitle.heightOf`), which they outgrow past
/// about 1.3x whatever sits beside them — the title's own matter, not the
/// daemon's. The chip never scales, and the sheet over it keeps the full size.
Widget _screen(
  AppNotifier app, {
  bool body = true,
  bool chip = true,
  VoidCallback? onTitleTap,
}) => DaemonHost(
  notifier: app,
  child: Scaffold(
    backgroundColor: grid.AppPalette.windowBg,
    body: SafeArea(
      child: Stack(
        children: [
          if (body)
            Positioned.fill(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 84, 12, 12),
                child: Text(
                  '> fix the login redirect\n\n'
                  '  Reading src/auth/redirect.ts\n'
                  '  Editing 2 files\n',
                  style: TextStyle(
                    fontFamily: grid.AppFont.mono,
                    fontSize: 13,
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
              ),
            ),
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: Builder(
              builder: (context) => MediaQuery.withClampedTextScaling(
                maxScaleFactor: _titleScale,
                child: TerminalTitle(
                  name: 'Fix login redirect',
                  place: 'studio:harness',
                  branch: 'fix/login-redirect',
                  onTap: onTitleTap ?? () {},
                  onFind: () {},
                  daemon: chip
                      ? const DaemonChip(margin: EdgeInsets.only(left: 12))
                      : null,
                ),
              ),
            ),
          ),
        ],
      ),
    ),
  ),
);

/// The largest text scale [_screen]'s title is drawn at.
const _titleScale = 1.3;

DaemonHostState _host(WidgetTester tester) =>
    tester.state<DaemonHostState>(find.byType(DaemonHost));

void main() {
  setUpAll(_fonts);

  const header = Size(390, 80);
  const phone = Size(390, 844);

  testWidgets('chip: idle, need, work, fail, boop', (tester) async {
    for (final (name, watch) in [
      ('idle', const DaemonWatch()),
      ('need', const DaemonWatch(needs: {'m/a#q'})),
      ('work', const DaemonWatch(working: {'m/a'})),
      ('fail', const DaemonWatch(failing: {'m/a'})),
    ]) {
      final app = await _app({
        'daemons': [_daemon('tim')],
        'pair': 'tim',
      });
      await _capture(
        tester,
        'chip-tim-$name',
        header,
        _screen(app, body: false),
        then: () async {
          await tester.pump();
          final face = _host(tester).face;
          face.sync(const DaemonWatch());
          face.sync(watch);
          face.pulse();
          await tester.pump(const Duration(milliseconds: 400));
        },
      );
    }
  });

  testWidgets('title: the chip at the right end, its size at any text size', (
    tester,
  ) async {
    for (final (name, size, scale, chip) in [
      ('title-320', const Size(320, 80), 1.0, true),
      ('title-320-no-chip', const Size(320, 80), 1.0, false),
      ('title-390-large-text', const Size(390, 80), 1.3, true),
    ]) {
      final app = await _app({
        'daemons': [_daemon('tim')],
        'pair': 'tim',
      });
      var menus = 0;
      await _capture(
        tester,
        name,
        size,
        _screen(app, body: false, chip: chip, onTitleTap: () => menus++),
        textScale: scale,
      );
      final chipFinder = find.byKey(const ValueKey('daemon-chip'));
      if (!chip) {
        expect(chipFinder, findsNothing, reason: name);
        continue;
      }
      final title = tester.getRect(
        find.byKey(const ValueKey('terminal-title')),
      );
      final sprite = tester.getRect(chipFinder);
      final names = tester.getRect(find.text('Fix login redirect'));
      // Inside the title, at its right end, beside the names rather than over
      // them — and the art never scales with the text.
      expect(sprite.right, lessThanOrEqualTo(title.right), reason: name);
      expect(
        title.right - sprite.right,
        lessThanOrEqualTo(12 + 1),
        reason: name,
      );
      expect(sprite.top, greaterThanOrEqualTo(title.top), reason: name);
      expect(sprite.bottom, lessThanOrEqualTo(title.bottom), reason: name);
      expect(names.right, lessThanOrEqualTo(sprite.left), reason: name);
      expect(sprite.height, DaemonChip.height, reason: name);
      // A tap on it opens the daemon's sheet, not the harness's menu the rest
      // of the title opens.
      await tester.tap(chipFinder);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(
        find.byKey(const ValueKey('daemon-sheet')),
        findsOneWidget,
        reason: name,
      );
      expect(menus, 0, reason: name);
    }
  });

  testWidgets('chip: every daemon at 2.0 and 0.1', (tester) async {
    for (final d in _roster.daemons) {
      for (final (version, xp) in [('2.0', 600), ('0.1', 0)]) {
        final app = await _app({
          'daemons': [_daemon(d.id, xp: xp)],
          'pair': d.id,
        });
        await _capture(
          tester,
          'chip-${d.id}-$version',
          header,
          _screen(app, body: false),
        );
      }
    }
  });

  testWidgets('chip: the nest, and the egg ready', (tester) async {
    for (final (name, habits, eggs) in [
      ('nest-1', ['turn'], <Map<String, dynamic>>[]),
      ('nest-4', ['turn', 'split', 'find', 'store'], <Map<String, dynamic>>[]),
      (
        'egg-ready',
        ['turn', 'split', 'find', 'store', 'resume'],
        [
          {'id': 'e0', 'kind': 'first', 'grantedAt': ''},
        ],
      ),
    ]) {
      final app = await _app({
        'daemons': const [],
        'eggs': eggs,
        'habits': habits,
      });
      await _capture(tester, 'chip-$name', header, _screen(app, body: false));
    }
  });

  testWidgets('sheet: a daemon, its shelf and eggs', (tester) async {
    final app = await _app({
      'daemons': [
        _daemon('tim'),
        _daemon('gnu', xp: 150),
        _daemon('tux', xp: 0, shiny: true),
        _daemon('beastie', xp: 0),
      ],
      'eggs': [
        {'id': 'e1', 'kind': 'week', 'grantedAt': ''},
        {'id': 'e2', 'kind': 'night', 'grantedAt': ''},
      ],
      'pair': 'tim',
      'habits': const ['turn', 'split', 'find', 'machine', 'store'],
      'firstEgg': true,
    });
    Future<void> open() async {
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('daemon-chip')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 1200));
    }

    await _capture(tester, 'sheet-tim', phone, _screen(app), then: open);
    await _capture(
      tester,
      'sheet-tim-scrolled',
      phone,
      _screen(app),
      then: () async {
        await open();
        await tester.drag(
          find.byKey(const ValueKey('daemon-sheet')),
          const Offset(0, -1200),
        );
        await tester.pump(const Duration(milliseconds: 600));
      },
    );
    await _capture(
      tester,
      'sheet-tim-320-large-text',
      const Size(320, 640),
      _screen(app),
      textScale: 1.5,
      then: open,
    );
  });

  testWidgets('sheet: the nest before any daemon', (tester) async {
    final app = await _app({
      'daemons': const [],
      'eggs': const [],
      'habits': const ['turn', 'split', 'find'],
    });
    await _capture(
      tester,
      'sheet-nest',
      phone,
      _screen(app),
      then: () async {
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('daemon-chip')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 600));
      },
    );
  });

  testWidgets('reveal: every stage, a secret, a shiny legendary', (
    tester,
  ) async {
    final app = await _app(const {'daemons': []});
    Future<void> reveal(
      String name,
      String id,
      HatchFrame frame, {
      bool shiny = false,
      Size size = phone,
      String kind = 'first',
    }) => _capture(
      tester,
      'reveal-$name',
      size,
      DaemonHatchReveal(
        roster: _roster,
        egg: ZooEgg(id: 'e', kind: kind, grantedAt: ''),
        result: Future.value(ZooHatch(eggId: 'e', daemonId: id, shiny: shiny)),
        zoo: app.zoo,
        still: frame,
      ),
    );

    final tim = _roster.byId('tim')!;
    final sprite = renderSprite(_roster, tim, 0, DaemonMood.idle);
    await reveal(
      '1-egg',
      'tim',
      HatchFrame(stage: HatchStage.egg, egg: eggFrame(_roster, offset: -1)),
    );
    await reveal(
      '2-crack',
      'tim',
      HatchFrame(stage: HatchStage.egg, egg: eggFrame(_roster, crack: 2)),
    );
    await reveal(
      '3-pop',
      'tim',
      HatchFrame(stage: HatchStage.egg, egg: eggPopFrame(_roster)),
    );
    await reveal(
      '4-silhouette',
      'tim',
      HatchFrame(stage: HatchStage.silhouette, sprite: silhouette(sprite)),
    );
    await reveal(
      '5-colour-blink',
      'tim',
      HatchFrame(
        stage: HatchStage.colour,
        sprite: renderSprite(_roster, tim, 0, DaemonMood.idle, lid: '-'),
      ),
    );
    final timRows = renderBanner(daemonBanner, 'tim').length;
    await reveal(
      '6-banner-typing',
      'tim',
      HatchFrame(stage: HatchStage.banner, sprite: sprite, bannerRows: 2),
    );
    await reveal(
      '6-banner',
      'tim',
      HatchFrame(stage: HatchStage.banner, sprite: sprite, bannerRows: timRows),
    );
    await reveal(
      '7-card',
      'tim',
      HatchFrame(stage: HatchStage.card, sprite: sprite, bannerRows: timRows),
    );
    await reveal(
      '7-card-320',
      'tim',
      HatchFrame(stage: HatchStage.card, sprite: sprite, bannerRows: timRows),
      size: const Size(320, 568),
    );
    // The grue (drop unix, on hold) is the one daemon that only shows in
    // the dark: its reveal starts pitch black, if one ever hatches.
    await reveal(
      'grue-pitch',
      'grue',
      const HatchFrame(stage: HatchStage.pitch),
      kind: 'night',
    );
    final grue = _roster.byId('grue')!;
    final grueSprite = renderSprite(_roster, grue, 0, DaemonMood.idle);
    await reveal(
      'grue-card',
      'grue',
      HatchFrame(
        stage: HatchStage.card,
        sprite: grueSprite,
        bannerRows: renderBanner(daemonBanner, 'grue').length,
      ),
      kind: 'night',
    );
    final beastie = _roster.byId('beastie')!;
    await reveal(
      'beastie-card',
      'beastie',
      HatchFrame(
        stage: HatchStage.card,
        sprite: renderSprite(_roster, beastie, 0, DaemonMood.idle),
        bannerRows: renderBanner(daemonBanner, 'beastie').length,
      ),
      kind: 'night',
    );
    final tux = _roster.byId('tux')!;
    await reveal(
      'tux-shiny-card',
      'tux',
      HatchFrame(
        stage: HatchStage.card,
        sprite: renderSprite(_roster, tux, 0, DaemonMood.idle),
        bannerRows: renderBanner(daemonBanner, 'tux').length,
      ),
      shiny: true,
      kind: 'marathon',
    );
  });

  testWidgets('reveal: every name fits a 320pt screen, drop 1 at full size', (
    tester,
  ) async {
    if (!_realMono) {
      markTestSkipped('no real monospace face on this machine');
      return;
    }
    final app = await _app(const {'daemons': []});
    final banner = find.byKey(const ValueKey('daemon-hatch-banner'));
    for (final d in _roster.daemons) {
      final rows = renderBanner(daemonBanner, d.id);
      await _capture(
        tester,
        'banner-${d.id}-320',
        const Size(320, 568),
        DaemonHatchReveal(
          key: ValueKey(d.id),
          roster: _roster,
          egg: const ZooEgg(id: 'e', kind: 'first', grantedAt: ''),
          result: Future.value(
            ZooHatch(eggId: 'e', daemonId: d.id, shiny: false),
          ),
          zoo: app.zoo,
          still: HatchFrame(
            stage: HatchStage.banner,
            sprite: renderSprite(_roster, d, 0, DaemonMood.idle),
            bannerRows: rows.length,
          ),
        ),
      );
      // Inside the margins, and never wrapped: a banner wider than the 280pt
      // between them (mutt, gopher and beastie of drop init; the held drops'
      // longer names, up to fortune's 43 columns) scales down whole. A name
      // of 25 columns or fewer is drawn at its own size.
      final drawn = tester.getRect(banner);
      final natural = tester.getSize(banner);
      expect(drawn.left, greaterThanOrEqualTo(20), reason: d.id);
      expect(drawn.right, lessThanOrEqualTo(300), reason: d.id);
      expect(
        drawn.height * natural.width,
        closeTo(natural.height * drawn.width, 1),
        reason: d.id,
      );
      final cols = rows.fold(0, (w, r) => r.length > w ? r.length : w);
      if (cols <= 25) {
        expect(natural.width, lessThanOrEqualTo(280), reason: d.id);
      }
      if (natural.width <= 280) {
        expect(drawn.width, closeTo(natural.width, .01), reason: d.id);
      }
    }
  });

  // ── economy v2 ─────────────────────────────────────────────────────────────

  Finder sheetScroll() => find
      .descendant(
        of: find.byKey(const ValueKey('daemon-sheet')),
        matching: find.byType(Scrollable),
      )
      .first;

  Future<void> openSheet(WidgetTester tester) async {
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('daemon-chip')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1200));
  }

  /// Scroll the sheet until [key] is on screen, then [past] points more.
  Future<void> scrollTo(
    WidgetTester tester,
    String key, {
    double past = 0,
  }) async {
    await tester.scrollUntilVisible(
      find.byKey(ValueKey(key)),
      120,
      scrollable: sheetScroll(),
    );
    if (past != 0) {
      await tester.drag(
        find.byKey(const ValueKey('daemon-sheet')),
        Offset(0, -past),
      );
    }
    await tester.pump(const Duration(milliseconds: 600));
  }

  testWidgets('v2 reveal: a duplicate, a serial card, a shiny card', (
    tester,
  ) async {
    final app = await _app({
      'daemons': [_daemon('tim', xp: 150, dupes: 1, shiny: true)],
      'pair': 'tim',
    });
    Future<void> reveal(
      String name,
      String id,
      ZooHatch hatch, {
      String kind = 'turn',
      int? bannerRows,
    }) => _capture(
      tester,
      name,
      phone,
      DaemonHatchReveal(
        key: ValueKey(name),
        roster: _roster,
        egg: ZooEgg(id: 'e', kind: kind, grantedAt: ''),
        result: Future.value(hatch),
        zoo: app.zoo,
        still: HatchFrame(
          stage: HatchStage.card,
          sprite: renderSprite(_roster, _roster.byId(id)!, 0, DaemonMood.idle),
          bannerRows: bannerRows ?? renderBanner(daemonBanner, id).length,
        ),
      ),
      then: () async {
        await tester.pump();
        await tester.pump();
      },
    );

    await reveal(
      'v2-reveal-duplicate-now-shiny-level-up',
      'tim',
      const ZooHatch(
        eggId: 'e',
        daemonId: 'tim',
        shiny: true,
        duplicate: true,
        xp: 150,
        count: 2,
        becameShiny: true,
        levelUp: ZooLevelUp(id: 'tim', level: 2, version: '1.0'),
        versionBefore: '0.1',
      ),
      bannerRows: 0,
    );
    expect(find.text('tim x2 · +150 xp · now shiny'), findsOneWidget);
    await reveal(
      'v2-reveal-duplicate-plain',
      'tim',
      const ZooHatch(
        eggId: 'e',
        daemonId: 'tim',
        shiny: false,
        duplicate: true,
        xp: 150,
        count: 3,
      ),
      bannerRows: 0,
    );
    await reveal(
      'v2-reveal-serial-card',
      'gnu',
      const ZooHatch(eggId: 'e', daemonId: 'gnu', shiny: false, serial: 42),
    );
    await reveal(
      'v2-reveal-shiny-serial-card',
      'tux',
      const ZooHatch(eggId: 'e', daemonId: 'tux', shiny: true, serial: 7),
      kind: 'marathon',
    );
  });

  testWidgets('v2 sheet: shiny chip, serial, shelf, card, setup egg', (
    tester,
  ) async {
    final app = await _app({
      'daemons': [
        _daemon('tim', shiny: true, serial: 42, dupes: 1),
        _daemon('gnu', xp: 150, serial: 1203),
        _daemon('tux', xp: 0, dupes: 3),
        _daemon('beastie', xp: 0),
      ],
      'eggs': [
        {'id': 's', 'kind': 'setup', 'grantedAt': ''},
        {'id': 'w', 'kind': 'week', 'grantedAt': ''},
      ],
      'pair': 'tim',
      'habits': const ['turn', 'split', 'find', 'machine'],
      'firstEgg': true,
    });
    await _capture(tester, 'v2-chip-shiny', header, _screen(app, body: false));
    expect(find.byKey(const ValueKey('daemon-chip-shiny')), findsOneWidget);
    await _capture(
      tester,
      'v2-sheet-shiny-serial',
      phone,
      _screen(app),
      then: () => openSheet(tester),
    );
    await _capture(
      tester,
      'v2-sheet-setup-egg-and-shelf',
      phone,
      _screen(app),
      then: () async {
        await openSheet(tester);
        await scrollTo(tester, 'daemon-hatch-setup', past: -140);
      },
    );
    await _capture(
      tester,
      'v2-sheet-habits-setup',
      phone,
      _screen(app),
      then: () async {
        await openSheet(tester);
        await scrollTo(tester, 'daemon-habits-intro', past: 120);
      },
    );
    await _capture(
      tester,
      'v2-sheet-card-shiny-serial',
      phone,
      _screen(app),
      then: () async {
        await openSheet(tester);
        await scrollTo(tester, 'daemon-card-share', past: 200);
      },
    );
  });

  testWidgets('v2 sheet: the nest names the required habit', (tester) async {
    final app = await _app({
      'daemons': const [],
      'eggs': const [],
      'habits': const ['split', 'find'],
    });
    await _capture(
      tester,
      'v2-sheet-nest-habits',
      phone,
      _screen(app),
      then: () => openSheet(tester),
    );
  });

  testWidgets('v2 sheet: a drop announced but not released', (tester) async {
    final roster = rosterWithDropTwo();
    final backend = FakeZooBackend()
      ..zoo = {
        'daemons': [
          _daemon('tim', serial: 42),
          _daemon('gnu', xp: 150),
          _daemon('tux', xp: 0, dupes: 1),
        ],
        'pair': 'tim',
        'firstEgg': true,
        'setupEgg': true,
      };
    final zoo = ZooClient(
      read: backend.read,
      write: backend.write,
      roster: roster,
    );
    // A day inside drop 2's announcement, once it has dates (see
    // rosterWithDropTwo).
    final face = DaemonFace(zoo, now: () => DateTime.utc(2026, 10, 5));
    addTearDown(() {
      face.dispose();
      zoo.dispose();
    });
    zoo.ensure();
    await _capture(
      tester,
      'v2-sheet-announced-drop',
      phone,
      Scaffold(
        backgroundColor: DaemonInk.ground,
        body: SafeArea(
          child: DaemonSheet(
            face: face,
            facts: () => const DaemonFacts(),
            onHatch: (_) {},
          ),
        ),
      ),
      then: () async {
        await tester.pump();
        await tester.scrollUntilVisible(
          find.byKey(const ValueKey('daemon-shelf-drop-unix')),
          120,
          scrollable: sheetScroll(),
        );
        await tester.drag(
          find.byKey(const ValueKey('daemon-sheet')),
          const Offset(0, -220),
        );
        await tester.pump(const Duration(milliseconds: 600));
      },
    );
    expect(find.text('zoo: drop 2 unix  out 2026-10-15'), findsOneWidget);
  });

  // ── round 4 ────────────────────────────────────────────────────────────────

  testWidgets('r4 consent: after the first hatch, and on its own page', (
    tester,
  ) async {
    final app = await _app(const {'daemons': []});
    final tim = _roster.byId('tim')!;
    Widget reveal() => DaemonHatchReveal(
      roster: _roster,
      egg: const ZooEgg(id: 'e', kind: 'first', grantedAt: ''),
      result: Future.value(
        const ZooHatch(eggId: 'e', daemonId: 'tim', shiny: false),
      ),
      zoo: app.zoo,
      askConsent: true,
      still: HatchFrame(
        stage: HatchStage.consent,
        sprite: renderSprite(_roster, tim, 0, DaemonMood.idle),
      ),
    );
    Future<void> settle() async {
      await tester.pump();
      await tester.pump();
    }

    await _capture(tester, 'r4-consent', phone, reveal(), then: settle);
    expect(find.text('What tim sees'), findsOneWidget);
    // Short: its answer fits a phone's screen without a scroll.
    if (_realMono) {
      expect(
        tester
            .getRect(find.byKey(const ValueKey('daemon-consent-watch')))
            .bottom,
        lessThanOrEqualTo(phone.height),
      );
    }
    await _capture(
      tester,
      'r4-consent-small-phone',
      const Size(375, 667),
      reveal(),
      then: () async {
        await settle();
        await tester.drag(
          find.byKey(const ValueKey('daemon-hatch')),
          const Offset(0, -400),
        );
        await tester.pump(const Duration(milliseconds: 600));
      },
    );
    await _capture(
      tester,
      'r4-consent-320-large-text',
      const Size(320, 568),
      reveal(),
      textScale: 1.5,
      then: settle,
    );
    // The sheet's way to give it: its own page (the grue, in the dark).
    final grue = _roster.byId('grue')!;
    await _capture(
      tester,
      'r4-consent-page-grue',
      phone,
      DaemonConsentPage(
        zoo: app.zoo,
        name: 'grue',
        sprite: renderSprite(_roster, grue, 2, DaemonMood.idle),
        colour: grue.colorFor(shiny: false),
        pitch: true,
      ),
    );
  });

  testWidgets('r4 sheet: watching and the dial, not watching, a need line', (
    tester,
  ) async {
    Future<AppNotifier> app({
      Map<String, dynamic>? consent,
      String autonomy = 'watch',
    }) => _app({
      'daemons': [_daemon('tim', serial: 42), _daemon('gnu', xp: 150)],
      'pair': 'tim',
      'habits': const ['turn', 'split', 'find', 'machine', 'store', 'resume'],
      'firstEgg': true,
      'setupEgg': true,
      'autonomy': autonomy,
      'consent': consent,
    });

    await _capture(
      tester,
      'r4-sheet-watching-autonomy',
      phone,
      _screen(
        await app(
          consent: {'watching': true, 'at': '2026-09-26T12:00:00Z'},
          autonomy: 'suggest',
        ),
      ),
      then: () async {
        await openSheet(tester);
        await scrollTo(tester, 'daemon-autonomy-where', past: 260);
      },
    );
    expect(find.byKey(const ValueKey('daemon-consent-stop')), findsOneWidget);
    await _capture(
      tester,
      'r4-sheet-not-watching',
      phone,
      _screen(await app()),
      then: () async {
        await openSheet(tester);
        await scrollTo(tester, 'daemon-autonomy-where', past: 260);
      },
    );
    expect(find.byKey(const ValueKey('daemon-consent-give')), findsOneWidget);
    await _capture(
      tester,
      'r4-sheet-said-no-320-large-text',
      const Size(320, 640),
      _screen(
        await app(
          consent: {'watching': false, 'at': '2026-09-26T12:00:00Z'},
          autonomy: 'act-within-rules',
        ),
      ),
      textScale: 1.5,
      then: () async {
        await openSheet(tester);
        await scrollTo(tester, 'daemon-watching', past: 20);
      },
    );
    await _capture(
      tester,
      'r4-sheet-need-line',
      phone,
      _screen(await app()),
      then: () async {
        await openSheet(tester);
        _host(tester).face.sync(const DaemonWatch(needs: {'m/a#q'}));
        await tester.pump(const Duration(milliseconds: 400));
      },
    );
    expect(find.text('tim: a harness needs you.  (bell)'), findsOneWidget);
  });

  testWidgets('r4 reveal: a level-up morphs to the new version', (
    tester,
  ) async {
    final app = await _app({
      'daemons': [_daemon('tim', xp: 450, dupes: 1)],
      'pair': 'tim',
    });
    final tim = _roster.byId('tim')!;
    final from = renderSprite(_roster, tim, 1, DaemonMood.idle);
    final to = renderSprite(_roster, tim, 2, DaemonMood.idle);
    final morph = versionMorph(from, to);
    // tim is drawn filled: each frame names the version its plate is at.
    final frames = [
      (from, false, 1),
      for (final (i, frame) in morph.indexed)
        (frame, i < morph.length - 1, i == 0 ? 1 : 2),
    ];
    for (final (i, (sprite, faint, version)) in frames.indexed) {
      await _capture(
        tester,
        'r4-morph-$i',
        phone,
        DaemonHatchReveal(
          key: ValueKey('morph-$i'),
          roster: _roster,
          egg: const ZooEgg(id: 'e', kind: 'turn', grantedAt: ''),
          result: Future.value(
            const ZooHatch(
              eggId: 'e',
              daemonId: 'tim',
              shiny: false,
              duplicate: true,
              xp: 150,
              count: 2,
              levelUp: ZooLevelUp(id: 'tim', level: 4, version: '2.0'),
              versionBefore: '1.0',
            ),
          ),
          zoo: app.zoo,
          still: HatchFrame(
            stage: HatchStage.card,
            sprite: sprite,
            faint: faint,
            version: version,
          ),
        ),
        then: () async {
          await tester.pump();
          await tester.pump();
        },
      );
    }
    expect(find.text('level up · bond 4/4 · now tim 2.0'), findsOneWidget);
  });

  // ── drop init: plates ──────────────────────────────────────────────────────

  testWidgets('plate: every filled daemon in the reveal, at 2.0', (
    tester,
  ) async {
    final app = await _app(const {'daemons': []});
    for (final d in _roster.daemons.where((d) => d.plate)) {
      for (final (name, size) in [
        ('390', phone),
        ('320', const Size(320, 568)),
      ]) {
        await _capture(
          tester,
          'plate-reveal-${d.id}-$name',
          size,
          DaemonHatchReveal(
            key: ValueKey('${d.id} $name'),
            roster: _roster,
            egg: const ZooEgg(id: 'e', kind: 'turn', grantedAt: ''),
            result: Future.value(
              ZooHatch(
                eggId: 'e',
                daemonId: d.id,
                shiny: false,
                duplicate: true,
                xp: 150,
                count: 2,
                versionBefore: '2.0',
              ),
            ),
            zoo: app.zoo,
            still: HatchFrame(
              stage: HatchStage.card,
              sprite: renderSprite(_roster, d, 2, DaemonMood.idle),
            ),
          ),
          then: () async {
            await tester.pump();
            await tester.pump();
          },
        );
        // A phone is wide enough for the reveal plate; it stays inside the
        // reveal's margins, never wrapped.
        final plate = find.byKey(const ValueKey('daemon-hatch-plate'));
        expect(
          tester.widget<DaemonPlateView>(plate).size,
          PlateSize.reveal,
          reason: '${d.id} $name',
        );
        final drawn = tester.getRect(plate);
        expect(drawn.left, greaterThanOrEqualTo(20 - .01), reason: d.id);
        expect(drawn.right, lessThanOrEqualTo(size.width - 20 + .01));
      }
    }
  });

  testWidgets('plate: every filled daemon in its sheet, at 2.0 and shiny', (
    tester,
  ) async {
    for (final d in _roster.daemons.where((d) => d.plate)) {
      for (final shiny in [false, true]) {
        final app = await _app({
          'daemons': [_daemon(d.id, shiny: shiny)],
          'pair': d.id,
          'firstEgg': true,
        });
        await _capture(
          tester,
          'plate-sheet-${d.id}${shiny ? '-shiny' : ''}',
          phone,
          _screen(app),
          then: () async {
            await tester.pump();
            await tester.tap(find.byKey(const ValueKey('daemon-chip')));
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 1200));
          },
        );
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('daemon-portrait')),
            matching: find.byType(DaemonPlateView),
          ),
          findsOneWidget,
        );
      }
    }
  });
}

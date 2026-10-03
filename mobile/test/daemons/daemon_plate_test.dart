// A filled daemon's plate on the phone (drop init): its loop a frame every
// frameMs, frame 0 under Reduce Motion, behind another route or with the app
// in the background; the size the hatch reveal draws it at for the screen;
// and tim at 2.0, idle, in the reveal and the sheet, as the text they draw.
// Set HARNESS_DAEMON_DUMP to a file path to write that text out.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/daemons/plates.dart';
import 'package:harness_mobile/daemons/render.dart';
import 'package:harness_mobile/daemons/roster.dart';
import 'package:harness_mobile/daemons/zoo.dart';
import 'package:harness_mobile/phone/daemon_chip.dart';
import 'package:harness_mobile/phone/daemon_hatch.dart';
import 'package:harness_mobile/phone/daemon_plate.dart';
import 'package:harness_mobile/phone/daemon_scope.dart';

import '../agent_pager_fixture.dart';
import 'zoo_fixture.dart';

final _roster = daemonRoster;
final _tim = _roster.byId('tim')!;

/// What a plate view draws now.
String _drawn(WidgetTester tester, [Finder? of]) {
  final text = tester.widget<Text>(
    find.descendant(
      of: of ?? find.byType(DaemonPlateView),
      matching: find.byType(Text),
    ),
  );
  return text.data ?? text.textSpan!.toPlainText();
}

List<String> _loop(DaemonMood mood, {String version = '2.0'}) => [
  for (final f in daemonPlates.frames('tim', PlateSize.portrait, version, mood))
    f.join('\n'),
];

Widget _plate({
  DaemonMood mood = DaemonMood.idle,
  bool animate = true,
  bool reduceMotion = false,
  bool ticking = true,
}) => MaterialApp(
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
    child: child!,
  ),
  home: TickerMode(
    enabled: ticking,
    child: Center(
      child: DaemonPlateView(
        roster: _roster,
        def: _tim,
        size: PlateSize.portrait,
        version: '2.0',
        mood: mood,
        animate: animate,
      ),
    ),
  ),
);

void main() {
  testWidgets('a plate loops a frame every frameMs, from the top of a mood', (
    tester,
  ) async {
    final idle = _loop(DaemonMood.idle), work = _loop(DaemonMood.work);
    expect(idle, hasLength(8));
    expect(work, hasLength(4));
    expect(daemonPlates.frameMs, 170);
    await tester.pumpWidget(_plate());
    expect(_drawn(tester), idle[0]);
    await tester.pump(const Duration(milliseconds: 169));
    expect(_drawn(tester), idle[0]);
    await tester.pump(const Duration(milliseconds: 1));
    expect(_drawn(tester), idle[1]);
    for (var i = 2; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 170));
      expect(_drawn(tester), idle[i], reason: 'frame $i');
    }
    // The loop comes round.
    await tester.pump(const Duration(milliseconds: 170));
    expect(_drawn(tester), idle[0]);
    await tester.pump(const Duration(milliseconds: 170));
    expect(_drawn(tester), idle[1]);
    // A new mood starts its own loop at its first frame.
    await tester.pumpWidget(_plate(mood: DaemonMood.work));
    expect(_drawn(tester), work[0]);
    await tester.pump(const Duration(milliseconds: 170));
    expect(_drawn(tester), work[1]);
    // A screen with a plate on it still settles between frames.
    await tester.pumpAndSettle();
  });

  testWidgets('Reduce Motion, a route in front, or no motion show frame 0', (
    tester,
  ) async {
    final idle = _loop(DaemonMood.idle);
    for (final (why, widget) in [
      ('Reduce Motion', _plate(reduceMotion: true)),
      ('the background', _plate(animate: false)),
      ('a route in front', _plate(ticking: false)),
    ]) {
      await tester.pumpWidget(widget);
      await tester.pump(const Duration(seconds: 2));
      expect(_drawn(tester), idle[0], reason: why);
    }
    // Moving again, then Reduce Motion mid-loop: back to frame 0, and it
    // stays there.
    await tester.pumpWidget(_plate());
    await tester.pump(const Duration(milliseconds: 510));
    expect(_drawn(tester), idle[3]);
    await tester.pumpWidget(_plate(reduceMotion: true));
    expect(_drawn(tester), idle[0]);
    await tester.pump(const Duration(seconds: 1));
    expect(_drawn(tester), idle[0]);
    // A route coming off it lets it run again.
    await tester.pumpWidget(_plate(ticking: false));
    await tester.pumpWidget(_plate());
    await tester.pump(const Duration(milliseconds: 170));
    expect(_drawn(tester), idle[1]);
  });

  testWidgets('a silhouette is frame 0 as `#`, without colour or motion', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: DaemonPlateView(
          roster: _roster,
          def: _tim,
          size: PlateSize.reveal,
          version: '0.1',
          asSilhouette: true,
        ),
      ),
    );
    final still = daemonPlates.still('tim', PlateSize.reveal, '0.1');
    expect(_drawn(tester), still.map(silhouette).join('\n'));
    await tester.pump(const Duration(seconds: 1));
    expect(_drawn(tester), still.map(silhouette).join('\n'));
    expect(
      tester
          .widget<Text>(
            find.descendant(
              of: find.byType(DaemonPlateView),
              matching: find.byType(Text),
            ),
          )
          .textSpan,
      isNull,
    );
  });

  test('the reveal plate where 56 columns are legible, else the portrait', () {
    // 280pt: a 320pt phone inside the reveal's margins.
    var fit = revealPlateFit(_roster, 280);
    expect(fit.size, PlateSize.reveal);
    expect(fit.fontSize, closeTo(280 / (56 * .6), .001));
    expect(fit.fontSize, greaterThanOrEqualTo(revealMinFont));
    fit = revealPlateFit(_roster, 350);
    expect(fit.size, PlateSize.reveal);
    // A tablet does not blow it up.
    fit = revealPlateFit(_roster, 900);
    expect(fit, (size: PlateSize.reveal, fontSize: revealMaxFont));
    // Narrower than that (a phone split in two): the portrait plate, scaled
    // to the width.
    fit = revealPlateFit(_roster, 250);
    expect(fit.size, PlateSize.portrait);
    expect(fit.fontSize, closeTo(250 / (28 * .6), .001));
  });

  for (final (name, size, plate) in [
    ('a phone', const Size(390, 844), PlateSize.reveal),
    ('a 320pt phone', const Size(320, 568), PlateSize.reveal),
    ('half a phone', const Size(280, 600), PlateSize.portrait),
  ]) {
    testWidgets('the reveal on $name draws its ${plate.name} plate', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = size;
      addTearDown(tester.view.reset);
      final app = pagerApp(PagerConn());
      addTearDown(app.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: DaemonHatchReveal(
            roster: _roster,
            egg: const ZooEgg(id: 'e', kind: 'first', grantedAt: ''),
            result: Future.value(
              const ZooHatch(eggId: 'e', daemonId: 'gopher', shiny: false),
            ),
            zoo: app.zoo,
            still: HatchFrame(
              stage: HatchStage.card,
              sprite: renderSprite(
                _roster,
                _roster.byId('gopher')!,
                0,
                DaemonMood.idle,
              ),
              version: 2,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      expect(tester.takeException(), isNull);
      final view = find.byKey(const ValueKey('daemon-hatch-plate'));
      expect(tester.widget<DaemonPlateView>(view).size, plate);
      expect(tester.widget<DaemonPlateView>(view).version, '2.0');
      // Inside the reveal's 20pt margins.
      final drawn = tester.getRect(view);
      expect(drawn.left, greaterThanOrEqualTo(20 - .01));
      expect(drawn.right, lessThanOrEqualTo(size.width - 20 + .01));
      expect(tester.getSemantics(view).label, 'gopher 2.0');
    });
  }

  testWidgets('tim at 2.0, idle: the reveal and the sheet, as text', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 3200);
    addTearDown(tester.view.reset);
    Widget still(Widget home) => MaterialApp(
      builder: (context, child) => MediaQuery(
        // Frame 0: what Reduce Motion shows, and what a dump can pin.
        data: MediaQuery.of(context).copyWith(disableAnimations: true),
        child: child!,
      ),
      home: home,
    );
    List<String> texts(Finder of) => [
      for (final e
          in find
              .descendant(of: of, matching: find.byType(RichText))
              .evaluate())
        (e.widget as RichText).text.toPlainText(),
    ];

    // The reveal: a duplicate tim, drawn at the 2.0 it forked from.
    final app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    await tester.pumpWidget(
      still(
        DaemonHatchReveal(
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
              versionBefore: '2.0',
            ),
          ),
          zoo: app.zoo,
          still: HatchFrame(
            stage: HatchStage.card,
            sprite: renderSprite(_roster, _tim, 2, DaemonMood.idle),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    final plate = find.byKey(const ValueKey('daemon-hatch-plate'));
    expect(tester.widget<DaemonPlateView>(plate).size, PlateSize.reveal);
    final revealRows = daemonPlates.still('tim', PlateSize.reveal, '2.0');
    expect(_drawn(tester, plate), revealRows.join('\n'));
    final reveal = texts(find.byKey(const ValueKey('daemon-hatch')));
    expect(reveal, contains('fork() returned 0. another tim.'));
    expect(reveal, contains('tim x2 · +150 xp'));

    // The sheet: tim paired at 2.0 (600 xp), content.
    final backend = FakeZooBackend()
      ..zoo = {
        'daemons': [
          {
            'id': 'tim',
            'hatchedAt': '2026-09-27T09:42:00Z',
            'egg': 'first',
            'xp': 600,
            'serial': 1,
          },
        ],
        'pair': 'tim',
        'firstEgg': true,
        'setupEgg': true,
      };
    final host = pagerApp(PagerConn());
    addTearDown(host.dispose);
    host.api = ZooApi(backend);
    host.zoo.ensure();
    await tester.pumpWidget(
      still(
        DaemonHost(
          notifier: host,
          child: const Scaffold(
            body: SafeArea(child: Align(child: DaemonChip())),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('daemon-chip')));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    final portrait = find.descendant(
      of: find.byKey(const ValueKey('daemon-portrait')),
      matching: find.byType(DaemonPlateView),
    );
    expect(tester.widget<DaemonPlateView>(portrait).mood, DaemonMood.idle);
    final portraitRows = daemonPlates.still('tim', PlateSize.portrait, '2.0');
    expect(_drawn(tester, portrait), portraitRows.join('\n'));
    final sheet = texts(find.byKey(const ValueKey('daemon-sheet')));
    expect(sheet, contains('tim: all quiet. eight arms free.'));
    // Its card: the same portrait plate, framed.
    final card = sheet.firstWhere((t) => t.startsWith('.---'));
    for (final row in portraitRows) {
      expect(card, contains(row));
    }

    final out = Platform.environment['HARNESS_DAEMON_DUMP'];
    if (out != null) {
      File(out).writeAsStringSync(
        '== the reveal: tim 2.0, idle, frame 0 (a duplicate, 390pt) ==\n'
        '${reveal.join('\n')}\n\n'
        '== the sheet: tim 2.0, idle, frame 0 (390pt) ==\n'
        '${sheet.join('\n')}\n',
      );
    }
  });
}

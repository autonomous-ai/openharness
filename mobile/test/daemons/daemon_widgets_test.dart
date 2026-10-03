// The daemon where a phone meets it: the chip in the header, its sheet, and
// the full-screen hatch reveal — on a 320pt phone and with large text too —
// and, round 4, the first-day consent after the first hatch, the sheet's
// consent and dial, and a level-up's morph. Drop init: tim and the rest are
// drawn filled, their plates looping in the sheet and the reveal while the
// chip keeps the one-line sprite; drop 2 and 3 are on hold, shown nowhere.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/daemons/card.dart';
import 'package:harness_mobile/daemons/daemon_face.dart';
import 'package:harness_mobile/daemons/daemon_lines.dart';
import 'package:harness_mobile/daemons/plates.dart';
import 'package:harness_mobile/daemons/render.dart';
import 'package:harness_mobile/daemons/roster.dart';
import 'package:harness_mobile/daemons/zoo.dart';
import 'package:harness_mobile/daemons/zoo_client.dart';
import 'package:harness_mobile/phone/daemon_chip.dart';
import 'package:harness_mobile/phone/daemon_hatch.dart';
import 'package:harness_mobile/phone/daemon_plate.dart';
import 'package:harness_mobile/phone/daemon_scope.dart';
import 'package:harness_mobile/phone/daemon_sheet.dart';
import 'package:harness_mobile/phone/daemon_style.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../agent_pager_fixture.dart';
import 'zoo_fixture.dart';

/// Every platform call a test cares about: the clipboard and the haptics.
class _Platform {
  String? clipboard;
  final haptics = <String>[];

  void install(WidgetTester tester) {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        switch (call.method) {
          case 'Clipboard.setData':
            clipboard = (call.arguments as Map)['text'] as String?;
          case 'HapticFeedback.vibrate':
            haptics.add(call.arguments as String);
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
  }
}

Map<String, dynamic> _nest({
  List<String> habits = const [],
  bool egg = false,
}) => {
  'daemons': const [],
  'eggs': [
    if (egg) {'id': 'e0', 'kind': 'first', 'grantedAt': ''},
  ],
  'pair': null,
  'habits': habits,
  'firstEgg': egg,
};

Future<AppNotifier> _pump(
  WidgetTester tester,
  FakeZooBackend backend, {
  Size size = const Size(390, 844),
  double textScale = 1,
  bool reduceMotion = false,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final app = pagerApp(PagerConn());
  addTearDown(app.dispose);
  app.api = ZooApi(backend);
  app.zoo.ensure();
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          textScaler: TextScaler.linear(textScale),
          disableAnimations: reduceMotion,
        ),
        child: child!,
      ),
      home: DaemonHost(
        notifier: app,
        child: const Scaffold(
          body: SafeArea(
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [DaemonChip(), SizedBox(width: 14)],
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  return app;
}

/// The sheet's own scroll view.
final _sheetScroll = find
    .descendant(
      of: find.byKey(const ValueKey('daemon-sheet')),
      matching: find.byType(Scrollable),
    )
    .first;

Future<void> _openSheet(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('daemon-chip')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

/// Walk the reveal to its card, a frame at a time.
Future<void> _toCard(WidgetTester tester) async {
  for (var i = 0; i < 120; i++) {
    if (find.byKey(const ValueKey('daemon-hatch-card')).evaluate().isNotEmpty) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 100));
  }
  fail('the reveal never reached its card');
}

/// The text a plate view draws now: its frame's rows, or its `#` shape.
String _plateText(WidgetTester tester, Finder plate) {
  final text = tester.widget<Text>(
    find.descendant(of: plate, matching: find.byType(Text)),
  );
  return text.data ?? text.textSpan!.toPlainText();
}

/// The portrait in the sheet: a filled daemon's plate view.
final _portraitPlate = find.descendant(
  of: find.byKey(const ValueKey('daemon-portrait')),
  matching: find.byType(DaemonPlateView),
);

void main() {
  late FakeZooBackend backend;
  setUp(() => backend = FakeZooBackend());

  testWidgets('the chip draws the paired sprite and says who it is', (
    tester,
  ) async {
    await _pump(tester, backend);
    final chip = find.byKey(const ValueKey('daemon-chip'));
    expect(chip, findsOneWidget);
    expect(find.text('  (o o)   '), findsOneWidget);
    expect(
      tester.getSemantics(chip).label,
      'tim, tim 0.1, content, 1 egg waiting',
    );
    // Eggs are waiting: a dot on its corner.
    expect(find.byKey(const ValueKey('daemon-chip-eggs')), findsOneWidget);
  });

  testWidgets('no chip outside the shell, or before the zoo answers', (
    tester,
  ) async {
    await tester.pumpWidget(const MaterialApp(home: DaemonChip()));
    expect(find.byKey(const ValueKey('daemon-chip')), findsNothing);

    final app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: DaemonHost(notifier: app, child: const DaemonChip()),
      ),
    );
    expect(find.byKey(const ValueKey('daemon-chip')), findsNothing);
  });

  testWidgets('a tap boops it and opens its sheet', (tester) async {
    final platform = _Platform()..install(tester);
    await _pump(tester, backend);
    await _openSheet(tester);
    expect(platform.haptics, contains('HapticFeedbackType.selectionClick'));
    expect(find.byKey(const ValueKey('daemon-sheet')), findsOneWidget);
    expect(find.byKey(const ValueKey('daemon-name')), findsOneWidget);
    // Booped: the portrait plate loops the boop's frames.
    final plate = tester.widget<DaemonPlateView>(_portraitPlate);
    expect(plate.mood, DaemonMood.boop);
    expect(plate.size, PlateSize.portrait);
    expect(plate.version, '0.1');
    final boop = daemonPlates.frames(
      'tim',
      PlateSize.portrait,
      '0.1',
      DaemonMood.boop,
    );
    expect([
      for (final f in boop) f.join('\n'),
    ], contains(_plateText(tester, _portraitPlate)));
    await tester.pump(const Duration(seconds: 1));
    expect(
      tester.widget<DaemonPlateView>(_portraitPlate).mood,
      DaemonMood.idle,
    );
    // The line is the truth: nothing is waiting on this phone, and tim's idle template has no slots.
    expect(find.byKey(const ValueKey('daemon-line')), findsOneWidget);
    expect(find.textContaining('all quiet. eight arms free.'), findsOneWidget);
    expect(find.textContaining('screen -> tmux -> tim'), findsOneWidget);
    expect(find.textContaining('zoo: drop 1 init  2/9'), findsOneWidget);
    expect(find.text('Hatch'), findsOneWidget);
  });

  testWidgets('only a need or a failure takes the yellow message line', (
    tester,
  ) async {
    await _pump(tester, backend);
    await _openSheet(tester);
    final line = find.byKey(const ValueKey('daemon-line'));
    bool alert() => find
        .descendant(
          of: line,
          matching: find.byWidgetPredicate(
            (w) =>
                w is Container &&
                w.decoration is BoxDecoration &&
                (w.decoration! as BoxDecoration).color == DaemonInk.yellow,
          ),
        )
        .evaluate()
        .isNotEmpty;
    Color? colour() => tester
        .widget<Text>(find.descendant(of: line, matching: find.byType(Text)))
        .style
        ?.color;

    // Booped: it is talking about itself, which needs nobody.
    expect(alert(), isFalse);
    await tester.pump(const Duration(seconds: 1));
    final face = tester.state<DaemonHostState>(find.byType(DaemonHost)).face;
    for (final (watch, mood, loud) in [
      (const DaemonWatch(), DaemonMood.idle, false),
      (const DaemonWatch(working: {'m/a'}), DaemonMood.work, false),
      (const DaemonWatch(needs: {'m/a#q'}), DaemonMood.need, true),
      (const DaemonWatch(failing: {'m/a'}), DaemonMood.fail, true),
      (const DaemonWatch(), DaemonMood.idle, false),
    ]) {
      face.sync(watch);
      await tester.pump();
      expect(face.mood, mood);
      expect(alert(), loud, reason: mood.name);
      // Content is dim text; an alert is dark on the yellow line.
      expect(
        colour(),
        loud ? DaemonInk.pitch : DaemonInk.dim,
        reason: mood.name,
      );
    }
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('the shelf pairs a daemon you own', (tester) async {
    final app = await _pump(tester, backend);
    await _openSheet(tester);
    final gnu = find.byKey(const ValueKey('daemon-shelf-gnu'));
    await tester.ensureVisible(gnu);
    await tester.pumpAndSettle();
    expect(tester.getSemantics(gnu).label, 'gnu');
    await tester.tap(gnu);
    await tester.pump();
    expect(app.zoo.paired!.id, 'gnu');
    await app.zoo.settle();
    expect(backend.written, [
      {'op': 'zoo.pair', 'id': 'gnu'},
    ]);
    await tester.pump();
    expect(tester.getSemantics(gnu).label, 'gnu, paired');
    // Empty slots are numbered; the secret is a `[ ! ]`.
    expect(
      tester
          .getSemantics(find.byKey(const ValueKey('daemon-shelf-init-#03')))
          .label,
      'Number 03, not hatched yet',
    );
    expect(
      tester
          .getSemantics(find.byKey(const ValueKey('daemon-shelf-init-secret')))
          .label,
      'A secret, not found yet',
    );
    // Drops 2 and 3 are on hold: no shelf, no silhouettes, no count.
    expect(find.byKey(const ValueKey('daemon-shelf-drop-unix')), findsNothing);
    expect(find.byKey(const ValueKey('daemon-shelf-drop-tty')), findsNothing);
    expect(find.textContaining('drop 2'), findsNothing);
  });

  testWidgets(
    'two individuals of one species have separate names, traits and pair actions',
    (tester) async {
      const pip = 'aaaaaaaaaaaaaaaaaaaaaaaa', dot = 'bbbbbbbbbbbbbbbbbbbbbbbb';
      backend.zoo = {
        'daemons': [
          {
            'uid': pip,
            'id': 'tim',
            'name': 'pip',
            'seed': 13,
            'serial': 42,
            'hatched': '',
            'egg': 'first',
          },
          {
            'uid': dot,
            'id': 'tim',
            'name': 'dot',
            'seed': 17,
            'serial': 43,
            'hatched': '',
            'egg': 'turn',
          },
        ],
        'paired': pip,
        'eggs': [],
        'firstEgg': true,
        'setupEgg': true,
      };
      final app = await _pump(tester, backend);
      await _openSheet(tester);
      final group = find.byKey(const ValueKey('daemon-individuals-tim'));
      await tester.scrollUntilVisible(group, 200, scrollable: _sheetScroll);
      expect(find.byKey(const ValueKey('daemon-traits-tim')), findsOneWidget);
      expect(find.text('> pip the tim'), findsOneWidget);
      final pick = find.byKey(const ValueKey('daemon-pair-$dot'));
      await tester.scrollUntilVisible(pick, 200, scrollable: _sheetScroll);
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(pick);
      await app.zoo.settle();
      await tester.pump();
      expect(app.zoo.paired!.uid, dot);
      expect(backend.written, contains(equals({'op': 'zoo.pair', 'uid': dot})));
      expect(find.text('> dot the tim'), findsOneWidget);
      expect(find.textContaining('tim -c'), findsWidgets);
      expect(find.textContaining('1 in '), findsWidgets);
    },
  );

  testWidgets(
    'a repeated species hatches a named individual without merging its sibling',
    (tester) async {
      backend.zoo = {
        'daemons': [
          {
            'uid': 'aaaaaaaaaaaaaaaaaaaaaaaa',
            'id': 'tim',
            'name': 'pip',
            'seed': 13,
            'serial': 42,
            'hatched': '',
            'egg': 'first',
          },
        ],
        'paired': 'aaaaaaaaaaaaaaaaaaaaaaaa',
        'eggs': [
          {'id': 'e0', 'kind': 'turn', 'grantedAt': ''},
        ],
        'firstEgg': true,
        'setupEgg': true,
      };
      backend.nextDaemon = 'tim';
      backend.nextSeed = 17;
      backend.nextSerial = 43;
      final app = await _pump(tester, backend, reduceMotion: true);
      await _openSheet(tester);
      await tester.ensureVisible(find.text('Hatch'));
      await tester.tap(find.text('Hatch'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(app.zoo.zoo.daemons, hasLength(2));
      expect(find.byKey(const ValueKey('daemon-hatch-merged')), findsNothing);
      final name = find.byKey(const ValueKey('daemon-hatch-name'));
      await tester.ensureVisible(name);
      await tester.enterText(name, 'dot');
      await tester.pump();
      await tester.ensureVisible(
        find.byKey(const ValueKey('daemon-hatch-done')),
      );
      await tester.tap(find.byKey(const ValueKey('daemon-hatch-done')));
      await app.zoo.settle();
      await tester.pump(const Duration(milliseconds: 300));
      final born = app.zoo.zoo.daemons.last;
      expect(born.title, 'dot the tim');
      expect(born.seed, 17);
      expect(
        backend.written,
        contains(
          equals({'op': 'zoo.nickname', 'uid': born.uid, 'name': 'dot'}),
        ),
      );
      expect(app.zoo.zoo.daemons.first.name, 'pip');
    },
  );

  testWidgets('before any daemon the sheet is the nest and its habits', (
    tester,
  ) async {
    backend.zoo = _nest(habits: const ['turn', 'split', 'find']);
    await _pump(tester, backend);
    // A turn and two more: the egg is ready to arrive.
    expect(find.text(r" \_(*')_/ "), findsOneWidget);
    await _openSheet(tester);
    expect(find.text('A daemon is incubating'), findsOneWidget);
    expect(find.text('[x]'), findsNWidgets(3));
    expect(find.text('[ ]'), findsNWidgets(5));
    expect(find.text('Hatch'), findsNothing);
  });

  testWidgets('hatching: wobble, crack, silhouette, colour, banner, card', (
    tester,
  ) async {
    final platform = _Platform()..install(tester);
    backend.zoo = _nest(
      habits: const ['turn', 'split', 'find', 'machine', 'store'],
      egg: true,
    );
    backend.nextDaemon = 'tim';
    final app = await _pump(tester, backend);
    expect(find.text(r' \_(oo)_/ '), findsOneWidget);
    await _openSheet(tester);
    expect(find.text('Your egg is ready'), findsOneWidget);
    await tester.tap(find.text('Hatch'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const ValueKey('daemon-hatch-egg')), findsOneWidget);
    // The chip keeps the egg while the reveal runs.
    expect(app.zoo.paired!.id, 'tim');

    var sawSilhouette = false, sawBanner = false, sawPlate = false;
    for (var i = 0; i < 80; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      // tim is drawn filled: first its plate's `#` shape, then the plate.
      final shape = find.byKey(const ValueKey('daemon-hatch-sprite'));
      if (shape.evaluate().isNotEmpty &&
          RegExp(r'^[# \n]+$').hasMatch(_plateText(tester, shape))) {
        sawSilhouette = true;
      }
      if (find
          .byKey(const ValueKey('daemon-hatch-plate'))
          .evaluate()
          .isNotEmpty) {
        sawPlate = true;
      }
      if (find
          .byKey(const ValueKey('daemon-hatch-banner'))
          .evaluate()
          .isNotEmpty) {
        sawBanner = true;
      }
      if (find
          .byKey(const ValueKey('daemon-hatch-card'))
          .evaluate()
          .isNotEmpty) {
        break;
      }
    }
    expect(sawSilhouette, isTrue);
    expect(sawPlate, isTrue);
    expect(sawBanner, isTrue);
    expect(platform.haptics, contains('HapticFeedbackType.mediumImpact'));
    // The hatchling's plate: 0.1, in its shiny gradient, looping.
    final plate = tester.widget<DaemonPlateView>(
      find.byKey(const ValueKey('daemon-hatch-plate')),
    );
    expect(plate.version, '0.1');
    expect(plate.shiny, isTrue);
    expect(plate.animate, isTrue);
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('daemon-hatch-stamp')))
          .data,
      '[ * SHINY * COMMON ]  #01/09',
    );
    expect(
      find.textContaining("fork() returned 0. it's a tim."),
      findsOneWidget,
    );
    final card = tester
        .widget<DaemonCardView>(find.byKey(const ValueKey('daemon-hatch-card')))
        .text;
    expect(card, contains('tim 0.1'));
    expect(card, contains('first egg'));

    await tester.ensureVisible(
      find.byKey(const ValueKey('daemon-hatch-share')),
    );
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-share')));
    await tester.pump();
    expect(platform.clipboard, '```\n$card\n```');
    expect(
      find.text('Copied as a code block. Paste it anywhere.'),
      findsOneWidget,
    );

    // The account's first daemon: Done asks whether it may watch.
    await tester.ensureVisible(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-consent')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-close')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('daemon-hatch')), findsNothing);
    await tester.pump(const Duration(seconds: 2));
    final chipText = tester.widget<Text>(
      find
          .descendant(
            of: find.byKey(const ValueKey('daemon-chip')),
            matching: find.byType(Text),
          )
          .last,
    );
    expect(chipText.data, '  (o o)   ');
    // This one hatched shiny: its star before the slot.
    expect(find.byKey(const ValueKey('daemon-chip-shiny')), findsOneWidget);
  });

  testWidgets('a secret starts pitch black', (tester) async {
    backend.zoo = _nest(egg: true);
    backend.nextDaemon = 'grue';
    await _pump(tester, backend);
    await _openSheet(tester);
    await tester.tap(find.text('Hatch'));
    var pitch = false;
    for (var i = 0; i < 60; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      if (find
          .byKey(const ValueKey('daemon-hatch-pitch'))
          .evaluate()
          .isNotEmpty) {
        pitch = true;
        // Nothing of it is shown yet: only the dark.
        expect(find.byKey(const ValueKey('daemon-hatch-sprite')), findsNothing);
        final scaffold = tester.widget<Scaffold>(
          find.byKey(const ValueKey('daemon-hatch')),
        );
        expect(scaffold.backgroundColor, const Color(0xFF000000));
        break;
      }
    }
    expect(pitch, isTrue);
    await _toCard(tester);
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('daemon-hatch-stamp')))
          .data,
      startsWith('[ * SHINY * SECRET ]  #S/09'),
    );
  });

  testWidgets(
    'beastie, a secret out of the dark, starts pitch black and then lights up',
    (tester) async {
      backend.zoo = _nest(egg: true);
      backend.nextDaemon = 'beastie';
      await _pump(tester, backend);
      await _openSheet(tester);
      await tester.tap(find.text('Hatch'));
      var pitch = false;
      for (var i = 0; i < 60; i++) {
        await tester.pump(const Duration(milliseconds: 100));
        if (find
            .byKey(const ValueKey('daemon-hatch-pitch'))
            .evaluate()
            .isNotEmpty) {
          pitch = true;
          // Nothing of it is shown yet: only the dark.
          expect(
            find.byKey(const ValueKey('daemon-hatch-sprite')),
            findsNothing,
          );
          final scaffold = tester.widget<Scaffold>(
            find.byKey(const ValueKey('daemon-hatch')),
          );
          expect(scaffold.backgroundColor, const Color(0xFF000000));
          break;
        }
      }
      expect(pitch, isTrue);
      await _toCard(tester);
      // Unlike the grue, it does not live in the dark: the lights come on.
      expect(
        tester
            .widget<Scaffold>(find.byKey(const ValueKey('daemon-hatch')))
            .backgroundColor,
        isNot(const Color(0xFF000000)),
      );
      expect(find.byKey(const ValueKey('daemon-hatch-pitch')), findsNothing);
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('daemon-hatch-stamp')))
            .data,
        startsWith('[ * SHINY * SECRET ]  #S/09'),
      );
    },
  );

  testWidgets('Reduce Motion goes straight to the card', (tester) async {
    backend.zoo = _nest(egg: true);
    await _pump(tester, backend, reduceMotion: true);
    await _openSheet(tester);
    await tester.tap(find.text('Hatch'));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.byKey(const ValueKey('daemon-hatch-card')), findsOneWidget);
    expect(find.byKey(const ValueKey('daemon-hatch-banner')), findsOneWidget);
  });

  testWidgets('an egg the zoo cannot open stays in the nest', (tester) async {
    backend.zoo = _nest(egg: true);
    final app = await _pump(tester, backend, reduceMotion: true);
    backend.failWrites = true;
    await _openSheet(tester);
    await tester.tap(find.text('Hatch'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.byKey(const ValueKey('daemon-hatch-failed')), findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.pumpAndSettle();
    expect(app.zoo.readyEgg, isNotNull);
  });

  for (final (name, size, scale) in [
    ('a 320pt phone', const Size(320, 568), 1.0),
    ('large text', const Size(390, 844), 2.0),
    ('large text on a 320pt phone', const Size(320, 568), 1.6),
  ]) {
    testWidgets('nothing overflows on $name', (tester) async {
      backend.zoo = {
        ...backend.zoo,
        'daemons': [
          for (final id in ['tim', 'gnu', 'yak', 'beastie', 'gopher'])
            {
              'id': id,
              'hatchedAt': '2026-09-26T09:42:00Z',
              'egg': 'turn',
              'xp': 600,
            },
        ],
        'pair': 'yak',
      };
      // Some of the widest plates of the drop: yak paired at 2.0, tux
      // hatching.
      backend.nextDaemon = 'tux';
      await _pump(tester, backend, size: size, textScale: scale);
      await _openSheet(tester);
      expect(tester.takeException(), isNull);
      await tester.drag(
        find.byKey(const ValueKey('daemon-sheet')),
        const Offset(0, -2000),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
      await tester.drag(
        find.byKey(const ValueKey('daemon-sheet')),
        const Offset(0, 2000),
      );
      await tester.pump();
      await tester.scrollUntilVisible(
        find.text('Hatch'),
        120,
        scrollable: _sheetScroll,
      );
      await tester.ensureVisible(find.text('Hatch').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Hatch').first);
      await _toCard(tester);
      expect(tester.takeException(), isNull);
      // The card keeps its columns: scaled to fit, never wrapped.
      final card = tester.widget<Text>(
        find.descendant(
          of: find.byKey(const ValueKey('daemon-hatch-card')),
          matching: find.byType(Text),
        ),
      );
      expect(card.softWrap, isFalse);
      expect(
        tester.getRect(find.byKey(const ValueKey('daemon-hatch-card'))).width,
        lessThanOrEqualTo(size.width),
      );
    });
  }

  testWidgets('the name is a banner that fits a 320pt screen, never wrapped', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 568);
    addTearDown(tester.view.reset);
    final app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    final banner = find.byKey(const ValueKey('daemon-hatch-banner'));
    final box = find.ancestor(of: banner, matching: find.byType(FittedBox));

    Future<void> still(String id, int rows, {double textScale = 1}) async {
      final def = daemonRoster.byId(id)!;
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(textScale)),
            child: child!,
          ),
          home: DaemonHatchReveal(
            // A still is read once: a new one for every frame.
            key: ValueKey('$id $rows $textScale'),
            roster: daemonRoster,
            egg: const ZooEgg(id: 'e', kind: 'first', grantedAt: ''),
            result: Future.value(
              ZooHatch(eggId: 'e', daemonId: id, shiny: false),
            ),
            zoo: app.zoo,
            still: HatchFrame(
              stage: HatchStage.banner,
              sprite: renderSprite(daemonRoster, def, 0, DaemonMood.idle),
              bannerRows: rows,
            ),
          ),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull, reason: id);
    }

    for (final d in daemonRoster.daemons) {
      final rows = renderBanner(daemonBanner, d.id);
      await still(d.id, rows.length);
      final text = tester.widget<Text>(banner);
      expect(text.data, rows.join('\n'), reason: d.id);
      expect(text.softWrap, isFalse);
      expect(text.textScaler, TextScaler.noScaling);
      expect(text.style!.height, 1.15);
      expect(text.style!.fontSize, 18);
      // One line per row: nothing wrapped, whatever the scale it is drawn at.
      final unwrapped = TextPainter(
        text: TextSpan(text: text.data, style: text.style),
        textDirection: TextDirection.ltr,
      )..layout();
      addTearDown(unwrapped.dispose);
      expect(unwrapped.computeLineMetrics(), hasLength(rows.length));
      expect(tester.getSize(banner), unwrapped.size, reason: d.id);
      // Inside the reveal's 20pt margins: scaled down when it must be.
      final drawn = tester.getRect(box);
      expect(drawn.left, greaterThanOrEqualTo(20 - .01), reason: d.id);
      expect(drawn.right, lessThanOrEqualTo(300 + .01), reason: d.id);
      expect(tester.getSemantics(box).label, d.id);
    }

    // Typing in a row at a time never moves or rescales what is there.
    final rows = renderBanner(daemonBanner, 'grue');
    await still('grue', 1);
    final first = tester.getRect(box);
    expect(tester.widget<Text>(banner).data, rows.first);
    await still('grue', rows.length);
    expect(tester.getRect(box), first);

    // Larger text does not grow art that would only be scaled back down (the
    // words around it grow, and move it).
    await still('grue', rows.length, textScale: 2);
    expect(tester.getRect(box).width, closeTo(first.width, .01));
    expect(tester.getRect(box).height, closeTo(first.height, .01));
  });

  testWidgets('a still of the reveal draws any moment', (tester) async {
    final app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    Future<void> still(String id, HatchFrame frame) async {
      await tester.pumpWidget(
        MaterialApp(
          home: DaemonHatchReveal(
            key: ValueKey('$id ${frame.stage}'),
            roster: daemonRoster,
            egg: const ZooEgg(id: 'e', kind: 'night', grantedAt: ''),
            result: Future.value(
              ZooHatch(eggId: 'e', daemonId: id, shiny: false),
            ),
            zoo: app.zoo,
            still: frame,
          ),
        ),
      );
      await tester.pump();
    }

    // The night egg's moth: its plate's shape, from the plate, not the sprite.
    await still(
      'bug',
      const HatchFrame(stage: HatchStage.silhouette, sprite: '#####'),
    );
    final shape = find.byKey(const ValueKey('daemon-hatch-sprite'));
    expect(
      _plateText(tester, shape),
      daemonPlates
          .still('bug', tester.widget<DaemonPlateView>(shape).size, '0.1')
          .map(silhouette)
          .join('\n'),
    );
    expect(find.bySemanticsLabel('A silhouette'), findsOneWidget);
    // A line-art daemon (drop unix, on hold) still draws the sprite given.
    await still(
      'tmux',
      const HatchFrame(stage: HatchStage.silhouette, sprite: '#####'),
    );
    expect(find.text('#####'), findsOneWidget);
  });

  // ── economy v2 ─────────────────────────────────────────────────────────────

  Map<String, dynamic> daemon(
    String id, {
    int xp = 0,
    bool shiny = false,
    int? serial,
    int? dupes,
    String? origin,
  }) => {
    'id': id,
    'hatchedAt': '2026-09-26T12:00:00Z',
    'egg': 'first',
    'xp': xp,
    'shiny': shiny,
    'serial': ?serial,
    'dupes': ?dupes,
    'origin': ?origin,
  };

  Text chipText(WidgetTester tester) => tester.widget<Text>(
    find
        .descendant(
          of: find.byKey(const ValueKey('daemon-chip')),
          matching: find.byType(Text),
        )
        .last,
  );

  testWidgets('a shiny daemon wears its shiny colour, and a * on the chip', (
    tester,
  ) async {
    backend.zoo = {
      'daemons': [daemon('tim', shiny: true)],
      'pair': 'tim',
      'firstEgg': true,
    };
    await _pump(tester, backend);
    final tim = daemonRoster.byId('tim')!;
    // The star stands before the slot, which stays ten cells.
    final star = find.byKey(const ValueKey('daemon-chip-shiny'));
    expect(tester.widget<Text>(star).data, '*');
    expect(tester.widget<Text>(star).style!.color, tim.colorFor(shiny: true));
    expect(chipText(tester).data, '  (o o)   ');
    expect(chipText(tester).style!.color, tim.colorFor(shiny: true));
    // Every shiny of drop init is gold.
    expect(tim.colorFor(shiny: true), const Color(0xFFD7AF00));
    expect(
      tester.getSemantics(find.byKey(const ValueKey('daemon-chip'))).label,
      'tim, tim 0.1, shiny, content',
    );
    await _openSheet(tester);
    await tester.pump(const Duration(seconds: 1));
    // The portrait plate runs down the shiny gradient.
    expect(tester.widget<DaemonPlateView>(_portraitPlate).shiny, isTrue);
    final plate = tester.widget<Text>(
      find.descendant(of: _portraitPlate, matching: find.byType(Text)),
    );
    final rows = plate.textSpan!.toPlainText().split('\n');
    final colours = <Color>{};
    plate.textSpan!.visitChildren((span) {
      final c = span.style?.color;
      if (c != null) colours.add(c);
      return true;
    });
    for (var r = 0; r < rows.length; r++) {
      for (final ch in rows[r].split('')) {
        if (ch == ' ') continue;
        expect(
          colours,
          contains(
            plateColor(
              daemonRoster,
              tim,
              rows.length,
              r,
              ch,
              ground: DaemonInk.deep,
              shiny: true,
            ),
          ),
        );
      }
    }
    expect(
      colours,
      isNot(contains(plateColor(daemonRoster, tim, rows.length, 0, '#'))),
    );
    expect(find.text('SHINY COMMON  #01/09'), findsOneWidget);
  });

  testWidgets('the sheet shows the serial, its card copies, a guest has none', (
    tester,
  ) async {
    final platform = _Platform()..install(tester);
    backend.zoo = {
      'daemons': [
        daemon('tim', xp: 600, serial: 42, shiny: true),
        daemon('gnu', serial: 9, origin: 'local'),
      ],
      'pair': 'tim',
      'firstEgg': true,
      'setupEgg': true,
    };
    final app = await _pump(tester, backend);
    await _openSheet(tester);
    await tester.pump(const Duration(seconds: 1));
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('daemon-version'))).data,
      '2.0  #0042',
    );
    final card = find.byKey(const ValueKey('daemon-card'));
    await tester.scrollUntilVisible(card, 200, scrollable: _sheetScroll);
    final view = tester.widget<DaemonCardView>(card);
    expect(view.text, contains('tim 2.0  #0042'));
    expect(view.text, contains('SHINY COMMON'));
    expect(view.shiny, isTrue);
    expect(
      tester.getSemantics(card).label,
      'The card: tim, shiny common, #0042',
    );
    // The portrait plate's glyphs wear the shiny gradient; their frame and
    // the words stay ink.
    final rich = tester
        .widget<Text>(find.descendant(of: card, matching: find.byType(Text)))
        .textSpan!;
    final rows = (rich as TextSpan).children!.cast<TextSpan>();
    final tim = daemonRoster.byId('tim')!;
    final portrait = cardPortraitRows(daemonRoster, tim, '2.0');
    final height = portrait.to - portrait.from;
    for (var r = 0; r < height; r++) {
      final row = rows[portrait.from + r];
      expect(row.toPlainText(), '${view.lines[portrait.from + r]}\n');
      for (final run in row.children!.cast<TextSpan>()) {
        final glyphs = run.text!.replaceAll(RegExp(r'[ \n]'), '');
        if (glyphs.isEmpty) continue;
        if (glyphs.contains('|')) {
          expect(run.style, isNull, reason: 'the frame stays ink');
          continue;
        }
        // A run is one colour: glyphs of one brightness share it.
        for (final ch in glyphs.split('')) {
          expect(
            run.style!.color,
            plateColor(
              daemonRoster,
              tim,
              height,
              r,
              ch,
              ground: DaemonInk.deep,
              shiny: true,
            ),
          );
        }
      }
    }
    expect(rows[portrait.to].style, isNull);
    await tester.ensureVisible(find.byKey(const ValueKey('daemon-card-share')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('daemon-card-share')));
    await tester.pump();
    expect(platform.clipboard, fencedCard(view.lines));
    expect(find.text('Copied as a code block.'), findsOneWidget);

    // A guest's daemon, seeded: no serial on its sheet or its card.
    app.zoo.pair('gnu');
    await tester.pump();
    expect(
      tester.widget<DaemonCardView>(card).text,
      isNot(contains(RegExp(r'#\d{4}'))),
    );
    expect(tester.widget<DaemonCardView>(card).serial, isNull);
    await tester.drag(
      find.byKey(const ValueKey('daemon-sheet')),
      const Offset(0, 3000),
    );
    await tester.pump();
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('daemon-version'))).data,
      '0.1',
    );
    await app.zoo.settle();
  });

  testWidgets('the shelf counts duplicates, marks shiny ones and the pair', (
    tester,
  ) async {
    backend.zoo = {
      'daemons': [daemon('tim', dupes: 1, shiny: true), daemon('gnu')],
      'pair': 'tim',
      'firstEgg': true,
      'setupEgg': true,
    };
    await _pump(tester, backend);
    await _openSheet(tester);
    final tim = find.byKey(const ValueKey('daemon-shelf-tim'));
    await tester.scrollUntilVisible(tim, 200, scrollable: _sheetScroll);
    expect(tester.getSemantics(tim).label, 'tim, shiny, 2 of it, paired');
    expect(find.text('> tim* x2'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('daemon-shelf-gnu')),
        matching: find.text('gnu'),
      ),
      findsOneWidget,
    );
    final sprite = tester.widget<Text>(
      find.descendant(of: tim, matching: find.byType(Text)).first,
    );
    expect(
      sprite.style!.color,
      daemonRoster.byId('tim')!.colorFor(shiny: true),
    );
    // One shelf: drop 1 is out, and drops 2 and 3 are on hold.
    expect(find.textContaining('zoo: drop 1 init  2/9'), findsOneWidget);
    expect(find.textContaining('zoo: drop'), findsOneWidget);
  });

  testWidgets('a drop announced but not released shows as silhouettes', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 1600);
    addTearDown(tester.view.reset);
    final roster = rosterWithDropTwo();
    backend.zoo = {
      'daemons': [daemon('tim')],
      'pair': 'tim',
      'firstEgg': true,
      'setupEgg': true,
    };
    Future<void> sheetOn(DateTime day) async {
      final zoo = ZooClient(
        read: backend.read,
        write: backend.write,
        roster: roster,
      );
      final face = DaemonFace(zoo, now: () => day);
      addTearDown(() {
        face.dispose();
        zoo.dispose();
      });
      zoo.ensure();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            key: ValueKey(day),
            backgroundColor: DaemonInk.ground,
            body: DaemonSheet(
              face: face,
              facts: () => const DaemonFacts(),
              onHatch: (_) {},
            ),
          ),
        ),
      );
      await tester.pump();
    }

    // Not announced yet: shown nowhere. Drop 3 stays on hold throughout.
    await sheetOn(DateTime.utc(2026, 9, 30));
    expect(
      find.byKey(const ValueKey('daemon-shelf-drop-init')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('daemon-shelf-drop-unix')), findsNothing);
    expect(find.byKey(const ValueKey('daemon-shelf-drop-tty')), findsNothing);

    // Announced: its regulars as `#` silhouettes, its name and release date.
    await sheetOn(DateTime.utc(2026, 10, 5));
    final unix = find.byKey(const ValueKey('daemon-shelf-drop-unix'));
    await tester.scrollUntilVisible(unix, 200, scrollable: _sheetScroll);
    expect(
      find.descendant(
        of: unix,
        matching: find.text('zoo: drop 2 unix  out 2026-10-15'),
      ),
      findsOneWidget,
    );
    // tmux's 0.1, `[o o]`, as its shape.
    expect(
      find.descendant(of: unix, matching: find.text('## ##')),
      findsWidgets,
    );
    expect(
      tester
          .getSemantics(find.byKey(const ValueKey('daemon-shelf-unix-#01')))
          .label,
      'Number 01 of drop 2 unix, out 2026-10-15',
    );
    expect(
      tester
          .getSemantics(find.byKey(const ValueKey('daemon-shelf-unix-secret')))
          .label,
      'A secret of drop 2 unix, out 2026-10-15',
    );
    expect(find.byKey(const ValueKey('daemon-shelf-drop-tty')), findsNothing);

    // Released: empty slots like any other drop.
    await sheetOn(DateTime.utc(2026, 10, 15));
    await tester.scrollUntilVisible(unix, 200, scrollable: _sheetScroll);
    expect(
      find.descendant(of: unix, matching: find.text('zoo: drop 2 unix  0/9')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: unix, matching: find.text('## ##')),
      findsNothing,
    );
    expect(find.byKey(const ValueKey('daemon-shelf-drop-tty')), findsNothing);
  });

  testWidgets('habits: the copy comes from the rules, then the setup egg', (
    tester,
  ) async {
    final rules = daemonRoster.rules;
    final required = rules.habits
        .firstWhere((h) => rules.firstEggRequire.contains(h.key))
        .label;
    backend.zoo = _nest(habits: const ['turn', 'split']);
    await _pump(tester, backend);
    await _openSheet(tester);
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('daemon-habits-intro')))
          .data,
      'The first egg arrives after any ${rules.firstEggNeed} of these, the '
      'required one included. The setup egg follows at '
      '${rules.setupEggNeed}. 2 done.',
    );
    expect(find.bySemanticsLabel('$required, required, done'), findsOneWidget);
    expect(find.text('Hatch'), findsNothing);
  });

  testWidgets('the setup egg sits in the nest like any other egg', (
    tester,
  ) async {
    final rules = daemonRoster.rules;
    backend.zoo = {
      'daemons': [daemon('tim')],
      'eggs': [
        {'id': 's', 'kind': 'setup', 'grantedAt': ''},
      ],
      'pair': 'tim',
      'habits': ['turn', 'split', 'find', 'machine'],
      'firstEgg': true,
    };
    await _pump(tester, backend);
    await _openSheet(tester);
    await tester.pump(const Duration(seconds: 1));
    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is EggPlateView &&
            widget.kind == 'setup' &&
            widget.stage == 'p4',
      ),
      findsOneWidget,
    );
    expect(find.text('setup egg'), findsOneWidget);
    expect(find.byKey(const ValueKey('daemon-hatch-setup')), findsOneWidget);
    // The setup egg has not been granted yet: the habits say when it comes.
    final intro = find.byKey(const ValueKey('daemon-habits-intro'));
    await tester.scrollUntilVisible(intro, 200, scrollable: _sheetScroll);
    expect(
      tester.widget<Text>(intro).data,
      'The setup egg arrives after any ${rules.setupEggNeed} of these. '
      '4 done.',
    );
  });

  testWidgets('with both habit eggs granted, the habits are gone', (
    tester,
  ) async {
    backend.zoo = {
      'daemons': [daemon('tim')],
      'pair': 'tim',
      'habits': ['turn', 'split', 'find', 'machine', 'store', 'days'],
      'firstEgg': true,
      'setupEgg': true,
    };
    await _pump(tester, backend);
    await _openSheet(tester);
    await tester.drag(
      find.byKey(const ValueKey('daemon-sheet')),
      const Offset(0, -3000),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('daemon-habits-intro')), findsNothing);
    expect(find.text('HABITS'), findsNothing);
  });

  testWidgets('a duplicate says what it merged into, then the level', (
    tester,
  ) async {
    backend.zoo = {
      'daemons': [daemon('tim')],
      'eggs': [
        {'id': 'e1', 'kind': 'turn', 'grantedAt': ''},
      ],
      'pair': 'tim',
      'firstEgg': true,
      'setupEgg': true,
    };
    backend.nextDaemon = 'tim';
    final app = await _pump(tester, backend);
    await _openSheet(tester);
    await tester.tap(find.text('Hatch'));
    var sawBanner = false;
    for (var i = 0; i < 80; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      if (find
          .byKey(const ValueKey('daemon-hatch-banner'))
          .evaluate()
          .isNotEmpty) {
        sawBanner = true;
      }
      if (find
          .byKey(const ValueKey('daemon-hatch-merged'))
          .evaluate()
          .isNotEmpty) {
        break;
      }
    }
    // No name to reveal, and no new daemon's card.
    expect(sawBanner, isFalse);
    expect(find.byKey(const ValueKey('daemon-hatch-card')), findsNothing);
    expect(find.byKey(const ValueKey('daemon-hatch-share')), findsNothing);
    expect(find.text('fork() returned 0. another tim.'), findsOneWidget);
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('daemon-hatch-merged')))
          .data,
      'tim x2 · +${daemonRoster.rules.duplicateXp} xp · now shiny',
    );
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('daemon-hatch-level')))
          .data,
      'level up · bond 2/4 · now tim 1.0',
    );
    await tester.ensureVisible(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.pumpAndSettle();
    expect(app.zoo.zoo.daemon('tim')!.dupes, 1);
    // The chip: the same daemon, grown and now shiny.
    await tester.pump(const Duration(seconds: 2));
    expect(chipText(tester).data, ' ,(o o),  ');
    expect(find.byKey(const ValueKey('daemon-chip-shiny')), findsOneWidget);
  });

  testWidgets('a new daemon\'s card carries its serial', (tester) async {
    backend.zoo = _nest(egg: true);
    backend.nextDaemon = 'tim';
    backend.nextSerial = 42;
    backend.nextShiny = false;
    await _pump(tester, backend, reduceMotion: true);
    await _openSheet(tester);
    await tester.tap(find.text('Hatch'));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    final card = tester.widget<DaemonCardView>(
      find.byKey(const ValueKey('daemon-hatch-card')),
    );
    expect(card.text, contains('tim 0.1  #0042'));
    expect(card.shiny, isFalse);
    expect(card.serial, 42);
  });

  testWidgets('an egg that became xp shows as +xp, not as an egg', (
    tester,
  ) async {
    backend.grants = [
      {'kind': 'turn', 'xp': 50},
    ];
    final app = await _pump(tester, backend);
    final eggs = app.zoo.zoo.eggs.length;
    app.zoo.habit('find');
    await app.zoo.settle();
    await tester.pump();
    expect(app.zoo.zoo.eggs, hasLength(eggs));
    await _openSheet(tester);
    await tester.pump(const Duration(seconds: 1));
    expect(
      find.text('+50 xp · a turn egg, with no room to hold it'),
      findsOneWidget,
    );
    // Seen once: closing the sheet forgets it.
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();
    expect(app.zoo.xpGrants, isEmpty);
  });

  // ── round 4: consent, the dial, the level-up morph ─────────────────────────

  /// Open the only egg and walk the reveal to its card.
  Future<void> hatchToCard(WidgetTester tester) async {
    await _openSheet(tester);
    await tester.tap(find.text('Hatch'));
    await tester.pump();
    await _toCard(tester);
    await tester.pumpAndSettle();
  }

  List<Map<String, dynamic>> consentOps() => [
    for (final op in backend.written)
      if (op['op'] == 'zoo.consent') op,
  ];

  testWidgets('the first hatch asks, after its card, whether it may watch', (
    tester,
  ) async {
    backend.zoo = _nest(egg: true);
    backend.nextDaemon = 'tim';
    final app = await _pump(tester, backend, reduceMotion: true);
    await hatchToCard(tester);
    expect(find.byKey(const ValueKey('daemon-consent')), findsNothing);
    await tester.ensureVisible(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.pump();
    // The same full screen, now asking.
    expect(find.byKey(const ValueKey('daemon-hatch')), findsOneWidget);
    expect(find.byKey(const ValueKey('daemon-consent')), findsOneWidget);
    expect(find.text('What tim sees'), findsOneWidget);
    expect(
      find.text('Nothing here happens until you say yes.'),
      findsOneWidget,
    );
    for (final heading in [
      'WHAT IT READS',
      'WHAT IT WRITES',
      'WHERE IT RUNS',
    ]) {
      expect(find.text(heading), findsOneWidget);
    }
    expect(
      find.text('Nothing until you allow it. Then, on that computer:'),
      findsOneWidget,
    );
    expect(find.text('lessons, only with your yes'), findsOneWidget);
    expect(consentOps(), isEmpty);

    await tester.ensureVisible(
      find.byKey(const ValueKey('daemon-consent-watch')),
    );
    await tester.tap(find.byKey(const ValueKey('daemon-consent-watch')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('daemon-hatch')), findsNothing);
    await app.zoo.settle();
    expect(consentOps(), [
      {'op': 'zoo.consent', 'watching': true},
    ]);
    expect(app.zoo.zoo.watching, isTrue);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('"Not now" sends nothing, and the question stays open', (
    tester,
  ) async {
    backend.zoo = _nest(egg: true);
    backend.nextDaemon = 'tim';
    final app = await _pump(tester, backend, reduceMotion: true);
    await hatchToCard(tester);
    await tester.ensureVisible(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.pump();
    await tester.ensureVisible(
      find.byKey(const ValueKey('daemon-consent-not-now')),
    );
    await tester.tap(find.byKey(const ValueKey('daemon-consent-not-now')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('daemon-hatch')), findsNothing);
    await app.zoo.settle();
    expect(consentOps(), isEmpty);
    expect(app.zoo.zoo.consent, isNull);
    // The sheet can let it later.
    await _openSheet(tester);
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('daemon-consent-give')),
      120,
      scrollable: _sheetScroll,
    );
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('daemon-watching'))).data,
      'tim watches nothing until you say yes.',
    );
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('no question when it was already given', (tester) async {
    // Given on a computer before this phone's first hatch.
    backend.zoo = {
      ..._nest(egg: true),
      'consent': {'watching': true, 'at': '2026-09-28T12:00:00Z'},
    };
    backend.nextDaemon = 'tim';
    await _pump(tester, backend, reduceMotion: true);
    await hatchToCard(tester);
    await tester.ensureVisible(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('daemon-hatch')), findsNothing);
    expect(find.byKey(const ValueKey('daemon-consent')), findsNothing);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('a later hatch never asks', (tester) async {
    backend.nextSerial = 9;
    await _pump(tester, backend, reduceMotion: true);
    await hatchToCard(tester);
    await tester.ensureVisible(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('daemon-hatch')), findsNothing);
    expect(find.byKey(const ValueKey('daemon-consent')), findsNothing);
    expect(consentOps(), isEmpty);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('the sheet gives and withdraws consent, and reads the dial', (
    tester,
  ) async {
    backend.zoo = {
      ...backend.zoo,
      'autonomy': 'suggest',
      'consent': {'watching': true, 'at': '2026-09-28T12:00:00Z'},
    };
    backend.consentAt = '2026-09-29T12:00:00Z';
    final app = await _pump(tester, backend);
    await _openSheet(tester);
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('daemon-autonomy-where')),
      120,
      scrollable: _sheetScroll,
    );
    Text text(String key) => tester.widget<Text>(find.byKey(ValueKey(key)));
    expect(
      text('daemon-watching').data,
      'tim watches the coding agents on your computers, since 2026-09-28.',
    );
    // The dial, read only: its level, the floor, and where it turns.
    expect(
      text('daemon-autonomy').textSpan!.toPlainText(),
      'suggest  2/4  It recommends; every action waits for your key.',
    );
    expect(
      text('daemon-autonomy-floor').data,
      'At every level tim never pushes, deletes, force-pushes or bypasses '
      'permissions.',
    );
    expect(
      text('daemon-autonomy-where').data,
      'Change it at a computer, where each step up waits for your yes.',
    );
    expect(
      find.bySemanticsLabel(
        'Autonomy: suggest, 2 of 4. '
        'It recommends; every action waits for your key.',
      ),
      findsOneWidget,
    );

    // Withdrawn with one tap.
    await tester.tap(find.byKey(const ValueKey('daemon-consent-stop')));
    await tester.pump();
    // Shown at once.
    expect(find.byKey(const ValueKey('daemon-consent-give')), findsOneWidget);
    await app.zoo.settle();
    await tester.pump();
    expect(consentOps(), [
      {'op': 'zoo.consent', 'watching': false},
    ]);
    expect(
      text('daemon-watching').data,
      'tim watches nothing: you said no on 2026-09-29.',
    );
    // Its dial is the account's: a no leaves it where it was.
    expect(
      text('daemon-autonomy').textSpan!.toPlainText(),
      startsWith('suggest'),
    );

    // Given again: the consent screen first, over the sheet.
    await tester.tap(find.byKey(const ValueKey('daemon-consent-give')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('daemon-consent-page')), findsOneWidget);
    expect(find.text('What tim sees'), findsOneWidget);
    await tester.ensureVisible(
      find.byKey(const ValueKey('daemon-consent-watch')),
    );
    await tester.tap(find.byKey(const ValueKey('daemon-consent-watch')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('daemon-consent-page')), findsNothing);
    await app.zoo.settle();
    await tester.pump();
    expect(consentOps().last, {'op': 'zoo.consent', 'watching': true});
    // A yes starts the dial at watch.
    expect(
      text('daemon-autonomy').textSpan!.toPlainText(),
      'watch  1/4  It reads and tells you. Nothing else.',
    );
    expect(find.byKey(const ValueKey('daemon-consent-stop')), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('the sheet\'s line for a need is facts first, then the tag', (
    tester,
  ) async {
    await _pump(tester, backend);
    await _openSheet(tester);
    await tester.pump(const Duration(seconds: 1));
    final face = tester.state<DaemonHostState>(find.byType(DaemonHost)).face;
    face.sync(const DaemonWatch(needs: {'m/a#q'}));
    await tester.pump();
    // Nothing on this phone says who asked: the phone's facts, tim's tag.
    expect(find.text('tim: a harness needs you.  (bell)'), findsOneWidget);
    face.sync(const DaemonWatch(failing: {'m/a'}));
    await tester.pump();
    expect(find.text('tim: something failed.  (pane is dead)'), findsOneWidget);
  });

  /// The reveal's hatchling as drawn now, and whether it is faint: a line
  /// sprite's text, or for a filled daemon `plate <version>` (in colour) and
  /// `# <version>` (its shape).
  (String, bool) revealSprite(WidgetTester tester) {
    final plate = find.byKey(const ValueKey('daemon-hatch-plate'));
    if (plate.evaluate().isNotEmpty) {
      return ('plate ${tester.widget<DaemonPlateView>(plate).version}', false);
    }
    final sprite = find.byKey(const ValueKey('daemon-hatch-sprite'));
    final widget = tester.widget(sprite);
    if (widget is DaemonPlateView) {
      expect(widget.asSilhouette, isTrue);
      return ('# ${widget.version}', true);
    }
    final text = widget as Text;
    return (text.data!, (text.style!.color!.a) < 1);
  }

  Map<String, dynamic> duplicateZoo({int xp = 0, String id = 'tim'}) => {
    'daemons': [daemon(id, xp: xp)],
    'eggs': [
      {'id': 'e1', 'kind': 'turn', 'grantedAt': ''},
    ],
    'pair': 'tim',
    'firstEgg': true,
    'setupEgg': true,
    'consent': {'watching': true, 'at': '2026-09-28T12:00:00Z'},
  };

  testWidgets('a level-up morphs the sprite to its new version', (
    tester,
  ) async {
    backend.zoo = duplicateZoo();
    backend.nextDaemon = 'tim';
    await _pump(tester, backend);
    await _openSheet(tester);
    await tester.tap(find.text('Hatch'));
    final seen = <(String, bool)>[];
    for (var i = 0; i < 500; i++) {
      await tester.pump(const Duration(milliseconds: 20));
      if (find.byKey(const ValueKey('daemon-hatch-level')).evaluate().isEmpty) {
        continue;
      }
      final now = revealSprite(tester);
      if (seen.isEmpty || seen.last != now) seen.add(now);
      if (now.$1 == 'plate 1.0') break;
    }
    // The 0.1 plate it was, its shape, the 1.0 plate's shape, then the 1.0
    // plate: three quick frames.
    expect(seen, [
      ('plate 0.1', false),
      ('# 0.1', true),
      ('# 1.0', true),
      ('plate 1.0', false),
    ]);
    expect(find.bySemanticsLabel('tim 1.0'), findsOneWidget);
    // It stays grown.
    await tester.pump(const Duration(seconds: 1));
    expect(revealSprite(tester), ('plate 1.0', false));
    // A duplicate is never asked about, even though it is a card's Done.
    await tester.ensureVisible(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('daemon-hatch')), findsNothing);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('Reduce Motion shows the new version straight away', (
    tester,
  ) async {
    backend.zoo = duplicateZoo();
    backend.nextDaemon = 'tim';
    await _pump(tester, backend, reduceMotion: true);
    await _openSheet(tester);
    await tester.tap(find.text('Hatch'));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.byKey(const ValueKey('daemon-hatch-level')), findsOneWidget);
    expect(revealSprite(tester), ('plate 1.0', false));
    await tester.pump(const Duration(seconds: 2));
    expect(revealSprite(tester), ('plate 1.0', false));
    // Reduce Motion: the plate holds its first frame.
    final plate = find.byKey(const ValueKey('daemon-hatch-plate'));
    expect(
      _plateText(tester, plate),
      tester.widget<DaemonPlateView>(plate).loop.first.join('\n'),
    );
  });

  testWidgets('a duplicate is drawn at its version; no new one, no morph', (
    tester,
  ) async {
    // 150 xp is 1.0 at bond 2; 150 more is bond 3, still 1.0.
    backend.zoo = duplicateZoo(xp: 150);
    backend.nextDaemon = 'tim';
    await _pump(tester, backend);
    await _openSheet(tester);
    await tester.tap(find.text('Hatch'));
    final seen = <String>{};
    for (var i = 0; i < 200; i++) {
      await tester.pump(const Duration(milliseconds: 50));
      if (find
          .byKey(const ValueKey('daemon-hatch-level'))
          .evaluate()
          .isNotEmpty) {
        seen.add(revealSprite(tester).$1);
      }
    }
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('daemon-hatch-level')))
          .data,
      'level up · bond 3/4',
    );
    expect(seen, {'plate 1.0'});
  });

  testWidgets('a line-art daemon still morphs its sprite', (tester) async {
    // tmux, the tim that was, of drop unix (on hold): if a zoo from before
    // ever pairs one, it grows as it always did.
    backend.zoo = duplicateZoo(id: 'tmux');
    backend.nextDaemon = 'tmux';
    await _pump(tester, backend);
    await _openSheet(tester);
    await tester.tap(find.text('Hatch'));
    final seen = <(String, bool)>[];
    for (var i = 0; i < 500; i++) {
      await tester.pump(const Duration(milliseconds: 20));
      if (find.byKey(const ValueKey('daemon-hatch-level')).evaluate().isEmpty) {
        continue;
      }
      final now = revealSprite(tester);
      if (seen.isEmpty || seen.last != now) seen.add(now);
      if (now.$1 == '[o|o]') break;
    }
    expect(seen, [
      ('[o o]', false),
      ('## ##', true),
      ('#####', true),
      ('[o|o]', false),
    ]);
    expect(find.byKey(const ValueKey('daemon-hatch-plate')), findsNothing);
    await tester.ensureVisible(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.tap(find.byKey(const ValueKey('daemon-hatch-done')));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 1));
  });
}

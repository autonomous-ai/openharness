import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' show PointerDeviceKind;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/status_line_style.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/machine_details.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/section_heading.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/engine_identity.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

Future<void> _openAddMachineDialog(
  WidgetTester tester,
  SuperTabLaunchFixture f,
  dynamic c, {
  Brightness brightness = Brightness.dark,
  double textScale = 1,
}) async {
  final previousBrightness = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previousBrightness);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: Scaffold(
        body: SizedBox(
          width: 300,
          height: 400,
          child: SuperTabMachines(
            controller: c,
            app: f.app,
            onAddAgent: (_) {},
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip('Add machine'));
  await tester.pumpAndSettle();
}

final _picker = find.byKey(const ValueKey('swarm-machine-picker'));

/// What hovering or focusing a machine row says.
String _tipOf(WidgetTester tester, Finder row) => tester
    .widget<Tooltip>(
      find.ancestor(of: row, matching: find.byType(Tooltip)).first,
    )
    .message!;

/// The words on a machine's line: its name, and its owner's when the name is shared.
String _lineOf(WidgetTester tester, String id) => find
    .descendant(
      of: find.byKey(ValueKey('super-machine-$id')),
      matching: find.byType(RichText),
    )
    .evaluate()
    .map((e) => (e.widget as RichText).text.toPlainText())
    .join();

Finder _option(String id) => find.byKey(ValueKey('swarm-machine-option-$id'));

void main() {
  final capture = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
  setUpAll(() => loadCaptureFonts(capture));
  test('a computer is shown by its real hostname without ".local", and a name a person chose stays as it is', () {
    for (final (hostname, shown) in [
      ('MacBookPro2021.local', 'MacBookPro2021'),
      ('MacBooks-MacBook-Pro-19.local', 'MacBooks-MacBook-Pro-19'),
      ('MacbookPro.local', 'MacbookPro'),
      ('Mac-mini.local', 'Mac-mini'),
      ('build-server.LOCAL', 'build-server'),
    ]) {
      expect(superTabMachineName(hostname), shown);
    }
    for (final name in [
      'Ada’s Mac',
      'M2',
      'MacBook Pro lab',
      'Build server',
      'locally.local.test',
      '.local',
    ]) {
      expect(superTabMachineName(name), name);
    }
  });
  testWidgets(
    'a machine is one line; its numbers and age are in its tooltip, and an offline one waits under "Offline · 1"',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(280, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer();
      final now = DateTime.now().millisecondsSinceEpoch;
      server.state['machines'] = [
        for (final live in [true, false])
          {
            'machineId': live ? 'online' : 'offline',
            'name': live ? 'Studio Mac' : 'M2',
            'contributorId': 'owner',
            'observation': {
              'receivedAt': now - (live ? 0 : 60000),
              'resources': {
                'cpuPercent': 0,
                'memoryTotalBytes': 32000000000,
                'memoryUsedBytes': 32000000000,
                'diskTotalBytes': 1000000000000,
                'diskFreeBytes': 141000000000,
              },
              'quotas': [
                {'engine': 'claude', 'known': false, 'windows': []},
                {
                  'engine': 'codex',
                  'known': true,
                  'windows': [
                    {'name': '5-hour', 'usedPercent': 0},
                  ],
                },
              ],
            },
          },
      ];
      final c = server.controller();
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final offline = find.byKey(const ValueKey('super-machine-offline'));
      final online = find.byKey(const ValueKey('super-machine-online'));
      // The line shows the one known allowance, Codex's, and no hardware number or age; the row's tooltip
      // says whose machine it is and its hardware.
      expect(find.textContaining('CPU'), findsNothing);
      expect(find.textContaining('GB'), findsNothing);
      expect(find.textContaining('ago'), findsNothing);
      expect(
        tester
            .widget<EngineMark>(
              find.descendant(of: online, matching: find.byType(EngineMark)),
            )
            .engine,
        'codex',
      );
      expect(
        find.descendant(of: online, matching: find.text('100%')),
        findsOneWidget,
      );
      expect(
        _tipOf(tester, online),
        'Owned by owner · CPU 100% free · RAM 0 GB free · SSD 141 GB free',
      );
      expect(tester.getSize(online).height, 36);
      // Offline machines start out of sight, under their disclosure.
      expect(offline, findsNothing);
      expect(find.text('Offline · 1'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('super-machines-offline')));
      await tester.pumpAndSettle();
      expect(c.offlineMachinesOpen, isTrue);
      // Offline: its state in words, never when it was last seen, and no allowance chip.
      expect(
        _tipOf(tester, offline),
        'Offline · Owned by owner · CPU 100% free · RAM 0 GB free · SSD 141 GB free',
      );
      expect(
        find.descendant(of: offline, matching: find.byType(EngineMark)),
        findsNothing,
      );
      expect(
        tester.getTopLeft(offline).dy,
        greaterThan(tester.getTopLeft(online).dy),
      );
      // The entire row opens its details, including keyboard activation.
      Focus.of(tester.element(find.text('Studio Mac'))).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Available capacity'), findsOneWidget);
      expect(find.text('CPU'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(SuperTabMachineDetails),
          matching: find.text('100%'),
        ),
        findsOneWidget,
      );
      expect(find.text('0 GB of 32 GB'), findsOneWidget);
      expect(find.text('141 GB of 1000 GB'), findsOneWidget);
      expect(find.textContaining('GPU'), findsNothing);
      expect(find.text('—'), findsNothing);
      expect(find.text('100% left'), findsOneWidget);
      expect(
        tester
            .widget<EngineMark>(
              find.descendant(
                of: find.byType(AlertDialog),
                matching: find.byType(EngineMark),
              ),
            )
            .engine,
        'codex',
      );
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      await tester.tap(offline);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(
        (tester.widget<AlertDialog>(find.byType(AlertDialog)).title! as Text)
            .data,
        'M2',
      );
      expect(find.text('Available capacity'), findsNothing);
      expect(find.text('Model allowances'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets(
    'online machines come first by name; offline ones follow under a closed, saved "Offline · N"',
    (tester) async {
      final server = ConversationServer();
      final now = DateTime.now().millisecondsSinceEpoch;
      Map<String, dynamic> machine(String id, String name, int ageMs) => {
        'machineId': id,
        'name': name,
        'contributorId': 'owner',
        'observation': {'receivedAt': now - ageMs},
      };
      server.state['machines'] = [
        machine('z', 'Zed Mac', 0),
        machine('g', 'Gamma', 600000),
        machine('a', 'alpha Mac', 25000),
        machine('b', 'Beta', 600000),
      ];
      final c = server.controller();
      await c.refresh();
      Future<void> show() async {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: ListenableBuilder(
                listenable: c,
                builder: (context, _) => SuperTabMachines(
                  controller: c,
                  embedded: true,
                  onAddAgent: (_) {},
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      double y(String key) => tester.getTopLeft(find.byKey(ValueKey(key))).dy;
      await show();
      // Late is online too; case does not decide the order.
      expect(y('super-machine-a'), lessThan(y('super-machine-z')));
      expect(y('super-machine-z'), lessThan(y('super-machines-offline')));
      expect(find.text('Offline · 2'), findsOneWidget);
      expect(find.byKey(const ValueKey('super-machine-b')), findsNothing);
      expect(find.byKey(const ValueKey('super-machine-g')), findsNothing);

      await tester.tap(find.byKey(const ValueKey('super-machines-offline')));
      await tester.pumpAndSettle();
      expect(y('super-machines-offline'), lessThan(y('super-machine-b')));
      expect(y('super-machine-b'), lessThan(y('super-machine-g')));

      // Saved, and read back by the next controller for this Swarm.
      await c.flush();
      expect(server.saved!['offlineMachinesOpen'], isTrue);
      final reopened = server.controller(initial: server.saved!);
      expect(reopened.offlineMachinesOpen, isTrue);
      reopened.dispose();
      expect(server.controller().offlineMachinesOpen, isFalse);

      // Nothing offline, no disclosure.
      server.state['machines'] = [machine('z', 'Zed Mac', 0)];
      await c.refresh();
      await show();
      expect(
        find.byKey(const ValueKey('super-machines-offline')),
        findsNothing,
      );

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets(
    'two machines of one model keep their real names, and a row never names its owner; its tooltip does',
    (tester) async {
      final server = ConversationServer();
      final now = DateTime.now().millisecondsSinceEpoch;
      server.state['people'] = [
        {'id': 'tony', 'email': 'tony@example.com', 'role': 'owner'},
        {'id': 'dee', 'email': 'dee@example.com', 'role': 'collaborator'},
      ];
      Map<String, dynamic> machine(String id, String name, String owner) => {
        'machineId': id,
        'name': name,
        'contributorId': owner,
        'observation': {'receivedAt': now},
      };
      server.state['machines'] = [
        machine('t', 'MacBooks-MacBook-Pro-9.local', 'tony'),
        machine('d', 'MacBook Pro', 'dee'),
      ];
      final c = server.controller();
      await c.refresh();
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // Two MacBook Pros keep their real names, never a model name or an owner.
      expect(_lineOf(tester, 't'), 'MacBooks-MacBook-Pro-9');
      expect(_lineOf(tester, 'd'), 'MacBook Pro');
      expect(find.textContaining('tony'), findsNothing);
      expect(find.textContaining('dee'), findsNothing);
      final row = find.byKey(const ValueKey('super-machine-t'));
      expect(_tipOf(tester, row), 'Owned by tony');
      expect(
        tester.getSemantics(row).label,
        startsWith('MacBooks-MacBook-Pro-9, Live, Owned by tony'),
      );
      semantics.dispose();
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets(
    'agents: up to three overlapping avatars then +N, centered on the + column; none shows nothing',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(320, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer();
      final now = DateTime.now().millisecondsSinceEpoch;
      server.state['agents'] = [
        for (final (machine, count) in [('five', 5), ('two', 2)])
          for (var i = 0; i < count; i++)
            {
              'id': '$machine-$i',
              'name': 'Harness $i',
              'displayName': '${machine == 'five' ? 'Five' : 'Two'} $i',
              'machineId': machine,
              'harnessId': 'native-$machine-$i',
              'contributorId': 'owner',
              'configuration': {'engine': 'codex'},
            },
      ];
      server.state['machines'] = [
        for (final id in ['five', 'two', 'none'])
          {
            'machineId': id,
            'name': id,
            'contributorId': 'owner',
            'observation': {'receivedAt': now},
          },
      ];
      final c = server.controller();
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(
              controller: c,
              embedded: true,
              onAddAgent: (_) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Finder inRow(String id, Finder finder) => find.descendant(
        of: find.byKey(ValueKey('super-machine-$id')),
        matching: finder,
      );
      List<Rect> avatars(String id) => [
        for (final e in inRow(id, find.byType(SuperTabAvatar)).evaluate())
          tester.getRect(find.byWidget(e.widget)),
      ]..sort((a, b) => a.left.compareTo(b.left));

      final five = avatars('five');
      expect(five, hasLength(3));
      expect(inRow('five', find.text('+2')), findsOneWidget);
      for (var i = 1; i < five.length; i++) {
        expect(five[i].left - five[i - 1].left, closeTo(13, .01));
      }
      expect(five.first.width, 16);
      final rowFive = tester.getRect(
        find.byKey(const ValueKey('super-machine-five')),
      );
      for (final a in five) {
        expect(a.center.dy, closeTo(rowFive.center.dy, .5));
      }
      // The agents column ends half an avatar past the heading's + (embedded: 16 from the edge), so +2 ends there.
      expect(
        tester.getRect(inRow('five', find.text('+2'))).right,
        closeTo(rowFive.right - 16 + 9, .5),
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('super-machine-agents-five')),
          matching: find.byType(SuperTabAvatar),
        ),
        findsNWidgets(3),
      );
      expect(
        find.byTooltip(
          [for (var i = 0; i < 5; i++) 'Five $i — Engineer'].join('\n'),
        ),
        findsOneWidget,
      );

      final two = avatars('two');
      expect(two, hasLength(2));
      expect(inRow('two', find.textContaining('+')), findsNothing);
      final rowTwo = tester.getRect(
        find.byKey(const ValueKey('super-machine-two')),
      );
      expect(two.last.center.dx, closeTo(rowTwo.right - 16, .5));

      expect(avatars('none'), isEmpty);
      expect(
        find.byKey(const ValueKey('super-machine-agents-none')),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets(
    'each known, unexpired allowance is a chip, Claude first: amber under 20%, red under 10%, its windows on hover',
    (tester) async {
      final server = ConversationServer();
      final now = DateTime.now();
      final at = now.millisecondsSinceEpoch;
      Map<String, dynamic> quota(
        String engine,
        int used, {
        bool known = true,
        DateTime? resetsAt,
      }) => {
        'engine': engine,
        'known': known,
        'windows': [
          {
            'name': '5-hour',
            'usedPercent': used,
            'resetsAt': (resetsAt ?? now.add(const Duration(hours: 2)))
                .millisecondsSinceEpoch,
          },
        ],
      };
      Map<String, dynamic> machine(
        String id,
        List<Map<String, dynamic>> quotas, {
        int age = 0,
      }) => {
        'machineId': id,
        'name': id,
        'contributorId': 'owner',
        'observation': {'receivedAt': at - age, 'quotas': quotas},
      };
      server.state['machines'] = [
        // Listed Codex first; shown Claude first.
        machine('both', [quota('codex', 95), quota('claude', 85)]),
        machine('fine', [quota('claude', 50)]),
        machine('expired', [
          quota(
            'codex',
            10,
            resetsAt: now.subtract(const Duration(minutes: 1)),
          ),
        ]),
        machine('unknown', [quota('claude', 10, known: false)]),
        // An old reading's allowance is not shown as now.
        machine('gone', [quota('claude', 50)], age: 600000),
      ];
      final c = server.controller();
      await c.refresh();
      c.offlineMachinesOpen = true;
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Finder chip(String id, String engine) =>
          find.byKey(ValueKey('super-machine-allowance-$id-$engine'));
      Color? ink(Finder chip, String figure) => tester
          .widget<Text>(find.descendant(of: chip, matching: find.text(figure)))
          .style
          ?.color;

      expect(
        tester.getTopLeft(chip('both', 'claude')).dx,
        lessThan(tester.getTopLeft(chip('both', 'codex')).dx),
      );
      expect(
        tester
            .widget<EngineMark>(
              find.descendant(
                of: chip('both', 'claude'),
                matching: find.byType(EngineMark),
              ),
            )
            .size,
        14,
      );
      final surface = DesktopChrome.surface;
      expect(
        ink(chip('both', 'claude'), '15%'),
        statusLineInkOnSurface(grid.AppPalette.usageLow, surface),
      );
      expect(
        ink(chip('both', 'codex'), '5%'),
        statusLineInkOnSurface(grid.AppPalette.usageCritical, surface),
      );
      expect(
        ink(chip('fine', 'claude'), '50%'),
        statusLineInkOnSurface(DesktopChrome.muted, surface),
      );
      expect(
        tester
            .widget<Text>(
              find.descendant(
                of: chip('fine', 'claude'),
                matching: find.text('50%'),
              ),
            )
            .style
            ?.fontFeatures,
        contains(const FontFeature.tabularFigures()),
      );
      // Each chip says its windows on hover, and its share in words to a screen reader.
      final claudeTip = tester
          .widget<Tooltip>(
            find
                .ancestor(
                  of: chip('both', 'claude'),
                  matching: find.byType(Tooltip),
                )
                .first,
          )
          .message!;
      expect(
        claudeTip,
        startsWith('Claude Code\n5-hour: 15% remaining · resets in '),
      );
      expect(
        find.bySemanticsLabel(RegExp('Claude Code 15% remaining')),
        findsOneWidget,
      );
      expect(
        find.bySemanticsLabel(RegExp('Codex 5% remaining')),
        findsOneWidget,
      );
      // No chip for an expired or unknown allowance, nor for an offline machine; no warning icon anywhere.
      expect(find.byKey(const ValueKey('super-machine-gone')), findsOneWidget);
      for (final id in ['expired', 'unknown', 'gone']) {
        expect(
          find.descendant(
            of: find.byKey(ValueKey('super-machine-$id')),
            matching: find.byType(EngineMark),
          ),
          findsNothing,
          reason: id,
        );
      }
      expect(find.byIcon(AppIcons.triangleAlert), findsNothing);
      semantics.dispose();
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets(
    'every row shares the Claude, Codex and agents columns: their right edges line up, an empty slot keeps '
    'its place, and a narrow list hides a column for every row at once',
    (tester) async {
      final server = ConversationServer();
      final at = DateTime.now().millisecondsSinceEpoch;
      Map<String, dynamic> quota(String engine, int used) => {
        'engine': engine,
        'known': true,
        'windows': [
          {'name': '5-hour', 'usedPercent': used},
        ],
      };
      // Quota sets: both, Claude only, Codex only, none; agents: 7, 3, 1, 0; and one offline.
      final machines = [
        ('both', [quota('claude', 0), quota('codex', 57)], 7, 0),
        ('claude', [quota('claude', 91)], 3, 0),
        ('codex', [quota('codex', 100)], 1, 0),
        ('none', <Map<String, dynamic>>[], 0, 0),
        ('gone', [quota('claude', 50)], 1, 600000),
      ];
      server.state['machines'] = [
        for (final (id, quotas, _, age) in machines)
          {
            'machineId': id,
            'name': '$id machine',
            'contributorId': 'owner',
            'observation': {'receivedAt': at - age, 'quotas': quotas},
          },
      ];
      server.state['agents'] = [
        for (final (id, _, agents, _) in machines)
          for (var i = 0; i < agents; i++)
            {
              'id': '$id-$i',
              'name': 'Harness $i',
              'displayName': 'Agent $i',
              'machineId': id,
              'harnessId': 'native-$id-$i',
              'contributorId': 'owner',
              'configuration': {'engine': 'claude'},
            },
      ];
      final c = server.controller();
      await c.refresh();
      c.offlineMachinesOpen = true;
      final ids = [for (final m in machines) m.$1];
      Finder key(String k) => find.byKey(ValueKey(k));
      bool has(String k) => key(k).evaluate().isNotEmpty;
      double right(String k) => tester.getRect(key(k)).right;

      // The sidebar's widths, less its 8 px padding on each side, and a wide one.
      for (final width in [164.0, 188.0, 224.0, 264.0, 420.0]) {
        for (final scale in [1.0, 2.0]) {
          await tester.pumpWidget(
            MaterialApp(
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: Scaffold(
                body: Align(
                  alignment: Alignment.topLeft,
                  child: SizedBox(
                    width: width,
                    child: SuperTabMachines(
                      controller: c,
                      embedded: true,
                      onAddAgent: (_) {},
                    ),
                  ),
                ),
              ),
            ),
          );
          final reason = 'at width $width, scale $scale';
          expect(tester.takeException(), isNull, reason: reason);

          // Each allowance column shows for every row that has the quota, or for none.
          for (final (engine, owners) in [
            ('claude', ['both', 'claude']),
            ('codex', ['both', 'codex']),
          ]) {
            final shown = [
              for (final id in owners) has('super-machine-figure-$id-$engine'),
            ];
            expect(shown.toSet(), hasLength(1), reason: '$engine $reason');
            if (shown.first) {
              // The figures start at one x, right after the mark, whichever rows leave the other column blank.
              final edges = {
                for (final id in owners)
                  tester
                      .getTopLeft(key('super-machine-figure-$id-$engine'))
                      .dx
                      .toStringAsFixed(2),
              };
              expect(edges, hasLength(1), reason: '$engine $reason');
            }
            // Offline: never a chip.
            expect(
              has('super-machine-figure-gone-$engine'),
              isFalse,
              reason: reason,
            );
          }
          // The agents column: one right edge for every row, those without agents too,
          // and either avatars on every row that has agents or a count on all of them.
          final slots = {
            for (final id in ids)
              if (has('super-machine-agents-slot-$id'))
                right('super-machine-agents-slot-$id').toStringAsFixed(2),
          };
          expect(slots, hasLength(1), reason: reason);
          final stacked = {
            for (final id in ['both', 'claude', 'codex', 'gone'])
              find
                  .descendant(
                    of: key('super-machine-$id'),
                    matching: find.byType(SuperTabAvatar),
                  )
                  .evaluate()
                  .isNotEmpty,
          };
          expect(stacked, hasLength(1), reason: reason);
          if (width == 420 && scale == 1) {
            expect(stacked.single, isTrue, reason: reason);
            expect(has('super-machine-figure-both-claude'), isTrue);
            expect(has('super-machine-figure-both-codex'), isTrue);
            // The avatars stand 16 px clear of the figures before them.
            final stackLeft = find
                .descendant(
                  of: key('super-machine-agents-both'),
                  matching: find.byType(SuperTabAvatar),
                )
                .evaluate()
                .map((e) => tester.getTopLeft(find.byWidget(e.widget)).dx)
                .reduce(math.min);
            expect(
              stackLeft - right('super-machine-figure-both-codex'),
              greaterThanOrEqualTo(16 - .01),
            );
            // Claude's column comes before Codex's, and the agents after both.
            expect(
              right('super-machine-figure-both-claude'),
              lessThan(right('super-machine-figure-both-codex')),
            );
            expect(
              right('super-machine-figure-both-codex'),
              lessThan(slots.single.isEmpty ? 0 : double.parse(slots.single)),
            );
          }
        }
      }
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets(
    'as the list narrows the names keep their minimum: agents become a count, then Codex goes, then Claude',
    (tester) async {
      final server = ConversationServer();
      final now = DateTime.now();
      server.state['agents'] = [
        for (var i = 0; i < 5; i++)
          {
            'id': 'agent-$i',
            'name': 'Harness $i',
            'displayName': 'Engineer $i',
            'machineId': 'm',
            'harnessId': 'native-$i',
            'contributorId': 'owner',
            'configuration': {'engine': 'claude'},
          },
      ];
      server.state['machines'] = [
        {
          'machineId': 'm',
          'name': "Diego's Mac Studio",
          'contributorId': 'owner',
          'observation': {
            'receivedAt': now.millisecondsSinceEpoch,
            'quotas': [
              for (final (engine, used) in [('claude', 52), ('codex', 8)])
                {
                  'engine': engine,
                  'known': true,
                  'windows': [
                    {'name': '5-hour', 'usedPercent': used},
                  ],
                },
            ],
          },
        },
      ];
      final c = server.controller();
      await c.refresh();
      for (final scale in [1.0, 2.0]) {
        // What the end shows at each width, widest first: avatars, then the chips.
        final states = <(int, bool, bool)>[];
        // The 11 px figures keep Claude visible at 180 px. Sweep narrower so
        // both text scales still reach the count-only stage.
        for (var width = 460.0; width >= 160; width -= 10) {
          await tester.pumpWidget(
            MaterialApp(
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: Scaffold(
                body: Align(
                  alignment: Alignment.topLeft,
                  child: SizedBox(
                    width: width,
                    child: SuperTabMachines(
                      controller: c,
                      embedded: true,
                      onAddAgent: (_) {},
                    ),
                  ),
                ),
              ),
            ),
          );
          final reason = 'at width $width, scale $scale';
          expect(tester.takeException(), isNull, reason: reason);
          final row = find.byKey(const ValueKey('super-machine-m'));
          final avatars = find
              .descendant(of: row, matching: find.byType(SuperTabAvatar))
              .evaluate()
              .length;
          bool shows(String engine) => find
              .byKey(ValueKey('super-machine-allowance-m-$engine'))
              .evaluate()
              .isNotEmpty;
          final state = (avatars, shows('claude'), shows('codex'));
          states.add(state);
          // The count always stays; with fewer avatars it says the rest.
          expect(
            find.descendant(of: row, matching: find.text('+${5 - avatars}')),
            avatars == 5 ? findsNothing : findsOneWidget,
            reason: reason,
          );
          // A chip goes only once the avatars have, Codex before Claude.
          if (!state.$3) expect(avatars, 0, reason: reason);
          if (!state.$2) expect(state.$3, isFalse, reason: reason);
          // The name's room, from where it starts to the first column, keeps its
          // minimum while any column but the count remains.
          final nameLeft = tester
              .getTopLeft(
                find.descendant(of: row, matching: find.byType(RichText)).first,
              )
              .dx;
          final firstColumn = [
            for (final key in [
              'super-machine-allowance-m-claude',
              'super-machine-allowance-m-codex',
              'super-machine-agents-slot-m',
            ])
              if (find.byKey(ValueKey(key)).evaluate().isNotEmpty)
                tester.getTopLeft(find.byKey(ValueKey(key))).dx,
          ].reduce(math.min);
          if (state.$2 || avatars > 0) {
            expect(
              firstColumn - nameLeft,
              greaterThanOrEqualTo(48 * scale - 1),
              reason: reason,
            );
          }
        }
        // Widest: everything; and every step after only takes away.
        expect(states.first, (3, true, true), reason: 'scale $scale');
        int rank((int, bool, bool) s) =>
            s.$1 * 4 + (s.$2 ? 2 : 0) + (s.$3 ? 1 : 0);
        for (var i = 1; i < states.length; i++) {
          expect(
            rank(states[i]),
            lessThanOrEqualTo(rank(states[i - 1])),
            reason: 'scale $scale, step $i',
          );
        }
        // Each stage is reached on the way down.
        expect(
          states.any((s) => s == (0, true, true)),
          isTrue,
          reason: 'scale $scale',
        );
        expect(
          states.any((s) => s == (0, true, false)),
          isTrue,
          reason: 'scale $scale',
        );
        expect(states.last, (0, false, false), reason: 'scale $scale');
      }
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets(
    'an offline machine is reached through "Offline · N", and its details still attach a running agent',
    (tester) async {
      final server = ConversationServer();
      server.state['machines'] = [
        {
          'machineId': 'gone',
          'name': 'Old Mini',
          'contributorId': 'owner',
          'observation': {
            'receivedAt': DateTime.now()
                .subtract(const Duration(minutes: 10))
                .millisecondsSinceEpoch,
          },
        },
      ];
      final c = server.controller();
      await c.refresh();
      final attached = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(
              controller: c,
              onAddAgent: (group) => attached.add(group.id),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final row = find.byKey(const ValueKey('super-machine-gone'));
      expect(row, findsNothing);
      await tester.tap(find.byKey(const ValueKey('super-machines-offline')));
      await tester.pumpAndSettle();
      await tester.tap(row);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Attach running agent'));
      await tester.pumpAndSettle();
      expect(attached, [c.selected!.id]);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  for (final brightness in [Brightness.dark, Brightness.light]) {
    for (final textScale in [1.0, 2.0]) {
      for (final width in [280.0, 380.0]) {
        testWidgets(
          'machine identity, full-row target and details fit ${brightness.name} ${textScale}x at $width',
          (tester) async {
            await tester.binding.setSurfaceSize(const Size(900, 850));
            addTearDown(() => tester.binding.setSurfaceSize(null));
            final previousBrightness = grid.AppTheme.brightness.value;
            grid.AppTheme.brightness.value = brightness;
            addTearDown(
              () => grid.AppTheme.brightness.value = previousBrightness,
            );
            final server = ConversationServer();
            server.state['people'] = [
              {'id': 'owner', 'email': 'dee@example.com', 'role': 'owner'},
            ];
            server.state['agents'] = [
              for (var i = 0; i < 8; i++)
                {
                  'id': 'agent-$i',
                  'name': 'Harness $i',
                  'displayName': i == 0 ? 'Atlas' : 'Engineer $i',
                  'machineId': 'm',
                  'harnessId': 'native-$i',
                  'contributorId': 'owner',
                  'configuration': {'engine': 'codex'},
                },
            ];
            (server.state['conversations'] as List)[0]
              ..['leadId'] = 'agent-0'
              ..['agentIds'] = ['agent-0'];
            server.state['machines'] = [
              {
                'machineId': 'm',
                'name': 'M2',
                'contributorId': 'owner',
                'paused': true,
                'engines': ['claude', 'codex'],
                'cwd': '/work/a-very-long-project-folder-without-spaces/checked-out-project',
                'observation': {
                  'receivedAt': DateTime.now().millisecondsSinceEpoch,
                  'resources': {
                    'deviceType': 'MacBook Pro',
                    'chip': 'Apple M2 Max',
                    'os': 'macOS',
                    'cpuPercent': 27,
                    'gpuPercent': 7,
                    'memoryTotalBytes': 64000000000,
                    'memoryUsedBytes': 36000000000,
                    'diskTotalBytes': 1000000000000,
                    'diskFreeBytes': 141000000000,
                  },
                  'quotas': [
                    {'engine': 'claude', 'known': false, 'windows': []},
                    {
                      'engine': 'codex',
                      'known': true,
                      'windows': [
                        {
                          'name': '5-hour',
                          'usedPercent': 30,
                          'resetsAt': DateTime.now()
                              .add(const Duration(hours: 2))
                              .millisecondsSinceEpoch,
                        },
                        {
                          'name': 'Weekly',
                          'usedPercent': 10,
                          'resetsAt': DateTime.now()
                              .add(const Duration(days: 3))
                              .millisecondsSinceEpoch,
                        },
                      ],
                    },
                  ],
                },
              },
            ];
            final c = server.controller();
            await c.refresh();
            final machineBoundary = GlobalKey();
            await tester.pumpWidget(
              MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: grid.buildAppTheme(brightness: brightness),
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(context)
                      .copyWith(textScaler: TextScaler.linear(textScale)),
                  child: child!,
                ),
                home: Scaffold(
                  body: Align(
                    alignment: Alignment.topLeft,
                    child: RepaintBoundary(
                      key: machineBoundary,
                      child: Material(
                        color: grid.AppDesktop.surface,
                        child: SizedBox(
                          width: width,
                          child: SuperTabMachines(
                            controller: c,
                            embedded: true,
                            onAddAgent: (_) {},
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            );
            await tester.pumpAndSettle();
            final row = find.byKey(const ValueKey('super-machine-m'));
            final rowRect = tester.getRect(row);
            expect(rowRect.width, width);
            // One line at a project row's height and on its columns.
            if (textScale == 1) expect(rowRect.height, 36);
            final dot = tester.getRect(
              find.descendant(
                of: row,
                matching: find.byType(SuperTabMachineDot),
              ),
            );
            // Level 1, one indent step in from the heading's columns.
            final indent = SuperTabSectionHeading.indentFor(1);
            expect(dot.center.dx, closeTo(rowRect.left + indent + 16, .01));
            expect(dot.center.dy, closeTo(rowRect.center.dy, .5));
            expect(
              tester
                  .getTopLeft(
                    find
                        .descendant(of: row, matching: find.byType(RichText))
                        .first,
                  )
                  .dx,
              rowRect.left + indent + 32,
            );
            // Left to right, as they read: the first agent is drawn last, on top.
            final avatars =
                tester
                    .widgetList<SuperTabAvatar>(
                      find.descendant(
                        of: row,
                        matching: find.byType(SuperTabAvatar),
                      ),
                    )
                    .toList()
                  ..sort(
                    (a, b) => tester
                        .getTopLeft(find.byWidget(a))
                        .dx
                        .compareTo(tester.getTopLeft(find.byWidget(b)).dx),
                  );
            // No owner avatar; the PM first, at most three agents, the rest as +N.
            expect(
              avatars.map((a) => a.identity),
              isNot(contains('person:owner')),
            );
            expect(avatars.first.identity, 'agent:agent-0');
            expect(avatars.first.name, 'Atlas');
            expect(avatars.length, lessThanOrEqualTo(3));
            expect(find.text('+${8 - avatars.length}'), findsOneWidget);
            if (width == 380 && textScale == 1) expect(avatars, hasLength(3));
            expect(
              find.textContaining('Atlas — Product Manager'),
              findsNothing,
            );
            expect(
              find.byTooltip(
                [
                  'Atlas — Product Manager',
                  for (var i = 1; i < 8; i++) 'Engineer $i — Engineer',
                ].join('\n'),
              ),
              findsOneWidget,
            );
            // The owner, paused and the numbers are in the row's tooltip, not on the line, and never an age.
            expect(
              _tipOf(tester, row),
              'Owned by dee · New work paused · CPU 73% free · GPU 93% free · RAM 28 GB free · SSD 141 GB free',
            );
            expect(find.byIcon(AppIcons.pause), findsNothing);
            for (final value in ['CPU', 'GPU', 'RAM', 'SSD', 'dee', 'ago']) {
              expect(find.textContaining(value), findsNothing);
            }
            // Codex's tightest window, when the line has room for it; Claude's allowance is unknown.
            final codex = find.byKey(
              const ValueKey('super-machine-allowance-m-codex'),
            );
            if (codex.evaluate().isNotEmpty) {
              expect(
                find.descendant(of: codex, matching: find.text('70%')),
                findsOneWidget,
              );
            }
            expect(
              find.byKey(const ValueKey('super-machine-allowance-m-claude')),
              findsNothing,
            );
            final ink = find.descendant(
              of: row,
              matching: find.byType(InkWell),
              matchRoot: true,
            );
            expect(tester.getRect(ink.first), rowRect);
            expect(tester.takeException(), isNull);

            // The blank right edge and all capacity/allowance lines belong to
            // the same hover and click target as the machine's name.
            final mouse = await tester.createGesture(
              kind: PointerDeviceKind.mouse,
            );
            await mouse.addPointer(
              location: Offset(rowRect.right + 20, rowRect.center.dy),
            );
            await tester.pump();
            await mouse.moveTo(Offset(rowRect.right - 2, rowRect.center.dy));
            await tester.pumpAndSettle();
            final captureName =
                '${brightness.name}-${textScale}x-${width.toInt()}';
            await captureBoundary(
              tester,
              machineBoundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary,
              capture,
              'machine-hover-$captureName',
            );
            await tester.tapAt(Offset(rowRect.right - 2, rowRect.center.dy));
            await mouse.removePointer();
            await tester.pumpAndSettle();
            if (capture != null) {
              // A frame can settle before asynchronous bitmap decoding has
              // finished. Wait for the real asset before photographing it.
              await tester.runAsync(
                () => precacheImage(
                  AssetImage(engineIdentity('codex').asset!),
                  tester.element(find.byType(EngineMark).first),
                ).timeout(const Duration(seconds: 10)),
              );
              await tester.pumpAndSettle();
            }
            final dialog = find.byType(AlertDialog);
            final details = find.byType(SuperTabMachineDetails);
            expect(dialog, findsOneWidget);
            expect(details, findsOneWidget);
            expect(
              find.descendant(
                of: details,
                matching: find.text('28 GB of 64 GB'),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(
                of: details,
                matching: find.text('141 GB of 1000 GB'),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(
                of: details,
                matching: find.textContaining(
                  '5-hour: 70% remaining\nResets in ',
                ),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(
                of: details,
                matching: find.textContaining(
                  'Weekly: 90% remaining\nResets in ',
                ),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(of: details, matching: find.text('—')),
              findsNothing,
            );
            expect(tester.takeException(), isNull);
            await captureWindow(
              tester,
              capture,
              'machine-details-$captureName',
            );
            if (capture != null && textScale > 1) {
              await Scrollable.ensureVisible(
                tester.element(find.text('Model allowances')),
                alignment: 0,
              );
              await tester.pumpAndSettle();
              await captureWindow(
                tester,
                capture,
                'machine-details-more-$captureName',
              );
            }
            await tester.tap(find.widgetWithText(TextButton, 'Close'));
            await tester.pumpAndSettle();
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
            await c.flush();
            c.dispose();
          },
        );
      }
    }
  }

  test('shared repository metadata excludes embedded credentials', () {
    expect(
      superTabRepositoryUrl('https://token@github.com/example/project'),
      isNull,
    );
    expect(
      superTabRepositoryUrl('ssh://git:secret@github.com/example/project'),
      isNull,
    );
    expect(
      superTabRepositoryUrl('git@github.com:example/project.git'),
      'git@github.com:example/project.git',
    );
    expect(
      superTabRepositoryUrl('https://github.com/example/project'),
      'https://github.com/example/project',
    );
  });
  test('a daemon\'s canonical remote is shared as an HTTPS repository', () {
    // The CLI daemon reports `origin` as host/owner/repo, without a scheme.
    expect(
      superTabRepositoryUrl('github.com/autonomous-ai/openharness'),
      'https://github.com/autonomous-ai/openharness',
    );
    expect(
      superTabRepositoryUrl('gitlab.example.co.uk/team/group/project'),
      'https://gitlab.example.co.uk/team/group/project',
    );
    // A canonical port may be SSH's; it is not guessed as HTTPS.
    expect(superTabRepositoryUrl('git.example.com:2222/team/project'), isNull);
    // Local and relative remotes are not shareable repositories.
    expect(superTabRepositoryUrl('../project'), isNull);
    expect(superTabRepositoryUrl('/Users/me/project.git'), isNull);
    expect(superTabRepositoryUrl('github.com'), isNull);
  });
  testWidgets(
    'Add machine has one field and contributes the prepared project and installed engines',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['project'] = {
        'machineId': 'm',
        'cwd': '/work/project',
        'scope': 'swarm',
        'repositoryUrl': null,
      };
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 300,
              height: 400,
              child: SuperTabMachines(
                controller: c,
                app: f.app,
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Add machine'));
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Agents the Swarm starts on this machine run without asking for permission.',
        ),
        findsOneWidget,
      );
      expect(_picker, findsOneWidget);
      expect(
        find.text('This Mac (${f.app.stateOf('m')!.machine.displayName})'),
        findsOneWidget,
      );
      expect(find.byType(Checkbox), findsNothing);
      expect(find.text('Choose project folder'), findsNothing);
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text(
            'Harness clones each project into ~/harnesses/swarms and lets '
            "the Swarm's agents work in it.",
          ),
        ),
        findsOneWidget,
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(f.connection.server.posts.single['command'], {
        'type': 'machine.contribute',
        'machineId': 'm',
        'name': f.app.stateOf('m')!.machine.displayName,
        'cwd': '/work/project',
        'scope': 'swarm',
        'engines': ['claude', 'codex', 'pi'],
        'maxAgents': 4,
      });
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine: the lead runs on This Mac but it is not contributed yet, so "+" still offers it',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['agents'] = [
        {
          'id': 'lead-agent',
          'name': 'Lead',
          'machineId': 'm',
          'harnessId': 'native-lead',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
      ];
      (f.connection.server.state['conversations'] as List)[0]['leadId'] =
          'lead-agent';
      (f.connection.server.state['conversations'] as List)[0]['agentIds'] = [
        'lead-agent',
      ];
      f.connection.server.state['project'] = {
        'machineId': 'm',
        'cwd': '/work/project',
        'repositoryUrl': null,
      };
      // No 'machines' entry: an agent running on This Mac does not mean it
      // was ever contributed to this tab.
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(_picker, findsOneWidget);
      expect(
        find.text('This Mac (${f.app.stateOf('m')!.machine.displayName})'),
        findsOneWidget,
      );
      final button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Add machine'),
      );
      expect(button.onPressed, isNotNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine: already-contributed machines remain visible but cannot be added again',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(_picker, findsOneWidget);
      expect(find.text('Choose a machine'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Add machine'),
            )
            .onPressed,
        isNull,
      );
      expect(find.textContaining('Already in this tab:'), findsNothing);
      await tester.tap(_picker);
      await tester.pumpAndSettle();
      expect(tester.widget<MenuItemButton>(_option('m')).onPressed, isNull);
      expect(find.byTooltip('Already in this Swarm'), findsOneWidget);
      await tester.tap(_option('m'));
      await tester.pumpAndSettle();
      expect(find.text('Choose a machine'), findsOneWidget);
      expect(f.connection.server.posts, isEmpty);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine: an available owned machine is selected ahead of an already-contributed one',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      const other = Machine(
        machineId: 'm2',
        authMode: MachineAuthMode.remote,
        name: 'Other Mac',
      );
      f.app.machines = [...f.app.machines, other];
      f.app.machineStates['m2'] = MachineState(other)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(_picker, findsOneWidget);
      expect(find.text('Other Mac'), findsOneWidget);
      expect(
        find.text('This Mac (${f.app.stateOf('m')!.machine.displayName})'),
        findsNothing,
      );
      expect(find.textContaining('Already in this tab:'), findsNothing);
      final button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Add machine'),
      );
      expect(button.onPressed, isNotNull);
      await tester.tap(_picker);
      await tester.pumpAndSettle();
      expect(tester.widget<MenuItemButton>(_option('m')).onPressed, isNull);
      expect(tester.widget<MenuItemButton>(_option('m2')).onPressed, isNotNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine: offline and unlinked owned machines are disabled with status tooltips; shared machines stay excluded',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      const offline = Machine(
        machineId: 'm3',
        authMode: MachineAuthMode.remote,
        name: 'macbok test local',
      );
      f.app.machines = [...f.app.machines, offline];
      f.app.machineStates['m3'] = MachineState(offline)
        ..nodeOnline = false
        ..connectionStatus = ConnectionStatus.disconnected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      const unlinked = Machine(
        machineId: 'm4',
        authMode: MachineAuthMode.remote,
        name: 'Studio Mac',
      );
      const sharedHarness = Machine(
        machineId: 'm5',
        authMode: MachineAuthMode.remote,
        name: 'Another account’s harness',
        isShared: true,
      );
      const sharedMachine = Machine(
        machineId: 'm6',
        authMode: MachineAuthMode.remote,
        name: 'Another account’s computer',
        machineShare: MachineShare(
          ownerName: 'Another owner',
          ownerEmail: 'another@example.com',
          via: 'email',
          added: true,
        ),
      );
      for (final machine in [unlinked, sharedHarness, sharedMachine]) {
        f.app.machineStates[machine.machineId] = MachineState(machine)
          ..nodeOnline = true
          ..connectionStatus = ConnectionStatus.connected;
      }
      f.app.machineStates['m4']!.needsLink = true;
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(_picker, findsOneWidget);
      expect(find.text('macbok test local'), findsNothing);
      expect(find.textContaining('Offline:'), findsNothing);
      expect(find.textContaining('Not linked:'), findsNothing);
      await tester.tap(_picker);
      await tester.pumpAndSettle();
      expect(tester.widget<MenuItemButton>(_option('m3')).onPressed, isNull);
      expect(tester.widget<MenuItemButton>(_option('m4')).onPressed, isNull);
      expect(_option('m5'), findsNothing);
      expect(_option('m6'), findsNothing);
      const offlineHint = 'Offline. Open Harness on this computer to add it.';
      expect(find.byTooltip(offlineHint), findsOneWidget);
      expect(
        find.byTooltip('Not linked. Link this computer from Machines.'),
        findsOneWidget,
      );
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(tester.getCenter(find.byTooltip(offlineHint)));
      await tester.pumpAndSettle(const Duration(milliseconds: 800));
      expect(find.text(offlineHint), findsOneWidget);
      await tester.tap(_option('m3'));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: _picker,
          matching: find.text(
            'This Mac (${f.app.stateOf('m')!.machine.displayName})',
          ),
        ),
        findsOneWidget,
      );
      expect(f.connection.server.posts, isEmpty);
      await mouse.removePointer();

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Machine picker skips unavailable rows with the keyboard and returns focus to the field',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      for (final (id, name, online) in [
        ('m2', 'Offline Mac', false),
        ('m3', 'Studio Mac', true),
      ]) {
        final machine = Machine(
          machineId: id,
          authMode: MachineAuthMode.remote,
          name: name,
        );
        f.app.machineStates[id] = MachineState(machine)
          ..nodeOnline = online
          ..connectionStatus = online
              ? ConnectionStatus.connected
              : ConnectionStatus.disconnected;
      }
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);
      await tester.tap(_picker);
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: _picker, matching: find.text('Studio Mac')),
        findsOneWidget,
      );
      expect(f.connection.server.posts, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pumpAndSettle();
      expect(_option('m2'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(_option('m2'), findsNothing);
      expect(tester.widget<TextButton>(_picker).focusNode!.hasFocus, isTrue);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'A machine that goes offline while the form is open cannot be submitted',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);
      f.app.machineStates['m']!.nodeOnline = false;
      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
      await tester.pumpAndSettle();
      expect(f.connection.server.posts, isEmpty);
      expect(
        f.connection.calls.where(
          (call) =>
              call.$1 == 'super_tabs' &&
              call.$2['action'] == 'prepareContribution',
        ),
        isEmpty,
      );
      expect(find.byType(AlertDialog), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  for (final brightness in Brightness.values) {
    testWidgets(
      'Machine picker handles unavailable long names at 2x text in ${brightness.name}',
      (tester) async {
        tester.view.physicalSize = const Size(540, 800);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final f = SuperTabLaunchFixture();
        f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
        f.app.machineStates['m']!.nodeOnline = false;
        const unlinked = Machine(
          machineId: 'studio',
          authMode: MachineAuthMode.remote,
          name: 'Design Studio’s MacBook Pro with a long custom machine name',
        );
        f.app.machineStates['studio'] = MachineState(unlinked)
          ..nodeOnline = true
          ..needsLink = true;
        final c = await f.app.superTabs.open(tabId);
        await c.refresh();
        await _openAddMachineDialog(
          tester,
          f,
          c,
          brightness: brightness,
          textScale: 2,
        );
        expect(
          tester
              .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Add machine'),
              )
              .onPressed,
          isNull,
        );
        await tester.tap(_picker);
        await tester.pumpAndSettle();
        expect(tester.widget<MenuItemButton>(_option('m')).onPressed, isNull);
        expect(
          tester.widget<MenuItemButton>(_option('studio')).onPressed,
          isNull,
        );
        expect(tester.takeException(), isNull);

        await tester.pumpWidget(const SizedBox());
        await c.flush();
        f.app.superTabs.dispose();
        await tester.pump();
      },
    );
  }

  testWidgets('Machine details omit unknown subscription allowances', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.connection.server.state['machines'] = [
      {
        'machineId': 'm',
        'contributorId': 'owner',
        'observation': {
          'receivedAt': DateTime.now().millisecondsSinceEpoch,
          'quotas': [
            for (final engine in ['claude', 'codex', 'opencode', 'cursor'])
              {
                'engine': engine,
                'known': engine == 'claude',
                'windows': [
                  {'name': '5-hour', 'usedPercent': 40},
                ],
              },
          ],
        },
      },
    ];
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 300,
            height: 400,
            child: SuperTabMachines(
              controller: c,
              app: f.app,
              onAddAgent: (_) {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    // Only the known allowance of the two the list shows, Claude's, has a chip; so do the details.
    expect(
      tester
          .widgetList<EngineMark>(find.byType(EngineMark))
          .map((mark) => mark.engine),
      ['claude'],
    );
    await tester.tap(find.byKey(const ValueKey('super-machine-m')));
    await tester.pumpAndSettle();
    expect(
      tester
          .widgetList<EngineMark>(find.byType(EngineMark))
          .map((mark) => mark.engine)
          .toSet(),
      {'claude'},
    );

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets(
    'Configure on a machine card reads as editing: title "Configure machine", button "Save"',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      // Never reported, so offline: under the disclosure.
      c.offlineMachinesOpen = true;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 300,
              height: 400,
              child: SuperTabMachines(
                controller: c,
                app: f.app,
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-machine-m')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Configure'));
      await tester.pumpAndSettle();

      expect(find.text('Configure machine'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Save'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Add machine'), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );
}

import 'dart:io';
import 'dart:ui' show PointerDeviceKind;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_icons.dart';
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
  test(
    'generated computer names are readable and custom names stay intact',
    () {
      for (final hostname in [
        'MacBookPro2021.local',
        'MacBooks-MacBook-Pro-19.local',
        'MacbookPro.local',
      ]) {
        expect(superTabMachineName(hostname), 'MacBook Pro');
      }
      expect(superTabMachineName('Mac-mini.local'), 'Mac mini');
      expect(superTabMachineName('build-server.local'), 'build-server');
      for (final name in [
        'Ada’s Mac',
        'M2',
        'MacBook Pro lab',
        'Build server',
      ]) {
        expect(superTabMachineName(name), name);
      }
    },
  );
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
      // The list says no number, age or allowance; the row's tooltip does.
      expect(find.textContaining('CPU'), findsNothing);
      expect(find.textContaining('GB'), findsNothing);
      expect(find.textContaining('ago'), findsNothing);
      expect(find.byType(EngineMark), findsNothing);
      expect(
        _tipOf(tester, online),
        matches(
          RegExp(
            r'^Updated (just now|\ds ago) · CPU 100% free · RAM 0 GB free · SSD 141 GB free$',
          ),
        ),
      );
      expect(tester.getSize(online).height, 36);
      // Offline machines start out of sight, under their disclosure.
      expect(offline, findsNothing);
      expect(find.text('Offline · 1'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('super-machines-offline')));
      await tester.pumpAndSettle();
      expect(c.offlineMachinesOpen, isTrue);
      expect(
        _tipOf(tester, offline),
        'Offline · last seen 1 min ago · CPU 100% free · RAM 0 GB free · SSD 141 GB free',
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
    'a name two machines share is told apart by its owner, and only then',
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
        machine('s', 'Studio', 'dee'),
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
      expect(_lineOf(tester, 't'), 'MacBook Pro · tony');
      expect(_lineOf(tester, 'd'), 'MacBook Pro · dee');
      expect(_lineOf(tester, 's'), 'Studio');
      // The owner is in muted ink, after the name.
      final span = tester
          .widget<RichText>(
            find.descendant(
              of: find.byKey(const ValueKey('super-machine-t')),
              matching: find.byType(RichText),
            ),
          )
          .text;
      TextSpan? owner;
      span.visitChildren((child) {
        if (child is TextSpan && child.text == ' · tony') owner = child;
        return owner == null;
      });
      expect(owner!.style!.color, DesktopChrome.muted);
      expect(
        tester
            .getSemantics(find.byKey(const ValueKey('super-machine-t')))
            .label,
        startsWith('MacBook Pro · tony, Live, Updated'),
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
      // The last mark, +2, centers where the heading's + does (embedded: 16 from the edge).
      expect(
        tester.getCenter(inRow('five', find.text('+2'))).dx,
        closeTo(rowFive.right - 16, .5),
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
    'an allowance under 10% is the one warning a row shows, and says which',
    (tester) async {
      final server = ConversationServer();
      final now = DateTime.now().millisecondsSinceEpoch;
      Map<String, dynamic> machine(String id, int used, {int age = 0}) => {
        'machineId': id,
        'name': id,
        'contributorId': 'owner',
        'observation': {
          'receivedAt': now - age,
          'quotas': [
            {
              'engine': 'codex',
              'known': true,
              'windows': [
                {'name': '5-hour', 'usedPercent': used},
              ],
            },
          ],
        },
      };
      server.state['machines'] = [
        machine('low', 98),
        machine('fine', 90),
        // An old reading's allowance is no warning about now.
        machine('gone', 99, age: 600000),
      ];
      final c = server.controller();
      await c.refresh();
      c.offlineMachinesOpen = true;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final warning = find.byKey(const ValueKey('super-machine-attention-low'));
      expect(warning, findsOneWidget);
      expect(find.byTooltip('Codex: 2% left'), findsOneWidget);
      expect(
        _tipOf(tester, find.byKey(const ValueKey('super-machine-low'))),
        endsWith(' · Codex: 2% left'),
      );
      expect(
        find.byKey(const ValueKey('super-machine-attention-fine')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('super-machine-attention-gone')),
        findsNothing,
      );
      // At the end, centered on the + column when nothing follows it.
      final row = tester.getRect(
        find.byKey(const ValueKey('super-machine-low')),
      );
      expect(tester.getCenter(warning).dx, closeTo(row.right - 28, .5));
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
            // Paused, the numbers and the age are in the row's tooltip, not on the line.
            expect(
              _tipOf(tester, row),
              matches(
                RegExp(
                  r'^Updated (just now|\ds ago) · New work paused · CPU 73% free · GPU 93% free · RAM 28 GB free · SSD 141 GB free$',
                ),
              ),
            );
            expect(find.byIcon(AppIcons.pause), findsNothing);
            for (final value in ['CPU', 'GPU', 'RAM', 'SSD', '70%', 'dee']) {
              expect(find.textContaining(value), findsNothing);
            }
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
    // The list shows no allowance at all; the details show the known one.
    expect(find.byType(EngineMark), findsNothing);
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

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/app_icon_button.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/agent_instructions.dart';
import 'package:harness/super_tabs/model.dart';

import 'support/swarm_v4_data.dart';

/// An agent's instructions pane shows, under the agent's own file, what else instructs it in its folder, read only: the
/// project's `AGENTS.md` and `CLAUDE.md` (anh Dee, 2026-11-10: Faye's instructions, in lampOS), each folded to its name and
/// size until opened (anh Dee, the same day: a project's long AGENTS.md read as the agent's own).
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  SuperTabAgent agent(String name) => SuperTabAgent.fromJson({
    'id': 'id-$name',
    'name': name,
    'machineId': 'm',
    'harnessId': 'h',
    'contributorId': 'p',
    'configuration': {'engine': 'claude'},
  });

  // lampOS's AGENTS.md is 18 KB.
  final agentsMd = [
    for (var i = 1; i <= 320; i++)
      'Rule $i: keep the answer short, and say what you checked.',
  ].join('\n');

  Map<String, Object?> file(String name, String text, {bool? truncated}) => {
    'name': name,
    'text': text,
    'truncated': ?truncated,
  };

  Widget pane(
    SwarmV4Computer computer, {
    Brightness brightness = Brightness.light,
    String name = 'Faye',
  }) => MaterialApp(
    theme: grid.buildAppTheme(brightness: brightness),
    home: Scaffold(
      body: SwarmAgentInstructions(
        agent: agent(name),
        machineName: 'Mac Studio',
        onClose: () {},
        link: computer.link,
      ),
    ),
  );

  /// Opens every file of the folder that has text of its own and is closed, as a person clicks each.
  Future<void> openFiles(WidgetTester tester) async {
    for (var i = 0; key('swarm-shared-name-$i').evaluate().isNotEmpty; i++) {
      final row = key('swarm-shared-row-$i');
      if (row.evaluate().isEmpty ||
          key('swarm-shared-text-$i').evaluate().isNotEmpty) {
        continue;
      }
      await tester.ensureVisible(row);
      await tester.tap(row);
      await tester.pumpAndSettle();
    }
  }

  /// [open]: with the folder's files opened, as most of these read them.
  Future<void> show(
    WidgetTester tester,
    SwarmV4Computer computer, {
    Size size = const Size(880, 800),
    Brightness brightness = Brightness.light,
    String name = 'Faye',
    bool open = true,
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(pane(computer, brightness: brightness, name: name));
    await tester.pumpAndSettle();
    if (open) await openFiles(tester);
  }

  const empty =
      'Empty for now. Tell Faye how you want it to work, and it writes it down here.';

  double top(WidgetTester tester, Finder finder) =>
      tester.getTopLeft(finder).dy;

  testWidgets(
    'Faye has no file of her own: it says so, and her AGENTS.md and CLAUDE.md, opened, show read only and whole, at 880 wide',
    (tester) async {
      final computer = SwarmV4Computer()
        ..shared = [
          file('AGENTS.md', agentsMd, truncated: false),
          file('CLAUDE.md', 'Read AGENTS.md first.', truncated: false),
        ];
      await show(tester, computer);
      expect(find.text('agents/Faye.md'), findsOneWidget);
      expect(find.text('AGENTS.md'), findsOneWidget);
      expect(find.text('CLAUDE.md'), findsOneWidget);
      expect(find.text(empty), findsOneWidget);
      // The whole text of each, selectable, and nothing to type into.
      expect(
        tester.widget<SelectableText>(key('swarm-shared-text-0')).data,
        agentsMd,
      );
      expect(
        tester.widget<SelectableText>(key('swarm-shared-text-1')).data,
        'Read AGENTS.md first.',
      );
      expect(find.byType(TextField), findsNothing);
      for (final i in [0, 1]) {
        expect(
          tester
              .widget<EditableText>(
                find.descendant(
                  of: key('swarm-shared-text-$i'),
                  matching: find.byType(EditableText),
                ),
              )
              .readOnly,
          isTrue,
        );
      }
      // AGENTS.md then CLAUDE.md, as the computer sent them, and the end of the long one is reachable.
      expect(
        top(tester, find.text('AGENTS.md')),
        lessThan(top(tester, find.text('CLAUDE.md'))),
      );
      await tester.dragUntilVisible(
        find.text('Read AGENTS.md first.'),
        find.byType(SingleChildScrollView).first,
        const Offset(0, -400),
      );
      expect(find.text('Read AGENTS.md first.').hitTestable(), findsOneWidget);
      // Her own file is hers to write: Edit is there.
      expect(key('swarm-instructions-edit'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  // anh Dee, 2026-11-10, on Arlo's pane in openharness: "why is the default instructions for the PM so long" (its own file
  // was empty; the long text was the repository's AGENTS.md), and "click edit the instruction becomes blank".
  testWidgets(
    'an agent with no file of its own says so first; its folder\'s files are folded, a click opens one; Edit says what to write',
    (tester) async {
      final computer = SwarmV4Computer()
        ..shared = [
          file('AGENTS.md', agentsMd, truncated: false),
          file('CLAUDE.md', 'Read AGENTS.md first.', truncated: false),
        ];
      await show(tester, computer, open: false);
      expect(find.text(empty), findsOneWidget);
      expect(find.text('From its folder'), findsOneWidget);
      // Each by name and size, its text a click away.
      expect(find.text('AGENTS.md'), findsOneWidget);
      expect(find.text('320 lines'), findsOneWidget);
      expect(find.text('CLAUDE.md'), findsOneWidget);
      expect(find.text('1 line'), findsOneWidget);
      expect(key('swarm-shared-text-0'), findsNothing);
      expect(key('swarm-shared-text-1'), findsNothing);
      await tester.tap(find.text('AGENTS.md'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<SelectableText>(key('swarm-shared-text-0')).data,
        agentsMd,
      );
      expect(key('swarm-shared-text-1'), findsNothing);
      await tester.tap(find.text('AGENTS.md'));
      await tester.pumpAndSettle();
      expect(key('swarm-shared-text-0'), findsNothing);

      // Her own file, empty, and what goes in it.
      await tester.tap(key('swarm-instructions-edit'));
      await tester.pumpAndSettle();
      expect(key('swarm-instructions-field'), findsOneWidget);
      expect(
        find.text(
          'Rules for Faye, as you would tell it. It reads them at every start.',
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'the agent\'s own file comes first, then each of the others in the order sent',
    (tester) async {
      final computer =
          SwarmV4Computer(files: {'h/Faye': 'Answer in Vietnamese.'})
            ..shared = [
              file('AGENTS.md', 'Ship small.'),
              file('CLAUDE.md', 'Read AGENTS.md first.'),
            ];
      await show(tester, computer);
      final own = top(tester, key('swarm-instructions-text'));
      final first = top(tester, find.text('AGENTS.md'));
      final second = top(tester, find.text('CLAUDE.md'));
      expect(own, lessThan(first));
      expect(first, lessThan(second));
      expect(find.text('Answer in Vietnamese.'), findsOneWidget);
    },
  );

  testWidgets(
    'a CLAUDE.md that links to AGENTS.md is named, and its text is not shown twice',
    (tester) async {
      final computer = SwarmV4Computer()
        ..shared = [
          file('AGENTS.md', agentsMd, truncated: false),
          file('CLAUDE.md', agentsMd, truncated: false),
        ];
      await show(tester, computer);
      expect(find.text('CLAUDE.md'), findsOneWidget);
      expect(find.text('Same as AGENTS.md.'), findsOneWidget);
      expect(key('swarm-shared-text-0'), findsOneWidget);
      expect(key('swarm-shared-text-1'), findsNothing);
    },
  );

  testWidgets(
    'two files cut at 64 KB with the same start are both shown: what follows the cut may differ',
    (tester) async {
      final computer = SwarmV4Computer()
        ..shared = [
          file('AGENTS.md', agentsMd, truncated: true),
          file('CLAUDE.md', agentsMd, truncated: true),
        ];
      await show(tester, computer);
      expect(find.text('Same as AGENTS.md.'), findsNothing);
      expect(key('swarm-shared-text-1'), findsOneWidget);
      expect(find.text('Cut at 64 KB.'), findsNWidgets(2));
    },
  );

  testWidgets(
    'Try again keeps what shows until the answer, and a read that fails again keeps the files it had',
    (tester) async {
      final computer = SwarmV4Computer(files: {'h/Faye': 'Be brief.'})
        ..refuse = 'NOT_UTF8'
        ..shared = [file('AGENTS.md', 'Ship small.')];
      await show(tester, computer);
      expect(find.text('Ship small.'), findsOneWidget);
      // A slow computer: the answer waits.
      final slow = Completer<void>();
      computer.hold = () => slow.future;
      await tester.tap(key('swarm-instructions-retry'));
      await tester.pump();
      expect(find.text('Ship small.'), findsOneWidget);
      expect(key('swarm-instructions-error'), findsOneWidget);
      expect(
        tester.widget<AppIconButton>(key('swarm-instructions-retry')).spinning,
        isTrue,
      );
      // It times out: no word on the others, so they stay.
      computer
        ..refuse = 'TIMEOUT'
        ..shared = null;
      slow.complete();
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-instructions-error')).data,
        'Mac Studio didn\'t answer. Try again.',
      );
      expect(find.text('Ship small.'), findsOneWidget);
      expect(
        tester.widget<AppIconButton>(key('swarm-instructions-retry')).spinning,
        isFalse,
      );
    },
  );

  testWidgets('a folder with only a CLAUDE.md shows that one', (tester) async {
    final computer = SwarmV4Computer()
      ..shared = [file('CLAUDE.md', 'Read the docs first.')];
    await show(tester, computer);
    expect(find.text('CLAUDE.md'), findsOneWidget);
    expect(find.text('AGENTS.md'), findsNothing);
    expect(find.text('Read the docs first.'), findsOneWidget);
    expect(find.text(empty), findsOneWidget);
  });

  testWidgets('a file the computer cut says so, and only that file does', (
    tester,
  ) async {
    final computer = SwarmV4Computer()
      ..shared = [
        file('AGENTS.md', 'First part of a long file', truncated: true),
        file('CLAUDE.md', 'All of it.', truncated: false),
      ];
    await show(tester, computer);
    expect(find.text('Cut at 64 KB.'), findsOneWidget);
    expect(key('swarm-shared-cut-0'), findsOneWidget);
    expect(key('swarm-shared-cut-1'), findsNothing);
    // It sits under its own text, before the next file.
    expect(
      top(tester, key('swarm-shared-text-0')),
      lessThan(top(tester, key('swarm-shared-cut-0'))),
    );
    expect(
      top(tester, key('swarm-shared-cut-0')),
      lessThan(top(tester, find.text('CLAUDE.md'))),
    );
  });

  testWidgets(
    'a computer that sends nothing more (an older one) shows the agent\'s own file alone',
    (tester) async {
      final computer = SwarmV4Computer(files: {'h/Faye': 'Be brief.'});
      await show(tester, computer);
      expect(find.text('Be brief.'), findsOneWidget);
      expect(find.text('AGENTS.md'), findsNothing);
      expect(find.text('CLAUDE.md'), findsNothing);
      expect(find.text(empty), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    '"Empty for now" shows whenever her own file is empty, whatever else her folder holds',
    (tester) async {
      Future<void> check({
        String? own,
        Object? shared,
        Object? skipped,
        required bool says,
        required String reason,
      }) async {
        final computer = SwarmV4Computer(files: {'h/Faye': ?own})
          ..shared = shared
          ..skipped = skipped;
        await show(tester, computer);
        expect(
          find.text(empty),
          says ? findsOneWidget : findsNothing,
          reason: reason,
        );
        await tester.pumpWidget(const SizedBox());
      }

      await check(says: true, reason: 'nothing at all');
      await check(own: '  \n', says: true, reason: 'a blank own file');
      await check(
        shared: [file('AGENTS.md', ' \n\n')],
        says: true,
        reason: 'a blank AGENTS.md has nothing to read',
      );
      await check(
        shared: <Object?>[],
        skipped: <Object?>[],
        says: true,
        reason: 'empty lists',
      );
      await check(
        shared: [file('AGENTS.md', 'Ship small.')],
        says: true,
        reason: 'only AGENTS.md: hers is still empty',
      );
      await check(
        own: 'Be brief.',
        shared: [file('AGENTS.md', 'Ship small.')],
        says: false,
        reason: 'both',
      );
      await check(own: 'Be brief.', says: false, reason: 'only its own');
    },
  );

  testWidgets('a file that is there and not shown says why, in a line', (
    tester,
  ) async {
    final computer = SwarmV4Computer()
      ..shared = [file('AGENTS.md', 'Ship small.')]
      ..skipped = [
        {'name': 'CLAUDE.md', 'why': 'link'},
        {'name': 'CLAUDE.local.md', 'why': 'not_text'},
        {'name': 'a.md', 'why': 'unreadable'},
        {'name': 'b.md', 'why': 'not_a_file'},
        {'name': '../AGENTS.md', 'why': 'too_much'},
        {'name': 'c.md', 'why': 'a reason from a newer computer'},
        {'name': 'd.md'},
      ];
    await show(tester, computer);
    for (final line in [
      'CLAUDE.md is a link.',
      'CLAUDE.local.md isn\'t text.',
      'a.md can\'t be read.',
      'b.md isn\'t a file.',
      '../AGENTS.md isn\'t shown: too much text.',
      'c.md isn\'t shown.',
      'd.md isn\'t shown.',
    ]) {
      expect(find.text(line), findsOneWidget, reason: line);
    }
    // After the files that are shown.
    expect(
      top(tester, key('swarm-shared-text-0')),
      lessThan(top(tester, key('swarm-skipped-0'))),
    );
  });

  testWidgets(
    'only skipped files: "Empty for now", and why the others are not shown',
    (tester) async {
      final computer = SwarmV4Computer()
        ..skipped = [
          {'name': 'AGENTS.md', 'why': 'not_text'},
        ];
      await show(tester, computer);
      expect(find.text(empty), findsOneWidget);
      expect(find.text('AGENTS.md isn\'t text.'), findsOneWidget);
    },
  );

  testWidgets(
    'what is not understood is left out, and what is understood beside it still shows',
    (tester) async {
      for (final bad in <Object?>['AGENTS.md', 42, <String, Object?>{}, true]) {
        final computer = SwarmV4Computer(files: {'h/Faye': 'Be brief.'})
          ..shared = bad
          ..skipped = bad;
        await show(tester, computer);
        expect(find.text('Be brief.'), findsOneWidget, reason: '$bad');
        expect(tester.takeException(), isNull, reason: '$bad');
        await tester.pumpWidget(const SizedBox());
      }
      final computer = SwarmV4Computer(files: {'h/Faye': 'Be brief.'})
        ..shared = [
          null,
          1,
          'x',
          <String, Object?>{},
          {'name': 'AGENTS.md'},
          {'text': 'no name'},
          {'name': 5, 'text': 'name is not text'},
          {'name': 'AGENTS.md', 'text': 5},
          {'name': '', 'text': 'name is empty'},
          // A newer computer's entry: a path, the engines that load it, a field nobody knows.
          {
            'name': 'CLAUDE.md',
            'path': '../CLAUDE.md',
            'text': 'The parent\'s.',
            'loadedBy': ['claude'],
            'future': 1,
          },
          {'name': 'CLAUDE.md', 'text': 'Its own.'},
        ]
        ..skipped = [
          3,
          {'why': 'link'},
          {'name': 'x.md', 'why': 7},
        ];
      await show(tester, computer);
      // Listed by path when there is one, so two of one name are told apart.
      expect(find.text('../CLAUDE.md'), findsOneWidget);
      expect(find.text('CLAUDE.md'), findsOneWidget);
      expect(find.text('The parent\'s.'), findsOneWidget);
      expect(find.text('Its own.'), findsOneWidget);
      expect(find.text('x.md isn\'t shown.'), findsOneWidget);
      expect(find.text('AGENTS.md'), findsNothing);
      expect(find.textContaining('name is'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'Edit and Save are for the agent\'s own file: the others wait, nothing of them is sent, and they are back after',
    (tester) async {
      // Both at the most the computer sends, 64 KiB: the pane's own limit counts the agent's file alone.
      final big = 'a' * 65536;
      final computer = SwarmV4Computer(files: {'h/Faye': 'Be brief.'})
        ..shared = [
          file('AGENTS.md', big, truncated: true),
          file('CLAUDE.md', 'z' * 65536, truncated: true),
        ];
      await show(tester, computer);
      expect(key('swarm-shared-text-0'), findsOneWidget);
      await tester.tap(key('swarm-instructions-edit'));
      await tester.pumpAndSettle();
      expect(key('swarm-shared-text-0'), findsNothing);
      expect(
        tester
            .widget<TextField>(key('swarm-instructions-field'))
            .controller!
            .text,
        'Be brief.',
      );
      await tester.tap(key('swarm-instructions-cancel'));
      await tester.pumpAndSettle();
      expect(key('swarm-shared-text-0'), findsOneWidget);
      // A save of the own file at its limit: 64 KiB of it, beside 128 KiB of the others.
      await tester.tap(key('swarm-instructions-edit'));
      await tester.pumpAndSettle();
      await tester.enterText(key('swarm-instructions-field'), 'b' * 65536);
      await tester.pump();
      await tester.tap(key('swarm-instructions-save'));
      await tester.pumpAndSettle();
      final write = computer.requests.last;
      expect(write.$2, 'agent_instructions_write');
      expect(write.$3.keys.toSet(), {'agentId', 'name', 'text', 'version'});
      expect(computer.files['h/Faye'], 'b' * 65536);
      expect(key('swarm-instructions-field'), findsNothing);
      expect(find.text('b' * 65536), findsOneWidget);
      // They are still there, as they were read: a save's answer carries none.
      expect(
        tester.widget<SelectableText>(key('swarm-shared-text-0')).data,
        big,
      );
      expect(key('swarm-shared-text-1'), findsOneWidget);
      // One byte over is refused as before, and nothing is sent.
      await tester.tap(key('swarm-instructions-edit'));
      await tester.pumpAndSettle();
      await tester.enterText(key('swarm-instructions-field'), 'c' * 65537);
      await tester.pump();
      final sent = computer.requests.length;
      await tester.tap(key('swarm-instructions-save'));
      await tester.pumpAndSettle();
      expect(computer.requests, hasLength(sent));
      expect(
        tester.widget<Text>(key('swarm-instructions-save-error')).data,
        'Too long to save. Keep it under 64 KB.',
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a read the computer refuses for the agent\'s own file still shows the others, and Try again reads again',
    (tester) async {
      final computer = SwarmV4Computer(files: {'h/Faye': 'Be brief.'})
        ..refuse = 'TOO_LARGE'
        ..shared = [file('AGENTS.md', 'Ship small.')];
      await show(tester, computer);
      expect(
        tester.widget<Text>(key('swarm-instructions-error')).data,
        'Too long to open here.',
      );
      expect(key('swarm-instructions-retry'), findsOneWidget);
      expect(find.text('Ship small.'), findsOneWidget);
      expect(find.text('Be brief.'), findsNothing);
      // The agent's own file cannot be written from here: no Edit.
      expect(key('swarm-instructions-edit'), findsNothing);
      computer.refuse = null;
      await tester.tap(key('swarm-instructions-retry'));
      await tester.pumpAndSettle();
      expect(key('swarm-instructions-error'), findsNothing);
      expect(find.text('Be brief.'), findsOneWidget);
      expect(find.text('Ship small.'), findsOneWidget);
      expect(key('swarm-instructions-edit'), findsOneWidget);
    },
  );

  testWidgets(
    'Edit and Cancel pressed fast, five times over, leave the pane as it was, and Try again pressed fast reads each time',
    (tester) async {
      final computer = SwarmV4Computer(files: {'h/Faye': 'Be brief.'})
        ..shared = [file('AGENTS.md', 'Ship small.')];
      await show(tester, computer);
      for (var i = 0; i < 5; i++) {
        await tester.tap(key('swarm-instructions-edit'));
        await tester.pump();
        expect(key('swarm-shared-text-0'), findsNothing, reason: '$i');
        await tester.tap(key('swarm-instructions-cancel'));
        await tester.pump();
      }
      await tester.pumpAndSettle();
      expect(find.text('Be brief.'), findsOneWidget);
      expect(find.text('Ship small.'), findsOneWidget);
      expect(computer.requests, hasLength(1));
      // A computer that does not answer well: every press of Try again asks again, and the last answer shows.
      computer.refuse = 'TIMEOUT';
      await tester.pumpWidget(const SizedBox());
      await show(tester, computer);
      for (var i = 0; i < 3; i++) {
        await tester.tap(key('swarm-instructions-retry'));
        await tester.pump();
      }
      computer.refuse = null;
      await tester.tap(key('swarm-instructions-retry'));
      await tester.pumpAndSettle();
      expect(key('swarm-instructions-error'), findsNothing);
      expect(find.text('Be brief.'), findsOneWidget);
      await openFiles(tester);
      expect(find.text('Ship small.'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a computer that cannot be asked shows no files, as before', (
    tester,
  ) async {
    final computer = SwarmV4Computer()..refuse = 'OFFLINE';
    await show(tester, computer);
    expect(find.text('Mac Studio is offline.'), findsOneWidget);
    expect(find.text('AGENTS.md'), findsNothing);
    expect(key('swarm-instructions-retry'), findsOneWidget);
  });

  testWidgets(
    'an answer that comes after the pane moved to another agent shows none of the first one\'s files',
    (tester) async {
      final computer = SwarmV4Computer(
        files: {'h/Faye': 'Faye\'s own.', 'h/Kai': 'Kai\'s own.'},
      )..shared = [file('AGENTS.md', 'Faye\'s project.')];
      final slow = Completer<void>();
      var reads = 0;
      computer.hold = () => reads++ == 0 ? slow.future : Future.value();
      await tester.binding.setSurfaceSize(const Size(880, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final who = ValueNotifier('Faye');
      addTearDown(who.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: ValueListenableBuilder(
              valueListenable: who,
              builder: (_, name, _) => SwarmAgentInstructions(
                agent: agent(name),
                machineName: 'Mac Studio',
                onClose: () {},
                link: computer.link,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      // Kai is shown while Faye's answer is on its way, and Kai's computer holds another project.
      computer.shared = [file('AGENTS.md', 'Kai\'s project.')];
      who.value = 'Kai';
      await tester.pumpAndSettle();
      await openFiles(tester);
      expect(find.text('Kai\'s own.'), findsOneWidget);
      expect(find.text('Kai\'s project.'), findsOneWidget);
      slow.complete();
      await tester.pumpAndSettle();
      expect(find.text('Faye\'s own.'), findsNothing);
      expect(find.text('Faye\'s project.'), findsNothing);
      expect(find.text('Kai\'s own.'), findsOneWidget);
      expect(find.text('Kai\'s project.'), findsOneWidget);
    },
  );

  for (final width in [390.0, 560.0, 880.0]) {
    testWidgets(
      'awkward text at ${width.toInt()} wide: one unbroken line, emoji, tabs, Windows line ends and a very long name stay inside the pane',
      (tester) async {
        final computer = SwarmV4Computer(files: {'h/Faye': 'x' * 20000})
          ..shared = [
            file('AGENTS.md', 'https://example.com/${'a1b2c3' * 3000}'),
            file('CLAUDE.md', '\u{1F680}\u{1F389} tab\there\r\nsecond\r\n﻿'),
            file('${'long-name-' * 30}.md', 'Ship small.'),
          ]
          ..skipped = [
            {'name': 'z' * 200, 'why': 'link'},
          ];
        await show(tester, computer, size: Size(width, 700));
        expect(tester.takeException(), isNull);
        final edge = tester.getRect(find.byType(SwarmAgentInstructions)).right;
        for (final k in [
          'swarm-instructions-text',
          'swarm-shared-text-0',
          'swarm-shared-text-1',
          'swarm-shared-name-2',
          'swarm-skipped-0',
        ]) {
          expect(
            tester.getRect(key(k)).right,
            lessThanOrEqualTo(edge),
            reason: k,
          );
        }
        await tester.dragUntilVisible(
          key('swarm-skipped-0'),
          find.byType(SingleChildScrollView).first,
          const Offset(0, -2000),
        );
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('a file with Windows line ends reads like one with Unix ones', (
    tester,
  ) async {
    Future<double> height(String text) async {
      final computer = SwarmV4Computer()..shared = [file('AGENTS.md', text)];
      await show(tester, computer);
      final h = tester.getSize(key('swarm-shared-text-0')).height;
      await tester.pumpWidget(const SizedBox());
      return h;
    }

    expect(
      await height('one\r\ntwo\r\nthree'),
      await height('one\ntwo\nthree'),
    );
  });

  // What goes into the agent (anh Dee, 2026-11-11: "show users what goes into the agent. and what they can edit"): beside its
  // own file, which alone has Edit, what Harness adds at every start and its person's own CLAUDE.md on its computer, each read
  // only and folded, and a last line for its engine's own instructions, which nobody sees here.
  group('what goes into the agent', () {
    const basics =
        'You are a Swarm agent on a team shipping one project.\n- Your tasks are GitHub issues.';

    testWidgets(
      'Harness\'s Swarm basics and its person\'s own CLAUDE.md, read only, each a click from its text, then its engine\'s own',
      (tester) async {
        final computer = SwarmV4Computer(files: {'h/Faye': 'Be brief.'})
          ..shared = [file('AGENTS.md', 'Ship small.')]
          ..basics = basics
          ..personal = [
            {
              'name': 'CLAUDE.md',
              'path': '~/.claude/CLAUDE.md',
              'text': 'Answer in plain words.\n',
            },
          ];
        await show(tester, computer, open: false);
        expect(computer.asked, [
          {'action': 'basics', 'harnessId': 'h'},
        ]);
        // Each under its own heading, after the agent's own file and its folder's.
        Text text(String k) => tester.widget<Text>(key(k));
        expect(text('swarm-harness-heading').data, 'From Harness');
        expect(text('swarm-personal-heading').data, 'From Mac Studio');
        expect(text('swarm-harness-name-0').data, 'Swarm basics');
        expect(text('swarm-harness-size-0').data, '2 lines');
        expect(text('swarm-personal-name-0').data, '~/.claude/CLAUDE.md');
        expect(text('swarm-personal-size-0').data, '2 lines');
        expect(
          text('swarm-engine-own').data,
          'And Claude Code\'s own instructions, from Anthropic.',
        );
        final order = [
          'swarm-instructions-text',
          'swarm-shared-heading',
          'swarm-harness-heading',
          'swarm-personal-heading',
          'swarm-engine-own',
        ].map((k) => top(tester, key(k))).toList();
        expect(order, [...order]..sort());
        // Folded until opened, as a person clicks each.
        expect(find.text(basics), findsNothing);
        expect(find.text('Answer in plain words.\n'), findsNothing);
        for (final row in ['swarm-harness-row-0', 'swarm-personal-row-0']) {
          await tester.ensureVisible(key(row));
          await tester.tap(key(row));
          await tester.pumpAndSettle();
        }
        expect(
          tester.widget<SelectableText>(key('swarm-harness-text-0')).data,
          basics,
        );
        expect(
          tester.widget<SelectableText>(key('swarm-personal-text-0')).data,
          'Answer in plain words.\n',
        );
        // Only the agent's own file has Edit: the others are changed where they are kept.
        expect(key('swarm-instructions-edit'), findsOneWidget);
        await tester.tap(key('swarm-harness-row-0'));
        await tester.pumpAndSettle();
        expect(key('swarm-harness-text-0'), findsNothing);
      },
    );

    testWidgets('a file there and not shown is said in its own group', (
      tester,
    ) async {
      final computer = SwarmV4Computer(files: {'h/Faye': 'Be brief.'})
        ..shared = [file('AGENTS.md', 'Ship small.')]
        ..skipped = [
          {'name': 'CLAUDE.local.md', 'why': 'link'},
        ]
        ..basics = basics
        ..personalSkipped = [
          {'name': 'CLAUDE.md', 'path': '~/.claude/CLAUDE.md', 'why': 'link'},
        ];
      await show(tester, computer, open: false);
      expect(
        tester.widget<Text>(key('swarm-personal-skipped-0')).data,
        '~/.claude/CLAUDE.md is a link.',
      );
      expect(
        tester.widget<Text>(key('swarm-skipped-0')).data,
        'CLAUDE.local.md is a link.',
      );
      final order = [
        'swarm-shared-heading',
        'swarm-skipped-0',
        'swarm-harness-heading',
        'swarm-personal-heading',
        'swarm-personal-skipped-0',
      ].map((k) => top(tester, key(k))).toList();
      expect(order, [...order]..sort());
    });

    testWidgets('a Codex agent\'s last line names Codex\'s own, from OpenAI', (
      tester,
    ) async {
      final computer = SwarmV4Computer(files: {'h/Kai': 'Review fast.'});
      final codex = SuperTabAgent.fromJson({
        'id': 'id-Kai',
        'name': 'Kai',
        'machineId': 'm',
        'harnessId': 'h',
        'contributorId': 'p',
        'configuration': {'engine': 'codex'},
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: SwarmAgentInstructions(
              agent: codex,
              machineName: 'Mac Studio',
              onClose: () {},
              link: computer.link,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-engine-own')).data,
        'And Codex\'s own instructions, from OpenAI.',
      );
    });

    testWidgets(
      'a computer from before them shows neither, and still the last line',
      (tester) async {
        final computer = SwarmV4Computer(files: {'h/Faye': 'Be brief.'})
          ..shared = [file('AGENTS.md', 'Ship small.')];
        await show(tester, computer);
        expect(key('swarm-harness-heading'), findsNothing);
        expect(key('swarm-personal-heading'), findsNothing);
        expect(find.text('Ship small.'), findsOneWidget);
        expect(key('swarm-engine-own'), findsOneWidget);
        // A refused read keeps what Harness said before it.
        computer.basics = basics;
        await tester.pumpWidget(const SizedBox());
        await show(tester, computer, open: false);
        expect(key('swarm-harness-heading'), findsOneWidget);
      },
    );
  });
}

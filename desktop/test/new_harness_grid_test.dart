import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'support/launch_menu.dart'
    show harnessChoicesActive, focusLaunchRow, openLaunchRow;
import 'support/mixed_agents.dart';
import 'swarm_state_test.dart' show createApp;

/// Records what the form asks the daemon for, so a test can tell whether a
/// key STARTED an agent rather than inferring it from the screen.
class _Daemon extends WsConn {
  _Daemon()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final requests = <String>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add(type);
    if (type == 'engines_probe') return {'engines': []};
    if (type == 'dsh_list') return {'dsh': []};
    if (type == 'git_project_info') {
      return {
        'isGit': true,
        'branch': 'main',
        'branches': [
          {'ref': 'refs/heads/main', 'name': 'main'},
        ],
      };
    }
    return {};
  }
}

void main() {
  Future<(NewHarnessController, _Daemon)> mount(
    WidgetTester tester, {
    String focus = 'agent',
    double width = 820,
    double height = 450,
    double scale = 1,
    MemoryKeymap? keymap,
  }) async {
    final daemon = _Daemon();
    final app = createApp(connectionForTest: (_) => daemon);
    seedMixedAgents(app);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      folder: '/work/harness-app-landing-page',
    );
    addTearDown(app.dispose);
    addTearDown(box.dispose);
    keymap ??= MemoryKeymap();
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: KeymapProvider(
          keymap: keymap,
          child: KeymapHost(
            keymap: keymap,
            enabled: () => true,
            actions: const {},
            child: Scaffold(
              body: Center(
                child: SizedBox(
                  width: width,
                  height: height,
                  child: NewHarnessForm(
                    controller: box,
                    onClose: () {},
                    onCreated: () {},
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await focusLaunchRow(tester, focus);
    return (box, daemon);
  }

  testWidgets('Enter accepts a value before a separate Enter launches', (
    tester,
  ) async {
    final (box, daemon) = await mount(tester);
    await key(tester, LogicalKeyboardKey.enter);
    expect(harnessChoicesActive(tester), isTrue);
    expect(daemon.requests, isNot(contains('agent_create')));
    await key(tester, LogicalKeyboardKey.enter);
    expect(box.field, NewHarnessField.launch);
    expect(daemon.requests, isNot(contains('agent_create')));
    expect(find.textContaining('⇧'), findsNothing);
    await key(tester, LogicalKeyboardKey.enter, shift: true);
    expect(daemon.requests, isNot(contains('agent_create')));
    await key(tester, LogicalKeyboardKey.enter);
    expect(daemon.requests, contains('agent_create'));
  });

  group('one grid', () {
    double heightOf(WidgetTester tester, String field) =>
        tester.getSize(find.byKey(ValueKey('new-harness-field-$field'))).height;

    for (final (width, height, scale) in [
      (823.25, 417.5, 1.0),
      (1283.7, 587.3, 1.6),
    ]) {
      testWidgets(
        'fields and action keep whole cells at $width × $height, scale $scale',
        (tester) async {
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = const Size(1400, 900);
          addTearDown(tester.view.reset);
          final (box, _) = await mount(
            tester,
            width: width,
            height: height,
            scale: scale,
          );
          await openLaunchRow(tester, 'advanced');
          final surface = find.byKey(const ValueKey('new-harness-surface'));
          final origin = tester.getTopLeft(surface);
          final cell = terminalCellSizeOf(tester.element(surface));
          Finder textIn(String key, String text) => find.descendant(
            of: find.byKey(ValueKey(key)),
            matching: find.text(text),
          );
          Finder label(String name, String text) =>
              textIn('new-harness-field-$name', text);
          void onGrid(Finder text) {
            final offset = tester.getTopLeft(text) - origin;
            expect(
              offset.dx / cell.width,
              closeTo((offset.dx / cell.width).roundToDouble(), .01),
            );
            expect(
              offset.dy / cell.height,
              closeTo((offset.dy / cell.height).roundToDouble(), .01),
            );
          }

          final agent = label('agent', 'Agent');
          final start = label('start', 'New Harness');
          final fields = {
            'agent': 'Agent',
            'model': 'Model',
            'approvals': 'Approvals',
            if (box.usesProfile) 'profile': 'Profile',
            'project': 'Project',
            'advanced': 'Options',
            'branch': 'Branch',
            'worktree': 'Worktree',
          };
          for (final entry in fields.entries) {
            final text = label(entry.key, entry.value);
            onGrid(text);
            expect(tester.getTopLeft(text).dx, tester.getTopLeft(agent).dx);
          }
          onGrid(start);
          final lastAgentSetting = box.usesProfile
              ? label('profile', 'Profile')
              : label('approvals', 'Approvals');
          expect(
            tester.getTopLeft(label('branch', 'Branch')).dy -
                tester.getBottomLeft(lastAgentSetting).dy,
            closeTo(0, .01),
          );
          expect(
            tester.getTopLeft(start).dy -
                tester.getBottomLeft(label('worktree', 'Worktree')).dy,
            closeTo(cell.height, .01),
          );
          final value = label('agent', box.launchAgentLabel);
          onGrid(value);
          expect(
            tester.getTopLeft(value).dx - tester.getTopLeft(agent).dx,
            closeTo(11 * cell.width, .01),
          );
          final size = tester.getSize(surface);
          expect(size.width / cell.width, closeTo(56, .01));
          expect(
            size.height / cell.height,
            closeTo(box.usesProfile ? 14 : 13, .01),
          );
          expect(tester.takeException(), isNull);
        },
      );
    }

    testWidgets('every field is exactly one row', (tester) async {
      await mount(tester);
      await openLaunchRow(tester, 'advanced');
      final row = heightOf(tester, 'agent');
      for (final field in [
        'model',
        'approvals',
        'project',
        'branch',
        'worktree',
      ]) {
        expect(heightOf(tester, field), row, reason: '$field drifted');
      }
    });

    testWidgets('a wrapped notice is a whole number of rows', (tester) async {
      final (box, _) = await mount(tester, focus: 'model');
      final row = heightOf(tester, 'agent');
      await openLaunchRow(tester, 'model');
      final notice = box.modelNotice;
      expect(notice, isNotNull);
      final height = tester.getSize(find.text(notice!)).height;
      expect(height / row, closeTo((height / row).roundToDouble(), .01));
      expect(height, greaterThan(row), reason: 'The fixture wraps it.');
    });

    testWidgets('the right pane has one text column', (tester) async {
      final (box, _) = await mount(tester, focus: 'model');
      await openLaunchRow(tester, 'model');
      double left(Finder finder) => tester.getTopLeft(finder).dx;
      final column = left(find.byKey(const ValueKey('new-harness-query')));
      expect(left(find.text(box.modelNotice!)), closeTo(column, .5));
      expect(left(find.text('Subscription')), closeTo(column, .5));
      expect(left(find.text('Refresh models')), closeTo(column, .5));
    });

    testWidgets('every value on the left starts on one column', (tester) async {
      final (box, _) = await mount(tester);
      // The same words can be a choice on the right; look inside each field.
      double left(String field, String text) => tester
          .getTopLeft(
            find.descendant(
              of: find.byKey(ValueKey('new-harness-field-$field')),
              matching: find.text(text),
            ),
          )
          .dx;
      final column = left('agent', box.agentLabel);
      expect(left('project', box.launchProjectLabel), closeTo(column, .5));
    });

    testWidgets(
      'Options rows are consecutive and Machine has no separate row',
      (tester) async {
        final (box, _) = await mount(tester);
        await openLaunchRow(tester, 'advanced');
        expect(
          find.byKey(const ValueKey('new-harness-field-machine')),
          findsNothing,
        );
        final fields = [
          'advanced',
          'model',
          'approvals',
          if (box.usesProfile) 'profile',
          'branch',
          'worktree',
        ];
        Rect? previous;
        for (final field in fields) {
          final row = tester.getRect(
            find.byKey(ValueKey('new-harness-field-$field')),
          );
          if (previous != null) expect(row.top, closeTo(previous.bottom, .01));
          previous = row;
        }
      },
    );
  });

  group('small reads', () {
    testWidgets('the hint sits against the caret, with no space between', (
      tester,
    ) async {
      final (box, _) = await mount(tester);
      await key(tester, LogicalKeyboardKey.arrowRight);
      final hint = tester
          .widget<TextField>(find.byKey(const ValueKey('new-harness-query')))
          .decoration!
          .hintText!;
      expect(hint, isNot(startsWith(' ')));
      expect(hint, box.hint);
    });

    testWidgets('this computer leads the machine list', (tester) async {
      final (box, _) = await mount(tester, focus: 'machine');
      // Make the machine that lists LAST the local one, so this passes only
      // if the list really moves it to the top.
      final last = box.options.lastWhere((row) => !row.synthetic);
      expect(last.id, isNot(box.options.first.id));
      box.app.stateOf(last.id)!.localOnly = true;
      box.focusField(NewHarnessField.harness);
      box.focusField(NewHarnessField.machine);
      await tester.pumpAndSettle();
      expect(box.options.firstWhere((row) => !row.synthetic).id, last.id);
    });

    testWidgets('usable machines come before unusable ones', (tester) async {
      final (box, _) = await mount(tester, focus: 'machine');
      final rows = box.options.where((row) => !row.synthetic).toList();
      final firstUnusable = rows.indexWhere((row) => !row.enabled);
      expect(firstUnusable, isNonNegative, reason: 'fixture has one');
      expect(
        rows.skip(firstUnusable).every((row) => !row.enabled),
        isTrue,
        reason: 'No usable machine may follow an unusable one.',
      );
    });

    testWidgets('Terminal needs no gloss', (tester) async {
      await mount(tester);
      expect(find.text('A shell, no agent'), findsNothing);
    });
  });

  group('focus ownership', () {
    for (final activation in ['right', 'typing', 'enter']) {
      testWidgets('$activation enters the automatically visible chooser', (
        tester,
      ) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(2200, 700);
        addTearDown(tester.view.reset);
        final (box, daemon) = await mount(tester, focus: 'start', width: 2200);
        final surface = find.byKey(const ValueKey('new-harness-surface'));
        final chooser = find.byKey(
          const ValueKey('new-harness-chooser-surface'),
        );
        final frame = tester.getRect(surface);
        final originalEngine = box.engine;
        expect(chooser, findsNothing);
        await key(tester, LogicalKeyboardKey.arrowDown);
        expect(box.field, NewHarnessField.harness);
        expect(chooser, findsOneWidget);
        expect(harnessChoicesActive(tester), isFalse);
        expect(
          FocusManager.instance.primaryFocus?.debugLabel,
          'new-harness-form',
        );
        // A visible chooser does not capture navigation before activation.
        await key(tester, LogicalKeyboardKey.arrowDown);
        expect(box.field, NewHarnessField.projectMenu);
        await key(tester, LogicalKeyboardKey.arrowUp);
        expect(box.field, NewHarnessField.harness);
        expect(box.engine, originalEngine);
        switch (activation) {
          case 'right':
            await key(tester, LogicalKeyboardKey.arrowRight);
          case 'enter':
            await key(tester, LogicalKeyboardKey.enter);
          case 'typing':
            await tester.sendKeyEvent(LogicalKeyboardKey.keyC, character: 'c');
            await tester.pumpAndSettle();
            expect(box.query, 'c');
            await key(tester, LogicalKeyboardKey.backspace);
            expect(box.query, isEmpty);
        }
        expect(harnessChoicesActive(tester), isTrue);
        expect(
          FocusManager.instance.primaryFocus?.debugLabel,
          'new-harness-query',
        );
        final first = box.selected!.id;
        await key(tester, LogicalKeyboardKey.arrowDown);
        expect(box.selected!.id, isNot(first));
        expect(box.field, NewHarnessField.harness);
        expect(box.engine, originalEngine);
        expect(tester.getRect(surface), frame);
        await key(tester, LogicalKeyboardKey.escape);
        expect(harnessChoicesActive(tester), isFalse);
        expect(chooser, findsNothing);
        expect(box.engine, originalEngine);
        await key(tester, LogicalKeyboardKey.arrowRight);
        final wanted = box.selected!.id;
        await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(box.engine, wanted);
        expect(box.field, NewHarnessField.launch);
        expect(chooser, findsNothing);
        expect(tester.getRect(surface), frame);
        await tester.sendKeyRepeatEvent(LogicalKeyboardKey.enter);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(daemon.requests, isNot(contains('agent_create')));
        await key(tester, LogicalKeyboardKey.enter);
        expect(daemon.requests, contains('agent_create'));
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('a controller-selected field is already visible', (
      tester,
    ) async {
      final (box, _) = await mount(tester);
      box.focusField(NewHarnessField.mode);
      await tester.pumpAndSettle();
      expect(find.text('Options'), findsOneWidget);
      expect(box.advancedOpen, isTrue);
      expect(
        tester
            .widget<Semantics>(
              find.byKey(const ValueKey('new-harness-field-approvals')),
            )
            .properties
            .selected,
        isTrue,
      );
    });

    testWidgets('Enter finishes a project prompt before launching', (
      tester,
    ) async {
      final (box, daemon) = await mount(tester, focus: 'project');
      box.focusField(NewHarnessField.projectName);
      await tester.pumpAndSettle();
      box.setQuery('ledger');
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.enter);
      expect(box.projectLabel, contains('ledger'));
      expect(daemon.requests, isNot(contains('agent_create')));
      await key(tester, LogicalKeyboardKey.enter);
      expect(daemon.requests, contains('agent_create'));
    });

    testWidgets(
      'remapped next and previous keys move the rows, then the list',
      (tester) async {
        final keymap = MemoryKeymap()
          ..apply(
            '{"bindings":['
            '{"keys":"ctrl+l","command":"picker.complete","when":"picker"},'
            '{"keys":"ctrl+h","command":"picker.complete_back","when":"picker"}]}',
          );
        final (box, _) = await mount(tester, keymap: keymap);
        expect(box.field, NewHarnessField.harness);
        for (final (move, back) in [
          (LogicalKeyboardKey.keyN, LogicalKeyboardKey.keyP),
          (LogicalKeyboardKey.keyL, LogicalKeyboardKey.keyH),
        ]) {
          // The list closed: they walk the rows.
          await key(tester, move, ctrl: true);
          expect(box.field, NewHarnessField.projectMenu);
          await key(tester, back, ctrl: true);
          expect(box.field, NewHarnessField.harness);
          // The list open: they walk the choices, and the row stays put.
          await key(tester, LogicalKeyboardKey.arrowRight);
          final first = box.selected!.id;
          await key(tester, move, ctrl: true);
          expect(box.selected!.id, isNot(first));
          expect(box.field, NewHarnessField.harness);
          await key(tester, back, ctrl: true);
          expect(box.selected!.id, first);
          await key(tester, LogicalKeyboardKey.escape);
        }
      },
    );

    testWidgets('a narrow window keeps a status line on the grid', (
      tester,
    ) async {
      final (box, _) = await mount(tester, width: 600);
      box.warn('Machine is busy');
      await tester.pumpAndSettle();
      final status = find.byKey(const ValueKey('new-harness-status'));
      expect(status, findsOneWidget);
      final row = tester
          .getSize(find.byKey(const ValueKey('new-harness-field-agent')))
          .height;
      expect(tester.getSize(status).height / row, closeTo(1, .01));
    });
  });
}

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'support/real_fonts.dart';

Future<void> seedPreviews(AppNotifier app) async {
  final machine = app.machineStates['m']!;
  machine.nodeOnline = true;
  machine.connectionStatus = ConnectionStatus.connected;
  machine.agents = [
    for (final (id, name, engine) in [
      ('a0', 'Checkout retries', 'codex'),
      ('a1', 'Search experience', 'claude'),
      ('a2', 'Workspace sync', 'codex'),
    ])
      Agent(
        id: id,
        sessionId: 'session-$id',
        name: name,
        engine: engine,
        terminalAvailable: true,
        project: AgentProject(
          name: id == 'a0' ? 'storefront' : 'workbench',
          cwd: '/work/${id == 'a0' ? 'storefront' : 'workbench'}',
          branch: 'feat/${id == 'a0' ? 'safe-retries' : 'search'}',
        ),
      ),
  ];
  Future<void> event(String id, String type, Map<String, dynamic> payload) =>
      app.handleEventForTest('m', {
        'type': type,
        'payload': {'agentId': id, 'sessionId': 'session-$id', ...payload},
      });
  await event('a0', 'turn_started', {
    'userMessage':
        'Prevent duplicate charges when a checkout request is retried.',
  });
  await event('a0', 'text_delta', {
    'content': 'Payment retries now reuse the same idempotency key.\n\n**Verified**\n- A timed-out checkout can be retried safely.\n- The original receipt is preserved.\n- All 24 payment tests pass.',
  });
  await event('a0', 'turn_ended', {});
  await event('a1', 'turn_started', {
    'userMessage': 'Show the current task and latest result when selecting a workspace. Keep keyboard navigation fast.',
  });
  await event('a1', 'text_delta', {
    'content': 'The cached preview is connected. I’m checking keyboard focus and resizing at narrow window widths.',
  });
  await event('a1', 'tool_start', {'tool': 'Read'});
  await event('a2', 'turn_started', {
    'userMessage': 'Keep shared workspaces in sync across both machines.',
  });
  await event('a2', 'commander_question', {
    'requestId': 'q',
    'questions': [
      {
        'q': 'Should a workspace reopen its last layout on another machine?',
        'options': ['Restore the layout', 'Start with one pane'],
      },
    ],
  });
}

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide')..addFont(
          rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
        ))
        .load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide300')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
          ),
        ))
        .load();
  });

  testWidgets('offline previews retain text without claiming to work or wait', (
    tester,
  ) async {
    final app = createApp();
    await seedPreviews(app);
    app.adoptSessionForTest(terminal('a69', []));
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyO);
    final field = find.byKey(const ValueKey('swarm-search-input'));
    await tester.enterText(field, 'Workspace sync');
    await tester.pump();
    expect(find.text('Needs your input'), findsOneWidget);
    app.machineStates['m']!.connectionStatus = ConnectionStatus.disconnected;
    app.notifyListeners();
    await tester.pump();
    expect(find.textContaining('Offline', findRichText: true), findsOneWidget);
    expect(find.text('Needs your input'), findsNothing);
    expect(
      find.textContaining('Keep shared workspaces in sync'),
      findsOneWidget,
    );
    expect(find.textContaining('Saved text'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
  for (final inline in [false, true]) {
    for (final mapping in ['fallback', 'default', 'remapped']) {
      testWidgets(
        'preview paging retains search input and selection (inline=$inline, $mapping)',
        (tester) async {
          final app = createApp();
          await seedPreviews(app);
          // Both session and group previews must outgrow the reading area.
          app.machineStates['m']!.agents.addAll([
            for (var i = 3; i < 8; i++)
              Agent(
                id: 'paging-$i',
                name: 'Additional agent $i',
                engine: 'codex',
                terminalAvailable: true,
              ),
          ]);
          await app.handleEventForTest('m', {
            'type': 'text_delta',
            'payload': {
              'agentId': 'a0',
              'sessionId': 'session-a0',
              'content': List.generate(
                60,
                (i) => 'Existing result line $i: the saved session details.',
              ).join('\n'),
            },
          });
          await app.handleEventForTest('m', {
            'type': 'turn_ended',
            'payload': {'agentId': 'a0', 'sessionId': 'session-a0'},
          });
          final frames = <TerminalBinaryFrame>[];
          app.adoptSessionForTest(terminal('a69', frames));
          app.newSwarm();
          final map = MemoryKeymap();
          final remapped = mapping == 'remapped';
          if (remapped) {
            map.apply('''{"bindings":[
              {"keys":"pageup","command":null,"when":"picker"},
              {"keys":"pagedown","command":null,"when":"picker"},
              {"keys":"alt+j","command":"picker.preview_page_down","when":"picker"},
              {"keys":"alt+k","command":"picker.preview_page_up","when":"picker"}
            ]}''');
          }
          if (mapping == 'fallback') {
            await mount(tester, app);
          } else {
            await configured.mount(tester, app, map);
          }
          final field = find.byKey(
            ValueKey(inline ? 'harness-start-search' : 'swarm-search-input'),
          );
          if (inline) {
            await tester.tap(field);
          } else {
            await chord(tester, LogicalKeyboardKey.keyO);
          }
          await tester.enterText(field, 'Checkout retries');
          await tester.pump();
          final search = tester
              .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
              .search;
          ScrollPosition previewPosition() => tester
              .widget<Scrollbar>(
                find.descendant(
                  of: find.byKey(const ValueKey('swarm-search-preview')),
                  matching: find.byType(Scrollbar),
                ),
              )
              .controller!
              .position;
          final editor = tester.widget<EditableText>(
            find.descendant(of: field, matching: find.byType(EditableText)),
          );
          final value = editor.controller.value;
          final selected = search.selected!.id;
          final listPosition = tester
              .widget<ListView>(
                find.byKey(const ValueKey('swarm-search-result-list')),
              )
              .controller!
              .position;
          final listOffset = listPosition.pixels;
          var notifications = 0;
          search.addListener(() => notifications++);
          expect(previewPosition().maxScrollExtent, greaterThan(0));
          if (remapped) {
            await key(tester, LogicalKeyboardKey.pageDown);
            expect(previewPosition().pixels, 0);
          }
          Future<void> page({bool up = false, bool pump = true}) async {
            final trigger = remapped
                ? up
                      ? LogicalKeyboardKey.keyK
                      : LogicalKeyboardKey.keyJ
                : up
                ? LogicalKeyboardKey.pageUp
                : LogicalKeyboardKey.pageDown;
            if (remapped) {
              await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
            }
            await tester.sendKeyEvent(trigger);
            if (remapped) {
              await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
            }
            if (pump) await tester.pump();
          }

          await page(pump: false);
          expect(previewPosition().pixels, greaterThan(0));
          expect(search.selected!.id, selected);
          expect(editor.controller.value, value);
          expect(editor.focusNode.hasPrimaryFocus, isTrue);
          expect(listPosition.pixels, listOffset);
          expect(notifications, 0);
          await tester.pump();
          await page(up: true);
          expect(previewPosition().pixels, 0);

          // The IME owns navigation during composition; no page or accept leaks.
          editor.controller.value = value.copyWith(
            composing: TextRange(start: 0, end: value.text.length),
          );
          await page();
          expect(previewPosition().pixels, 0);
          expect(search.selected!.id, selected);
          editor.controller.value = value;
          await page();
          expect(previewPosition().pixels, greaterThan(0));

          // Switching to a group and paging before its frame uses the new
          // viewport and never retains the previous session's reading position.
          await tester.enterText(field, 'Additional agent 3');
          await page();
          expect(search.selected!.agentId, 'paging-3');
          await page(up: true);
          expect(previewPosition().pixels, 0);
          await tester.enterText(field, 'Checkout retries');
          await tester.pump();
          expect(previewPosition().pixels, 0);
          expect(editor.focusNode.hasPrimaryFocus, isTrue);
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.pump();
          expect(app.panes.any((pane) => pane.agentId == 'a0'), isTrue);
          expect(frames, isEmpty);
          await tester.pumpWidget(const SizedBox());
          app.dispose();
          map.dispose();
        },
      );
    }
    testWidgets(
      'existing content previews are immediate and preserve search focus (inline=$inline)',
      (tester) async {
        final app = createApp();
        await seedPreviews(app);
        app.adoptSessionForTest(
          terminal('a69', [])..terminal.write('Raw terminal noise'),
        );
        app.newSwarm();
        await mount(tester, app);
        final field = find.byKey(
          ValueKey(inline ? 'harness-start-search' : 'swarm-search-input'),
        );
        if (inline) {
          await tester.tap(field);
        } else {
          await chord(tester, LogicalKeyboardKey.keyO);
        }
        await tester.enterText(field, 'Checkout retries');
        await tester.pump();
        expect(
          find.byKey(const ValueKey('swarm-search-preview')),
          findsOneWidget,
        );
        expect(
          find.textContaining('Payment retries now reuse'),
          findsOneWidget,
        );
        expect(find.text('Latest response'), findsOneWidget);
        expect(find.textContaining('Raw terminal noise'), findsNothing);
        final editor = tester.widget<EditableText>(
          find.descendant(of: field, matching: find.byType(EditableText)),
        );
        expect(editor.focusNode.hasFocus, isTrue);
        final list = tester.getRect(
          find.byKey(const ValueKey('swarm-search-result-list')),
        );
        final preview = tester.getRect(
          find.byKey(const ValueKey('swarm-search-preview')),
        );
        expect(preview.left, greaterThanOrEqualTo(list.right));

        await tester.enterText(field, 'Search experience');
        await tester.pump();
        expect(find.text('Current request'), findsOneWidget);
        expect(
          find.textContaining('The cached preview is connected'),
          findsOneWidget,
        );
        expect(find.textContaining('Payment retries now reuse'), findsNothing);
        expect(editor.focusNode.hasFocus, isTrue);
        await app.handleEventForTest('m', {
          'type': 'text_delta',
          'payload': {
            'agentId': 'a1',
            'sessionId': 'session-a1',
            'content': 'The current selection updates immediately.',
          },
        });
        await tester.pump(const Duration(milliseconds: 80));
        expect(
          find.text('The current selection updates immediately.'),
          findsOneWidget,
        );
        expect(editor.focusNode.hasFocus, isTrue);

        await tester.enterText(field, 'Test host');
        await tester.pump();
        final search = tester
            .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
            .search;
        expect(
          search.rows.every((row) => row.isCreate || row.agentId != null),
          isTrue,
        );
        await tester.enterText(field, 'Workspace sync');
        await tester.pump();
        expect(
          find.text(
            'Should a workspace reopen its last layout on another machine?',
          ),
          findsOneWidget,
        );

        await tester.enterText(field, 'Checkout retries');
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(app.panes.any((pane) => pane.agentId == 'a0'), isTrue);
        expect(
          find.byKey(const ValueKey('swarm-search-preview')),
          findsNothing,
        );
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }

  testWidgets(
    'earlier explanations remain readable by keyboard after a commit receipt',
    (tester) async {
      final app = createApp();
      await seedPreviews(app);
      final agent = app.machineStates['m']!.agents.first;
      final record = app.sessionPreviews.read(app.previewKey('m', agent))!;
      record.completedText =
          'I’ll commit the checkout changes.\n\nCommitted and pushed.';
      record.earlierResponses.add(
        'Retrying a checkout now reuses the original payment and receipt.',
      );
      app.adoptSessionForTest(terminal('a69', []));
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyO);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'Checkout',
      );
      await tester.pump();
      final explanation = find.text(
        'Retrying a checkout now reuses the original payment and receipt.',
      );
      expect(explanation, findsOneWidget);
      expect(find.text('Earlier in this session'), findsOneWidget);
      final preview = tester.getRect(
        find.byKey(const ValueKey('swarm-search-preview')),
      );
      await key(tester, LogicalKeyboardKey.pageDown);
      expect(
        tester.getRect(explanation).top,
        greaterThanOrEqualTo(preview.top),
      );
      expect(tester.getRect(explanation).bottom, lessThan(preview.bottom));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  for (final size in [
    const Size(1280, 800),
    const Size(760, 650),
    const Size(400, 600),
  ]) {
    testWidgets('preview remains readable and scrollable at $size', (
      tester,
    ) async {
      final app = createApp();
      await seedPreviews(app);
      app.adoptSessionForTest(terminal('a69', []));
      await mount(tester, app);
      tester.view.physicalSize = size;
      await tester.pump();
      await chord(tester, LogicalKeyboardKey.keyO);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'Checkout',
      );
      await tester.pump(const Duration(milliseconds: 200));
      expect(tester.takeException(), isNull);
      final preview = tester.getRect(
        find.byKey(const ValueKey('swarm-search-preview')),
      );
      final list = tester.getRect(
        find.byKey(const ValueKey('swarm-search-result-list')),
      );
      if (size.width < 864) {
        expect(preview.bottom, lessThanOrEqualTo(list.top));
      }
      final directory = Platform.environment['HARNESS_PREVIEW_CAPTURE_DIR'];
      if (directory != null) {
        final renderView = tester.binding.renderViews.first;
        final layer = renderView.debugLayer! as OffsetLayer;
        await tester.runAsync(() async {
          final image = await layer.toImage(Offset.zero & size);
          final data = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(directory).create(recursive: true);
          await File('$directory/preview-${size.width.toInt()}.png')
              .writeAsBytes(data!.buffer.asUint8List());
          image.dispose();
        });
      }
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }
}

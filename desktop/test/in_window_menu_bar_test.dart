import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/terminal/terminal_binary.dart';

import 'terminal_clipboard_test.dart' show liveSession;
import 'swarm_state_test.dart' show createApp;

import 'package:flutter/foundation.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/shortcuts/keymap_native.dart';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/screens/swarm_menu_bus.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/widgets/app_menu.dart' show AppMenuItem;
import 'package:harness/widgets/in_window_menu_bar.dart';

import 'keymap_host_test.dart' show MemoryKeymap;

/// The in-window menu bar's wiring (Linux and Windows).
///
/// The bar is a mouse-shaped door onto the same surfaces the native menus
/// drive: the app-menu rows report through [InWindowMenuBar.onAction] and the
/// swarm rows dispatch through the bus with the SAME action strings the macOS
/// channel delivers. Those strings are the shared contract with
/// `_RootShellState.runAppMenuAction` and `SwarmScreen._onNative` — a typo in
/// one is a menu item that silently does nothing — so the tests pin strings
/// and arguments, not styling, which the other menus' tests already guard.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final appActions = <String>[];
  final swarmCalls = <MethodCall>[];

  setUp(() {
    appActions.clear();
    swarmCalls.clear();
    swarmMenuBus.setHandler((call) async => swarmCalls.add(call));
    swarmMenuBus.send('update', {
      'enabled': true,
      'canReopen': true,
      'canFind': true,
      'canClosePane': true,
      'canGoBack': true,
      'canGoForward': true,
    });
  });

  tearDown(() {
    swarmMenuBus.setHandler(null);
    swarmMenuBus.send('update', {'enabled': false});
    swarmMenuBus.send('keymapState', {'contexts': {}});
  });

  Future<void> pumpBar(WidgetTester tester, {Widget? body}) async {
    tester.view.physicalSize = const Size(900 * 2, 700 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: Column(
            children: [
              InWindowMenuBar(
                onAction: (action) async => appActions.add(action),
                visible: true,
              ),
              Expanded(child: body ?? const SizedBox.shrink()),
            ],
          ),
        ),
      ),
    );
  }

  /// Taps the first hit-testable widget under [key].
  ///
  /// MenuAnchor keeps a closed menu's rows mounted but unhittable while its
  /// close animation unwinds, and a long menu scrolls its lower rows out of
  /// the panel's max height — so a raw find matches a row the pointer cannot
  /// reach. Scrolling to the row and waiting for a hit-testable match keeps
  /// the sequence deterministic without weakening what it asserts.
  Future<void> tap(WidgetTester tester, String key) async {
    for (var attempt = 0; attempt < 5; attempt++) {
      final candidates = find.byKey(Key(key));
      if (candidates.evaluate().isNotEmpty) {
        await tester.ensureVisible(candidates.first);
        await tester.pumpAndSettle();
        final tappable = candidates.hitTestable();
        if (tappable.evaluate().isNotEmpty) {
          await tester.tap(tappable.first);
          await tester.pumpAndSettle();
          return;
        }
      }
      await tester.pump(const Duration(milliseconds: 50));
    }
    fail('no tappable widget for $key');
  }

  String? clipboard;
  setUp(() {
    clipboard = 'paste me';
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.getData') {
            return clipboard == null ? null : {'text': clipboard};
          }
          if (call.method == 'Clipboard.hasStrings') {
            return {'value': clipboard?.isNotEmpty ?? false};
          }
          if (call.method == 'Clipboard.setData') {
            clipboard = (call.arguments as Map)['text'] as String?;
          }
          return null;
        });
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  for (final command in ['copy', 'cut', 'paste', 'select-all']) {
    testWidgets('Windows Edit $command edits the original real TextField', (
      tester,
    ) async {
      final controller = TextEditingController(text: 'hello world');
      addTearDown(controller.dispose);
      await pumpBar(tester, body: TextField(controller: controller));
      await tester.tap(find.byType(TextField));
      controller.selection = const TextSelection(
        baseOffset: 0,
        extentOffset: 5,
      );
      await tester.pump();
      await tap(tester, 'menu-bar-edit');
      for (final entry in {
        'cut': 'Ctrl+X',
        'copy': 'Ctrl+C',
        'paste': 'Ctrl+V',
        'select-all': 'Ctrl+A',
      }.entries) {
        expect(
          find.descendant(
            of: find.byKey(Key('menu-bar-${entry.key}')),
            matching: find.text(entry.value),
          ),
          findsOneWidget,
        );
      }
      // Keyboard navigation can move primary focus into the overlay too.
      final originalFocus = FocusManager.instance.primaryFocus;
      Focus.of(
        tester.element(
          find.text(
            command == 'select-all'
                ? 'Select All'
                : '${command[0].toUpperCase()}${command.substring(1)}',
          ),
        ),
      ).requestFocus();
      await tester.pump();
      expect(FocusManager.instance.primaryFocus, isNot(same(originalFocus)));
      await tap(tester, 'menu-bar-$command');
      if (command == 'select-all') {
        expect(
          controller.selection,
          const TextSelection(baseOffset: 0, extentOffset: 11),
        );
      } else {
        expect(
          controller.text,
          command == 'cut'
              ? ' world'
              : command == 'paste'
              ? 'paste me world'
              : 'hello world',
        );
        if (command == 'cut' || command == 'copy') expect(clipboard, 'hello');
      }
    }, variant: TargetPlatformVariant.only(TargetPlatform.windows));
  }

  for (final image in [false, true]) {
    testWidgets(
      'Windows composer Edit Paste image=$image preserves draft and selection',
      (tester) async {
        const channel = MethodChannel('harness/clipboard_image');
        final png = Uint8List.fromList([137, 80, 78, 71]);
        final messenger =
            TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(channel, (_) async => png);
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        clipboard = image ? null : 'insert';
        final app = createApp();
        app.stateOf('m')!.terminalImagePasteAvailable = true;
        final frames = <TerminalBinaryFrame>[];
        final controls = <String>[];
        final session = liveSession(
          'a0',
          frames,
          engine: 'claude',
          controls: controls,
        );
        await pumpBar(
          tester,
          body: TerminalPanel(
            notifier: app,
            session: session,
            focused: true,
            composerVisible: true,
            onToggleComposer: () {},
          ),
        );
        await tester.enterText(find.byType(TextField), 'my draft');
        final controller = tester
            .widget<TextField>(find.byType(TextField))
            .controller!;
        controller.selection = const TextSelection.collapsed(offset: 3);
        await tap(tester, 'menu-bar-edit');
        Focus.of(tester.element(find.text('Paste'))).requestFocus();
        await tester.pump();
        await tap(tester, 'menu-bar-paste');
        if (image) {
          expect(
            controls.where((c) => c == 'terminal_chunked_upload_begin'),
            hasLength(1),
          );
          await session.handleFrame('terminal_chunked_upload_begin_result', {
            'streamId': session.streamId,
            'accepted': true,
          });
          await tester.pump();
          expect(frames.single.kind, TerminalBinaryKind.imagePaste);
          expect(frames.single.bytes, png);
          expect(controller.text, 'my draft');
          expect(
            controller.selection,
            const TextSelection.collapsed(offset: 3),
          );
          await session.handleFrame('terminal_paste_image_result', {
            'streamId': session.streamId,
            'outcome': 'clipboard',
          });
        } else {
          expect(controller.text, 'my insertdraft');
          expect(frames, isEmpty);
        }
        await tester.pumpWidget(const SizedBox());
        session.dispose();
        app.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.windows),
    );
  }

  testWidgets('Windows Edit targets the real terminal clipboard paths', (
    tester,
  ) async {
    final app = createApp();
    app.stateOf('m')!.terminalPasteRawAvailable = true;
    final frames = <TerminalBinaryFrame>[];
    final session = liveSession('a0', frames);
    session.terminal.write('terminal selection');
    await pumpBar(
      tester,
      body: TerminalPanel(notifier: app, session: session, focused: true),
    );
    await tester.pump();
    final view = tester.widget<TerminalView>(find.byType(TerminalView));
    view.focusNode!.requestFocus();
    view.controller!.setSelection(
      session.terminal.buffer.createAnchor(0, 0),
      session.terminal.buffer.createAnchor(8, 0),
    );
    await tester.pump();
    await tap(tester, 'menu-bar-edit');
    expect(find.byKey(const Key('menu-bar-cut')), findsOneWidget);
    expect(
      tester.widget(find.byKey(const Key('menu-bar-cut'))),
      isNot(isA<AppMenuItem>()),
    );
    for (final entry in {
      'copy': 'Ctrl+C',
      'paste': 'Ctrl+V',
      'select-all': 'Ctrl+Shift+A',
    }.entries) {
      expect(
        find.descendant(
          of: find.byKey(Key('menu-bar-${entry.key}')),
          matching: find.text(entry.value),
        ),
        findsOneWidget,
      );
    }
    await tap(tester, 'menu-bar-copy');
    expect(clipboard, 'terminal');
    expect(view.controller!.selection, isNull);
    expect(frames, isEmpty);
    view.focusNode!.requestFocus();
    await tester.pump();
    await tap(tester, 'menu-bar-edit');
    await tap(tester, 'menu-bar-select-all');
    expect(view.controller!.selection, isNotNull);
    view.focusNode!.requestFocus();
    await tester.pump();
    await tap(tester, 'menu-bar-edit');
    await tap(tester, 'menu-bar-paste');
    expect(frames.single.kind, TerminalBinaryKind.paste);
    expect(frames.single.bytes, 'terminal'.codeUnits);
    await tester.pumpWidget(const SizedBox());
    session.dispose();
    app.dispose();
  }, variant: TargetPlatformVariant.only(TargetPlatform.windows));

  testWidgets('Windows Edit disables every edit row without editing focus', (
    tester,
  ) async {
    await pumpBar(tester);
    await tap(tester, 'menu-bar-edit');
    for (final command in ['cut', 'copy', 'paste', 'select-all']) {
      final row = find.byKey(Key('menu-bar-$command'));
      expect(row, findsOneWidget);
      expect(tester.widget(row), isNot(isA<AppMenuItem>()));
    }
  }, variant: TargetPlatformVariant.only(TargetPlatform.windows));

  for (final removeEditor in [false, true]) {
    testWidgets(
      'Windows Edit clears its target when ${removeEditor ? 'the editor is removed' : 'focus leaves editing'}',
      (tester) async {
        final visible = ValueNotifier(true);
        final elsewhere = FocusNode();
        addTearDown(visible.dispose);
        addTearDown(elsewhere.dispose);
        await pumpBar(
          tester,
          body: Column(
            children: [
              ValueListenableBuilder<bool>(
                valueListenable: visible,
                builder: (_, show, _) =>
                    show ? const TextField() : const SizedBox(),
              ),
              Focus(focusNode: elsewhere, child: const SizedBox()),
            ],
          ),
        );
        await tester.tap(find.byType(TextField));
        await tester.pump();
        await tap(tester, 'menu-bar-edit');
        expect(
          tester.widget(find.byKey(const Key('menu-bar-copy'))),
          isA<AppMenuItem>(),
        );
        if (removeEditor) {
          visible.value = false;
        } else {
          elsewhere.requestFocus();
        }
        await tester.pumpAndSettle();
        for (final command in ['cut', 'copy', 'paste', 'select-all']) {
          expect(
            tester.widget(find.byKey(Key('menu-bar-$command'))),
            isNot(isA<AppMenuItem>()),
          );
        }
        expect(tester.takeException(), isNull);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.windows),
    );
  }

  testWidgets('Windows Edit ignores a disposed editor after overlay focus', (
    tester,
  ) async {
    final visible = ValueNotifier(true);
    final controller = TextEditingController(text: 'old target');
    addTearDown(visible.dispose);
    addTearDown(controller.dispose);
    await pumpBar(
      tester,
      body: ValueListenableBuilder<bool>(
        valueListenable: visible,
        builder: (_, show, _) =>
            show ? TextField(controller: controller) : const SizedBox(),
      ),
    );
    await tester.tap(find.byType(TextField));
    controller.selection = const TextSelection(baseOffset: 0, extentOffset: 3);
    await tester.pump();
    await tap(tester, 'menu-bar-edit');
    Focus.of(tester.element(find.text('Copy'))).requestFocus();
    await tester.pump();
    visible.value = false;
    await tester.pumpAndSettle();
    await tap(tester, 'menu-bar-copy');
    expect(clipboard, 'paste me');
    expect(tester.takeException(), isNull);
    await tap(tester, 'menu-bar-edit');
    expect(
      tester.widget(find.byKey(const Key('menu-bar-copy'))),
      isNot(isA<AppMenuItem>()),
    );
  }, variant: TargetPlatformVariant.only(TargetPlatform.windows));

  testWidgets('Linux Edit keeps its existing rows', (tester) async {
    await pumpBar(tester);
    await tap(tester, 'menu-bar-edit');
    expect(find.byKey(const Key('menu-bar-cut')), findsNothing);
  }, variant: TargetPlatformVariant.only(TargetPlatform.linux));

  testWidgets('Settings remains reachable before the workspace is enabled', (
    tester,
  ) async {
    await swarmMenuBus.send('update', {'enabled': false});
    await pumpBar(tester);
    await tap(tester, 'menu-bar-harness');
    await tap(tester, 'menu-bar-settings');
    expect(appActions, ['settings']);
    expect(swarmCalls, isEmpty);
  });

  testWidgets('stays off the screen when not visible', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: InWindowMenuBar(onAction: (_) async {}, visible: false),
        ),
      ),
    );

    expect(find.text('File'), findsNothing);
    expect(find.text('History'), findsNothing);
    expect(find.text('View'), findsNothing);
  });

  testWidgets('the Harness menu carries the app-menu commands', (tester) async {
    await pumpBar(tester);

    await tap(tester, 'menu-bar-harness');
    await tap(tester, 'menu-bar-about');
    expect(appActions.last, 'showAbout');

    await tap(tester, 'menu-bar-harness');
    // The panel it opens is Appearance, as Settings' rail calls it; "…" like Settings… beside it.
    expect(find.text('Appearance…'), findsOneWidget);
    expect(find.text('Customize Harness'), findsNothing);
    await tap(tester, 'menu-bar-customize');
    expect(swarmCalls.last.method, 'customize');

    await tap(tester, 'menu-bar-harness');
    await tap(tester, 'menu-bar-shortcuts');
    expect(appActions.last, 'showShortcuts');

    await tap(tester, 'menu-bar-harness');
    await tap(tester, 'menu-bar-check-for-updates');
    expect(appActions.last, 'checkForUpdates');
  });

  testWidgets('the File menu fires the native action strings', (tester) async {
    await pumpBar(tester);

    await tap(tester, 'menu-bar-file');
    await tap(tester, 'menu-bar-new-harness');
    expect(swarmCalls.last.method, 'newAgent');

    await tap(tester, 'menu-bar-file');
    await tap(tester, 'menu-bar-open-harness');
    expect(swarmCalls.last.method, 'sessions');

    await tap(tester, 'menu-bar-file');
    await tap(tester, 'menu-bar-open-project');
    expect(swarmCalls.last.method, 'addAgent');

    await tap(tester, 'menu-bar-file');
    await tap(tester, 'menu-bar-clone-agent');
    expect(swarmCalls.last.method, 'cloneAgent');

    // Kept off the File menu, as SwarmTitlebar.swift keeps it off.
    await tap(tester, 'menu-bar-file');
    expect(find.byKey(const Key('menu-bar-new-terminal')), findsNothing);
    await tap(tester, 'menu-bar-move-pane');
    expect(swarmCalls.last.method, 'movePaneToTab');

    await tap(tester, 'menu-bar-file');
    await tap(tester, 'menu-bar-close-tab');
    expect(swarmCalls.last.method, 'closeActive');
  });

  testWidgets('File shows the active tab\'s Agent Messages, with no on/off '
      'row', (tester) async {
    swarmMenuBus.send('update', {
      'enabled': true,
      'canShowAgentMessages': true,
    });
    await pumpBar(tester);

    await tap(tester, 'menu-bar-file');
    // Whether agents may message is the account's (Settings ▸ Experimental):
    // the tab's on/off was easy to hit by mistake (owner, 2026-10-12).
    expect(find.byKey(const Key('menu-bar-agent-messages')), findsNothing);
    expect(find.text('Agent Messages'), findsNothing);
    await tap(tester, 'menu-bar-show-agent-messages');
    expect(swarmCalls.last.method, 'showAgentMessages');
    expect(swarmCalls.last.arguments, isNull, reason: 'the active tab');

    // The Store tab has no log: the row goes quiet.
    swarmMenuBus.send('update', {'enabled': true});
    await tester.pump();
    await tap(tester, 'menu-bar-file');
    expect(find.byKey(const Key('menu-bar-show-agent-messages')), findsNothing);
    expect(find.text('Show Agent Messages'), findsOneWidget);
  });

  testWidgets('File shares the active tab with other accounts by role', (
    tester,
  ) async {
    const rows = {
      'invitePeople': 'menu-bar-invite-people',
      'stopSharingTab': 'menu-bar-stop-sharing-tab',
      'moveTabHere': 'menu-bar-move-tab-here',
      'leaveTab': 'menu-bar-leave-tab',
    };
    Future<void> offers(Map<String, bool> actions) async {
      swarmMenuBus.send('update', {
        'enabled': true,
        'canShowAgentMessages': true,
        'tabShareActions': actions,
      });
      await tester.pump();
      await tap(tester, 'menu-bar-file');
      for (final MapEntry(key: action, value: key) in rows.entries) {
        expect(
          find.byKey(Key(key)),
          actions[action] == true ? findsOneWidget : findsNothing,
          reason: action,
        );
      }
      // Each row asks for its action, on the active tab. The menu is open
      // for the first; each choice closes it.
      for (final (index, action) in actions.keys.indexed) {
        if (index > 0) await tap(tester, 'menu-bar-file');
        await tap(tester, rows[action]!);
        expect(swarmCalls.last.method, action);
        expect(swarmCalls.last.arguments, isNull, reason: 'the active tab');
      }
    }

    await pumpBar(tester);
    // An unshared tab.
    await offers({'invitePeople': true});
    expect(find.text('Invite People'), findsNothing, reason: 'menu closed');
    // A tab this account shares, from another of its computers.
    await offers({
      'invitePeople': true,
      'stopSharingTab': true,
      'moveTabHere': true,
    });
    // A tab this account was invited to.
    await offers({'leaveTab': true});
    // A daemon too old for shared tabs: none of them.
    await offers({});
    expect(find.text('Invite People'), findsNothing);
    expect(find.text('Leave Tab'), findsNothing);
    // Close File by choosing a row that opens nothing here.
    await tap(tester, 'menu-bar-show-agent-messages');

    // A modal is up: the rows stay, inert.
    swarmMenuBus.send('update', {
      'enabled': false,
      'tabShareActions': {'invitePeople': true, 'stopSharingTab': true},
    });
    await tester.pump();
    await tap(tester, 'menu-bar-file');
    expect(find.byKey(const Key('menu-bar-invite-people')), findsNothing);
    expect(find.text('Invite People'), findsOneWidget);
    expect(find.text('Stop Sharing Tab'), findsOneWidget);

    // Signed out or closed: the rows go with the rest of the state.
    swarmMenuBus.state.clear();
    await tester.pumpAndSettle();
    expect(find.text('Invite People'), findsNothing);
    expect(find.text('Stop Sharing Tab'), findsNothing);
  });

  testWidgets('View reaches both channels', (tester) async {
    await pumpBar(tester);

    await tap(tester, 'menu-bar-view');
    await tap(tester, 'menu-bar-notifications');
    expect(swarmCalls.last.method, 'notifications');

    await tap(tester, 'menu-bar-view');
    await tap(tester, 'menu-bar-layout');
    expect(appActions.last, 'showLayout');

    await tap(tester, 'menu-bar-view');
    await tap(tester, 'menu-bar-bigger-font');
    expect(appActions.last, 'increaseTerminalFontSize');

    for (final (key, action) in [
      ('menu-bar-machines', 'machineList'),
      ('menu-bar-models', 'models'),
      ('menu-bar-machine-monitor', 'manageMachines'),
    ]) {
      await tap(tester, 'menu-bar-view');
      await tap(tester, key);
      expect(swarmCalls.last.method, action);
    }
  });

  testWidgets('View shows Tab Activity only where its toggle acts, titled by '
      'whether it is open', (tester) async {
    // Agent Messages alone (a phone-width window) is not enough.
    swarmMenuBus.send('update', {
      'enabled': true,
      'canShowAgentMessages': true,
    });
    await pumpBar(tester);
    await tap(tester, 'menu-bar-view');
    expect(find.byKey(const Key('menu-bar-toggle-tab-activity')), findsNothing);
    await tap(tester, 'menu-bar-view');

    swarmMenuBus.send('update', {
      'enabled': true,
      'canShowAgentMessages': true,
      'canShowTabActivity': true,
    });
    await tester.pump();
    await tap(tester, 'menu-bar-view');
    expect(find.text('Show Tab Activity'), findsOneWidget);
    await tap(tester, 'menu-bar-toggle-tab-activity');
    expect(swarmCalls.last.method, 'toggleTabActivity');

    swarmMenuBus.send('update', {
      'enabled': true,
      'canShowTabActivity': true,
      'tabActivityOpen': true,
    });
    await tester.pump();
    await tap(tester, 'menu-bar-view');
    expect(find.text('Hide Tab Activity'), findsOneWidget);
  });

  testWidgets('History navigates and reopens from the state', (tester) async {
    swarmMenuBus.send('update', {
      'enabled': true,
      'canGoBack': true,
      'history': [
        {
          'id': 'visited-1',
          'title': 'Codex on workstation',
          'machineName': 'workstation',
          'current': true,
        },
      ],
      'closedHistory': [
        {'id': 'closed-1', 'title': 'Claude on laptop', 'canReopen': true},
        {'id': 'closed-2', 'title': 'Gone for good', 'canReopen': false},
      ],
    });
    await pumpBar(tester);

    await tap(tester, 'menu-bar-history');
    await tap(tester, 'menu-bar-history-back');
    expect(swarmCalls.map((c) => c.method), ['historyBack']);

    await tap(tester, 'menu-bar-history');
    await tap(tester, 'menu-bar-visited-visited-1');
    expect(swarmCalls.last.method, 'historyDestination');
    expect(swarmCalls.last.arguments, {'id': 'visited-1'});

    await tap(tester, 'menu-bar-history');
    await tap(tester, 'menu-bar-closed-closed-1');
    expect(swarmCalls.last.method, 'reopenHistory');
    expect(swarmCalls.last.arguments, {'id': 'closed-1'});

    // A closed tab that cannot reopen draws as a label, not a row.
    await tap(tester, 'menu-bar-history');
    expect(find.byKey(const Key('menu-bar-closed-closed-2')), findsNothing);
    expect(find.text('Gone for good'), findsOneWidget);
  });

  testWidgets('pane rows follow what the focused pane can take', (
    tester,
  ) async {
    swarmMenuBus.send('update', {
      'enabled': true,
      'canFind': false,
      'canClosePane': false,
      'paneActions': {'restartAgent': true, 'shareAgent': false},
    });
    await pumpBar(tester);

    await tap(tester, 'menu-bar-file');
    await tap(tester, 'menu-bar-restart-agent');
    expect(swarmCalls.last.method, 'restartAgent');

    // No pane to act on: the rows validateMenuItem would disable draw as labels.
    await tap(tester, 'menu-bar-file');
    for (final key in [
      'menu-bar-share-agent',
      'menu-bar-split-right',
      'menu-bar-zoom-pane',
      'menu-bar-close-pane',
    ]) {
      expect(find.byKey(Key(key)), findsNothing, reason: key);
    }
    expect(find.text('Share Harness'), findsOneWidget);
    await tap(tester, 'menu-bar-file');

    await tap(tester, 'menu-bar-edit');
    expect(find.byKey(const Key('menu-bar-find-terminal')), findsNothing);
    await tap(tester, 'menu-bar-commands');
    expect(swarmCalls.last.method, 'commands');
  });

  testWidgets(
    'File offers Make Leader or Remove Leader only where the pane can take it',
    (tester) async {
      // Prose: the row is absent without an offer; with one its title says which.
      swarmMenuBus.send('update', {
        'enabled': true,
        'paneActions': {'toggleLeader': false},
      });
      await pumpBar(tester);
      await tap(tester, 'menu-bar-file');
      expect(find.byKey(const Key('menu-bar-toggle-leader')), findsNothing);
      await tap(tester, 'menu-bar-file');

      swarmMenuBus.send('update', {
        'enabled': true,
        'paneActions': {'toggleLeader': true},
        'leaderAction': 'make',
      });
      await tester.pump();
      await tap(tester, 'menu-bar-file');
      expect(find.text('Make Leader'), findsOneWidget);
      await tap(tester, 'menu-bar-toggle-leader');
      expect(swarmCalls.last.method, 'toggleLeader');

      swarmMenuBus.send('update', {
        'enabled': true,
        'paneActions': {'toggleLeader': true},
        'leaderAction': 'remove',
      });
      await tester.pump();
      await tap(tester, 'menu-bar-file');
      expect(find.text('Remove Leader'), findsOneWidget);
      expect(find.text('Make Leader'), findsNothing);
    },
  );

  testWidgets('Windows New Tab menu hint uses the everywhere key', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    // Hint selection must not depend on the alias being declared last.
    map.map = ResolvedKeymap([
      ...harnessDefaultBindings.where((b) => b.outsideTerminal),
      ...harnessDefaultBindings.where((b) => !b.outsideTerminal),
    ], const KeymapConfig.empty());
    await swarmMenuBus.send('keymapState', nativeKeymapSnapshot(map));
    await pumpBar(tester);
    await tap(tester, 'menu-bar-file');
    final row = find.byKey(const Key('menu-bar-new-tab'));
    expect(
      find.descendant(of: row, matching: find.text('Ctrl+Shift+T')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: row, matching: find.text('Ctrl+T')),
      findsNothing,
    );
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('rows show the chord the keymap gives their action', (
    tester,
  ) async {
    swarmMenuBus.send('keymapState', {
      'version': 1,
      'contexts': {
        'terminal': [
          {
            'command': 'agent.new',
            'hint': 'Ctrl+Alt+N',
            'menuAction': 'newAgent',
          },
        ],
        'workspace': [
          {'command': 'agent.new', 'hint': 'Super+N', 'menuAction': 'newAgent'},
          {'command': 'keyboard.quick_start', 'hint': 'Super+K Q'},
        ],
      },
    });
    await pumpBar(tester);

    // The workspace binding wins: it is the one that works from anywhere.
    await tap(tester, 'menu-bar-file');
    expect(find.text('Super+N'), findsOneWidget);
    expect(find.text('Ctrl+Alt+N'), findsNothing);
    await tap(tester, 'menu-bar-file');

    // Quick Start sends the keymap command itself, as the macOS Help row does,
    // and shows that command's chord.
    await tap(tester, 'menu-bar-help');
    expect(find.text('Super+K Q'), findsOneWidget);
    await tap(tester, 'menu-bar-quick-start');
    expect(swarmCalls.last.method, 'keymapCommand');
    expect(swarmCalls.last.arguments, {'command': 'keyboard.quick_start'});

    await tap(tester, 'menu-bar-help');
    await tap(tester, 'menu-bar-keyboard-practice');
    expect(appActions.last, 'keyboardPractice');
  });

  // The Mac's Help ▸ Welcome Tour reports the same string over app_menu.
  testWidgets('Help opens the Welcome Tour', (tester) async {
    await pumpBar(tester);

    await tap(tester, 'menu-bar-help');
    expect(find.text('Welcome Tour'), findsOneWidget);
    await tap(tester, 'menu-bar-welcome-tour');
    expect(appActions.last, 'welcomeTour');
  });

  testWidgets('rows go quiet while the app cannot take them', (tester) async {
    swarmMenuBus.send('update', {
      'enabled': false,
      'canGoBack': false,
      'canReopen': false,
    });
    await pumpBar(tester);

    await tap(tester, 'menu-bar-file');
    expect(find.byKey(const Key('menu-bar-clone-agent')), findsNothing);
    expect(find.text('Clone Harness'), findsOneWidget);

    await tap(tester, 'menu-bar-history');
    expect(find.byKey(const Key('menu-bar-history-back')), findsNothing);
    expect(find.text('Back'), findsOneWidget);
  });
  testWidgets('pins what the Linux bar draws, menu by menu', (tester) async {
    await pumpBar(tester);
    expect(tester.getSize(find.byType(InWindowMenuBar)).height, 30);
    expect(
      [
        for (final button in tester.widgetList<TextButton>(
          find.byType(TextButton),
        ))
          (button.key! as ValueKey<String>).value,
      ],
      [
        'menu-bar-harness',
        'menu-bar-file',
        'menu-bar-edit',
        'menu-bar-view',
        'menu-bar-history',
        'menu-bar-window',
        'menu-bar-help',
      ],
    );
    Future<List<String>> rows(String menu) async {
      await tap(tester, menu);
      final shown = [
        for (final item in tester.widgetList<AppMenuItem>(
          find.byType(AppMenuItem),
        ))
          '${(item.key! as ValueKey<String>).value} ${item.label}',
      ];
      await tap(tester, menu);
      expect(find.byType(AppMenuItem), findsNothing);
      return shown;
    }

    expect(await rows('menu-bar-harness'), [
      'menu-bar-about About Harness',
      'menu-bar-customize Appearance…',
      'menu-bar-settings Settings…',
      'menu-bar-shortcuts Keyboard Shortcuts…',
      'menu-bar-check-for-updates Check for Updates…',
      'menu-bar-quit Quit Harness',
    ]);
    expect(await rows('menu-bar-file'), [
      'menu-bar-new-harness New Harness',
      'menu-bar-open-harness Open Harness',
      'menu-bar-open-project Open Project',
      'menu-bar-clone-agent Clone Harness',
      'menu-bar-new-tab New Tab',
      'menu-bar-rename-tab Rename Tab',
      'menu-bar-close-tab Close Tab',
      'menu-bar-split-right Split Right',
      'menu-bar-split-down Split Down',
      'menu-bar-zoom-pane Zoom Pane',
      'menu-bar-move-pane Move Pane to Tab',
      'menu-bar-close-pane Close Pane',
    ]);
    expect(await rows('menu-bar-edit'), [
      'menu-bar-find-terminal Find in Terminal…',
      'menu-bar-find-next Find Next',
      'menu-bar-find-previous Find Previous',
      'menu-bar-commands Search Commands…',
    ]);
    expect(await rows('menu-bar-view'), [
      'menu-bar-layout Layout…',
      'menu-bar-reset-font-size Default Font Size',
      'menu-bar-bigger-font Bigger',
      'menu-bar-smaller-font Smaller',
      'menu-bar-full-screen Enter Full Screen',
      'menu-bar-notifications Harnesses Needing Input…',
      'menu-bar-machines Machines',
      'menu-bar-models Models',
      'menu-bar-machine-monitor Machine Monitor',
    ]);
    expect(await rows('menu-bar-history'), [
      'menu-bar-history-back Back',
      'menu-bar-history-forward Forward',
      'menu-bar-reopen-last Reopen Closed Tab or Pane',
      'menu-bar-show-history Show Full History',
    ]);
    expect(await rows('menu-bar-window'), [
      'menu-bar-minimize Minimize',
      'menu-bar-zoom Zoom',
    ]);
    expect(await rows('menu-bar-help'), [
      'menu-bar-welcome-tour Welcome Tour',
      'menu-bar-quick-start Quick Start',
      'menu-bar-keyboard-practice Keyboard Practice',
      'menu-bar-export-logs Export Logs…',
    ]);
  });
  testWidgets('Quit Harness quits through the platform\'s own path', (
    tester,
  ) async {
    var quits = 0;
    tester.view.physicalSize = const Size(900 * 2, 700 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: Column(
            children: [
              InWindowMenuBar(
                onAction: (action) async => appActions.add(action),
                onQuit: () async => quits++,
                visible: true,
              ),
              const Expanded(child: SizedBox.shrink()),
            ],
          ),
        ),
      ),
    );
    await tap(tester, 'menu-bar-harness');
    await tap(tester, 'menu-bar-quit');
    expect(quits, 1);
    expect(appActions, isEmpty);
  });
}

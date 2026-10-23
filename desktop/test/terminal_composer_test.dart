import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/theme/app_theme.dart';

import 'dart:convert';

import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_composer.dart';
import 'package:harness/widgets/terminal_panel.dart';

/// The app only ever lists machines whose authMode is `remote`, so that field cannot tell this
/// computer apart from one across the network. `localOnly` — set when the machine's computerId is
/// this computer's — is what actually does, and it is what the composer keys off.
AppNotifier _notifier({required bool local}) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  final machine = Machine(
    machineId: 'm1',
    apiKey: '',
    authMode: MachineAuthMode.remote,
    name: 'm1',
    status: 'online',
  );
  app.machines = [machine];
  app.machineStates['m1'] = MachineState(machine)..localOnly = local;
  return app;
}

/// A session already past `terminal_ready`, so it accepts input.
Future<TerminalSession> _liveSession(
  List<String> outbound, {
  bool live = true,
  List<Map<String, dynamic>>? messages,
}) async {
  const streamId = '00112233-4455-6677-8899-aabbccddeeff';
  Object? openRequestId;
  final session = TerminalSession(
    machineId: 'm1',
    agentId: 'a1',
    agentName: 'a1',
    engineId: 'claude',
    client: const TerminalClientDescriptor(kind: 'desktop', name: 'Fixture'),
    send: (type, payload) async {
      // The session ignores a `terminal_ready` whose requestId is not the one it sent, so the
      // handshake has to answer the real request rather than a placeholder.
      if (type == 'terminal_open') openRequestId = payload['requestId'];
      if (type == 'message') {
        outbound.add(payload['content'] as String);
        messages?.add(Map.of(payload));
      }
      return true;
    },
    sendBinary: (_) async => true,
  );
  await session.open(initialCols: 80, initialRows: 24);
  await session.handleFrame('terminal_ready', {
    'requestId': openRequestId,
    'protocolVersion': 3,
    'streamId': streamId,
    'agentId': 'a1',
  });
  if (live) await _goLive(session);
  return session;
}

/// Render the authoritative keyframe, which is what actually flips a session to accepting input.
/// `terminal_ready` alone leaves it `opening`, and a disabled composer would make these tests pass
/// for the wrong reason.
Future<void> _goLive(TerminalSession session) async {
  const streamId = '00112233-4455-6677-8899-aabbccddeeff';
  await session.handleBinary(
    TerminalBinaryFrame(
      kind: TerminalBinaryKind.keyframe,
      streamId: streamId,
      seq: 0,
      bytes: Uint8List.fromList(utf8.encode(r'$ ')),
      compressed: false,
      cols: 80,
      rows: 24,
    ),
  );
}

Widget _host(
  AppNotifier app,
  TerminalSession session, {
  bool visible = true,
  VoidCallback? onToggle,
  String? firstTask,
}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 900,
      height: 400,
      child: TerminalPanel(
        notifier: app,
        session: session,
        focused: true,
        composerVisible: visible,
        firstTask: firstTask,
        onToggleComposer: onToggle ?? () {},
      ),
    ),
  ),
);

/// WCAG relative luminance, so the assertion below is about how visible the glyph actually is
/// rather than about which token name happens to be wired to it.
double _luminance(Color color) {
  double channel(double value) => value <= 0.03928
      ? value / 12.92
      : math.pow((value + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(color.r) +
      0.7152 * channel(color.g) +
      0.0722 * channel(color.b);
}

double _contrast(Color a, Color b) {
  final first = _luminance(a);
  final second = _luminance(b);
  final high = math.max(first, second);
  final low = math.min(first, second);
  return (high + 0.05) / (low + 0.05);
}

void main() {
  testWidgets(
    'a local first harness has an editable suggestion and sends nothing on opening',
    (tester) async {
      final sent = <String>[];
      final app = _notifier(local: true);
      final session = await _liveSession(sent);
      await tester.pumpWidget(
        _host(app, session, firstTask: 'Make a date page.'),
      );
      await tester.pump();
      expect(find.byType(TerminalComposer), findsOneWidget);
      expect(find.text('Make a date page.'), findsOneWidget);
      expect(sent, isEmpty);
      await tester.enterText(find.byType(TextField), 'My own first task');
      expect(sent, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
      session.dispose();
      app.dispose();
    },
  );
  group('composer clipboard paste', () {
    String? clipboard;
    Future<Object?> Function()? checkClipboard;
    var nonTextPastes = 0;
    late TerminalSession session;
    late FocusNode focusNode;

    setUp(() async {
      session = await _liveSession([]);
      focusNode = FocusNode();
      clipboard = 'pasted text';
      checkClipboard = null;
      nonTextPastes = 0;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
            switch (call.method) {
              case 'Clipboard.hasStrings':
                return checkClipboard == null
                    ? {'value': clipboard?.isNotEmpty ?? false}
                    : checkClipboard!();
              case 'Clipboard.getData':
                return clipboard == null ? null : {'text': clipboard};
            }
            return null;
          });
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null);
      focusNode.dispose();
      session.dispose();
    });

    Future<void> mountComposer(
      WidgetTester tester, {
      bool inputEnabled = true,
    }) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TerminalComposer(
              session: session,
              focusNode: focusNode,
              inputEnabled: inputEnabled,
              onPasteNonText: () async => nonTextPastes++,
            ),
          ),
        ),
      );
      await tester.enterText(find.byType(TextField), 'draft');
      await tester.pump();
    }

    Future<void> paste(WidgetTester tester, {bool command = false}) async {
      final modifier = command
          ? LogicalKeyboardKey.metaLeft
          : LogicalKeyboardKey.controlLeft;
      await tester.sendKeyDownEvent(modifier);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
      await tester.sendKeyUpEvent(modifier);
      await tester.pump();
    }

    String draft(WidgetTester tester) =>
        tester.widget<TextField>(find.byType(TextField)).controller!.text;

    testWidgets('held Ctrl+V pastes text only once', (tester) async {
      await mountComposer(tester);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.keyV);
      await tester.pump();
      await tester.sendKeyRepeatEvent(LogicalKeyboardKey.keyV);
      await tester.pump();
      await tester.sendKeyUpEvent(LogicalKeyboardKey.keyV);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();
      expect(draft(tester), 'draftpasted text');
      expect(nonTextPastes, 0);
      await tester.pumpWidget(const SizedBox());
    }, variant: TargetPlatformVariant.only(TargetPlatform.windows));

    testWidgets('Ctrl+V with text pastes into the field', (tester) async {
      await mountComposer(tester);
      final controller = tester
          .widget<TextField>(find.byType(TextField))
          .controller!;
      controller.selection = const TextSelection(
        baseOffset: 0,
        extentOffset: 5,
      );
      await paste(tester);
      expect(draft(tester), 'pasted text');
      expect(nonTextPastes, 0);
      await tester.pumpWidget(const SizedBox());
    }, variant: TargetPlatformVariant.only(TargetPlatform.windows));

    testWidgets('Ctrl+V with no text hands the paste to the pane', (
      tester,
    ) async {
      clipboard = null;
      await mountComposer(tester);
      await paste(tester);
      expect(nonTextPastes, 1);
      expect(draft(tester), 'draft');
      await tester.pumpWidget(const SizedBox());
    }, variant: TargetPlatformVariant.only(TargetPlatform.windows));

    testWidgets(
      'macOS Command+V keeps text paste and never hands images to the pane',
      (tester) async {
        await mountComposer(tester);
        await paste(tester, command: true);
        expect(draft(tester), 'draftpasted text');
        clipboard = null;
        await paste(tester, command: true);
        expect(draft(tester), 'draftpasted text');
        expect(nonTextPastes, 0);
        await tester.pumpWidget(const SizedBox());
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    testWidgets(
      'a failed clipboard check stays local and allows another paste',
      (tester) async {
        clipboard = null;
        await mountComposer(tester);
        checkClipboard = () async =>
            throw PlatformException(code: 'fixture-check-failed');
        await paste(tester);
        expect(tester.takeException(), isNull);
        expect(
          find.text('Could not read the clipboard. Try Paste again.'),
          findsOneWidget,
        );
        expect(draft(tester), 'draft');
        expect(nonTextPastes, 0);
        checkClipboard = null;
        await paste(tester);
        expect(nonTextPastes, 1);
        await tester.pumpWidget(const SizedBox());
      },
      variant: TargetPlatformVariant.only(TargetPlatform.windows),
    );

    for (final hasText in [false, true]) {
      for (final change in [
        'focus moved',
        'input disabled',
        'control taken',
        'agent replaced',
        'stream replaced',
        'composer disposed',
      ]) {
        testWidgets(
          'pending ${hasText ? 'text' : 'non-text'} clipboard check is cancelled after $change',
          (tester) async {
            final check = Completer<Object?>();
            checkClipboard = () => check.future;
            clipboard = hasText ? 'pasted text' : null;
            await mountComposer(tester);
            await paste(tester);
            TerminalSession? original;
            if (change == 'focus moved') {
              focusNode.unfocus();
            } else if (change == 'input disabled') {
              await tester.pumpWidget(
                MaterialApp(
                  home: Scaffold(
                    body: TerminalComposer(
                      session: session,
                      focusNode: focusNode,
                      inputEnabled: false,
                      onPasteNonText: () async => nonTextPastes++,
                    ),
                  ),
                ),
              );
            } else if (change == 'control taken') {
              await session.handleFrame('terminal_closed', {
                'streamId': session.streamId,
                'code': 'TERMINAL_TAKEN_OVER',
              });
            } else if (change == 'agent replaced') {
              original = session;
              session = await _liveSession([]);
              await mountComposer(tester);
            } else if (change == 'stream replaced') {
              session.streamId = 'replacement-stream';
            } else {
              await tester.pumpWidget(const SizedBox());
            }
            await tester.pump();
            check.complete({'value': hasText});
            await tester.pump();
            expect(nonTextPastes, 0);
            if (change != 'composer disposed') expect(draft(tester), 'draft');
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
            if (original != null) {
              session.dispose();
              session = original;
            }
          },
          variant: TargetPlatformVariant.only(TargetPlatform.windows),
        );
      }
    }
  });

  testWidgets('a remote pane gets the composer', (tester) async {
    final app = _notifier(local: false);
    final session = await _liveSession([]);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    expect(find.byType(TerminalComposer), findsOneWidget);
    session.dispose();
    app.dispose();
  });

  testWidgets('the main composer stays visually distinct in both themes', (
    tester,
  ) async {
    final original = grid.AppTheme.brightness.value;
    addTearDown(() => grid.AppTheme.brightness.value = original);

    for (final brightness in [Brightness.light, Brightness.dark]) {
      grid.AppTheme.brightness.value = brightness;
      final app = _notifier(local: false);
      final session = await _liveSession([]);
      await tester.pumpWidget(_host(app, session));
      await tester.pump();

      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.decoration?.hintText, 'Message harness…  ·  ↵ send');
      expect(
        find.byKey(const ValueKey('terminal-composer-prompt')),
        findsOneWidget,
      );
      expect(
        tester
            .getSize(find.byKey(const ValueKey('terminal-composer-surface')))
            .height,
        greaterThanOrEqualTo(48),
      );

      // The remote composer receives focus when its pane is selected.
      var surface = tester.widget<AnimatedContainer>(
        find.byKey(const ValueKey('terminal-composer-surface')),
      );
      var decoration = surface.decoration! as BoxDecoration;
      var border = decoration.border! as Border;
      expect(border.top.color, grid.AppPalette.accentOnSurface);
      expect(border.top.width, 1.5);
      expect(decoration.boxShadow, grid.AppSurface.composerShadow);

      field.focusNode!.unfocus();
      await tester.pump();
      surface = tester.widget<AnimatedContainer>(
        find.byKey(const ValueKey('terminal-composer-surface')),
      );
      decoration = surface.decoration! as BoxDecoration;
      border = decoration.border! as Border;
      expect(border.top.color, grid.AppGlass.lift);
      expect(border.top.width, 1);
      expect(decoration.boxShadow, grid.AppGlass.shadow);

      session.dispose();
      app.dispose();
      await tester.pumpWidget(const SizedBox.shrink());
    }
  });

  testWidgets('the composer follows terminal font settings live', (
    tester,
  ) async {
    final original = terminalFontStore.value;
    addTearDown(() => terminalFontStore.value = original);

    final app = _notifier(local: false);
    final session = await _liveSession([]);
    terminalFontStore.value = original.copyWith(
      fontFamily: 'Menlo',
      fontFamilyFallback: const ['Monaco', 'monospace'],
      fontSize: 18,
    );
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    void expectTypography(String family, double size) {
      final field = tester.widget<TextField>(find.byType(TextField));
      final renderedHintStyle = tester
          .widget<Text>(find.text('Message harness…  ·  ↵ send'))
          .style!;
      final promptStyle = tester
          .widget<AnimatedDefaultTextStyle>(
            find.byKey(const ValueKey('terminal-composer-prompt-style')),
          )
          .style;

      expect(field.style?.fontFamily, family);
      expect(field.style?.fontSize, size);
      expect(field.style?.letterSpacing, 0);
      expect(field.decoration?.hintStyle?.fontFamily, family);
      expect(field.decoration?.hintStyle?.fontSize, size);
      expect(field.decoration?.hintStyle?.letterSpacing, 0);
      expect(renderedHintStyle.fontFamily, family);
      expect(renderedHintStyle.fontSize, size);
      expect(renderedHintStyle.letterSpacing, 0);
      expect(promptStyle.fontFamily, family);
      expect(promptStyle.fontSize, size);
      expect(promptStyle.letterSpacing, 0);
    }

    expectTypography('Menlo', 18);

    // Settings can change while the pane is already open. The composer listens
    // to the same notifier as the terminal, so neither needs a reload.
    terminalFontStore.value = original.copyWith(
      fontFamily: 'Monaco',
      fontFamilyFallback: const ['Menlo', 'monospace'],
      fontSize: 15,
    );
    await tester.pump();
    expectTypography('Monaco', 15);

    session.dispose();
    app.dispose();
  });

  testWidgets('the composer remains recognizable while attaching', (
    tester,
  ) async {
    final app = _notifier(local: false);
    final session = await _liveSession([], live: false);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.enabled, isFalse);
    expect(field.decoration?.hintText, 'Connecting to terminal…');
    expect(
      find.byKey(const ValueKey('terminal-composer-surface')),
      findsOneWidget,
    );

    session.dispose();
    app.dispose();
  });

  testWidgets(
    'a pane on THIS computer does not — typing there is already fast',
    (tester) async {
      final app = _notifier(local: true);
      final session = await _liveSession([]);
      await tester.pumpWidget(_host(app, session));
      await tester.pump();

      expect(find.byType(TerminalComposer), findsNothing);
      session.dispose();
      app.dispose();
    },
  );

  testWidgets('toggling it off hides the box on a remote pane', (tester) async {
    final app = _notifier(local: false);
    final session = await _liveSession([]);
    await tester.pumpWidget(_host(app, session, visible: false));
    await tester.pump();

    expect(find.byType(TerminalComposer), findsNothing);
    session.dispose();
    app.dispose();
  });

  testWidgets('Enter sends the message and clears the box', (tester) async {
    final outbound = <String>[];
    final messages = <Map<String, dynamic>>[];
    final app = _notifier(local: false);
    final session = await _liveSession(outbound, messages: messages);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    await tester.tap(find.byType(TextField));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'deploy it');
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump(const Duration(milliseconds: 12));

    expect(outbound, ['deploy it']);
    expect(messages.single['usageIntent'], 'interactive');
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller?.text,
      '',
    );
    session.dispose();
    app.dispose();
  });

  testWidgets('Shift+Enter adds a line instead of sending', (tester) async {
    final outbound = <String>[];
    final app = _notifier(local: false);
    final session = await _liveSession(outbound);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    await tester.tap(find.byType(TextField));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'first');
    await tester.pump();

    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pump(const Duration(milliseconds: 12));

    expect(outbound, isEmpty, reason: 'Shift+Enter composes, it does not send');
    // The newline itself cannot be observed here: a widget test's raw key events do not reach the
    // platform text-input channel, so EditableText never inserts for them. What is checkable is
    // that the composer passed the key through untouched rather than consuming it.
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller?.text,
      'first',
    );

    // And that it was live the whole time — otherwise "nothing was sent" above would also be true
    // of a dead composer, and this test would pass for the wrong reason.
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump(const Duration(milliseconds: 12));
    expect(outbound, ['first']);
    session.dispose();
    app.dispose();
  });

  testWidgets('Option+Enter adds a line instead of sending', (tester) async {
    final outbound = <String>[];
    final app = _notifier(local: false);
    final session = await _liveSession(outbound);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    await tester.tap(find.byType(TextField));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'first');
    await tester.pump();

    await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    await tester.pump(const Duration(milliseconds: 12));

    expect(outbound, isEmpty, reason: '⌥⏎ composes, it does not send');
    // Unlike Shift+Enter, this newline IS observable: the composer writes it into the controller
    // itself rather than handing the key to a text-input channel a widget test never runs.
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller?.text,
      'first\n',
    );

    await tester.enterText(find.byType(TextField), 'first\nsecond');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump(const Duration(milliseconds: 12));
    expect(outbound, ['first\nsecond']);
    session.dispose();
    app.dispose();
  });

  testWidgets('Ctrl+W deletes the last word', (tester) async {
    final app = _notifier(local: false);
    final session = await _liveSession([]);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    await tester.tap(find.byType(TextField));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'deploy the service');
    await tester.pump();

    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyW);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump();

    expect(
      tester.widget<TextField>(find.byType(TextField)).controller?.text,
      'deploy the ',
    );
    session.dispose();
    app.dispose();
  });

  /// ⌥⌫ and ⌘⌫ are the pane's word-kill and line-kill (`kTerminalOwnedKeys`), and the composer is
  /// the same prompt wearing a Flutter field — so the two have to agree. Here they come from
  /// Flutter's own macOS text-editing shortcuts rather than from anything this app writes, which is
  /// exactly why they are pinned: nothing in the composer would notice if that changed.
  testWidgets('Option+Backspace kills the word behind the caret', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final outbound = <String>[];
    final app = _notifier(local: false);
    final session = await _liveSession(outbound);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    await tester.tap(find.byType(TextField));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'deploy the service');
    await tester.pump();

    await tester.sendKeyDownEvent(
      LogicalKeyboardKey.altLeft,
      platform: 'macos',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace, platform: 'macos');
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft, platform: 'macos');
    await tester.pump();

    expect(
      tester.widget<TextField>(find.byType(TextField)).controller?.text,
      'deploy the ',
    );
    expect(outbound, isEmpty, reason: 'editing a line is not sending it');
    debugDefaultTargetPlatformOverride = null;
    session.dispose();
    app.dispose();
  });

  testWidgets('Cmd+Backspace clears back to the start of the line', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final outbound = <String>[];
    final app = _notifier(local: false);
    final session = await _liveSession(outbound);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    await tester.tap(find.byType(TextField));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'deploy the service');
    await tester.pump();

    await tester.sendKeyDownEvent(
      LogicalKeyboardKey.metaLeft,
      platform: 'macos',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace, platform: 'macos');
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft, platform: 'macos');
    await tester.pump();

    expect(
      tester.widget<TextField>(find.byType(TextField)).controller?.text,
      '',
    );
    expect(outbound, isEmpty);
    debugDefaultTargetPlatformOverride = null;
    session.dispose();
    app.dispose();
  });

  testWidgets('Ctrl+U clears everything before the cursor', (tester) async {
    final app = _notifier(local: false);
    final session = await _liveSession([]);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    await tester.tap(find.byType(TextField));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'deploy the service');
    await tester.pump();

    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyU);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump();

    expect(
      tester.widget<TextField>(find.byType(TextField)).controller?.text,
      '',
    );
    session.dispose();
    app.dispose();
  });

  testWidgets(
    'the grip stays reachable once the box is gone, and gives its rows back',
    (tester) async {
      final app = _notifier(local: false);
      final session = await _liveSession([]);

      await tester.pumpWidget(_host(app, session));
      await tester.pump();
      expect(find.byType(ComposerGrip), findsOneWidget);
      final expandedSpot = tester.getCenter(find.byType(ComposerGrip));

      // Collapsed, the grip is the ONLY way back — a control that hid with the box would strand it.
      await tester.pumpWidget(_host(app, session, visible: false));
      await tester.pump();
      expect(find.byType(TerminalComposer), findsNothing);
      expect(find.byType(ComposerGrip), findsOneWidget);

      // It rides DOWN with the drawer it belongs to, by exactly the height the terminal just got
      // back. That movement is the point of collapsing, not a flaw in it — pinning the grip would
      // mean reserving the space it was supposed to free.
      final collapsedSpot = tester.getCenter(find.byType(ComposerGrip));
      expect(collapsedSpot.dy, greaterThan(expandedSpot.dy));
      expect(collapsedSpot.dx, expandedSpot.dx);
      session.dispose();
      app.dispose();
    },
  );

  testWidgets('tapping the grip asks for the toggle', (tester) async {
    var toggled = 0;
    final app = _notifier(local: false);
    final session = await _liveSession([]);
    await tester.pumpWidget(_host(app, session, onToggle: () => toggled++));
    await tester.pump();

    await tester.tap(find.byType(ComposerGrip));
    await tester.pump();

    expect(toggled, 1);
    session.dispose();
    app.dispose();
  });

  testWidgets('a local pane gets no grip either', (tester) async {
    final app = _notifier(local: true);
    final session = await _liveSession([]);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    expect(find.byType(ComposerGrip), findsNothing);
    session.dispose();
    app.dispose();
  });
  testWidgets('the grip glyph gains contrast in BOTH themes, not just one', (
    tester,
  ) async {
    final original = grid.AppTheme.brightness.value;
    addTearDown(() => grid.AppTheme.brightness.value = original);

    final app = _notifier(local: false);
    final session = await _liveSession([]);

    Future<({Color glyph, Color pane, Color wasFaint})> renderIn(
      Brightness brightness,
    ) async {
      grid.AppTheme.brightness.value = brightness;
      await tester.pumpWidget(_host(app, session));
      await tester.pump();
      final icon = tester.widget<Icon>(
        find.descendant(
          of: find.byType(ComposerGrip),
          matching: find.byType(Icon),
        ),
      );
      return (
        glyph: icon.color!,
        pane: grid.AppPalette.windowBg,
        // What the glyph used to be drawn in.
        wasFaint: AppColors.muted,
      );
    }

    for (final brightness in [Brightness.light, Brightness.dark]) {
      final drawn = await renderIn(brightness);
      expect(
        _contrast(drawn.glyph, drawn.pane),
        greaterThan(_contrast(drawn.wasFaint, drawn.pane)),
        reason:
            'the grip must read more strongly than the faint ink it started on, '
            'in $brightness — lighter on dark, darker on light',
      );
    }

    session.dispose();
    app.dispose();
  });
  testWidgets(
    'selecting a remote agent puts the caret in the box, not the terminal',
    (tester) async {
      final app = _notifier(local: false);
      final session = await _liveSession([]);
      await tester.pumpWidget(_host(app, session));
      await tester.pump();

      final field = tester.widget<TextField>(find.byType(TextField));
      expect(
        field.focusNode?.hasFocus,
        isTrue,
        reason:
            'the box is the whole point of a remote pane — it should not be '
            'the second thing the user has to click',
      );
      session.dispose();
      app.dispose();
    },
  );

  testWidgets('a local pane still lands in the terminal', (tester) async {
    final app = _notifier(local: true);
    final session = await _liveSession([]);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    // No box at all here, so the terminal keeps the keyboard exactly as before.
    expect(find.byType(TerminalComposer), findsNothing);
    expect(tester.testTextInput.hasAnyClients, isTrue);
    session.dispose();
    app.dispose();
  });

  testWidgets('a still-attaching agent hands the box focus once it goes live', (
    tester,
  ) async {
    final app = _notifier(local: false);
    // Opened but with no keyframe yet: the field is disabled, and a disabled field REFUSES focus.
    // Claiming once at mount would silently lose, which is what the deferred claim exists for.
    final session = await _liveSession([], live: false);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();
    expect(session.acceptsInput, isFalse);
    expect(
      tester.widget<TextField>(find.byType(TextField)).focusNode?.hasFocus,
      isFalse,
    );

    await _goLive(session);
    await tester.pump();
    await tester.pump();

    expect(session.acceptsInput, isTrue);
    expect(
      tester.widget<TextField>(find.byType(TextField)).focusNode?.hasFocus,
      isTrue,
    );
    session.dispose();
    app.dispose();
  });
}

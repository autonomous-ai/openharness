@TestOn('browser')
library;

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:harness/shortcuts/app_shortcuts.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:xterm/xterm.dart' show TerminalTargetPlatform;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_menu_bus.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/widgets/in_window_menu_bar.dart';

/// The native menu surfaces sit above every screen, sign-in included, so the
/// browser build builds them too: they must read the platform without
/// `dart:io`, whose `Platform` throws on the web before the first frame.
void main() {
  test('browser New Tab and companion conversation keep distinct keys', () {
    String? command(String keys) => harnessDefaultKeymap.match(
      KeymapContext.workspace,
      [KeyStroke.parse(keys)],
    ).command;
    expect(command('alt+t'), 'swarm.new');
    expect(command('alt+shift+a'), 'app.daemon_talk');
  });

  test(
    'a browser on Windows keeps its existing keys and terminal platform',
    () {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        expect(ctrlWorkspacePrefix, isFalse);
        expect(windowsKeyLabels, isFalse);
        expect(altWorkspacePrefix, isTrue);
        expect(commandKeyLabel, 'Cmd');
        expect(platformWorkspaceBinding('cmd+t'), 'alt+t');
        expect(shortcutHintFor(ShortcutAction.newSwarm), 'Alt+T');
        final session = TerminalSession(
          machineId: 'm',
          agentId: 'a',
          agentName: 'a',
          engineId: 'codex',
          send: (_, _) async => true,
          sendBinary: (_) async => true,
        );
        expect(session.terminal.platform, TerminalTargetPlatform.macos);
        session.dispose();
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    },
  );

  test('the menu bus is built without dart:io', () {
    expect(SwarmMenuBus.new, returnsNormally);
  });

  testWidgets('the in-window menu bar draws nothing in a browser', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(home: InWindowMenuBar(onAction: (_) async {})),
    );
    expect(tester.takeException(), isNull);
    expect(find.byType(MenuBar), findsNothing);
  });
}

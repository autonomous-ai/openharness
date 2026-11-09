import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';

import 'keymap_host_test.dart' show key;
import 'support/swarm_chat_screen.dart';

/// The Swarm chat's keys once its quick switcher (Cmd-K, "Switch
/// conversation") is gone: nothing opens on Cmd-K, nothing lists it, and what
/// else the chat has is where it was.
void main() {
  final shortcutsSearch = find.byKey(const ValueKey('shortcuts-search'));
  final findField = find.byKey(const ValueKey('super-find-field'));

  // The Swarm chat's own letters are Cmd's on a Mac and Ctrl's elsewhere.
  for (final (platform, cmd) in [
    (TargetPlatform.macOS, true),
    (TargetPlatform.linux, false),
    (TargetPlatform.windows, false),
  ]) {
    testWidgets(
      '${cmd ? 'Cmd' : 'Ctrl'}+K opens nothing in a Swarm chat on ${platform.name}: '
      'it has no switcher',
      (tester) async {
        final (f, c) = await mountSwarmChat(tester);
        await key(tester, LogicalKeyboardKey.keyK, cmd: cmd, ctrl: !cmd);
        await tester.pumpAndSettle();
        expect(find.byType(Dialog), findsNothing);
        expect(find.text('Switch conversation'), findsNothing);
        await leaveSwarmChat(tester, f, c);
      },
      variant: TargetPlatformVariant.only(platform),
    );
  }

  testWidgets(
    'a person clicks through the keys the chat has left: the Shortcuts sheet '
    'lists no switcher, and Find in chat still opens',
    (tester) async {
      final (f, c) = await mountSwarmChat(tester);

      // Shortcuts (Cmd+/): the old name finds nothing; the chat's own key is
      // there, with the scope it works in.
      await key(tester, LogicalKeyboardKey.slash, cmd: true);
      await tester.pumpAndSettle();
      expect(shortcutsSearch, findsOneWidget);
      await tester.enterText(shortcutsSearch, 'switch');
      await tester.pumpAndSettle();
      expect(find.text('Switch conversation'), findsNothing);
      await tester.enterText(shortcutsSearch, 'find in chat');
      await tester.pumpAndSettle();
      expect(find.widgetWithText(TextButton, 'Find in chat'), findsOneWidget);
      expect(find.text('In a Swarm tab, outside a terminal'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(shortcutsSearch, findsNothing);

      // And the chat still has its keys: a click on it, then Cmd+F opens
      // find, and Escape closes it.
      await focusSwarmChat(tester);
      await key(tester, LogicalKeyboardKey.keyF, cmd: true);
      await tester.pumpAndSettle();
      expect(findField, findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(findField, findsNothing);
      await leaveSwarmChat(tester, f, c);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  test(
    'a keybindings file from before still loads: its binding for the switcher '
    'is skipped and the rest of the file stays',
    () {
      expect(harnessCommandById.containsKey('swarm.quick_switcher'), isFalse);
      final config = KeymapConfig.parse('''{"bindings":[
        {"keys":"cmd+g","command":"swarm.quick_switcher","when":"swarmChat"},
        {"keys":"cmd+ctrl+h","command":"pane.focus_left"}
      ]}''', commands: harnessCommandById.keys.toSet());
      expect(config.bindings.single.command, 'pane.focus_left');
    },
  );
}

@TestOn('browser')
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_menu_bus.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/widgets/linux_menu_bar.dart';

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

  test('the menu bus is built without dart:io', () {
    expect(SwarmMenuBus.new, returnsNormally);
  });

  testWidgets('the Linux menu bar draws nothing in a browser', (tester) async {
    await tester.pumpWidget(
      MaterialApp(home: LinuxMenuBar(onAction: (_) async {})),
    );
    expect(tester.takeException(), isNull);
    expect(find.byType(MenuBar), findsNothing);
  });
}

// A Super Tab mounted the way a phone's browser (below the web chrome's
// compactBelow) or Desktop (no chrome at all) mounts it.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_fixture.dart';

final _phoneChrome = WorkspaceChrome(
  leadingWidth: (_) => 0,
  leading: (_, _) => const SizedBox.shrink(),
  compactBelow: 720,
);

/// The lead conversation, with one message from its owner and [seed]'s, in a
/// [size] window. [desktop] mounts it without chrome, as Desktop does.
Future<(ConversationServer, SuperTabController)> mountPhoneSuperTab(
  WidgetTester tester,
  Size size, {
  VoidCallback? onOpenGroupTerminals,
  bool terminalsVisible = false,
  bool desktop = false,
  void Function(ConversationServer server)? seed,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final server = ConversationServer()..append('Ship the phone header.');
  final lead = (server.state['conversations'] as List).first as Map;
  lead['agentIds'] = ['builder'];
  seed?.call(server);
  final controller = server.controller();
  await controller.refresh();
  final view = Scaffold(
    body: SuperTabView(
      controller: controller,
      onInvite: () {},
      onAddAgent: (_) {},
      onOpenTerminal: (_) {},
      onOpenGroupTerminals: onOpenGroupTerminals,
      terminalsVisible: terminalsVisible,
      machineName: (_) => 'Test Mac',
    ),
  );
  await tester.pumpWidget(
    MaterialApp(
      home: desktop
          ? view
          : WorkspaceChromeScope(chrome: _phoneChrome, child: view),
    ),
  );
  await tester.pumpAndSettle();
  return (server, controller);
}

Future<void> unmountPhoneSuperTab(
  WidgetTester tester,
  SuperTabController controller,
) async {
  await tester.pumpWidget(const SizedBox());
  await controller.flush();
  controller.dispose();
}

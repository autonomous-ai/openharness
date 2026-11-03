// A Super Tab mounted the way a phone's browser (below the web chrome's
// compactBelow) or Desktop (no chrome at all) mounts it.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_fixture.dart';

final _phoneChrome = WorkspaceChrome(compactBelow: 720);

/// The lead conversation, with one message from its owner and [seed]'s, in a
/// [size] window. [desktop] mounts it without chrome, as Desktop does.
Future<(ConversationServer, SuperTabController)> mountPhoneSuperTab(
  WidgetTester tester,
  Size size, {
  VoidCallback? onOpenGroupTerminals,
  bool terminalsVisible = false,
  bool desktop = false,
  void Function(ConversationServer server)? seed,
  ConversationServer? server,
  String? initial,
  double textScale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final given = server;
  final server0 =
      given ?? (ConversationServer()..append('Ship the phone header.'));
  if (given == null) {
    final lead = (server0.state['conversations'] as List).first as Map;
    lead
      ..['agentIds'] = ['builder']
      ..['leadId'] = 'builder';
  }
  seed?.call(server0);
  final controller = server0.controller();
  await controller.refresh();
  if (initial != null) await controller.select(initial);
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
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: desktop
          ? view
          : WorkspaceChromeScope(chrome: _phoneChrome, child: view),
    ),
  );
  await tester.pumpAndSettle();
  return (server0, controller);
}

Future<void> unmountPhoneSuperTab(
  WidgetTester tester,
  SuperTabController controller,
) async {
  await tester.pumpWidget(const SizedBox());
  await controller.flush();
  controller.dispose();
}

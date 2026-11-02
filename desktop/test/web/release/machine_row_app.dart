// A release-build page holding the real Swarm view on made-up data, beside a real terminal. Driven in a real browser
// by scripts/web-machine-menu-check.mjs, which says how to build it. Never shipped: nothing else imports it.
import 'package:flutter/material.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';
import 'package:web/web.dart' as web;
import 'package:xterm/xterm.dart';

import '../../support/super_tab_fixture.dart';

class _Routes extends NavigatorObserver {
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      web.document.title = route is PopupRoute ? 'menu-open' : 'no-menu';
  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      web.document.title = 'no-menu';
}

/// Publishes where the keyed widgets are, for the script to point at them.
void _publish() {
  final rects = <String>[];
  void visit(Element element) {
    final key = element.widget.key;
    if (key is ValueKey<String> && key.value.startsWith('super-machine')) {
      final box = element.findRenderObject();
      if (box is RenderBox && box.hasSize) {
        final at = box.localToGlobal(Offset.zero);
        rects.add(
          '${key.value}=${at.dx},${at.dy},${box.size.width},${box.size.height}',
        );
      }
    }
    element.visitChildren(visit);
  }

  WidgetsBinding.instance.rootElement?.visitChildren(visit);
  web.document.body?.setAttribute('data-rects', rects.join(';'));
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final server = ConversationServer();
  server.state['machines'] = [
    {
      'machineId': 'studio',
      'name': 'Studio',
      'contributorId': 'owner',
      'scope': 'all',
      'engines': ['codex'],
      'maxAgents': 2,
      'availableSlots': 2,
    },
  ];
  final controller = server.controller();
  await controller.refresh();
  runApp(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      navigatorObservers: [_Routes()],
      home: Scaffold(
        body: Row(
          children: [
            SizedBox(
              width: 1000,
              child: SuperTabView(
                controller: controller,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Studio',
              ),
            ),
            Expanded(
              child: TerminalView(
                Terminal(),
                key: const ValueKey('super-machine-check-terminal'),
              ),
            ),
          ],
        ),
      ),
    ),
  );
  WidgetsBinding.instance.addPersistentFrameCallback((_) => _publish());
}

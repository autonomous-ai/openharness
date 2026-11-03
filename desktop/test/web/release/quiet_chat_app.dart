// A release-build page holding the real Swarm view on made-up data, for the
// Quiet Swarm chat's screenshots: `?screen=1`, `?screen=2`. It publishes where
// its rows are, for the driving script to click. Never shipped: nothing in lib/
// imports it. Build: flutter build web -t test/web/release/quiet_chat_app.dart
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';
import 'package:web/web.dart' as web;

import 'quiet_chat_data.dart';

/// Publishes where the keyed rows and menu words are, for the script.
void _publish() {
  final rects = <String>[];
  void visit(Element element) {
    final widget = element.widget;
    final key = widget.key;
    final name = key is ValueKey<String>
        ? key.value
        : widget is Text && widget.data != null
        ? 'text:${widget.data}'
        : null;
    if (name != null) {
      final box = element.findRenderObject();
      if (box is RenderBox && box.hasSize && box.attached) {
        final at = box.localToGlobal(Offset.zero);
        rects.add(
          '$name=${at.dx},${at.dy},${box.size.width},${box.size.height}',
        );
      }
    }
    element.visitChildren(visit);
  }

  WidgetsBinding.instance.rootElement?.visitChildren(visit);
  web.document.body?.setAttribute('data-rects', rects.join('\n'));
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final server = quietChatServer(Uri.base.queryParameters['screen'] ?? '1');
  final controller = server.controller();
  await controller.refresh();
  await controller.select('lead');
  runApp(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: SuperTabView(
          controller: controller,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Studio',
        ),
      ),
    ),
  );
  Timer.periodic(const Duration(milliseconds: 200), (_) => _publish());
}

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there (task #2826).
final shots = Platform.environment['SUPER_TAB_FIND_SHOTS'];
final _picture = GlobalKey();

const _notes = [
  'Gõ Tiếng Việt trong ô tìm kiếm vẫn ra đúng tin nhắn.',
  'Pushed the branch; the checks are running.',
  'Reading the older pages before the reconnect.',
  'The reconnect keeps every queued edit in order.',
];

Future<void> _shot(WidgetTester tester, String name) async {
  await tester.runAsync(() async {
    final boundary =
        _picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 1.5);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(shots!).create(recursive: true);
    await File('$shots/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

Future<SuperTabController> _show(
  WidgetTester tester,
  ConversationServer server,
  Brightness brightness,
) async {
  await tester.binding.setSurfaceSize(const Size(1400, 820));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
  addTearDown(c.dispose);
  final before = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = before);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => RepaintBoundary(key: _picture, child: child),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Team Mac',
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}

Future<void> _find(WidgetTester tester, String query, {int up = 0}) async {
  await tester.tap(find.byKey(const ValueKey('super-find-button')).first);
  await tester.pumpAndSettle();
  await tester.enterText(
    find.byKey(const ValueKey('super-find-field')).first,
    query,
  );
  await tester.pumpAndSettle();
  for (var i = 0; i < up; i++) {
    await tester.tap(find.byKey(const ValueKey('super-find-older')).first);
    await tester.pumpAndSettle();
  }
}

void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    final theme = brightness.name;

    testWidgets('the chat at 2 of 4 ($theme)', (tester) async {
      final server = ConversationServer();
      for (var i = 1; i <= 20; i++) {
        server.append(_notes[i % 4 == 1 && i > 2 ? 0 : i % 3 + 1]);
      }
      await _show(tester, server, brightness);
      await _find(tester, 'tieng viet', up: 1);
      await _shot(tester, 'find-chat-$theme');
    }, skip: shots == null);

    testWidgets('a thread at 1 of 2 ($theme)', (tester) async {
      final server = ConversationServer()..threads = true;
      server.append('Có lỗi khi đọc trang cũ không?');
      server.append('Lỗi nhỏ thôi, đã sửa.');
      server.messages.last
        ..['thread'] = 'message-1'
        ..['replyTo'] = 'message-1';
      server.append('Pushed the fix.');
      server.messages.last
        ..['thread'] = 'message-1'
        ..['replyTo'] = 'message-2';
      final c = await _show(tester, server, brightness);
      c.openThread('message-1');
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-thread-find-button')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('super-find-field')).last,
        'loi',
      );
      await tester.pumpAndSettle();
      await _shot(tester, 'find-thread-$theme');
    }, skip: shots == null);

    testWidgets('the 50-page stop ($theme)', (tester) async {
      final server = ConversationServer()..messagePage = 1;
      for (var i = 1; i <= 80; i++) {
        server.append(i == 80 ? _notes[0] : _notes[i % 3 + 1]);
      }
      await _show(tester, server, brightness);
      await _find(tester, 'tiếng việt', up: 1);
      await _shot(tester, 'find-50-pages-$theme');
    }, skip: shots == null);
  }
}

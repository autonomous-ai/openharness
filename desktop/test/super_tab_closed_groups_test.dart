import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

final _picture = GlobalKey();

Widget _app(
  ConversationServer server,
  controller, [
  Brightness brightness = Brightness.light,
]) => MaterialApp(
  theme: grid.buildAppTheme(brightness: brightness),
  home: Scaffold(
    body: RepaintBoundary(
      key: _picture,
      child: SuperTabView(
        controller: controller,
        onInvite: () {},
        onAddAgent: (_) {},
        onOpenTerminal: (_) {},
        machineName: (_) => 'Test Mac',
      ),
    ),
  ),
);

/// Writes the view to `$SUPER_TAB_CLOSED_SHOTS/<name>.png` when that is set.
Future<void> _shot(WidgetTester tester, String name) async {
  final directory = Platform.environment['SUPER_TAB_CLOSED_SHOTS'];
  if (directory == null) return;
  await tester.runAsync(() async {
    final boundary =
        _picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage();
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(directory).create(recursive: true);
    await File('$directory/$name.png')
        .writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(() async {
    if (Platform.environment['SUPER_TAB_CLOSED_SHOTS'] != null) {
      await loadPreviewFonts();
    }
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'a closed group opens read-only and reopens (${brightness.name})',
      (tester) async {
        await tester.binding.setSurfaceSize(const Size(1280, 800));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final server = ConversationServer();
        final oldBrightness = grid.AppTheme.brightness.value;
        final oldPalette = grid.AppTheme.palette.value;
        grid.AppTheme.brightness.value = brightness;
        grid.AppTheme.palette.value = grid.AppTheme.paletteFor(brightness);
        addTearDown(() {
          grid.AppTheme.brightness.value = oldBrightness;
          grid.AppTheme.palette.value = oldPalette;
        });
        final groups = server.state['conversations'] as List;
        groups[1]['archived'] = true;
        server.append(
          'Verified the offline result.',
          conversationId: 'offline',
        );
        final controller = server.controller();
        await controller.refresh();
        await tester.pumpWidget(_app(server, controller, brightness));
        await tester.pumpAndSettle();
        // The sidebar lists no tasks, open or closed (task #2569): the
        // closed one is read and opened as the Tasks view opens it.
        expect(find.textContaining('Closed ('), findsNothing);
        await controller.loadDormant('lead');
        await controller.select('offline');
        await tester.pumpAndSettle();
        expect(controller.selectedId, 'offline');
        expect(find.text('Verified the offline result.'), findsOneWidget);
        // A closed group has no message box, only the notice and Reopen.
        expect(
          find.byKey(const ValueKey('super-message-composer')),
          findsNothing,
        );
        expect(find.textContaining('This group is closed'), findsOneWidget);

        await _shot(tester, 'closed-read-only-${brightness.name}');
        await tester.tap(find.byKey(const ValueKey('super-group-reopen')));
        await tester.pumpAndSettle();
        expect(server.posts.last['command'], {
          'type': 'conversation.archive',
          'conversationId': 'offline',
          'archived': false,
        });
        expect(find.byKey(const ValueKey('super-group-reopen')), findsNothing);
        expect(
          tester
              .widget<TextField>(
                find.byKey(const ValueKey('super-message-composer')),
              )
              .enabled,
          isTrue,
        );

        await tester.pumpWidget(const SizedBox());
        await controller.flush();
        controller.dispose();
      },
    );
  }
}

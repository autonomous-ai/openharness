import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/project_sidebar.dart';
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
  final closedRow = find.byKey(const ValueKey('super-closed-lead'));

  testWidgets('a project with no archived groups has no Closed row', (
    tester,
  ) async {
    final server = ConversationServer();
    final controller = server.controller();
    await controller.refresh();
    await tester.pumpWidget(_app(server, controller));
    await tester.pumpAndSettle();
    expect(closedRow, findsNothing);
    expect(find.textContaining('Closed ('), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'Closed (N) starts collapsed, lists archived groups, opens one read-only and reopens it (${brightness.name})',
      (tester) async {
        await tester.binding.setSurfaceSize(const Size(1280, 800));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final server = ConversationServer();
        await tester.binding.setSurfaceSize(const Size(1280, 800));
        addTearDown(() => tester.binding.setSurfaceSize(null));
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
        groups.add({
          ...conversationFixture('second', 'Second closed'),
          'projectId': 'lead',
          'archived': true,
        });
        server.append(
          'Verified the offline result.',
          conversationId: 'offline',
        );
        final controller = server.controller();
        await controller.refresh();
        await tester.pumpWidget(_app(server, controller, brightness));
        await tester.pumpAndSettle();
        final sidebar = find.byType(ProjectSidebar);
        Finder inside(Finder f) => find.descendant(of: sidebar, matching: f);
        if (closedRow.evaluate().isEmpty) {
          await tester.tap(
            find.byKey(const ValueKey('super-project-expand-lead')),
          );
          await tester.pumpAndSettle();
        }

        expect(inside(find.text('Closed (2)')), findsOneWidget);
        expect(find.byKey(const ValueKey('super-group-offline')), findsNothing);
        expect(find.byKey(const ValueKey('super-group-second')), findsNothing);

        await tester.tap(closedRow);
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('super-group-offline')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('super-group-second')),
          findsOneWidget,
        );
        await _shot(tester, 'closed-open-${brightness.name}');

        await tester.tap(find.byKey(const ValueKey('super-group-offline')));
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
        expect(inside(find.text('Closed (1)')), findsOneWidget);
        expect(find.byKey(const ValueKey('super-group-reopen')), findsNothing);
        expect(
          find.byKey(const ValueKey('super-group-offline')),
          findsOneWidget,
        );
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

  testWidgets(
    'closed groups read a page at a time; Show earlier reads the next',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer()..parts.dormantPage = 1;
      final groups = server.state['conversations'] as List;
      groups[1]['archived'] = true;
      groups.add({
        ...conversationFixture('second', 'Second closed'),
        'projectId': 'lead',
        'archived': true,
      });
      final controller = server.controller();
      await controller.refresh();
      await tester.pumpWidget(_app(server, controller));
      await tester.pumpAndSettle();
      if (closedRow.evaluate().isEmpty) {
        await tester.tap(
          find.byKey(const ValueKey('super-project-expand-lead')),
        );
        await tester.pumpAndSettle();
      }
      expect(find.text('Closed (1)'), findsOneWidget);
      await tester.tap(closedRow);
      await tester.pumpAndSettle();
      final earlier = find.byKey(const ValueKey('super-closed-earlier-lead'));
      expect(earlier, findsOneWidget);
      await tester.tap(earlier);
      await tester.pumpAndSettle();
      expect(find.text('Closed (2)'), findsOneWidget);
      expect(earlier, findsNothing);
      expect(find.byKey(const ValueKey('super-group-offline')), findsOneWidget);
      expect(find.byKey(const ValueKey('super-group-second')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );
}

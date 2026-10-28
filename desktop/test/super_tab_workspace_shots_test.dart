import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/workspace.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_WORKSPACE_SHOTS'];

DateTime _day(int month, int day) => DateTime(2026, month, day);

/// The Workspace menu and its dialogs as the PR shows them, in both themes:
/// the sidebar's row, the menu open, Workspace settings and New Workspace.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final f = SuperTabLaunchFixture()
        ..connection.workspaces = [
          {
            'id': 'w1',
            'name': 'Autonomous',
            'role': 'owner',
            'revision': 3,
            'swarms': [
              {
                'id': tabId,
                'name': 'openharness',
                'workspaceVisibility': 'invite-only',
                'member': true,
              },
              {
                'id': 'lamp',
                'name': 'lamp-os',
                'workspaceVisibility': 'workspace',
                'member': false,
              },
              {
                'id': 'fw',
                'name': 'firmware',
                'workspaceVisibility': 'invite-only',
                'member': false,
              },
            ],
          },
          {
            'id': 'w2',
            'name': 'Customer X',
            'role': 'guest',
            'revision': 1,
            'swarms': [
              {
                'id': 'support',
                'name': 'support',
                'workspaceVisibility': 'invite-only',
                'member': true,
              },
            ],
          },
        ]
        ..connection.workspacePeople = {
          'members': [
            {'userId': 'owner', 'email': 'ken@autonomous.ai', 'role': 'owner'},
            {
              'userId': 'diego',
              'email': 'diego@autonomous.ai',
              'role': 'admin',
            },
            {'userId': 'tony', 'email': 'tony@autonomous.ai', 'role': 'member'},
            {'userId': 'huy', 'email': 'huy@autonomous.ai', 'role': 'guest'},
          ],
          'invitations': [
            {
              'email': 'new@acme.com',
              'role': 'member',
              'expiresAt': _day(11, 11).millisecondsSinceEpoch,
            },
          ],
        };
      f.connection.server.state['name'] = 'openharness';
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'openharness');
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) =>
              RepaintBoundary(key: picture, child: child),
          home: Scaffold(
            body: ListenableBuilder(
              listenable: f.app,
              builder: (_, _) => SuperTabWorkspace(
                app: f.app,
                canvas: const SizedBox.expand(),
                onAddAgent: (_) {},
                onNewSwarm: () {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      Future<void> shot(String name) async {
        if (shots == null) return;
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1.5);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/workspace-$name-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }

      await shot('sidebar');
      await tester.tap(find.byKey(const ValueKey('super-workspace-menu')));
      await tester.pumpAndSettle();
      await shot('menu');
      await tester.tap(find.text('Workspace settings…'));
      await tester.pumpAndSettle();
      await shot('settings');
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-workspace-menu')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('New Workspace…'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).last, 'Acme');
      await tester.pump();
      await shot('new-workspace');
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    });
  }
}

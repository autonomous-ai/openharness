import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

void main() {
  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'sidebar shares text alignment and preserves lead navigation at ${scale}x',
      (tester) async {
        await tester.binding.setSurfaceSize(const Size(1600, 700));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final app = createApp(connected: true);
        addTearDown(app.dispose);
        final server = ConversationServer();
        server.state['projects'] = [
          projectFixture('lead', 'web-project', 'lead'),
          projectFixture(
            'empty',
            'sample-project',
            'empty-lead',
            visibility: 'private',
          ),
        ];
        (server.state['conversations'] as List)[1]
          ..['projectId'] = 'lead'
          ..['number'] = 12;
        (server.state['conversations'] as List).add({
          ...conversationFixture('empty-lead', 'Lead'),
          'projectId': 'empty',
        });
        final c = server.controller();
        await c.refresh();
        var created = 0;
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: Scaffold(
              body: SuperTabView(
                controller: c,
                app: app,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                onNewProject: () => created++,
                machineName: (_) => 'Test Mac',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final sidebar = find.byType(ProjectSidebar);
        Finder inside(Finder finder) =>
            find.descendant(of: sidebar, matching: finder);
        final expand = find.byKey(const ValueKey('super-project-expand-lead'));
        final empty = find.byKey(const ValueKey('super-project-expand-empty'));
        expect(expand, findsOneWidget);
        expect(empty, findsOneWidget);
        expect(inside(find.byType(OutlinedButton)), findsNothing);
        expect(
          tester
              .widget<TextButton>(
                find.byKey(const ValueKey('super-new-project')),
              )
              .style!
              .side!
              .resolve({}),
          BorderSide.none,
        );

        // Project names always select the lead; disclosure never switches chats.
        await tester.tap(inside(find.text('sample-project')));
        await tester.pumpAndSettle();
        expect(c.selectedId, 'empty-lead');
        await tester.tap(expand);
        await tester.pumpAndSettle();
        expect(c.selectedId, 'empty-lead');
        final work = find.byKey(const ValueKey('super-group-offline'));
        expect(work, findsOneWidget);
        final projectX = tester.getTopLeft(inside(find.text('web-project'))).dx;
        for (final label in [
          'sample-project',
          '#12 Offline editing',
          'New project',
          'Your devices',
        ]) {
          expect(tester.getTopLeft(inside(find.text(label))).dx, projectX);
        }
        final projectRect = tester.getRect(
          find.byKey(const ValueKey('super-group-lead')),
        );
        final workRect = tester.getRect(work);
        expect(workRect.left, projectRect.left);
        expect(workRect.right, projectRect.right);

        await tester.tap(work);
        await tester.pumpAndSettle();
        expect(c.selectedId, 'offline');
        await tester.tap(empty);
        await tester.pumpAndSettle();
        expect(c.selectedId, 'empty-lead');
        expect(c.expandedProjects, isNot(contains('empty')));
        expect(
          find.byTooltip('Chat with sample-project product manager'),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: empty,
            matching: find.byIcon(AppIcons.chevronRight),
          ),
          findsOneWidget,
        );

        // Both navigation actions retain keyboard activation.
        final newProject = find.byKey(const ValueKey('super-new-project'));
        Focus.of(
          tester.element(
            find.descendant(of: newProject, matching: find.text('New project')),
          ),
        ).requestFocus();
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(created, 1);
        await tester.tap(find.byKey(const ValueKey('super-your-devices')));
        await tester.pumpAndSettle();
        expect(app.machinesRequest, (devicePub: null, phones: false));
        expect(c.selectedId, 'empty-lead');
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );
  }
}

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_icon_button.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/terminal_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// The Swarm-wide conversation where the projects' Product Managers talk
/// (spec 2026-10-23-leads-see-and-talk.md): not part of any project, found by
/// the tab's `leadsConversationId`, shown above Projects for every person.
void main() {
  final captureDir = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
  setUpAll(() => loadCaptureFonts(captureDir));

  ConversationServer swarm({bool leads = true}) {
    final server = ConversationServer();
    server.state['projects'] = [
      projectFixture('lead', 'openharness', 'lead'),
      projectFixture('os', 'autonomous-os', 'os-lead'),
    ];
    server.state['agents'] = [
      for (final (id, name, project) in [
        ('pm-1', 'Wren', 'lead'),
        ('pm-2', 'Nova', 'os'),
      ])
        {
          'id': id,
          'projectId': project,
          'name': 'Lead',
          'displayName': name,
          'machineId': 'm',
          'harnessId': id,
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
    ];
    final conversations = server.state['conversations'] as List;
    conversations[0]['leadId'] = 'pm-1';
    conversations.add({
      ...conversationFixture('os-lead', 'Lead'),
      'projectId': 'os',
      'leadId': 'pm-2',
    });
    if (leads) {
      // As the backend sends it: no project, kind `leads`.
      conversations.add({
        ...conversationFixture('leads', 'Leads'),
        'kind': 'leads',
        'agentIds': ['pm-1', 'pm-2'],
      });
      server.state['leadsConversationId'] = 'leads';
    }
    return server;
  }

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    Brightness brightness = Brightness.dark,
    String account = 'owner',
  }) async {
    await tester.binding.setSurfaceSize(const Size(1100, 640));
    final previous = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = previous);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = server.controller(
      account: account,
      initial: {'tabId': 'tab', 'accountId': account, 'selectedId': 'lead'},
    );
    await controller.refresh();
    await tester.pumpWidget(
      // The whole app, so the picture has the Scaffold's background too.
      RepaintBoundary(
        key: const ValueKey('leads-capture'),
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabView(
              controller: controller,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Team Mac',
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return controller;
  }

  Future<void> close(WidgetTester tester, SuperTabController controller) async {
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  }

  final leadsRow = find.byKey(const ValueKey('super-group-leads'));
  final projects = find.text('Projects');

  testWidgets(
    'lists the Product Managers conversation as # product-managers among Projects, and opens and posts in it',
    (tester) async {
      final server = swarm();
      server.append(
        'I will take the roster file after #12 lands.',
        conversationId: 'leads',
      );
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'pm-1',
        'name': 'Lead',
        'displayName': 'Wren',
      };
      server.append(
        'Overlap: #12 Roster polish (openharness, Wren) and #3 Agents filter (autonomous-os, Nova) both own desktop/lib/super_tabs/roster.dart.',
        conversationId: 'leads',
      );
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'pm-1',
        'name': 'Lead',
      };
      server.messages.last['source'] = {'kind': 'overlap'};
      final controller = await show(tester, server);
      // An open project's heading and composer read as its row too.
      expect(find.text('# openharness'), findsOneWidget);
      expect(find.text('Message #openharness'), findsOneWidget);

      expect(leadsRow, findsOneWidget);
      expect(
        find.descendant(of: leadsRow, matching: find.text('product-managers')),
        findsOneWidget,
      );
      expect(
        tester.getTopLeft(projects).dy,
        lessThan(tester.getTopLeft(leadsRow).dy),
      );
      // It belongs to no project: never listed again as a workgroup of the first one.
      await tester.tap(find.byKey(const ValueKey('super-project-expand-lead')));
      await tester.pumpAndSettle();
      expect(find.text('Leads'), findsNothing);
      expect(leadsRow, findsOneWidget);

      await tester.tap(leadsRow);
      await tester.pumpAndSettle();
      // Its heading reads as its row, and it has no rename or archive.
      expect(find.text('# product-managers'), findsOneWidget);
      expect(find.byKey(const ValueKey('super-group-options')), findsNothing);
      expect(
        find.text('I will take the roster file after #12 lands.'),
        findsOneWidget,
      );

      // The overlap alert is a system note, not chat from a Product Manager.
      final note = find.byType(SuperTabTerminalRow);
      expect(note, findsOneWidget);
      expect(
        find.descendant(
          of: note,
          matching: find.textContaining(
            'both own desktop/lib/super_tabs/roster.dart',
            findRichText: true,
          ),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: note,
          matching: find.byIcon(AppIcons.triangleAlert),
        ),
        findsOneWidget,
      );

      await captureBoundary(
        tester,
        tester.renderObject<RenderRepaintBoundary>(
          find.byKey(const ValueKey('leads-capture')),
        ),
        captureDir,
        'leads-conversation',
      );
      // The roster is the whole Swarm's: both Product Managers, whatever their project.
      for (final id in ['pm-1', 'pm-2']) {
        expect(find.byKey(ValueKey('super-member-$id')), findsOneWidget);
      }
      // Agents join it by leading a project, never by being added.
      expect(find.byTooltip('Add agent'), findsNothing);
      final composer = find.byKey(const ValueKey('super-message-composer'));
      expect(
        find.descendant(
          of: composer,
          matching: find.text('Message #product-managers'),
        ),
        findsOneWidget,
      );
      await tester.enterText(composer, 'Nova, please go first.');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect((server.posts.last['command'] as Map)['conversationId'], 'leads');
      // Posted for every person to read, even before any Product Manager
      // receives it: never "this chat has no Lead".
      expect(find.textContaining('has no Lead'), findsNothing);
      expect(find.text('Add a Lead'), findsNothing);
      expect(
        (server.posts.last['command'] as Map)['text'],
        'Nova, please go first.',
      );

      await close(tester, controller);
    },
  );

  testWidgets(
    'a viewer reads it, without the terminals they may not open, and its pull requests have no project scope',
    (tester) async {
      final server = swarm();
      (server.state['people'] as List).add({
        'id': 'viewer',
        'email': 'viewer@example.com',
        'role': 'viewer',
      });
      final controller = await show(tester, server, account: 'viewer');
      // "This project" chosen in a workgroup does not follow into it.
      await tester.tap(find.byKey(const ValueKey('super-project-expand-lead')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-group-offline')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-pull-requests')));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(DropdownButton<bool>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('This project').last);
      await tester.pumpAndSettle();
      await tester.tap(leadsRow);
      await tester.pumpAndSettle();
      final terminals = find.byKey(const ValueKey('super-terminals'));
      expect(terminals, findsOneWidget);
      // A read-only viewer's terminal reads are refused, so the button is off.
      expect(tester.widget<AppIconButton>(terminals).onPressed, isNull);
      // It belongs to no project: no "This project" scope beside "This group".
      await tester.tap(find.byKey(const ValueKey('super-pull-requests')));
      await tester.pumpAndSettle();
      expect(find.text('This project'), findsNothing);
      expect(find.byType(DropdownButton<bool>), findsNothing);
      expect(find.textContaining('any chat of this project'), findsNothing);
      await close(tester, controller);
    },
  );

  testWidgets(
    'is not shown in a Swarm that has no Product Managers conversation',
    (tester) async {
      final controller = await show(tester, swarm(leads: false));
      expect(leadsRow, findsNothing);
      expect(find.text('product-managers'), findsNothing);
      expect(projects, findsOneWidget);
      await close(tester, controller);
    },
  );
}

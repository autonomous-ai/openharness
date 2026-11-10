import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/join_dialog.dart';
import 'package:harness/super_tabs/join_link.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/project_options.dart';
import 'package:harness/super_tabs/switch_pm.dart';
import 'package:harness/super_tabs/work_details.dart';

import 'support/super_tab_fixture.dart';

/// The join dialog's account and errors, and the words of every dialog's pending-action button (Desktop 1.3.89 audit).
void main() {
  const link = SwarmJoinLink('tab', token: 'invite-token');

  Future<void> join(WidgetTester t, SuperTabRequest request) async {
    await t.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(),
        home: Scaffold(
          body: SwarmJoinDialog(
            link: link,
            accountEmail: 'leo@example.com',
            isCurrent: () => true,
            onJoined: (_, _) {},
            request: request,
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
  }

  testWidgets('the join dialog names the account it joins with', (t) async {
    await join(
      t,
      (_, _, {body}) async => {'id': 'tab', 'name': 'Pilot', 'role': 'viewer'},
    );
    expect(find.text('Signed in as leo@example.com'), findsOneWidget);
    expect(find.text('leo@example.com'), findsNothing);
  });

  testWidgets('the join dialog draws its error in the error colour', (t) async {
    await join(
      t,
      (_, _, {body}) async =>
          throw const SuperTabFailure('FORBIDDEN', 'private', statusCode: 403),
    );
    final error = find.text(
      'This link is unavailable for your account. Ask the owner for an invitation.',
    );
    expect(error, findsOneWidget);
    expect(t.widget<Text>(error).style?.color, grid.AppPalette.dangerFill);
  });

  /// Opens a dialog, then leaves a command whose answer was lost: the dialog offers to check it.
  Future<void> pendingIn(
    WidgetTester t,
    Future<void> Function(BuildContext, SuperTabController) show,
  ) async {
    final server = ConversationServer();
    (server.state['people'] as List).add({
      'id': 'dee',
      'email': 'dee@example.com',
      'role': 'collaborator',
    });
    server.state['projects'] = [
      {
        ...projectFixture('lead', 'test private', 'lead'),
        'visibility': 'private',
        'members': [
          {'id': 'dee'},
        ],
      },
    ];
    final c = server.controller(account: 'owner');
    addTearDown(c.dispose);
    await c.refresh();
    await t.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => show(context, c),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await t.tap(find.text('open'));
    await t.pumpAndSettle();
    server.loseReply = true;
    await c.command({
      'type': 'project.rename',
      'projectId': 'lead',
      'name': 'x',
    });
    await t.pumpAndSettle();
    expect(c.hasPendingAction, isTrue);
    expect(find.widgetWithText(TextButton, 'Check again'), findsOneWidget);
    expect(find.text('Check pending action'), findsNothing);
    server.loseReply = false;
    await t.tap(find.widgetWithText(TextButton, 'Check again'));
    await t.pumpAndSettle();
    expect(c.hasPendingAction, isFalse);
  }

  SuperTabProject project(SuperTabController c) =>
      c.snapshot!.projectById('lead')!;

  testWidgets('Sharing offers Check again', (t) async {
    await pendingIn(
      t,
      (context, c) => showProjectAction(context, c, project(c), 'sharing'),
    );
  });

  testWidgets('Work details offers Check again', (t) async {
    await pendingIn(t, (context, c) => showSuperTabWork(context, c, 'offline'));
  });

  testWidgets('Switch Product Manager offers Check again', (t) async {
    await pendingIn(t, (context, c) => showSwitchPm(context, c, 'lead'));
  });
}

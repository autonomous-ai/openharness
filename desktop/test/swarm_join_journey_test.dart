import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/join_dialog.dart';
import 'package:harness/super_tabs/join_link.dart';
import 'package:harness/super_tabs/sharing.dart';

import 'support/swarm_sharing_server.dart';

/// The Swarm's sharing, and a join by its link (backend join.ts): the link's token lets the account asking in, as the
/// role the link gives; the owner's address is at example.com, as the backend tells Sharing (`ownDomain`).
class _JoinServer extends SwarmSharingServer {
  @override
  Map<String, dynamic> get settings => {
    ...super.settings,
    'ownDomain': 'example.com',
    'ownDomainPublic': false,
  };

  @override
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (path.endsWith('/join/preview') || path.endsWith('/join')) {
      if (access['mode'] != 'link' || body?['token'] != token) {
        throw const SuperTabFailure('FORBIDDEN', 'No', statusCode: 403);
      }
      final who = reader!;
      if (path.endsWith('/join')) {
        final people = state['people'] as List;
        if (!people.any((p) => (p as Map)['id'] == who)) {
          people.add({
            'id': who,
            'email': '$who@example.com',
            'role': access['role'],
          });
        }
        return {'id': 'tab', 'role': access['role']};
      }
      return {
        'id': 'tab',
        'name': state['name'],
        'role': access['role'],
        'alreadyMember': false,
      };
    }
    return super.request(method, path, body: body);
  }
}

/// Readiness row 31, clicked through on both computers: the owner turns on the join link in Sharing and copies it; the
/// person it is sent to opens it under their own account, sees the Swarm by name, and joins; the owner's Sharing then
/// lists them with the link's role.
void main() {
  Finder key(String k) => find.byKey(Key(k));

  testWidgets('the owner copies the join link; the person who opens it joins '
      'under their own account, and Sharing lists them', (tester) async {
    await tester.binding.setSurfaceSize(const Size(900, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String;
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    final server = _JoinServer();
    final owner = server.controller();
    addTearDown(owner.dispose);
    await owner.refresh();
    // The other computer, signed in as leo: what it asks goes as leo.
    final leo = server.controller(account: 'leo');
    addTearDown(leo.dispose);
    String? joined;
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: Builder(
            builder: (context) => Column(
              children: [
                TextButton(
                  onPressed: () => showSuperTabSharing(
                    context,
                    owner,
                    title: 'Manage people',
                  ),
                  child: const Text('Share'),
                ),
                // The link as the app reads it from a click (SwarmJoinLink.parse), in the join dialog.
                TextButton(
                  onPressed: () => showDialog<void>(
                    context: context,
                    builder: (_) => SwarmJoinDialog(
                      link: SwarmJoinLink.parse(copied!)!,
                      accountEmail: 'leo@example.com',
                      isCurrent: () => true,
                      request: leo.request,
                      onJoined: (id, name) => joined = '$id $name',
                    ),
                  ),
                  child: const Text('Open link'),
                ),
              ],
            ),
          ),
        ),
      ),
    );

    // The owner: Share, Anyone with the link, Save, Copy link; their people are only themselves.
    await tester.tap(find.text('Share'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-general-access'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Anyone with the link').last);
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-sharing-save'));
    await tester.pumpAndSettle();
    expect(server.access['mode'], 'link');
    await tester.tap(key('swarm-copy-link'));
    await tester.pumpAndSettle();
    expect(copied, SwarmJoinLink('tab', token: server.token).url);
    await tester.tap(find.text('People with access'));
    await tester.pumpAndSettle();
    expect(find.text('owner@example.com'), findsOneWidget);
    expect(find.text('leo@example.com'), findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byType(SwarmSharingDialog), findsNothing);

    // The person it was sent to opens it: the Swarm by name, then Join.
    await tester.tap(find.text('Open link'));
    await tester.pumpAndSettle();
    expect(
      find.descendant(
        of: find.byType(SwarmJoinDialog),
        matching: find.textContaining('Pilot'),
      ),
      findsWidgets,
    );
    await tester.tap(key('swarm-join-confirm'));
    await tester.pumpAndSettle();
    expect(joined, 'tab Pilot');
    expect(find.byType(SwarmJoinDialog), findsNothing);

    // The owner's Swarm reads the change (in the app, its change feed does), and Sharing lists leo with the link's role.
    await owner.refresh();
    await tester.tap(find.text('Share'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('People with access'));
    await tester.pumpAndSettle();
    final leoRow = find.ancestor(
      of: find.text('leo@example.com'),
      matching: find.byType(Column),
    );
    expect(
      find.descendant(of: leoRow.first, matching: find.text('Can collaborate')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
}

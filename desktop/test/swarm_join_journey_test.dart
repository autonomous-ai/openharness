import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/join_dialog.dart';
import 'package:harness/super_tabs/join_link.dart';
import 'package:harness/super_tabs/sharing.dart';

import 'support/super_tab_fixture.dart';

const _token = 'abcdefghijabcdefghijabcdefghijabcdefghijabc';

/// One Swarm's server as the backend answers sharing and joining (backend sharing.ts, join.ts): its access, the link it
/// hands out, and a join by that link adding the person who opened it.
class _JoinServer extends ConversationServer {
  Map<String, dynamic> access = {'mode': 'invited', 'role': 'collaborator'};
  int sharingRevision = 0;

  /// Who opens the link: the person on the other computer.
  final joiner = {'id': 'leo', 'email': 'leo@example.com'};

  Map<String, dynamic> get settings => {
    'revision': sharingRevision,
    'access': Map<String, dynamic>.from(access),
    'joinUrl': access['mode'] == 'link'
        ? const SwarmJoinLink('tab', token: _token).url
        : null,
  };

  bool _valid(Map<String, dynamic>? body) =>
      access['mode'] == 'link' && body?['token'] == _token;

  @override
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (path.endsWith('/sharing')) {
      if (method == 'GET') return settings;
      access = Map<String, dynamic>.from(body!['access'] as Map);
      sharingRevision++;
      return settings;
    }
    if (path.endsWith('/join/preview') || path.endsWith('/join')) {
      if (!_valid(body)) {
        throw const SuperTabFailure('FORBIDDEN', 'No', statusCode: 403);
      }
      if (path.endsWith('/join')) {
        final people = state['people'] as List;
        if (!people.any((p) => (p as Map)['id'] == joiner['id'])) {
          people.add({...joiner, 'role': access['role']});
          // The Swarm changed: its next read carries it, as the backend's revision does.
          revision++;
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
/// person it is sent to opens it, sees the Swarm's name, and joins; the owner's Sharing then lists them.
void main() {
  testWidgets('the owner copies the join link; the person who opens it joins, '
      'and Sharing lists them', (tester) async {
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
    String? joined;
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: Builder(
            builder: (context) => Column(
              children: [
                TextButton(
                  onPressed: () => showSuperTabSharing(context, owner),
                  child: const Text('Share'),
                ),
                // The other computer: the link, as the app's link handler hands it on (SwarmJoinHost).
                TextButton(
                  onPressed: () => showDialog<void>(
                    context: context,
                    builder: (_) => SwarmJoinDialog(
                      link: SwarmJoinLink.parse(copied!)!,
                      accountEmail: 'leo@example.com',
                      isCurrent: () => true,
                      request: server.request,
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

    // The owner: Share, Anyone with the link, Save, Copy link.
    await tester.tap(find.text('Share'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('swarm-general-access')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Anyone with the link').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('swarm-sharing-save')));
    await tester.pumpAndSettle();
    expect(server.access['mode'], 'link');
    await tester.tap(find.byKey(const Key('swarm-copy-link')));
    await tester.pumpAndSettle();
    expect(copied, const SwarmJoinLink('tab', token: _token).url);
    await tester.tap(find.text('People with access'));
    await tester.pumpAndSettle();
    expect(find.text('owner@example.com'), findsOneWidget);
    expect(find.text('leo@example.com'), findsNothing);
    await tester.tapAt(Offset.zero);
    await tester.pumpAndSettle();

    // The person it was sent to opens it: the Swarm by name, then Join.
    await tester.tap(find.text('Open link'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Pilot'), findsWidgets);
    await tester.tap(find.byKey(const Key('swarm-join-confirm')));
    await tester.pumpAndSettle();
    expect(joined, 'tab Pilot');
    expect(find.byType(SwarmJoinDialog), findsNothing);

    // The owner's Sharing lists them.
    await owner.refresh();
    await tester.tap(find.text('Share'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('People with access'));
    await tester.pumpAndSettle();
    expect(find.text('leo@example.com'), findsOneWidget);
    expect(find.text('Can collaborate'), findsWidgets);
    expect(tester.takeException(), isNull);
  });
}

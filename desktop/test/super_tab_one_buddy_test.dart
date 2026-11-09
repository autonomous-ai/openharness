import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/attachment_upload.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/buddy_fixture.dart';
import 'support/super_tab_fixture.dart';

/// One Buddy per person per Swarm (Dee, 10-31; spec
/// 2026-10-31-one-buddy-per-swarm): `Buddy` is the row over
/// Projects, with no Buddies section; New session picks a project; older
/// project Buddy chats read only.
void main() {
  List<Map<String, dynamic>> commands(ConversationServer server, String type) =>
      [
        for (final post in server.posts)
          if ((post['command'] as Map)['type'] == type)
            Map<String, dynamic>.from(post['command'] as Map),
      ];

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    Brightness brightness = Brightness.light,
    SuperTabUpload? upload,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = server.controller(account: 'peer', upload: upload);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Kens-MacBook',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return c;
  }

  Future<void> close(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  }

  /// A line in the reader's older Buddy chat in the lead project, so it has
  /// history to keep.
  void oldLine(ConversationServer server) {
    server.append('An older word', conversationId: 'buddy-peer-lead');
    final chat = (server.state['conversations'] as List).cast<Map>().firstWhere(
      (g) => g['id'] == 'buddy-peer-lead',
    );
    chat['lastMessageSequence'] = 1;
  }

  group('the controller', () {
    test('keys the one Buddy and its chat by the empty id, and adds and removes it naming no project', () async {
      final server = oneBuddySwarm();
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      expect(c.oneBuddy, isTrue);
      expect(c.buddyChat(SuperTabController.kSwarmBuddyKey), isNull);

      expect(await c.openBuddyChat(SuperTabController.kSwarmBuddyKey), isTrue);
      expect(commands(server, 'buddy.chat'), [
        {'type': 'buddy.chat'},
      ]);
      expect(c.selectedId, 'swarm-buddy-peer');
      expect(
        c.buddyChat(SuperTabController.kSwarmBuddyKey)?.isSwarmBuddyChat,
        isTrue,
      );

      expect(
        await c.addBuddy(
          projectId: SuperTabController.kSwarmBuddyKey,
          machineId: 'ken-mac',
          engine: 'claude',
        ),
        isTrue,
      );
      expect(commands(server, 'buddy.create'), [
        {'type': 'buddy.create', 'machineId': 'ken-mac', 'engine': 'claude'},
      ]);
      expect(c.buddy(SuperTabController.kSwarmBuddyKey), isNotNull);
      // No project's Buddy: the one Buddy belongs to none.
      expect(c.buddy('lead'), isNull);

      expect(await c.removeBuddy(SuperTabController.kSwarmBuddyKey), isTrue);
      expect(commands(server, 'buddy.remove'), [
        {'type': 'buddy.remove'},
      ]);
      expect(c.buddy(SuperTabController.kSwarmBuddyKey), isNull);
    });

    test(
      'never lists the one Buddy chat among a project\'s conversations',
      () async {
        final server = oneBuddySwarm();
        giveSwarmBuddy(server);
        final c = server.controller(account: 'peer');
        addTearDown(c.dispose);
        await c.refresh();
        final chat = c.buddyChat(SuperTabController.kSwarmBuddyKey)!;
        expect(chat.projectId, '');
        expect(c.snapshot!.projects.map((p) => p.id), isNot(contains('')));
      },
    );
  });

  group('security review 1 of #2437', () {
    testWidgets(
      'takes no reply in a thread of an earlier chat, and says it is kept to read',
      (tester) async {
        final server = oneBuddySwarm();
        giveSwarmBuddy(server);
        giveBuddy(server, id: 'old', name: 'Old');
        oldLine(server);
        final c = await show(tester, server);
        await c.select('buddy-peer-lead');
        await tester.pumpAndSettle();
        final root = c.messages('buddy-peer-lead').last;
        c.openThread(root.id);
        await tester.pumpAndSettle();
        final field = tester.widget<TextField>(
          find.byKey(const ValueKey('super-thread-composer')),
        );
        expect(field.enabled, isFalse);
        expect(
          field.decoration?.hintText,
          'This is an earlier chat, kept to read.',
        );
        await close(tester, c);
      },
    );
  });
}

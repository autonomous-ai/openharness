import 'dart:typed_data';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/agent_details.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/profile_sheet.dart';

import 'super_tab_profile_actions_test.dart' show picture;
import 'super_tab_roster_test.dart' show RosterFixture;
import 'support/super_tab_fixture.dart';

Map<String, dynamic> lastCommand(ConversationServer server) =>
    Map<String, dynamic>.from(server.posts.last['command'] as Map);

Future<SuperTabController> openSheet(
  WidgetTester tester,
  ConversationServer server, {
  String? agentId,
  Future<Uint8List?> Function()? pick,
}) async {
  await tester.binding.setSurfaceSize(const Size(1200, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
  addTearDown(c.dispose);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showSuperTabProfile(
              context,
              c,
              agentId: agentId,
              pickPicture: pick ?? () async => null,
            ),
            child: const Text('Open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
  return c;
}

void main() {
  testWidgets('your own row opens your profile from Edit profile', (
    tester,
  ) async {
    final f = RosterFixture();
    addTearDown(f.dispose);
    await f.initialize();
    await f.show(tester);
    await tester.tap(find.byKey(const ValueKey('super-person-owner')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('super-profile-edit')));
    await tester.pumpAndSettle();
    expect(find.text('Your profile'), findsOneWidget);
    expect(find.byKey(const ValueKey('super-status-text')), findsOneWidget);
    await f.close(tester);
  });

  testWidgets('a preset becomes your avatar at once', (tester) async {
    final server = ConversationServer();
    final c = await openSheet(tester, server);
    await tester.tap(find.byKey(const ValueKey('super-avatar-preset-fox')));
    await tester.pumpAndSettle();
    expect(lastCommand(server), {
      'type': 'member.avatar',
      'avatar': {'kind': 'preset', 'key': 'fox'},
    });
    expect(c.snapshot!.people.single.avatar, isNotNull);
    await tester.tap(find.text('Use default'));
    await tester.pumpAndSettle();
    expect(lastCommand(server), {'type': 'member.avatar', 'avatar': null});
  });

  testWidgets('an uploaded picture is resized and set', (tester) async {
    final server = ConversationServer();
    final bytes = (await tester.runAsync(() => picture(500, 300)))!;
    await openSheet(tester, server, pick: () async => bytes);
    await tester.runAsync(() async {
      await tester.tap(find.text('Upload picture…'));
      for (var i = 0; i < 50 && server.avatarUploads.isEmpty; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
    });
    await tester.pumpAndSettle();
    expect(server.avatarUploads, hasLength(1));
    expect(lastCommand(server)['avatar'], {'kind': 'upload', 'id': 'avatar-1'});
  });

  testWidgets(
    'a status is picked, cleared after an hour, and cleared by hand',
    (tester) async {
      final server = ConversationServer();
      final now = DateTime.utc(2026, 10, 27, 9);
      await withClock(Clock.fixed(now), () async {
        await openSheet(tester, server);
        await tester.tap(find.byKey(const ValueKey('super-status-☕')));
        await tester.pump();
        expect(find.widgetWithText(TextField, 'Coffee break'), findsOneWidget);
        await tester.ensureVisible(find.text('Save status'));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-status-clears')));
        await tester.pumpAndSettle();
        await tester.tap(find.text('In 1 hour').last);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Save status'));
        await tester.pumpAndSettle();
        expect(lastCommand(server), {
          'type': 'member.status',
          'status': {
            'text': 'Coffee break',
            'emoji': '☕',
            'until': '2026-10-27T10:00:00.000Z',
          },
        });
        await tester.ensureVisible(find.text('Clear status'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Clear status'));
        await tester.pumpAndSettle();
        expect(lastCommand(server), {'type': 'member.status', 'status': null});
      });
    },
  );

  testWidgets('an agent’s sheet changes its avatar and has no status', (
    tester,
  ) async {
    final server = ConversationServer();
    server.state['agents'] = [
      {
        'id': 'agent-1',
        'name': 'Kai',
        'machineId': 'm',
        'harnessId': 'h',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      },
    ];
    await openSheet(tester, server, agentId: 'agent-1');
    expect(find.text('Kai’s avatar'), findsOneWidget);
    expect(find.byKey(const ValueKey('super-status-text')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('super-avatar-preset-owl')));
    await tester.pumpAndSettle();
    expect(lastCommand(server), {
      'type': 'agent.avatar',
      'agentId': 'agent-1',
      'avatar': {'kind': 'preset', 'key': 'owl'},
    });
  });

  testWidgets('a refusal is shown in the sheet', (tester) async {
    final server = ConversationServer();
    await openSheet(tester, server);
    server.refuse = {'code': 'FORBIDDEN', 'message': 'Not allowed here.'};
    await tester.tap(find.byKey(const ValueKey('super-avatar-preset-cat')));
    await tester.pumpAndSettle();
    expect(find.text('Not allowed here.'), findsOneWidget);
  });

  testWidgets('the agent’s contributor changes its avatar from its details', (
    tester,
  ) async {
    for (final contributor in ['owner', 'someone-else']) {
      final server = ConversationServer();
      server.state['agents'] = [
        {
          'id': 'agent-1',
          'name': 'Kai',
          'machineId': 'm',
          'harnessId': 'h',
          'contributorId': contributor,
          'configuration': {'engine': 'codex'},
        },
      ];
      final c = server.controller();
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showSuperTabAgentDetails(
                  context,
                  c,
                  null,
                  c.snapshot!.agent('agent-1')!,
                  (_) {},
                ),
                child: const Text('Details'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Details'));
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabAvatar), findsOneWidget);
      if (contributor != 'owner') {
        expect(find.text('Change avatar'), findsNothing);
      } else {
        await tester.tap(find.text('Change avatar'));
        await tester.pumpAndSettle();
        expect(find.text('Kai’s avatar'), findsOneWidget);
      }
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    }
  });
}

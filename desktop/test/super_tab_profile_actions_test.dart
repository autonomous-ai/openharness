import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/avatar_upload.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/profile_actions.dart';

import 'support/super_tab_fixture.dart';

Future<Uint8List> picture(int width, int height) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawRect(
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    ui.Paint()..color = const ui.Color(0xff3366cc),
  );
  final image = await recorder.endRecording().toImage(width, height);
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return bytes!.buffer.asUint8List();
}

Map<String, dynamic> lastCommand(ConversationServer server) =>
    Map<String, dynamic>.from(server.posts.last['command'] as Map);

void main() {
  testWidgets('a picked picture is cropped square and resized before upload', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final png = await superTabAvatarPng(await picture(900, 400));
      final codec = await ui.instantiateImageCodec(png);
      final frame = (await codec.getNextFrame()).image;
      expect([frame.width, frame.height], [256, 256]);
      expect(png.length, lessThan(kSuperTabAvatarMaxBytes));
      expect(png.sublist(0, 4), [0x89, 0x50, 0x4e, 0x47]);
      frame.dispose();
    });
  });

  testWidgets('something that is not a picture is refused here', (
    tester,
  ) async {
    await tester.runAsync(() async {
      await expectLater(
        superTabAvatarPng(Uint8List.fromList('<html></html>'.codeUnits)),
        throwsA(isA<SuperTabFailure>()),
      );
    });
  });

  test('a status is set and cleared as the person’s own', () async {
    final server = ConversationServer();
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    final until = DateTime.utc(2026, 10, 27, 14);
    expect(
      await c.setStatus(
        SuperTabPersonStatus(text: 'Out', emoji: '🌴', until: until),
      ),
      isNull,
    );
    expect(lastCommand(server), {
      'type': 'member.status',
      'status': {
        'text': 'Out',
        'emoji': '🌴',
        'until': '2026-10-27T14:00:00.000Z',
      },
    });
    expect(c.snapshot!.people.single.status!.text, 'Out');
    expect(await c.setStatus(null), isNull);
    expect(lastCommand(server), {'type': 'member.status', 'status': null});
    expect(c.snapshot!.people.single.status, isNull);
  });

  testWidgets('an upload becomes the person’s avatar, a preset an agent’s', (
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
        'configuration': {'engine': 'claude'},
      },
    ];
    final c = server.controller();
    addTearDown(c.dispose);
    await tester.runAsync(() async {
      await c.refresh();
      expect(await c.uploadAvatar(await picture(300, 300)), isNull);
    });
    expect(server.avatarUploads, hasLength(1));
    expect(lastCommand(server), {
      'type': 'member.avatar',
      'avatar': {'kind': 'upload', 'id': 'avatar-1'},
    });
    expect(c.snapshot!.people.single.avatar, isA<SuperTabUploadedAvatar>());
    expect(
      await c.setAvatar(const SuperTabPresetAvatar('owl'), agentId: 'agent-1'),
      isNull,
    );
    expect(lastCommand(server), {
      'type': 'agent.avatar',
      'agentId': 'agent-1',
      'avatar': {'kind': 'preset', 'key': 'owl'},
    });
    expect(c.snapshot!.agent('agent-1')!.avatar, isA<SuperTabPresetAvatar>());
    expect(await c.setAvatar(null), isNull);
    expect(lastCommand(server), {'type': 'member.avatar', 'avatar': null});
  });

  test(
    'a reaction toggles the reader’s own, and the page shows the count',
    () async {
      final server = ConversationServer()..append('Shipped');
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      await c.loadMessages('lead');
      final message = c.messages('lead').single;
      expect(await c.react(message, SuperTabReactionEmoji.tada), isNull);
      expect(lastCommand(server), {
        'type': 'message.react',
        'conversationId': 'lead',
        'messageId': message.id,
        'emoji': 'tada',
        'on': true,
      });
      expect(c.messages('lead').single.reactions.single.count, 1);
      expect(
        await c.react(c.messages('lead').single, SuperTabReactionEmoji.tada),
        isNull,
      );
      expect(lastCommand(server)['on'], false);
      expect(c.messages('lead').single.reactions, isEmpty);
    },
  );

  test('a refusal is said in words, and a viewer sends nothing', () async {
    final server = ConversationServer()
      ..refuse = {'code': 'FORBIDDEN', 'message': 'Not yours.'};
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    expect(
      await c.setStatus(const SuperTabPersonStatus(text: 'Hi')),
      'Not yours.',
    );
    server.refuse = null;
    server.state['people'] = [
      {'id': 'owner', 'email': 'owner@example.com', 'role': 'viewer'},
    ];
    await c.refresh();
    final sent = server.posts.length;
    expect(
      await c.setStatus(const SuperTabPersonStatus(text: 'Hi')),
      isNotNull,
    );
    expect(server.posts, hasLength(sent));
  });
}

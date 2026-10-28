import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';

import 'support/super_tab_fixture.dart';

void main() {
  final now = DateTime.utc(2026, 10, 27, 9);

  test('a person carries their avatar and a status until it is over', () {
    final person = SuperTabPerson.fromJson({
      'id': 'p1',
      'email': 'dee@example.com',
      'role': 'owner',
      'avatar': {
        'kind': 'upload',
        'url': 'https://storage.googleapis.com/avatars/a?X-Goog-Signature=s',
      },
      'status': {
        'text': 'Out until 2pm',
        'emoji': '🌴',
        'until': '2026-10-27T14:00:00.000Z',
      },
    });
    expect(person.avatar, isA<SuperTabUploadedAvatar>());
    expect(
      (person.avatar! as SuperTabUploadedAvatar).url,
      Uri.parse('https://storage.googleapis.com/avatars/a?X-Goog-Signature=s'),
    );
    expect(person.status!.label, '🌴 Out until 2pm');
    expect(person.statusAt(now)?.text, 'Out until 2pm');
    expect(person.statusAt(DateTime.utc(2026, 10, 27, 14)), isNull);
  });

  test(
    'a preset, a missing avatar, and a link that is not ours read safely',
    () {
      SuperTabAvatarPicture? read(Object? avatar) => SuperTabPerson.fromJson({
        'id': 'p1',
        'email': 'dee@example.com',
        'role': 'owner',
        'avatar': avatar,
      }).avatar;
      expect(
        (read({'kind': 'preset', 'key': 'fox'})! as SuperTabPresetAvatar).key,
        'fox',
      );
      expect(read(null), isNull);
      expect(read({'kind': 'preset', 'key': 'dragon'}), isNull);
      expect(read({'kind': 'upload', 'url': 'javascript:alert(1)'}), isNull);
      expect(
        read({'kind': 'upload', 'url': 'http://tracker.example/p.png'}),
        isNull,
      );
      expect(
        read({'kind': 'upload', 'url': 'https://elsewhere.example/a.png'}),
        isNull,
      );
      // Avatars are never public: not even the chat files' own CDN.
      expect(
        read({
          'kind': 'upload',
          'url': 'https://cdn.harness.autonomous.ai/a.png',
        }),
        isNull,
      );
      // An upload whose signed link has not come yet shows the default face.
      expect(read({'kind': 'upload'}), isNull);
      expect(read('fox'), isNull);
    },
  );

  test(
    'an agent carries its avatar; a message carries its reaction counts',
    () {
      final agent = SuperTabAgent.fromJson({
        'id': 'a1',
        'name': 'Kai',
        'machineId': 'm',
        'harnessId': 'h',
        'contributorId': 'p1',
        'configuration': {'engine': 'claude'},
        'avatar': {'kind': 'preset', 'key': 'owl'},
      });
      expect((agent.avatar! as SuperTabPresetAvatar).key, 'owl');
      final message = SuperTabMessage.fromJson({
        'id': 'm1',
        'conversationId': 'lead',
        'text': 'Shipped',
        'sequence': 3,
        'author': {'kind': 'person', 'id': 'p1', 'name': 'dee@example.com'},
        'reactions': [
          {
            'emoji': 'tada',
            'count': 2,
            'by': [
              {'kind': 'person', 'id': 'p1'},
              {'kind': 'agent', 'id': 'a1'},
            ],
          },
          {'emoji': 'skull', 'count': 1, 'by': []},
        ],
      });
      expect(message.reactions, hasLength(1));
      expect(message.reactions.single.emoji, SuperTabReactionEmoji.tada);
      expect(message.reactions.single.count, 2);
      expect(message.reactions.single.includes('person', 'p1'), isTrue);
      expect(message.reactions.single.includes('person', 'p2'), isFalse);
      expect(SuperTabReactionEmoji.tada.glyph, '🎉');
    },
  );

  test(
    'a read’s signed link becomes the avatar of the person or agent it names',
    () async {
      final server = ConversationServer();
      server.state['people'] = [
        {
          'id': 'owner',
          'email': 'dee@example.com',
          'role': 'owner',
          'avatar': {'kind': 'upload'},
        },
      ];
      server.state['agents'] = [
        {
          'id': 'kai',
          'name': 'Kai',
          'machineId': 'm',
          'harnessId': 'h',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
          'avatar': {'kind': 'upload'},
        },
      ];
      server.state['avatars'] = {
        'person:owner': superTabSignedAvatar('a1'),
        'agent:kai': superTabSignedAvatar('a2'),
      };
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      expect(
        (c.snapshot!.people.single.avatar! as SuperTabUploadedAvatar).url
            .toString(),
        superTabSignedAvatar('a1'),
      );
      expect(
        (c.snapshot!.agent('kai')!.avatar! as SuperTabUploadedAvatar).url
            .toString(),
        superTabSignedAvatar('a2'),
      );
    },
  );
}

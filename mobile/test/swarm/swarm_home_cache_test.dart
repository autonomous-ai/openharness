import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_home_cache.dart';
import 'package:harness_mobile/swarm/swarm_pm_chat.dart';
import 'package:harness_mobile/swarm/team_glance.dart';
import 'package:harness_mobile/swarm/waiting_work.dart';

import 'swarm_fixture.dart';

/// The last Home kept on the phone, so a cold start draws it at once: only
/// what Home draws, encrypted under a key in the Keychain, and gone with the
/// account, the Swarm switch, or the person's access.
void main() {
  /// A Swarm whose work g1 waits on the person, with everything Home does
  /// not draw filled in: a brief, checks, a question, emails.
  ({SuperTabSnapshot snapshot, Map<String, String> partners}) read() {
    final load = firstLoad(
      groups: [
        {
          ...groupData(
            'g1',
            title: 'Rotate the keys',
            number: 4,
            agentIds: ['agent-builder'],
          ),
          'brief': 'The secret plan',
          'checks': [
            {'id': 'c1', 'description': 'Keys rotated in prod'},
          ],
          'assignment': {
            'id': 'attempt-g1',
            'agentId': 'agent-builder',
            'status': 'needs_human',
            'result': 'Which vault holds the old key?',
          },
          'partnerId': me,
          'lastMessageSequence': 12,
        },
      ],
    );
    final state = SuperTabParts.firstLoad(load).state;
    return (
      snapshot: SuperTabSnapshot.fromJson(state),
      partners: swarmPartners(state),
    );
  }

  group('the view kept', () {
    test('draws Home as the Swarm did', () {
      final (:snapshot, :partners) = read();

      final kept = swarmHomeSwarm(snapshot, partners);
      final back = SuperTabSnapshot.fromJson(kept.state);

      expect(back.name, snapshot.name);
      expect([for (final p in back.projects) p.name], ['Mobile']);
      final project = back.projects.single;
      expect(swarmPmName(back, project), 'River');
      expect(
        swarmTeamGlance(back, projectId: project.id).line,
        swarmTeamGlance(snapshot, projectId: project.id).line,
      );
      final waiting = swarmWaitingWork(back, me, partners: kept.partners);
      expect(
        [for (final w in waiting) w.conversation.label],
        ['#4 Rotate the keys'],
      );
      expect(waiting.single.status, 'needs_human');
      expect(waiting.single.agentName, 'Nova');
    });

    test('keeps nothing Home does not draw', () {
      final (:snapshot, :partners) = read();

      final text = jsonEncode(swarmHomeSwarm(snapshot, partners).state);

      expect(text, isNot(contains('The secret plan')));
      expect(text, isNot(contains('Keys rotated')));
      expect(text, isNot(contains('Which vault')));
      expect(text, isNot(contains('@example.com')));
      final back = SuperTabSnapshot.fromJson(
        swarmHomeSwarm(snapshot, partners).state,
      );
      expect(back.decisionsWaiting, 0);
      expect(back.mentionsWaiting, 0);
      expect(back.conversation('g1')!.lastMessageSequence, 0);
    });
  });

  group('faces kept', () {
    /// A Swarm where River wears an uploaded photo, Nova the owl, and the
    /// person the fox and a status.
    SuperTabSnapshot faces() {
      final load = firstLoad(
        agents: [
          {
            ...agent('agent-lead', name: 'Lead', displayName: 'River'),
            'avatar': {'kind': 'upload'},
          },
          {
            ...agent('agent-builder', displayName: 'Nova'),
            'avatar': {'kind': 'preset', 'key': 'owl'},
          },
        ],
        derived: {
          'avatars': {
            'agent:agent-lead':
                'https://storage.googleapis.com/avatars/river.png?sig=secret',
          },
        },
      );
      load['members'] = [
        part(me, 1, {
          ...person(me),
          'avatar': {'kind': 'preset', 'key': 'fox'},
          'status': {'text': 'At the dentist', 'emoji': null, 'until': null},
        }),
      ];
      return SuperTabSnapshot.fromJson(SuperTabParts.firstLoad(load).state);
    }

    test('a built-in picture is kept by its name', () {
      final back = SuperTabSnapshot.fromJson(
        swarmHomeSwarm(faces(), const {}).state,
      );
      expect(
        (back.agent('agent-builder')!.avatar! as SuperTabPresetAvatar).key,
        'owl',
      );
      expect((back.people.single.avatar! as SuperTabPresetAvatar).key, 'fox');
    });

    test('a photo, its link and a status are never kept', () {
      final snapshot = faces();
      expect(
        snapshot.agent('agent-lead')!.avatar,
        isA<SuperTabUploadedAvatar>(),
      );
      final kept = swarmHomeSwarm(snapshot, const {}).state;
      final text = jsonEncode(kept);
      expect(text, isNot(contains('storage.googleapis.com')));
      expect(text, isNot(contains('sig=secret')));
      expect(text, isNot(contains('upload')));
      expect(text, isNot(contains('At the dentist')));
      final back = SuperTabSnapshot.fromJson(kept);
      expect(back.agent('agent-lead')!.avatar, isNull);
      expect(back.people.single.status, isNull);
    });
  });

  group('kept on the phone', () {
    late Directory dir;
    late MemorySwarmHomeKey key;
    late SwarmHomeCache cache;

    setUp(() {
      dir = Directory.systemTemp.createTempSync('swarm-home');
      addTearDown(() => dir.deleteSync(recursive: true));
      key = MemorySwarmHomeKey();
      cache = SwarmHomeCache(key: key, file: File('${dir.path}/home.bin'));
    });

    List<SwarmHomeEntry> home() {
      final (:snapshot, :partners) = read();
      return [
        (
          id: tab,
          name: 'Phone Swarm',
          view: swarmHomeSwarm(snapshot, partners),
        ),
      ];
    }

    test('reads back for its account', () async {
      await cache.write(me, home());

      final back = await cache.read(me);

      expect([for (final s in back!) s.name], ['Phone Swarm']);
      final snapshot = SuperTabSnapshot.fromJson(back.single.view.state);
      expect(snapshot.projects.single.name, 'Mobile');
      expect(back.single.view.partners, {'g1': me});
    });

    test('is sealed on disk under a key kept in the Keychain', () async {
      await cache.write(me, home());

      final bytes = File('${dir.path}/home.bin').readAsBytesSync();
      final text = utf8.decode(bytes, allowMalformed: true);
      expect(text, isNot(contains('Mobile')));
      expect(text, isNot(contains('Rotate the keys')));
      expect(text, isNot(contains(me)));
      expect(key.value, isNotNull);
    });

    test('another account reads nothing, and the view goes', () async {
      await cache.write(me, home());

      expect(await cache.read('person-other'), isNull);
      expect(await cache.read(me), isNull);
    });

    test(
      'without its key it reads nothing, and the sealed file goes',
      () async {
        await cache.write(me, home());
        key.value = null;

        expect(await cache.read(me), isNull);
        expect(File('${dir.path}/home.bin').existsSync(), isFalse);
      },
    );

    test('a file that does not open reads nothing, never an error', () async {
      await cache.write(me, home());
      final file = File('${dir.path}/home.bin');
      final bytes = file.readAsBytesSync();
      bytes[bytes.length ~/ 2] ^= 0xff;
      file.writeAsBytesSync(bytes);

      expect(await cache.read(me), isNull);
      expect(file.existsSync(), isFalse);
    });

    test(
      'a Keychain that refuses reads and keeps nothing, never throws',
      () async {
        key.refuses = true;

        await cache.write(me, home());

        expect(await cache.read(me), isNull);
        expect(File('${dir.path}/home.bin').existsSync(), isFalse);
      },
    );

    test('clear leaves neither the view nor its key', () async {
      await cache.write(me, home());

      await cache.clear();

      expect(File('${dir.path}/home.bin').existsSync(), isFalse);
      expect(key.value, isNull);
      expect(await cache.read(me), isNull);
    });

    test('nothing read before any was kept', () async {
      expect(await cache.read(me), isNull);
    });
  });
}

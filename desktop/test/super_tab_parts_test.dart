import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/parts.dart';

/// The design's section 4 examples, recorded (test/super_tab_read_fixtures).
Map<String, dynamic> recorded(String name) => jsonDecode(
  File('test/super_tab_read_fixtures/$name.json').readAsStringSync(),
) as Map<String, dynamic>;

Map<String, dynamic> group(Map<String, dynamic> state, String id) =>
    (state['conversations'] as List).cast<Map<String, dynamic>>().firstWhere(
      (g) => g['id'] == id,
    );

void main() {
  test('a first load reassembles the state the screens read', () {
    final parts = SuperTabParts.firstLoad(recorded('first_load'));
    final state = parts.state;
    final snapshot = SuperTabSnapshot.fromJson(state);

    expect(parts.cursor, 'eyJ2IjoyLCJ0IjoxNzkzMDEwMDc0Mzc1LCJlIjozfQ');
    expect(parts.epoch, 3);
    expect(parts.lastChangedAt, 1793010101002);
    expect(snapshot.id, 'c51479bd73b59e58176ad9e4');
    expect(snapshot.name, 'openharness');
    expect(snapshot.leadsConversationId, 'leads');
    expect(snapshot.people.single.email, 'ken15@autonomous.ai');
    expect(snapshot.projects.single.leadConversationId, 'lead5701');
    expect(snapshot.conversations.map((g) => g.id), [
      'leads',
      'lead5701',
      'aeef',
    ]);
    expect(snapshot.conversation('aeef')!.lastMessageSequence, 219804);
    expect(snapshot.agents.map((a) => a.displayName), ['River', 'Hugo']);
    expect(snapshot.localModels!.grid, 'swarm-c514');
    expect(snapshot.mentionsWaiting, 0);
    expect(state['githubApp'], true);
    // The machine and its values worked out at read time.
    expect(snapshot.pool('7835')!['teamWork'], {'allowed': true});
    expect(snapshot.pool('7835')!['availableSlots'], 3);
  });

  test(
    'derived values overlay the agents; a null decision keeps the stored one',
    () {
      final state = SuperTabParts.firstLoad(recorded('first_load')).state;
      final agents = (state['agents'] as List).cast<Map<String, dynamic>>();
      final hugo = agents.firstWhere((a) => a['id'] == '0540');
      final river = agents.firstWhere((a) => a['id'] == '0fcb');
      expect(hugo['downSince'], '2026-10-26T10:19:51.474Z');
      expect(hugo['workDecision'], 'awaiting');
      expect(river['downSince'], isNull);
      expect(river.containsKey('workDecision'), isFalse);

      final changed = recorded('changes');
      final parts = SuperTabParts.firstLoad(recorded('first_load'))
        ..apply(changed);
      final after = (parts.state['agents'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((a) => a['id'] == '0540');
      // Derived says nothing more about the decision: the stored one stands.
      expect(after['workDecision'], 'release');
      expect(after['downSince'], isNull);
    },
  );

  test('a first load of another format is refused', () {
    expect(
      () => SuperTabParts.firstLoad({...recorded('first_load'), 'format': 1}),
      throwsFormatException,
    );
    expect(
      () => SuperTabParts.firstLoad({'revision': 4, 'state': {}}),
      throwsFormatException,
    );
  });

  test(
    'changes replace newer parts, drop tombstones and move dormant groups out',
    () {
      final parts = SuperTabParts.firstLoad(recorded('first_load'))
        ..addDormant([]);
      // 77ab and 9c1d were read earlier: active then.
      parts.apply({
        ...recorded('changes'),
        'derived': recorded('first_load')['derived'],
        'groups': [
          {
            'key': '77ab',
            'version': 214000,
            'changedAt': 1793010100000,
            'data': {
              'id': '77ab',
              'projectId': '5701',
              'title': 'Gone soon',
              'agentIds': <String>[],
              'archived': false,
              'brief': '',
              'checks': <dynamic>[],
              'assignment': null,
              'lastMessageSequence': 0,
            },
          },
          {
            'key': '9c1d',
            'version': 214001,
            'changedAt': 1793010100000,
            'data': {
              'id': '9c1d',
              'projectId': '5701',
              'title': 'Finished',
              'agentIds': <String>[],
              'archived': false,
              'brief': '',
              'checks': <dynamic>[],
              'assignment': null,
              'lastMessageSequence': 5,
            },
          },
        ],
        'machines': <dynamic>[],
      });
      expect(group(parts.state, '77ab')['title'], 'Gone soon');

      final change = parts.apply(recorded('changes'));
      final state = parts.state;
      expect(change.changed, isTrue);
      expect(change.removedGroups, {'77ab'});
      expect(change.dormantGroups, {'9c1d'});
      expect(parts.cursor, 'eyJ2IjoyLCJ0IjoxNzkzMDEwMDc3Mzc1LCJlIjozfQ');
      expect(parts.lastChangedAt, 1793010106120);
      expect(group(state, 'aeef')['lastMessageSequence'], 219810);
      expect((state['conversations'] as List).map((g) => g['id']), [
        'leads',
        'lead5701',
        'aeef',
        // Its data is kept, marked dormant, after the active groups.
        '9c1d',
      ]);
      expect(group(state, '9c1d')['dormant'], true);
      expect(SuperTabSnapshot.fromJson(state).pool('7835')!['paused'], true);
      expect(
        SuperTabSnapshot.fromJson(state).pool('7835')!['availableSlots'],
        2,
      );
      expect(state['mentionsWaiting'], 1);
    },
  );

  test('the overlap sends parts again: equal versions change nothing', () {
    final parts = SuperTabParts.firstLoad(recorded('first_load'));
    expect(parts.apply(recorded('changes')).changed, isTrue);
    final before = jsonEncode(parts.state);
    final again = parts.apply(recorded('changes'));
    expect(again.changed, isFalse);
    expect(again.removedGroups, isEmpty);
    expect(again.dormantGroups, isEmpty);
    expect(jsonEncode(parts.state), before);
  });

  test(
    'an older copy never replaces a newer one, nor brings a removed part back',
    () {
      final parts = SuperTabParts.firstLoad(recorded('first_load'));
      final older = {
        ...recorded('changes'),
        'derived': recorded('first_load')['derived'],
        'groups': [
          {
            'key': 'aeef',
            'version': 214000,
            'changedAt': 1793010000000,
            'data': {...group(parts.state, 'aeef'), 'title': 'Stale'},
          },
        ],
        'machines': <dynamic>[],
      };
      expect(parts.apply(older).changed, isFalse);
      expect(group(parts.state, 'aeef')['title'], '1726 G1: design doc');

      parts.apply({
        ...older,
        'groups': [
          {
            'key': 'aeef',
            'version': 214050,
            'changedAt': 1793010200000,
            'deleted': true,
          },
        ],
      });
      expect(
        (parts.state['conversations'] as List).map((g) => g['id']),
        isNot(contains('aeef')),
      );
      parts.apply(older);
      expect(
        (parts.state['conversations'] as List).map((g) => g['id']),
        isNot(contains('aeef')),
      );
    },
  );

  test(
    'a dormant group that changes again comes back to the active groups',
    () {
      final parts = SuperTabParts.firstLoad(recorded('first_load'));
      final dormant = recorded('dormant_groups');
      expect(parts.addDormant(dormant['groups'] as List).changed, isTrue);
      expect(group(parts.state, '9c1d')['dormant'], true);
      expect(parts.isDormant('9c1d'), isTrue);

      final back = {
        ...(dormant['groups'] as List).single as Map<String, dynamic>,
        'version': 214100,
      };
      back['data'] = {
        ...back['data'] as Map,
        'dormant': false,
        'archived': false,
      };
      parts.apply({
        ...recorded('changes'),
        'groups': [back],
      });
      expect(parts.isDormant('9c1d'), isFalse);
      expect(group(parts.state, '9c1d')['dormant'], false);
      expect(
        (parts.state['conversations'] as List).map((g) => g['id']).last,
        '9c1d',
      );
    },
  );

  test('a dormant list cannot replace a group held at a newer version', () {
    final parts = SuperTabParts.firstLoad(recorded('first_load'));
    final stale = {
      'key': 'aeef',
      'version': 1,
      'changedAt': 1,
      'data': {...group(parts.state, 'aeef'), 'dormant': true},
    };
    expect(parts.addDormant([stale]).changed, isFalse);
    expect(parts.isDormant('aeef'), isFalse);
  });

  test('a new part is listed after the ones read before it', () {
    final parts = SuperTabParts.firstLoad(recorded('first_load'));
    parts.apply({
      ...recorded('changes'),
      'head': {
        'key': 'head',
        'version': 214060,
        'changedAt': 1793010106000,
        'data': {
          ...(recorded('first_load')['head'] as Map)['data'] as Map,
          'name': 'Renamed',
        },
      },
      'members': [
        {
          'key': '6a87',
          'version': 214061,
          'changedAt': 1793010106000,
          'data': {
            'id': '6a87',
            'email': 'duy@example.com',
            'role': 'collaborator',
          },
        },
      ],
    });
    final snapshot = SuperTabSnapshot.fromJson(parts.state);
    expect(snapshot.name, 'Renamed');
    expect(snapshot.people.map((p) => p.id), ['6a86', '6a87']);
  });

  test('what it keeps reads back as the same store', () {
    final parts = SuperTabParts.firstLoad(recorded('first_load'))
      ..apply(recorded('changes'))
      ..addDormant(recorded('dormant_groups')['groups'] as List);
    final kept = SuperTabParts.fromJson(
      jsonDecode(jsonEncode(parts.toJson())) as Map<String, dynamic>,
    );
    expect(jsonEncode(kept.state), jsonEncode(parts.state));
    expect(kept.cursor, parts.cursor);
    expect(kept.epoch, parts.epoch);
    expect(kept.lastChangedAt, parts.lastChangedAt);
    // Versions are kept too: the overlap changes nothing on the copy.
    expect(kept.apply(recorded('changes')).changed, isFalse);
  });

  test(
    'a group a stub closed takes its data read by id at the same version',
    () {
      final parts = SuperTabParts.firstLoad(recorded('first_load'));
      parts.apply({
        ...recorded('changes'),
        'groups': [
          {
            'key': 'aeef',
            'version': 214100,
            'changedAt': 1793010200000,
            'dormant': true,
          },
        ],
      });
      // Held from before it closed: stale until read again.
      expect(group(parts.state, 'aeef')['archived'], false);
      final read = {
        'key': 'aeef',
        'version': 214100,
        'changedAt': 1793010200000,
        'data': {
          ...group(parts.state, 'aeef'),
          'archived': true,
          'dormant': true,
        },
      };
      expect(parts.addDormant([read]).changed, isTrue);
      expect(group(parts.state, 'aeef')['archived'], true);
      // Read once: the same copy again changes nothing.
      expect(parts.addDormant([read]).changed, isFalse);
    },
  );
}

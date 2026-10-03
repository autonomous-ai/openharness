import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/teams/team_controller.dart';

import 'support/team_fixture.dart';

void main() {
  test('watch and reopen only read; stopping a view stops polling', () async {
    final calls = <Map<String, dynamic>>[];
    final controller = TeamController(
      request: (p) async {
        calls.add(p);
        return {'teams': []};
      },
    );
    addTearDown(controller.dispose);
    controller.watch();
    await controller.refresh();
    controller.unwatch();
    controller.watch();
    await controller.refresh();
    controller.unwatch();
    expect(calls.map((p) => p['action']), everyElement('list'));
    expect(calls.length, 2);
  });
  test(
    'uncertain creation retries its original ID and original roster',
    () async {
      final calls = <Map<String, dynamic>>[];
      final controller = TeamController(
        request: (p) async {
          calls.add(p);
          if (calls.length == 1) throw TimeoutException('Connection lost');
          return {
            'team': {...teamFixture(), 'id': p['id']},
          };
        },
      );
      addTearDown(controller.dispose);
      controller.newMembers['one'] = {
        'machineId': 'host',
        'agentId': 'one',
        'name': 'one',
      };
      await controller.create();
      expect(controller.pendingCreate, isTrue);
      controller.newName = 'Edited after timeout';
      controller.newMembers.clear();
      await controller.create();
      expect(calls[1], calls[0]);
      expect(controller.pendingCreate, isFalse);
    },
  );
  test(
    'uncertain ask retries one question; a definitive refusal permits editing',
    () async {
      final sends = <Map<String, dynamic>>[];
      final controller = TeamController(
        request: (p) async {
          if (p['action'] == 'get') return {'team': teamFixture()};
          sends.add(p);
          if (sends.length == 1) throw TimeoutException('Lost acknowledgement');
          if (sends.length == 3) throw const TeamRequestError('Team paused');
          return {
            'exchange': {'id': p['id']},
          };
        },
      );
      addTearDown(controller.dispose);
      await controller.select(teamId);
      controller.draft = 'Which endpoint?';
      await controller.ask();
      expect(controller.pendingAsk, isTrue);
      controller.draft = 'Different draft';
      await controller.ask();
      expect(sends[1], sends[0]);
      expect(controller.draft, isEmpty);
      controller.draft = 'New question';
      await controller.ask();
      expect(controller.pendingAsk, isFalse);
      expect(controller.draft, 'New question');
      expect(sends[2]['id'], isNot(sends[0]['id']));
    },
  );
  test(
    'late refresh cannot replace a newer revision or another team',
    () async {
      final stale = Completer<Map<String, dynamic>>();
      var reads = 0;
      final controller = TeamController(
        request: (p) async {
          reads++;
          if (reads == 2) return stale.future;
          return {'team': teamFixture(id: p['teamId'] as String, revision: 4)};
        },
      );
      addTearDown(controller.dispose);
      await controller.select(teamId);
      controller.draft = 'Keep this draft';
      final slow = controller.refresh();
      await controller.select(otherTeamId);
      stale.complete({'team': teamFixture(revision: 99)});
      await slow;
      expect(controller.team?['id'], otherTeamId);
      await controller.select(teamId);
      expect(controller.draft, 'Keep this draft');
      controller.team!['revision'] = 9;
      await controller.refresh();
      expect(controller.team?['revision'], 9);
    },
  );
  test(
    'a send completed after changing teams clears only its own saved draft',
    () async {
      final sent = Completer<Map<String, dynamic>>();
      final controller = TeamController(
        request: (p) async => p['action'] == 'ask'
            ? sent.future
            : {'team': teamFixture(id: p['teamId'] as String)},
      );
      addTearDown(controller.dispose);
      await controller.select(teamId);
      controller.draft = 'Sent draft';
      final sending = controller.ask();
      await controller.select(otherTeamId);
      controller.draft = 'Unrelated draft';
      sent.complete({
        'exchange': {'id': questionId},
      });
      await sending;
      expect(controller.draft, 'Unrelated draft');
      await controller.select(teamId);
      expect(controller.draft, isEmpty);
      expect(controller.selectedExchange, questionId);
    },
  );
  test(
    'adding a teammate reconciles an uncertain membership with the same ID',
    () async {
      final additions = <Map<String, dynamic>>[];
      final controller = TeamController(
        request: (p) async {
          if (p['action'] == 'add_member') {
            additions.add(p);
            if (additions.length == 1) throw TimeoutException('Lost reply');
          }
          return {'team': teamFixture()};
        },
      );
      addTearDown(controller.dispose);
      await controller.select(teamId);
      await controller.addMember({
        'machineId': 'host',
        'agentId': 'firmware',
        'name': 'firmware',
      });
      expect(controller.pendingAdd, isTrue);
      await controller.addMember();
      expect(additions[1], additions[0]);
      expect(controller.pendingAdd, isFalse);
    },
  );
  test(
    'disposal ignores a delayed response and never cancels daemon work',
    () async {
      final pending = Completer<Map<String, dynamic>>();
      final controller = TeamController(request: (p) => pending.future);
      final loading = controller.select(teamId);
      controller.dispose();
      pending.complete({'team': teamFixture()});
      await loading;
      expect(controller.team, isNull);
    },
  );
}

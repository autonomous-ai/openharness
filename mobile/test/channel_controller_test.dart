import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/teams/team_controller.dart';

import 'support/team_fixture.dart';

void main() {
  test(
    'channel history opens directly and only reads its pinned tab',
    () async {
      final calls = <Map<String, dynamic>>[];
      final controller = TeamController(
        channelTabId: 'device',
        request: (p) async {
          calls.add(p);
          return {
            'team': {
              ...teamFixture(),
              'channel': {'tabId': 'device'},
            },
          };
        },
      );
      addTearDown(controller.dispose);
      controller.watch();
      await controller.refresh();
      controller.unwatch();
      expect(calls, [
        {'action': 'channel_get', 'tabId': 'device'},
      ]);
      expect(controller.isChannel, isTrue);
      expect(controller.selectedExchange, questionId);
    },
  );

  test(
    'uncertain consult retries the same source and joins repeated keypresses',
    () async {
      final calls = <Map<String, dynamic>>[];
      final pending = Completer<Map<String, dynamic>>();
      final controller = TeamController(
        channelTabId: 'device',
        request: (p) {
          calls.add(p);
          if (calls.length == 1) return pending.future;
          return Future.value({
            'consultation': {
              'receipt': {'state': 'queued'},
            },
          });
        },
      );
      addTearDown(controller.dispose);
      final first = controller.consult('host', 'mobile');
      final repeated = controller.consult('host', 'mobile');
      expect(identical(first, repeated), isTrue);
      pending.completeError(TimeoutException('Lost reply'));
      expect(await first, contains('same instruction'));
      await controller.consult('host', 'mobile');
      expect(calls[1], calls[0]);
      expect(calls[0]['tabId'], 'device');
      expect(calls[0]['from'], {'machineId': 'host', 'agentId': 'mobile'});
      await controller.consult('host', 'firmware');
      expect(calls[2]['id'], isNot(calls[0]['id']));
      expect(calls.map((p) => p['action']), everyElement('channel_consult'));
    },
  );

  test(
    'a definitive channel refusal does not leave an uncertain instruction',
    () async {
      final ids = <String>[];
      final controller = TeamController(
        channelTabId: 'single',
        request: (p) async {
          ids.add(p['id'] as String);
          return {
            'error': 'NO_PEERS',
            'detail': 'Add another agent to this swarm.',
          };
        },
      );
      addTearDown(controller.dispose);
      expect(
        await controller.consult('host', 'mobile'),
        contains('Add another agent'),
      );
      await controller.consult('host', 'mobile');
      expect(ids.toSet(), hasLength(2));
    },
  );
}

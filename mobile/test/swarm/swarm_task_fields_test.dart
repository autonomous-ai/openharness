import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';

/// What Desktop's model reads of a task and a Swarm, read the same way
/// (desktop_parity_test.dart names the fields; this holds their values).
void main() {
  Map<String, dynamic> group([Map<String, dynamic> more = const {}]) => {
    'id': 'g',
    'title': 'Task',
    'brief': '',
    'leadId': null,
    'archived': false,
    'agentIds': <String>[],
    ...more,
  };
  Map<String, dynamic> swarm([Map<String, dynamic> more = const {}]) => {
    'id': 'tab',
    'name': 'Swarm',
    'ownerId': 'owner',
    'paused': false,
    'people': <dynamic>[],
    'agents': <dynamic>[],
    'conversations': <dynamic>[],
    ...more,
  };

  test('a task says who asked and when it shipped', () {
    final task = SuperTabConversation.fromJson(
      group({'requesterId': 'tony', 'shippedAt': 1000}),
    );
    expect(task.requesterId, 'tony');
    expect(task.shippedAt, DateTime.fromMillisecondsSinceEpoch(1000));
  });

  test('a server that does not say leaves both empty', () {
    final task = SuperTabConversation.fromJson(group());
    expect(task.requesterId, isNull);
    expect(task.shippedAt, isNull);
  });

  test('a Swarm lists the machines the reader took out, strings only', () {
    expect(
      SuperTabSnapshot.fromJson(
        swarm({
          'removedMachines': ['m1', 3, 'm2'],
        }),
      ).removedMachines,
      ['m1', 'm2'],
    );
    expect(SuperTabSnapshot.fromJson(swarm()).removedMachines, isEmpty);
  });
}

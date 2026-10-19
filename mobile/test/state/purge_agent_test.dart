import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import '../viewer_app_fixture.dart';

/// Delete Harness from the phone: a harness and its saved conversation, gone for good — the
/// desktop's `purgeAgent`. Reviewed first, then deleted under that review, naming the harness
/// exactly; and a reply that never came is not taken for a delete that did not happen.
void main() {
  const created = '2026-10-16T01:00:00.000Z';
  final createdMs = DateTime.parse(created).millisecondsSinceEpoch;

  /// The harness to delete: Claude Code, mid-conversation, registered at [created].
  Map<String, dynamic> source({
    String id = 'a',
    String engine = 'claude',
    String? sessionId = 's1',
    bool registered = true,
  }) => agentJson(
    id,
    engine: engine,
    sessionId: sessionId,
    extra: {if (registered) 'createdAt': created},
  );

  /// A signed-in phone whose machine `m` lists [agents], and reviews then deletes as a current
  /// machine does.
  Future<ViewerRig> rigWith(List<Map<String, dynamic>> agents) async {
    final rig = viewerApp();
    rig.api.onMachines = () async => [remoteMachine('m')];
    final answers = rig.conn('m').answers;
    answers['agents_list'] = (_) => {'agents': agents};
    answers['terminal_capabilities'] = (_) => capabilities();
    answers['agent_purge'] = (p) => p['mode'] == 'inspect'
        ? {'reviewId': 'review-1', 'items': <Object>[]}
        : {'deleted': true};
    await rig.app.bootstrap();
    await settle();
    rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
    await settle();
    addTearDown(rig.app.dispose);
    return rig;
  }

  List<String> listed(ViewerRig rig) => [
    for (final agent in rig.app.stateOf('m')!.agents) agent.id,
  ];

  test('reviews, then deletes under that review, naming the harness '
      'exactly — and it leaves the list', () async {
    final rig = await rigWith([source(), source(id: 'b')]);

    final error = await rig.app.purgeAgent('m', 'a');

    expect(error, isNull);
    expect(rig.conn('m').payloadsOf('agent_purge'), [
      {
        'agentId': 'a',
        'sessionId': 's1',
        'createdAt': createdMs,
        'mode': 'inspect',
      },
      {
        'agentId': 'a',
        'sessionId': 's1',
        'createdAt': createdMs,
        'mode': 'delete',
        'reviewId': 'review-1',
      },
    ]);
    expect(listed(rig), ['b']);
    expect(rig.app.agentPurging('m', 'a'), isFalse);
  });

  test('a harness with no conversation yet is named by a null one', () async {
    final rig = await rigWith([source(sessionId: null)]);

    await rig.app.purgeAgent('m', 'a');

    final [review, _] = rig.conn('m').payloadsOf('agent_purge');
    expect(review.containsKey('sessionId'), isTrue);
    expect(review['sessionId'], isNull);
  });

  test('a refused review deletes nothing and says why, in the machine’s '
      'words when it has them', () async {
    final rig = await rigWith([source()]);
    final conn = rig.conn('m');
    conn.answers['agent_purge'] = (_) => throw refusal('OWNER_REQUIRED');
    expect(await rig.app.purgeAgent('m', 'a'), 'Delete failed: OWNER_REQUIRED');

    conn.answers['agent_purge'] = (_) => {
      'error': 'AGENT_CHANGED',
      'detail': 'The harness changed since it was reviewed.',
    };
    expect(
      await rig.app.purgeAgent('m', 'a'),
      'Delete failed: The harness changed since it was reviewed.',
    );

    expect(conn.payloadsOf('agent_purge').map((p) => p['mode']), [
      'inspect',
      'inspect',
    ]);
    expect(listed(rig), ['a']);
  });

  test('a review with no id is not deleted under', () async {
    final rig = await rigWith([source()]);
    rig.conn('m').answers['agent_purge'] = (_) => {'items': <Object>[]};

    expect(
      await rig.app.purgeAgent('m', 'a'),
      'Could not review this harness for deletion.',
    );
    expect(rig.conn('m').payloadsOf('agent_purge'), hasLength(1));
    expect(listed(rig), ['a']);
  });

  test('a delete whose reply never came asks to check, and keeps the '
      'row', () async {
    final rig = await rigWith([source()]);
    rig.conn('m').answers['agent_purge'] = (p) => p['mode'] == 'inspect'
        ? {'reviewId': 'review-1'}
        : throw const WsRequestTimeout('agent_purge');

    expect(
      await rig.app.purgeAgent('m', 'a'),
      'Could not confirm the deletion. Refresh harnesses to check.',
    );
    expect(listed(rig), ['a']);
  });

  test('a review whose reply never came deleted nothing, and says to try '
      'again', () async {
    final rig = await rigWith([source()]);
    rig.conn('m').answers['agent_purge'] = (_) =>
        throw const WsRequestTimeout('agent_purge');

    expect(
      await rig.app.purgeAgent('m', 'a'),
      'Could not review this harness for deletion. Try again.',
    );
    expect(rig.conn('m').payloadsOf('agent_purge'), hasLength(1));
  });

  test('a delete the machine does not confirm is not taken for one', () async {
    final rig = await rigWith([source()]);
    rig.conn('m').answers['agent_purge'] = (p) =>
        p['mode'] == 'inspect' ? {'reviewId': 'review-1'} : {'deleted': false};

    expect(
      await rig.app.purgeAgent('m', 'a'),
      'Could not confirm the deletion. Refresh harnesses to check.',
    );
    expect(listed(rig), ['a']);
  });

  test('a harness its machine never said it registered is not asked '
      'about', () async {
    final rig = await rigWith([source(registered: false)]);

    expect(
      await rig.app.purgeAgent('m', 'a'),
      'This harness is no longer listed. Refresh and try again.',
    );
    expect(rig.conn('m').payloadsOf('agent_purge'), isEmpty);
  });

  test('a terminal keeps no conversation, so it is stopped, not '
      'deleted', () async {
    final rig = await rigWith([source(engine: 'terminal')]);

    expect(
      await rig.app.purgeAgent('m', 'a'),
      'A terminal keeps no conversation. Stop it instead.',
    );
    expect(rig.conn('m').payloadsOf('agent_purge'), isEmpty);
  });

  test('pressed again while it is out joins the first', () async {
    final rig = await rigWith([source()]);
    final review = Completer<Map<String, dynamic>>();
    rig.conn('m').answers['agent_purge'] = (p) =>
        p['mode'] == 'inspect' ? review.future : {'deleted': true};

    final first = rig.app.purgeAgent('m', 'a');
    final second = rig.app.purgeAgent('m', 'a');
    expect(rig.app.agentPurging('m', 'a'), isTrue);
    review.complete({'reviewId': 'review-1'});

    expect(await first, isNull);
    expect(await second, isNull);
    expect(rig.conn('m').payloadsOf('agent_purge'), hasLength(2));
    expect(rig.app.agentPurging('m', 'a'), isFalse);
  });

  test('Agent reads when it was registered', () {
    expect(Agent.fromJson(source()).createdAt, DateTime.parse(created));
  });
}

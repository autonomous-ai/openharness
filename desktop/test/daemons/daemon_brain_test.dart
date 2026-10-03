// The window's half of the pair brain (daemons/BRAIN.md): what it hears from
// this computer's harnessd, and what it sends back. Frames are the shapes
// cli/src/pair/protocol.ts and brain.ts send.
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/daemons/daemon_brain.dart';
import 'package:harness/daemons/roster.dart';

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  late List<(String, Map<String, dynamic>)> sent;
  late bool reachable;
  late _Memory storage;
  late DaemonBrain brain;
  late DateTime now;

  setUp(() {
    sent = [];
    reachable = true;
    storage = _Memory();
    now = DateTime(2026, 9, 26, 9);
    brain = DaemonBrain(
      send: (type, payload) {
        if (!reachable) return false;
        sent.add((type, payload));
        return true;
      },
      storage: storage,
      random: Random(4),
      now: () => now,
    );
  });
  tearDown(() => brain.dispose());

  test('opening the terminal sends no words and pins the reply to the current individual', () async {
    brain.bindConversation('account:test', 'tim-one');
    final opening = brain.openConversation();
    expect(sent.single.$1, 'daemon_open');
    expect(sent.single.$2['companionUid'], 'tim-one');
    expect(sent.single.$2.containsKey('text'), isFalse);
    brain.receive('daemon_open_result', {
      'requestId': sent.single.$2['requestId'],
      'ok': true,
      'agentId': 'pair-tim',
    });
    expect((await opening)['ok'], isTrue);
    expect(brain.pairAgentId, 'pair-tim');
    expect(brain.talk, isEmpty);
    final stale = brain.openConversation();
    final requestId = sent.last.$2['requestId'];
    brain.bindConversation('account:test', 'gnu-one');
    brain.receive('daemon_open_result', {
      'requestId': requestId,
      'ok': true,
      'agentId': 'pair-tim',
    });
    expect((await stale)['error'], 'STALE_COMPANION');
    expect(brain.pairAgentId, 'pair-tim');
    brain.bindConversation('account:another', 'other-tim');
    expect(brain.pairAgentId, isNull);
  });

  test('daemon state restores the collection terminal without matching a character workspace', () {
    brain.bindConversation('account:test', 'tim-one');
    brain.receive('daemon_state', {
      'pair': 'tim',
      'companionHarness': {
        'agentId': 'collection-agent',
        'state': 'ready',
        'model': 'opus',
        'engine': 'claude',
      },
    });
    expect(brain.pairAgentId, 'collection-agent');
    expect(brain.pairEngine, 'claude');
    brain.bindConversation('account:test', 'gnu-one');
    expect(brain.pairAgentId, 'collection-agent');
    brain.bindConversation(null, null);
    expect(brain.pairAgentId, isNull);
    expect(brain.pairEngine, isNull);
  });

  test('an explicit engine choice commits only after success and cannot cross accounts', () async {
    brain.bindConversation('account:test', 'tim-one');
    brain.receive('daemon_state', {
      'pair': 'tim',
      'companionHarness': {'agentId': 'old-agent', 'engine': 'claude'},
    });
    final failed = brain.openConversation(engine: 'codex');
    expect(sent.last.$2['engine'], 'codex');
    expect(brain.pairEngine, 'claude');
    brain.receive('daemon_open_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': false,
      'error': 'BUSY',
    });
    await failed;
    expect(brain.pairEngine, 'claude');
    final opening = brain.openConversation(engine: 'codex');
    brain.receive('daemon_open_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': true,
      'agentId': 'codex-agent',
      'engine': 'codex',
    });
    await opening;
    expect(brain.pairEngine, 'codex');
    expect(brain.pairAgentId, 'codex-agent');
    final stale = brain.openConversation(engine: 'claude');
    final request = sent.last.$2['requestId'];
    brain.bindConversation('account:other', 'other-tim');
    brain.receive('daemon_open_result', {
      'requestId': request,
      'ok': true,
      'agentId': 'old-agent',
      'engine': 'claude',
    });
    expect((await stale)['error'], 'STALE_COMPANION');
    expect(brain.pairEngine, isNull);
    expect(brain.pairAgentId, isNull);
  });

  test('recent conversation survives a window restart, scoped to account and individual', () async {
    brain.bindConversation('account:one', 'tim-one');
    await Future<void>.delayed(Duration.zero);
    brain.receive('daemon_say', {
      'id': 'saved-reply',
      'mood': 'say',
      'from': 'pair',
      'line': 'Hello.',
      'reply': 'Our first little conversation.',
      'companionUid': 'tim-one',
    });
    await brain.flushConversation();
    final next = DaemonBrain(send: (_, _) => true, storage: storage);
    addTearDown(next.dispose);
    next.bindConversation('account:one', 'tim-one');
    await Future<void>.delayed(Duration.zero);
    expect(next.talk.single.text, 'Our first little conversation.');
    next.bindConversation('account:one', 'gnu-one');
    await Future<void>.delayed(Duration.zero);
    expect(next.talk, isEmpty);
    next.bindConversation('account:two', 'tim-one');
    await Future<void>.delayed(Duration.zero);
    expect(next.talk, isEmpty);
  });

  test(
    'full replies stay out of status text and never cross companion identities',
    () {
      brain.bindConversation('account:one', 'tim-one');
      final reply = {
        'id': 'chat-one',
        'mood': 'say',
        'from': 'pair',
        'line': 'A short hello.',
        'reply': 'A longer answer.\n\nWith a second paragraph.',
        'companionUid': 'tim-one',
        'actions': [
          {'key': 'y', 'label': 'approve'},
        ],
      };
      final spoken = <DaemonSay>[];
      brain.said.listen(spoken.add);
      brain.receive('daemon_say', reply);
      brain.receive('daemon_say', reply);
      expect(brain.talk, [
        (you: false, text: 'A longer answer.\n\nWith a second paragraph.'),
      ]);
      expect(spoken.first.line, 'A short hello.');
      expect(spoken.first.actions, isEmpty);
      brain.bindConversation('account:one', 'gnu-one');
      expect(brain.talk, isEmpty);
      brain.receive('daemon_say', reply);
      expect(brain.talk, isEmpty);
      brain.bindConversation('account:two', 'tim-one');
      expect(brain.pairAgentId, isNull);
    },
  );

  test('daemon_state: every machine, the +n, asks and what it did', () {
    expect(brain.active, isFalse);
    brain.receive('daemon_state', {
      'pair': 'tim',
      'needs': [
        {
          'machineId': 'office',
          'machine': 'office',
          'agentId': 'a1',
          'name': 'migration',
          'engine': 'codex',
          'requestId': 'r9',
          'question': 'Run npm run migrate?',
          'options': ['1. Yes', '3. No'],
          'deny': false,
          'allow': true,
          'since': 1790000000000,
          'id': 'need:office:e:1',
          'line': '[y/n/g] migration@office: Run npm run migrate?',
          'actions': [
            {'key': 'y', 'label': 'Yes', 'choice': '1. Yes'},
            {'key': 'N', 'label': 'No'},
          ],
        },
        {'machineId': 'broken'},
      ],
      'working': 2,
      'failing': [
        {
          'machineId': 'm',
          'machine': 'laptop',
          'agentId': 'b1',
          'name': 'billing',
          'reason': 'exit 1',
        },
      ],
      'machines': [
        {'machineId': 'm', 'name': 'laptop', 'status': 'ok', 'local': true},
        {'machineId': 'office', 'name': 'office', 'status': 'asleep'},
        {'machineId': 'studio', 'name': 'studio', 'status': 'connecting'},
      ],
      'done': {
        'count': 3,
        'last': [
          {
            'machineId': 'office',
            'machine': 'office',
            'agentId': 'a2',
            'name': 'api@office',
            'recap': 'tests pass.',
            'at': 1790000000000,
          },
        ],
      },
      'asks': [
        {
          'id': 'ask:7',
          'line': '[y/n] start codex in ~/api?',
          'actions': [
            {'key': 'y', 'label': 'do it', 'choice': 'y'},
            {'key': 'n', 'label': 'skip', 'choice': 'n'},
          ],
        },
      ],
      'acted': [
        {
          'machineId': 'office',
          'machine': 'office',
          'agentId': 'a3',
          'name': 'web@office',
          'by': 'rule',
          'action': 'answer',
          'text': 'answered "1. Yes"',
          'at': 1790000000000,
        },
      ],
    });
    final state = brain.state!;
    expect(brain.active, isTrue);
    expect(brain.paired, isTrue);
    expect(state.pair, 'tim');
    final need = state.needs.single;
    expect(need.key, 'office/a1#r9');
    expect(need.harness, 'office/a1');
    expect(need.sayId, 'need:office:e:1');
    expect(need.line, startsWith('[y/n/g] '));
    expect(need.since, DateTime.fromMillisecondsSinceEpoch(1790000000000));
    expect(need.actions.map((a) => (a.key, a.choice)), [
      ('y', '1. Yes'),
      ('n', 'N'),
    ]);
    expect(state.working, isTrue);
    expect(state.workingCount, 2, reason: 'a count, not a flag');
    expect(state.failing.single.reason, 'exit 1');
    expect(state.machines.map((m) => (m.name, m.status, m.away)), [
      ('laptop', 'ok', false),
      ('office', 'asleep', true),
      ('studio', 'connecting', false),
    ]);
    expect(state.doneCount, 3);
    expect(state.doneLast.single.line, 'api@office finished: tests pass.');
    expect(state.asks.single.id, 'ask:7');
    expect(state.acted.single.line, 'rule: web@office answered "1. Yes"');
    // Pairing off: the roster's lines again.
    brain.receive('daemon_state', {
      'pair': null,
      'needs': [],
      'working': 0,
      'failing': [],
      'machines': [],
      'done': {'count': 0, 'last': []},
      'asks': [],
      'acted': [],
    });
    expect(brain.active, isTrue);
    expect(brain.paired, isFalse);
  });

  test('says carry what they are about and their mood; unsays and briefs '
      'are passed on', () async {
    final said = <DaemonSay>[];
    final unsaid = <String>[];
    brain.said.listen(said.add);
    brain.unsaid.listen(unsaid.add);
    brain.receive('daemon_say', {
      'id': 'need:office:e:1',
      'about': {'machineId': 'office', 'agentId': 'a1', 'requestId': 'r1'},
      'mood': 'need',
      'line': '[y/n/g] api@office Bash: npm test',
      'actions': [
        {'key': 'y', 'label': 'Yes', 'choice': '1. Yes'},
        {'key': 'n', 'label': 'No', 'choice': '3. No'},
        {'key': 'g', 'label': 'open', 'choice': 'open'},
      ],
      'ttlMs': 5200,
    });
    brain.receive('daemon_say', {'id': 's2', 'line': '   '});
    brain.receive('daemon_unsay', {
      'id': 'need:office:e:1',
      'reason': 'answered',
    });
    final say = said.single;
    expect(say.mood, DaemonSayMood.need);
    expect(say.aboutKey, 'office/a1');
    expect(say.about!.requestId, 'r1');
    expect(say.ttl, const Duration(milliseconds: 5200));
    expect(unsaid, ['need:office:e:1']);
    // Moods map to faces as BRAIN.md draws them.
    expect(DaemonSayMood.auto.face, DaemonMood.done);
    expect(DaemonSayMood.say.face, DaemonMood.idle);
    expect(DaemonSayMood.ask.face, DaemonMood.need);
    expect(
      DaemonSay.fromJson({
        'id': 'b',
        'line': 'x',
        'about': {'machineId': 'm', 'agentId': ''},
      })!.aboutKey,
      isNull,
      reason: 'about no harness in particular',
    );
    brain.receive('daemon_brief', {
      'desk': 'd',
      'line': 'reattached. 2 done, 1 waiting 40m.',
      'items': [
        {
          'id': 'brief:office:r1:1',
          'kind': 'waiting',
          'machineId': 'office',
          'machine': 'office',
          'agentId': 'a1',
          'name': 'migration',
          'line': '[y/n/g] migration@office: Run npm run migrate? (40m)',
          'actions': [
            {'key': 'y', 'label': 'Yes', 'choice': '1. Yes'},
            {'key': 'g', 'label': 'open', 'choice': 'open'},
          ],
        },
        for (var i = 0; i < 6; i++)
          {
            'id': 'done:$i',
            'kind': 'done',
            'machineId': 'm',
            'machine': 'laptop',
            'line': 'web finished.',
          },
      ],
    });
    final brief = brain.brief!;
    expect(brief.line, startsWith('reattached.'));
    expect(brief.items, hasLength(5), reason: 'at most five');
    expect(brief.items.first.about?.key, 'office/a1');
    expect(brief.items.first.actions.map((a) => a.key), ['y', 'g']);
    expect(brief.items.last.about, isNull);
    expect(brief.keysLive(now), isTrue);
    expect(brief.keysLive(now.add(const Duration(seconds: 61))), isFalse);
  });

  test('keys first: a line is split into its keys and the rest', () {
    const y = (key: 'y', label: 'Yes', choice: '1');
    const g = (key: 'g', label: 'open', choice: 'open');
    final split = splitDaemonKeys('[y/g] api: npm test', const [y, g]);
    expect(split.keys, ['y', 'g']);
    expect(split.rest, 'api: npm test');
    // A line with answers that does not start with them gets them first.
    final put = splitDaemonKeys('api: npm test', const [g, y]);
    expect(put.keys, ['y', 'g']);
    expect(put.rest, 'api: npm test');
    final none = splitDaemonKeys('all quiet.', const []);
    expect(none.keys, isEmpty);
    expect(none.rest, 'all quiet.');
    expect(daemonKeysPrefix(const [g, y]), '[y/g] ');
  });

  test('an answer is one daemon_act; [g] comes back as a harness to open; '
      'a failed one is worded', () async {
    final errors = <String>[];
    final opens = <DaemonAbout>[];
    brain.errors.listen(errors.add);
    brain.opens.listen(opens.add);
    // Every line here was drawn a moment ago: its keys are armed.
    for (final id in ['s1', 's2', 'ask:1', 's3']) {
      brain.shown(id);
    }
    now = now.add(DaemonBrain.armAfter);
    sent.clear();
    expect(brain.act('s1', '1'), isTrue);
    final (type, payload) = sent.single;
    expect(type, 'daemon_act');
    expect(payload['id'], 's1');
    expect(payload['choice'], '1');
    final requestId = payload['requestId'] as String;
    brain.receive('daemon_act_result', {
      'requestId': 'someone-else',
      'ok': false,
      'error': 'GONE',
    });
    expect(errors, isEmpty, reason: 'not an answer this window gave');
    brain.receive('daemon_act_result', {
      'requestId': requestId,
      'id': 's1',
      'ok': false,
      'error': 'STALE_QUESTION',
      'detail': 'The dialog changed before the answer; nothing was typed.',
    });
    expect(errors, [
      'that question changed before the answer landed. nothing was typed.',
    ]);
    brain.act('s2', 'g');
    brain.receive('daemon_act_result', {
      'requestId': sent.last.$2['requestId'],
      'id': 's2',
      'ok': true,
      'open': {'machineId': 'office', 'agentId': 'a1'},
    });
    expect(opens.single.key, 'office/a1');
    brain.act('s2', 'n');
    brain.receive('daemon_act_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': false,
      'error': 'MACHINE_UNREACHABLE',
    });
    expect(errors.last, 'that machine is unreachable.');
    brain.act('ask:1', 'y');
    brain.receive('daemon_act_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': false,
      'error': 'AUTONOMY_WATCH',
    });
    expect(errors.last, contains('only watches'));
    // A code this window has no words for: harnessd's own.
    brain.act('ask:1', 'y');
    brain.receive('daemon_act_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': false,
      'error': 'SOMETHING_NEW',
      'detail': 'A newer harnessd says why.',
    });
    expect(errors.last, 'A newer harnessd says why.');
    reachable = false;
    expect(brain.act('s3', 'y'), isFalse);
    expect(errors.last, 'harnessd is not reachable.');
  });

  test('talk: daemon_talk, then started, resumed or sent; its answer comes '
      'back as a say', () {
    var changes = 0;
    brain.addListener(() => changes++);
    expect(brain.talkTo('   '), isFalse);
    expect(brain.talkTo('what needs me?'), isTrue);
    expect(sent.single.$1, 'daemon_talk');
    expect(sent.single.$2['text'], 'what needs me?');
    expect(brain.talkPhase, DaemonTalkPhase.waking);
    final requestId = sent.single.$2['requestId'];
    brain.receive('daemon_talk_result', {'requestId': 'other', 'ok': true});
    expect(brain.talkPhase, DaemonTalkPhase.waking);
    brain.receive('daemon_talk_result', {
      'requestId': requestId,
      'ok': true,
      'agentId': 'pair-1',
      'started': true,
    });
    expect(brain.talkPhase, DaemonTalkPhase.started);
    expect(brain.pairAgentId, 'pair-1');
    brain.receive('daemon_say', {
      'id': 'say:1',
      'about': {'machineId': 'm', 'agentId': ''},
      'mood': 'say',
      'line': 'api waits on you, 40m.',
      'actions': [],
      'ttlMs': 30000,
    });
    expect(brain.talkPhase, DaemonTalkPhase.idle);
    expect(brain.talk, [
      (you: true, text: 'what needs me?'),
      (you: false, text: 'api waits on you, 40m.'),
    ]);
    brain.talkTo('and office?');
    brain.receive('daemon_talk_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': true,
      'agentId': 'pair-1',
      'resumed': true,
    });
    expect(brain.talkPhase, DaemonTalkPhase.resumed);
    brain.talkTo('thanks');
    brain.receive('daemon_talk_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': false,
      'error': 'NO_ENGINE',
    });
    expect(brain.talkPhase, DaemonTalkPhase.failed);
    expect(brain.talkError, contains('Claude Code or Codex'));
    reachable = false;
    brain.talkTo('hello?');
    expect(brain.talkError, 'harnessd is not reachable.');
    expect(changes, greaterThan(4));
    for (var i = 0; i < DaemonBrain.talkKept + 10; i++) {
      brain.talkTo('$i');
    }
    expect(brain.talk, hasLength(DaemonBrain.talkKept));
  });

  test('presence: a stable desk, the pane in front (null clears it), '
      'doneSeen, and a guest names its pair and dial', () async {
    await brain.presence(active: false);
    await brain.presence(
      active: true,
      away: const Duration(minutes: 40),
      pair: 'tim',
      autonomy: 'watch',
      focusMachineId: 'm',
      focusAgentId: 'a3',
    );
    expect(sent.map((s) => s.$1), ['daemon_presence', 'daemon_presence']);
    final desk = sent[1].$2['desk'];
    expect(sent[0].$2, {
      'active': false,
      'desk': desk,
      'focusMachineId': null,
      'focusAgentId': null,
    });
    expect(sent[1].$2['awayMs'], 40 * 60 * 1000);
    expect(sent[1].$2['pair'], 'tim');
    expect(sent[1].$2['autonomy'], 'watch');
    expect(sent[1].$2['focusAgentId'], 'a3');
    await brain.focus(machineId: 'm', agentId: null);
    expect(sent.last.$2, {
      'desk': desk,
      'focusMachineId': null,
      'focusAgentId': null,
    }, reason: 'a focus change only: no active, nothing else');
    await brain.doneSeen();
    expect(sent.last.$2, {'desk': desk, 'doneSeen': true});
    await brain.guest(pair: 'vim', autonomy: 'act-on-key');
    expect(sent.last.$2, {
      'desk': desk,
      'pair': 'vim',
      'autonomy': 'act-on-key',
    });
    final again = DaemonBrain(send: (_, _) => true, storage: storage);
    addTearDown(again.dispose);
    expect(await again.desk(), desk);
  });

  test('shown, then armed: daemon_shown once, keys 450 ms later, nothing '
      'sent before', () {
    var changes = 0;
    brain.addListener(() => changes++);
    expect(brain.armed('need:1'), isFalse);
    expect(brain.act('need:1', 'y'), isFalse, reason: 'never shown');
    expect(sent, isEmpty);
    brain.shown('need:1');
    brain.shown('need:1');
    brain.shown('');
    expect(sent.map((s) => (s.$1, s.$2['id'])), [
      ('daemon_shown', 'need:1'),
    ], reason: 'once per line');
    expect(brain.wasShown('need:1'), isTrue);
    now = now.add(const Duration(milliseconds: 400));
    expect(brain.armed('need:1'), isFalse, reason: 'a margin past 400 ms');
    expect(brain.act('need:1', 'y'), isFalse);
    now = now.add(const Duration(milliseconds: 50));
    expect(brain.armed('need:1'), isTrue);
    expect(brain.act('need:1', 'y'), isTrue);
    expect(sent.last.$1, 'daemon_act');
    // harnessd did not count it (a new connection): shown again, re-armed.
    final errors = <String>[];
    brain.errors.listen(errors.add);
    brain.receive('daemon_act_result', {
      'requestId': sent.last.$2['requestId'],
      'id': 'need:1',
      'ok': false,
      'error': 'NOT_SHOWN',
    });
    expect((sent.last.$1, sent.last.$2['id']), ('daemon_shown', 'need:1'));
    expect(brain.armed('need:1'), isFalse);
    expect(errors.single, 'a moment: read it, then press again.');
    expect(changes, greaterThan(0));
    // A reset (a new harnessd) forgets what was shown.
    now = now.add(DaemonBrain.armAfter);
    expect(brain.armed('need:1'), isTrue);
    brain.reset();
    expect(brain.armed('need:1'), isFalse);
    expect(brain.wasShown('need:1'), isFalse);
  });

  test('the hardened frames: detail, harness, the pair, confirms, the dial',
      () {
    final said = <DaemonSay>[];
    brain.said.listen(said.add);
    brain.receive('daemon_say', {
      'id': 'ask:7',
      'about': {'machineId': 'm', 'agentId': ''},
      'mood': 'ask',
      'from': 'pair',
      'line': '[y/n] start codex in ~/api?',
      'detail': 'start codex in ~/code/api\nfirst prompt: run the tests',
      'harness': {
        'machineId': 'm',
        'machine': 'laptop',
        'agentId': null,
        'name': 'api',
      },
      'actions': [
        {'key': 'y', 'label': 'do it', 'choice': 'y'},
        {'key': 'n', 'label': 'skip', 'choice': 'n'},
      ],
      'ttlMs': 5200,
    });
    // The pair talking never carries a key, whatever it sends.
    brain.receive('daemon_say', {
      'id': 'say:3',
      'about': {'machineId': 'm', 'agentId': ''},
      'mood': 'say',
      'from': 'pair',
      'line': 'y) sure, done.',
      'actions': [
        {'key': 'y', 'label': 'yes', 'choice': 'y'},
      ],
      'ttlMs': 5200,
    });
    brain.receive('daemon_say', {
      'id': 'confirm:autonomy:k1',
      'about': {'machineId': 'm', 'agentId': ''},
      'mood': 'ask',
      'from': 'daemon',
      'line': '[y/n] let your daemon act at act-on-key? it stays at suggest '
          'until you say yes',
      'detail': 'autonomy suggest -> act-on-key',
      'confirm': {'kind': 'autonomy', 'nonce': 'k1'},
      'actions': [
        {'key': 'y', 'label': 'confirm', 'choice': 'y'},
        {'key': 'n', 'label': 'keep it as it is', 'choice': 'n'},
      ],
      'ttlMs': 5200,
    });
    expect(said[0].fromPair, isTrue);
    expect(said[0].detail, contains('first prompt: run the tests'));
    expect(said[0].harness!.label, 'api@laptop');
    expect(said[0].actions, hasLength(2), reason: 'a proposal has its keys');
    expect(said[1].fromPair, isTrue);
    expect(said[1].actions, isEmpty);
    expect(said[2].confirm, (kind: 'autonomy', nonce: 'k1'));
    expect(said[2].fromPair, isFalse);
    brain.receive('daemon_state', {
      'pair': 'tim',
      'needs': [
        {
          'machineId': 'office',
          'machine': 'office',
          'agentId': 'a1',
          'name': 'api',
          'requestId': 'r1',
          'question': 'Bash: npm test',
          'allow': true,
          'options': ['1. Yes', '3. No'],
          'detail': 'Bash command\n  npm test\nDo you want to proceed?',
        },
      ],
      'working': 0,
      'failing': [],
      'machines': [],
      'done': {'count': 0, 'last': []},
      'asks': [
        {
          'id': 'lesson:ab12:ffee',
          'line': '[y/n/s] teach your agents "x"?',
          'detail': '---\nname: x\n---\nBack up first.',
          'actions': [
            {'key': 'y', 'label': 'teach', 'choice': 'y'},
          ],
        },
      ],
      'acted': [],
      'autonomy': 'suggest',
      'autonomyRequested': 'act-on-key',
      'confirms': [
        {
          'id': 'confirm:autonomy:k1',
          'kind': 'autonomy',
          'nonce': 'k1',
          'line': '[y/n] let your daemon act at act-on-key?',
          'detail': 'autonomy suggest -> act-on-key',
          'actions': [
            {'key': 'y', 'label': 'confirm', 'choice': 'y'},
          ],
          'at': 1790000000000,
          'level': 'act-on-key',
        },
        {'kind': 'rules'},
      ],
    });
    final state = brain.state!;
    expect(state.needs.single.detail, contains('npm test'));
    expect(state.needs.single.allow, isTrue);
    expect(state.needs.single.options, ['1. Yes', '3. No']);
    expect(state.needs.single.who, 'api@office');
    expect(state.asks.single.isLesson, isTrue);
    expect(state.asks.single.lessonId, 'ab12');
    expect(state.asks.single.detail, contains('Back up first.'));
    expect(state.autonomy, 'suggest');
    expect(brain.autonomy, 'suggest');
    expect(state.autonomyRequested, 'act-on-key');
    expect(state.confirms.single.level, 'act-on-key');
    expect(state.confirms.single.id, 'confirm:autonomy:k1');
    expect(DaemonConfirm.idFor('rules', 'n2'), 'confirm:rules:n2');
    brain.receive('daemon_brief', {
      'line': 'x',
      'items': [
        {
          'id': 'b1',
          'kind': 'waiting',
          'line': '[y/n/g] api',
          'detail': 'the whole dialog',
        },
        {
          'id': 'lesson:ab12:ffee',
          'kind': 'lesson',
          'line': '[y/n] teach',
          'text': 'the lesson',
        },
      ],
    });
    expect(brain.brief!.items[0].shows, 'the whole dialog');
    expect(brain.brief!.items[1].shows, 'the lesson');
  });

  test('a confirmation is daemon_confirm, only once armed; its answer and '
      "a lesson key's are heard", () {
    final errors = <String>[];
    final results = <DaemonActResult>[];
    brain.errors.listen(errors.add);
    brain.results.listen(results.add);
    expect(brain.confirm('autonomy', 'k1', accept: true), isFalse);
    expect(sent, isEmpty);
    brain.shown('confirm:autonomy:k1');
    now = now.add(DaemonBrain.armAfter);
    expect(brain.confirm('autonomy', 'k1', accept: true), isTrue);
    final confirm = sent.last;
    expect(confirm.$1, 'daemon_confirm');
    expect(confirm.$2['kind'], 'autonomy');
    expect(confirm.$2['nonce'], 'k1');
    expect(confirm.$2['accept'], isTrue);
    brain.receive('daemon_confirm_result', {
      'requestId': confirm.$2['requestId'],
      'kind': 'autonomy',
      'nonce': 'k1',
      'ok': true,
      'accepted': true,
    });
    expect(results.last.ok, isTrue);
    expect(errors, isEmpty);
    brain.confirm('autonomy', 'k1', accept: false);
    brain.receive('daemon_confirm_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': false,
      'error': 'STALE_CONFIRM',
    });
    expect(errors.last, 'that request is no longer waiting.');
    // A lesson's key: learned, skipped, its text; and the person-only codes.
    brain.shown('lesson:ab12:ffee');
    now = now.add(DaemonBrain.armAfter);
    brain.act('lesson:ab12:ffee', 'y');
    brain.receive('daemon_act_result', {
      'requestId': sent.last.$2['requestId'],
      'id': 'lesson:ab12:ffee',
      'ok': true,
      'learned': 'run-migrations-safely',
    });
    expect(results.last.learned, 'run-migrations-safely');
    brain.act('lesson:ab12:ffee', 's');
    brain.receive('daemon_act_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': true,
      'lesson': 'the text',
    });
    expect(results.last.lesson, 'the text');
    for (final (code, words) in [
      ('PERSON_ONLY', 'approve it at a terminal'),
      ('INSIDE_HARNESS', 'never teaches a lesson'),
      ('GONE', 'its time ran out'),
      ('TOO_SOON', 'a moment'),
      ('NOT_ALLOW_CLASS', 'open it'),
      ('REMOTE_ANSWERS_ONLY', 'another machine'),
    ]) {
      brain.act('lesson:ab12:ffee', 'n');
      brain.receive('daemon_act_result', {
        'requestId': sent.last.$2['requestId'],
        'ok': false,
        'error': code,
        'detail': 'harnessd words',
      });
      expect(errors.last, contains(words), reason: code);
      now = now.add(DaemonBrain.armAfter);
    }
  });

  test('talk says what it costs, and waits when harnessd asks it to', () {
    brain.talkTo('hi');
    brain.receive('daemon_talk_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': true,
      'sent': true,
      'cost':
          'Each talk is a turn of your pair harness on its engine: it spends '
          'your model usage.',
    });
    expect(brain.talkCost, contains('spends your model usage'));
    expect(brain.talkWait, isNull);
    brain.talkTo('again');
    brain.receive('daemon_talk_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': false,
      'error': 'RATE_LIMITED',
      'detail': 'Six talks a minute, sixty an hour.',
      'retryAfterMs': 42000,
      'cost': 'x',
    });
    expect(brain.talkPhase, DaemonTalkPhase.failed);
    expect(brain.talkError, 'six talks a minute, sixty an hour.');
    expect(brain.talkWait, const Duration(seconds: 42));
    final before = sent.length;
    expect(brain.talkTo('please'), isFalse, reason: 'the box waits');
    expect(sent, hasLength(before));
    now = now.add(const Duration(seconds: 42));
    expect(brain.talkWait, isNull);
    expect(brain.talkTo('please'), isTrue);
  });

  test('a guest says whether the person agreed to being watched', () async {
    await brain.presence(active: true, pair: 'tim', consent: true);
    expect(sent.last.$2['consent'], isTrue);
    await brain.guest(pair: 'tim', autonomy: 'watch', consent: false);
    expect(sent.last.$2['consent'], isFalse);
    await brain.presence(active: true);
    expect(sent.last.$2.containsKey('consent'), isFalse, reason: 'signed in');
  });
}

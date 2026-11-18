// The cable link over a far end held by hand: the hello and the session, each daemon frame into the model (the C's
// fixtures in devices/harness-pro/firmware/test/test_pro_cable.c), each BarLink call into bytes, and the clocks.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/link/cable/cable_frame.dart';
import 'package:harness_max_bar/link/cable/cable_link.dart';
import 'package:harness_max_bar/model/types.dart';

import 'support/cable_fakes.dart';

const _welcome = {
  't': 'welcome',
  'machine': {'id': 'm1', 'name': 'Mac'},
  'features': ['voice.draft', 'resync', 'form', 'question.review', 'settings'],
};

class _Bar {
  _Bar({List<String>? log, RecordingModel? model}) : model = model ?? RecordingModel() {
    link = CableLink(
      this.model,
      transport: transport,
      clock: () => t,
      hostName: 'orangepi4pro',
      tickEvery: null,
      log: log?.add ?? (_) {},
    );
  }
  final RecordingModel model;
  final transport = FakeTransport();
  late final CableLink link;
  int t = 1000;

  Future<void> start() => link.start();

  /// Connected, welcomed, and everything so far forgotten.
  Future<void> session([Map<String, Object?> welcome = _welcome]) async {
    await link.start();
    transport.connect();
    transport.say(welcome);
    model.calls.clear();
    transport.clear();
  }

  void advance(int ms) {
    t += ms;
    link.tick();
  }
}

class _ThrowingModel extends RecordingModel {
  @override
  void onTurn(String agentId, String kind, String text, {int elapsedS = -1}) => throw StateError('the page broke');
}

String _rep(String unit, int times) => List.filled(times, unit).join();

bool _whole(String s) => utf8.decode(utf8.encode(s)) == s && !s.contains('�');

void main() {
  group('the hello', () {
    test('goes out as soon as the far end connects: board max, appFilter v1, no ota', () async {
      final bar = _Bar();
      await bar.start();
      expect(bar.transport.written, isEmpty);
      bar.transport.connect();
      expect(bar.transport.texts, [
        '{"t":"hello","fw":"$kBarFirmware","product":"harness","proto":3,"hw":"harness-max-flutter","board":"max",'
            '"swarms":"members-v1","recap":"long-v1","activity":"steps-v1","stats":"turn-v1","player":"library-v1",'
            '"appFilter":"v1","mac":"AE:32:4E:AD:E7:88"}',
      ]);
    });

    test('the mac is the C build\'s for the same host name', () {
      expect(macOf('orangepi4pro'), 'AE:32:4E:AD:E7:88');
      expect(macOf('orangepi4pro'), isNot(macOf('another')));
    });

    test('comes every 2 s while alone and every 15 s in a session', () async {
      final bar = _Bar();
      await bar.start();
      bar.transport.connect();
      bar.advance(1999);
      expect(bar.transport.kinds, ['hello']);
      bar.advance(1);
      expect(bar.transport.kinds, ['hello', 'hello']);
      bar.transport.say(_welcome);
      bar.transport.clear();
      // The one set while alone still goes out, as the C's hello task set it; the next waits 15 s.
      bar.advance(2000);
      expect(bar.transport.kinds, ['hello']);
      bar.transport.clear();
      for (var i = 0; i < 14; i++) {
        bar.transport.say({'t': 'ping'});
        bar.advance(1000);
      }
      expect(bar.transport.kinds.where((k) => k == 'hello'), isEmpty);
      bar.advance(1000);
      expect(bar.transport.kinds.where((k) => k == 'hello'), hasLength(1));
    });

    test('is not written with no far end', () async {
      final bar = _Bar();
      await bar.start();
      bar.advance(5000);
      expect(bar.transport.written, isEmpty);
    });
  });

  group('the session', () {
    test('a welcome brings the link up with the computer\'s name, and asks for the lists', () async {
      final bar = _Bar();
      await bar.start();
      bar.transport.connect();
      bar.transport.clear();
      bar.transport.say(_welcome);
      expect(bar.model.calls.single.name, 'link');
      expect(bar.model.calls.single.args, {'up': true, 'computer': 'Mac', 'offersNew': true});
      expect(bar.transport.kinds, ['machines.list', 'agents.list']);
      expect(bar.link.connected, isTrue);
      expect(bar.link.supports('question.review'), isTrue);
    });

    test('without the form feature New Harness is not offered; a nameless computer is "Machine"', () async {
      final bar = _Bar();
      await bar.start();
      bar.transport.connect();
      bar.transport.say({
        't': 'welcome',
        'machine': {'id': 'm9'},
        'features': ['player.library'],
      });
      expect(bar.model.calls.single.args, {'up': true, 'computer': 'Machine', 'offersNew': false});
    });

    test('features over 16, or one that is not a string, are none', () {
      expect(featuresOf({'features': List.filled(17, 'form')}), isEmpty);
      expect(
        featuresOf({
          'features': ['form', 3],
        }),
        isEmpty,
      );
      expect(featuresOf({'features': 'form'}), isEmpty);
      expect(
        featuresOf({
          'features': ['form', 'nope', 'question.review'],
        }),
        {'form', 'question.review'},
      );
    });

    test('the same computer greeting again is a keepalive; another computer is a new link', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say(_welcome);
      expect(bar.model.calls, isEmpty);
      expect(bar.transport.kinds, isEmpty);
      bar.transport.say({
        't': 'welcome',
        'machine': {'id': 'm2', 'name': 'Studio'},
      });
      expect(bar.model.calls.single.args, {'up': true, 'computer': 'Studio', 'offersNew': false});
      expect(bar.transport.kinds, ['machines.list', 'agents.list']);
    });

    test('a keepalive that stops offering New Harness says so', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({
        't': 'welcome',
        'machine': {'id': 'm1', 'name': 'Mac'},
      });
      expect(bar.model.calls.single.args, {'up': true, 'computer': 'Mac', 'offersNew': false});
    });

    test('a ping is answered even before the welcome; nothing else is heard without a session', () async {
      final bar = _Bar();
      await bar.start();
      bar.transport.connect();
      bar.transport.clear();
      bar.transport.say({'t': 'agents.begin'});
      bar.transport.say({'t': 'agent', 'id': 'a1', 'name': 'Alpha'});
      bar.transport.say({'t': 'agents.end'});
      bar.transport.say({'t': 'turn.started', 'agentId': 'a1', 'text': 'Working'});
      bar.transport.say({
        't': 'question',
        'agentId': 'a1',
        'id': 'q',
        'questions': [
          {'q': 'x'},
        ],
      });
      bar.transport.say({'t': 'focus', 'agentId': 'a1'});
      expect(bar.model.calls, isEmpty);
      expect(bar.transport.written, isEmpty);
      bar.transport.say({'t': 'ping'});
      expect(bar.transport.texts, ['{"t":"pong"}']);
      expect(bar.link.unknown, 6);
    });

    test('15 s without a frame from the daemon takes the link down', () async {
      final bar = _Bar();
      await bar.session();
      bar.advance(15000);
      expect(bar.model.calls, isEmpty);
      bar.advance(1);
      expect(bar.model.calls.single.args['up'], false);
      expect(bar.link.connected, isFalse);
      // Without a session nothing is heard again until the next welcome.
      bar.transport.say({'t': 'focus', 'agentId': 'a'});
      expect(bar.model.named('focus'), isEmpty);
    });

    test('a ping keeps the link up', () async {
      final bar = _Bar();
      await bar.session();
      for (var i = 0; i < 10; i++) {
        bar.advance(5000);
        bar.transport.say({'t': 'ping'});
      }
      expect(bar.model.named('link'), isEmpty);
    });

    test('the far end going takes the link down at once', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.close();
      expect(bar.model.calls.single.args, {'up': false, 'computer': '', 'offersNew': false});
    });

    test('a half-streamed ring does not survive the link', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({'t': 'agents.begin'});
      bar.transport.say({'t': 'agent', 'id': 'a1'});
      bar.transport.close();
      bar.transport.connect();
      bar.transport.say(_welcome);
      bar.transport.say({'t': 'agents.end'});
      expect(bar.model.named('agents'), isEmpty);
    });

    test('a seq gap asks for a snapshot, at most every 2 s', () async {
      final bar = _Bar();
      await bar.session({..._welcome, 'seq': 0});
      bar.transport.say({'t': 'ping', 'seq': 1});
      bar.advance(100);
      expect(bar.transport.kinds, ['pong']);
      bar.transport.say({'t': 'ping', 'seq': 3});
      bar.transport.clear();
      bar.advance(100);
      expect(bar.transport.kinds, ['resync']);
      expect(bar.link.seqGaps, 1);
      bar.transport.say({'t': 'ping', 'seq': 7});
      bar.transport.clear();
      bar.advance(100);
      expect(bar.transport.kinds, isEmpty);
      bar.advance(2000);
      expect(bar.transport.kinds.where((k) => k != 'hello'), ['resync']);
    });

    test('without `resync` the snapshot is asked for the old way; a daemon without seq is not checked', () async {
      final bar = _Bar();
      await bar.session({
        't': 'welcome',
        'machine': {'id': 'm1', 'name': 'Mac'},
        'seq': 0,
      });
      bar.transport.say({'t': 'ping', 'seq': 5});
      bar.transport.clear();
      bar.advance(100);
      expect(bar.transport.kinds, ['swarms.list', 'agents.list']);

      final quiet = _Bar();
      await quiet.session();
      quiet.transport.say({'t': 'ping', 'seq': 5});
      quiet.transport.say({'t': 'ping', 'seq': 9});
      quiet.transport.clear();
      quiet.advance(100);
      expect(quiet.transport.kinds, isEmpty);
    });

    test('a corrupt frame asks for a snapshot', () async {
      final bar = _Bar();
      await bar.session();
      final frame = encodeCableFrame(kCableTypeJson, utf8.encode('{"t":"ping"}'))!;
      frame[frame.length - 1] ^= 0xFF;
      bar.transport.bytes(frame);
      bar.advance(100);
      expect(bar.transport.kinds, ['resync']);
    });

    test('a frame whose tail never came is dropped after 300 ms, and the next one is heard', () async {
      final bar = _Bar();
      await bar.session();
      final frame = encodeCableFrame(kCableTypeJson, utf8.encode('{"t":"focus","agentId":"a"}'))!;
      bar.transport.bytes(frame.sublist(0, 8));
      bar.advance(299);
      expect(bar.link.decoder.pending, 8);
      bar.advance(1);
      expect(bar.link.decoder.pending, 0);
      expect(bar.link.decoder.corruptFrames, 1);
      bar.transport.bytes(frame);
      expect(bar.model.named('focus').single['id'], 'a');
    });

    test('a far end that holds the link 30 s without a session is dropped, then less and less often', () async {
      final bar = _Bar();
      await bar.start();
      bar.transport.connect();
      bar.advance(29999);
      expect(bar.transport.replugs, 0);
      bar.advance(1);
      expect(bar.transport.replugs, 1);
      bar.advance(59999);
      expect(bar.transport.replugs, 1);
      bar.advance(1);
      expect(bar.transport.replugs, 2);
      // A session resets the wait and holds it off.
      bar.transport.say(_welcome);
      for (var i = 0; i < 20; i++) {
        bar.advance(5000);
        bar.transport.say({'t': 'ping'});
      }
      expect(bar.transport.replugs, 2);
    });

    test('a model that throws on a frame does not take the link down', () async {
      final log = <String>[];
      final bar = _Bar(log: log, model: _ThrowingModel());
      await bar.session();
      bar.transport.say({'t': 'turn.done', 'agentId': 'a'});
      expect(log.last, contains('turn.done failed'));
      bar.transport.say({'t': 'focus', 'agentId': 'a'});
      expect(bar.model.calls.map((c) => c.name), ['focus']);
      expect(bar.link.connected, isTrue);
    });
  });

  group('the daemon\'s frames', () {
    test('the ring arrives whole at agents.end, with each row\'s host and caps as the C reads them', () async {
      final bar = _Bar();
      await bar.session();
      final longHost = _rep('h', 17);
      bar.transport.say({'t': 'agents.begin'});
      bar.transport.say({'t': 'agent', 'id': 'o1', 'name': 'auth', 'engine': 'claude', 'host': 'orca', 'caps': 'sv'});
      bar.transport.say({'t': 'agent', 'id': 'h1', 'host': 'harness', 'caps': 'svfa'});
      bar.transport.say({'t': 'agent', 'id': 'n1'});
      bar.transport.say({'t': 'agent', 'id': 'e1', 'host': 'vscode', 'caps': ''});
      bar.transport.say({'t': 'agent', 'id': 'l1', 'host': longHost, 'caps': 'sxvq'});
      bar.transport.say({'t': 'agent', 'id': 'x1', 'host': 7, 'caps': 5});
      bar.transport.say({
        't': 'agent',
        'id': 'm1',
        'host': '0123456789abcdef',
        'caps': '${_rep('a', 35)}${_rep('v', 16)}',
      });
      expect(bar.model.calls, isEmpty);
      bar.transport.say({'t': 'agents.end'});
      final rows = bar.model.named('agents').single['rows'] as List<AgentRow>;
      String row(AgentRow r) => '${r.id}|${r.name}|${r.engine}|${r.host}|${r.caps ?? '<null>'}';
      expect(rows.map(row), [
        'o1|auth|claude|orca|sv',
        'h1|h1||harness|svfa',
        'n1|n1|||<null>',
        'e1|e1||vscode|',
        'l1|l1|||sv',
        'x1|x1|||<null>',
        'm1|m1||0123456789abcdef|va',
      ]);
    });

    test('a repeated or over-long id is dropped, the ring holds 32, and an end with no begin is no ring', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({'t': 'agents.begin'});
      bar.transport.say({'t': 'agent', 'id': 'd0'});
      bar.transport.say({'t': 'agent', 'id': 'd0', 'name': 'again'});
      bar.transport.say({'t': 'agent', 'id': _rep('7', 48)});
      bar.transport.say({'t': 'agent', 'id': ''});
      bar.transport.say({'t': 'agent', 'name': 'no id'});
      for (var i = 1; i < 40; i++) {
        bar.transport.say({'t': 'agent', 'id': 'd$i', 'name': 'N$i'});
      }
      bar.transport.say({'t': 'agents.end'});
      final rows = bar.model.named('agents').single['rows'] as List<AgentRow>;
      expect(rows, hasLength(32));
      expect(rows.first.name, 'd0');
      expect(rows.last.id, 'd31');
      bar.model.calls.clear();
      bar.transport.say({'t': 'agents.end'});
      expect(bar.model.calls, isEmpty);
      // The next ring does not keep the last one's rows.
      bar.transport.say({'t': 'agents.begin'});
      bar.transport.say({'t': 'agent', 'id': 'o1'});
      bar.transport.say({'t': 'agents.end'});
      expect((bar.model.named('agents').single['rows'] as List<AgentRow>).map((r) => r.id), ['o1']);
    });

    test('a long name is cut on a character', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({'t': 'agents.begin'});
      bar.transport.say({'t': 'agent', 'id': 'a', 'name': _rep('é', 40), 'engine': 'claude-code-long'});
      bar.transport.say({'t': 'agents.end'});
      final row = (bar.model.named('agents').single['rows'] as List<AgentRow>).single;
      expect(utf8.encode(row.name).length, 38);
      expect(_whole(row.name), isTrue);
      expect(row.engine, 'claude-code');
    });

    test('apps: ids the bar could not send back and repeats are dropped, counts held to 0..999', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({
        't': 'apps',
        'shown': 'orca',
        'apps': [
          {'id': 'orca', 'name': 'Orca', 'count': 5, 'waiting': 1},
          {'id': 'harness', 'name': 'Harness', 'count': 3, 'waiting': 0},
          {'id': 'vscode', 'name': 'VS Code', 'count': 1, 'waiting': 0},
        ],
      });
      var call = bar.model.named('apps').single;
      String app(AppInfo a) => '${a.id}|${a.name}|${a.count}|${a.waiting}';
      expect(call['shown'], 'orca');
      expect((call['rows'] as List<AppInfo>).map(app), ['orca|Orca|5|1', 'harness|Harness|3|0', 'vscode|VS Code|1|0']);

      bar.model.calls.clear();
      bar.transport.sayRaw(
        '{"t":"apps","shown":"harness","apps":[{"name":"no id"},{"id":""},'
        '{"id":"0123456789abcdefg"},{"id":"Orca"},{"id":"or ca"},{"id":7},{"id":"harness","count":-2,"waiting":2.5},'
        '{"id":"harness","name":"again"},{"id":"0123456789abcdef","name":"${_rep('é', 40)}","count":1e9,'
        '"waiting":"4"},{"id":"terminal-app"}]}',
      );
      call = bar.model.named('apps').single;
      final rows = call['rows'] as List<AppInfo>;
      expect(call['shown'], 'harness');
      expect(rows.map((a) => '${a.id}|${a.count}|${a.waiting}'), [
        'harness|0|2',
        '0123456789abcdef|999|0',
        'terminal-app|0|0',
      ]);
      expect(rows[1].name.length, 19);
      expect(rows[0].name, '');
    });

    test('apps: past 16 the first ones; a shown that is not an id is none; no list is malformed', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({
        't': 'apps',
        'shown': '0123456789abcdefg',
        'apps': [
          for (var i = 0; i < 20; i++) {'id': 'a$i', 'count': 1},
        ],
      });
      final call = bar.model.named('apps').single;
      expect(call['shown'], '');
      expect((call['rows'] as List<AppInfo>).map((a) => a.id).last, 'a15');
      bar.model.calls.clear();
      bar.transport.say({
        'p': {'apps': []},
        't': 'apps',
      });
      expect(bar.model.named('apps').single['shown'], '');
      bar.model.calls.clear();
      final bad = bar.link.bad;
      bar.transport.say({'t': 'apps', 'shown': 'orca'});
      bar.transport.say({
        't': 'apps',
        'shown': 'orca',
        'apps': {'id': 'orca'},
      });
      expect(bar.model.calls, isEmpty);
      expect(bar.link.bad, bad + 2);
    });

    test('turn.activity: the spinner word, then the sentence with its clock, then the step', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({
        't': 'turn.activity',
        'agentId': 'a',
        'text': 'Infusing...',
        'action': 'Reading',
        'step': 'Read · x.c',
        'elapsedSeconds': 12,
      });
      expect(bar.model.calls.map((c) => '${c['kind']}|${c['text']}|${c['elapsed']}'), [
        'verb|Infusing...|-1',
        'activity|Reading|12',
        'step|Read · x.c|-1',
      ]);
      bar.model.calls.clear();
      bar.transport.say({'t': 'turn.activity', 'agentId': 'a', 'text': '', 'step': 'Bash · ls'});
      bar.transport.say({'t': 'turn.activity', 'agentId': 'a', 'text': '', 'step': ''});
      expect(bar.model.calls.map((c) => c['kind']), ['step']);
    });

    test('turn.activity: elapsedSeconds is a whole 0..2592000, else -1; alone it is an empty sentence', () async {
      final bar = _Bar();
      await bar.session();
      for (final bad in ['-1', '1.5', '2592001', '"12"', 'null', '1e999']) {
        bar.transport.sayRaw('{"t":"turn.activity","agentId":"a","action":"x","elapsedSeconds":$bad}');
      }
      expect(bar.model.calls.map((c) => c['elapsed']), List.filled(6, -1));
      bar.model.calls.clear();
      bar.transport.say({'t': 'turn.activity', 'agentId': 'a', 'elapsedSeconds': 2592000});
      bar.transport.say({'t': 'turn.activity', 'agentId': 'a', 'elapsedSeconds': 0});
      expect(bar.model.calls.map((c) => '${c['kind']}|${c['text']}|${c['elapsed']}'), [
        'activity||2592000',
        'activity||0',
      ]);
    });

    test('the rest of a turn, focus, and the enveloped form', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({'t': 'turn.started', 'agentId': 'a', 'text': 'Working'});
      bar.transport.say({'t': 'turn.started', 'agentId': 'b'});
      bar.transport.say({'t': 'turn.done', 'agentId': 'a'});
      bar.transport.say({'t': 'turn.error', 'agentId': 'a', 'message': 'boom'});
      bar.transport.say({'t': 'focus', 'agentId': 'a'});
      bar.transport.say({
        'p': {'agentId': 'c'},
        't': 'turn.done',
      });
      bar.transport.say({'t': 'turn.stats', 'agentId': 'a', 'commits': 1});
      expect(bar.model.calls.map((c) => '${c.name}|${c['id']}|${c['kind']}|${c['text']}|${c['elapsed']}'), [
        'turn|a|started|Working|0',
        'turn|b|started||0',
        'turn|a|done||0',
        'turn|a|error|boom|0',
        'focus|a|null|null|null',
        'turn|c|done||0',
      ]);
    });

    test('a frame with no agent, an empty one or one too long for an id is dropped', () async {
      final bar = _Bar();
      await bar.session();
      final bad = bar.link.bad;
      bar.transport.say({'t': 'turn.done'});
      bar.transport.say({'t': 'turn.done', 'agentId': ''});
      bar.transport.say({'t': 'turn.done', 'agentId': _rep('7', 48)});
      bar.transport.say({'t': 'turn.done', 'agentId': 5});
      expect(bar.model.calls, isEmpty);
      expect(bar.link.bad, bad + 1);
    });

    test('long words are cut on a character to the C\'s buffers', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({'t': 'turn.activity', 'agentId': 'a', 'step': 'a${_rep('é', 199)}'});
      bar.transport.say({'t': 'turn.activity', 'agentId': 'a', 'step': _rep('x', 400)});
      final ellipses = _rep('…', 300);
      bar.transport.say({'t': 'turn.activity', 'agentId': 'a', 'text': ellipses, 'action': ellipses});
      bar.transport.say({'t': 'summary', 'agentId': 'a', 'text': _rep('é', 3000)});
      bar.transport.say({'t': 'toast', 'text': _rep('é', 200)});
      final texts = [for (final c in bar.model.calls) (c['text'] as String)];
      final bytes = [for (final s in texts) utf8.encode(s).length];
      expect(bytes[0], inInclusiveRange(118, 120));
      expect(bytes[1], 120);
      expect(bytes[2], inInclusiveRange(125, 127));
      expect(bytes[3], inInclusiveRange(189, 191));
      expect(bytes[4], inInclusiveRange(2046, 2047));
      expect(bytes[5], inInclusiveRange(158, 159));
      expect(texts.every(_whole), isTrue);
    });

    test('summary: tier says how loud; a restore is never news; an older daemon\'s flags still count', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({'t': 'summary', 'agentId': 'a', 'text': 't', 'recap': 'r'});
      bar.transport.say({'t': 'summary', 'agentId': 'a', 'text': 't', 'quiet': true});
      bar.transport.say({'t': 'summary', 'agentId': 'a', 'text': 't', 'silent': true});
      bar.transport.say({'t': 'summary', 'agentId': 'a', 'text': 't', 'restore': true});
      bar.transport.say({
        't': 'summary',
        'agentId': 'a',
        'text': 't',
        'quiet': false,
        'silent': false,
        'restore': false,
      });
      bar.transport.say({'t': 'summary', 'agentId': 'a', 'text': 't', 'tier': 'alert'});
      bar.transport.say({'t': 'summary', 'agentId': 'a', 'text': 't', 'tier': 'list', 'quiet': true});
      bar.transport.say({'t': 'summary', 'agentId': 'a', 'text': 't', 'tier': 'silent', 'silent': true});
      bar.transport.say({'t': 'summary', 'agentId': 'a', 'text': 't', 'tier': 'list', 'restore': true});
      bar.transport.say({'t': 'summary', 'agentId': 'a', 'text': 't', 'tier': 'loud', 'quiet': true});
      bar.transport.say({'t': 'summary', 'agentId': 'a', 'text': 't', 'tier': 7});
      bar.transport.say({'t': 'summary', 'agentId': 'a'});
      expect(bar.model.calls.map((c) => '${c['tier']}|${c['restore']}'), [
        'SummaryTier.alert|false',
        'SummaryTier.silent|false',
        'SummaryTier.silent|false',
        'SummaryTier.silent|true',
        'SummaryTier.alert|false',
        'SummaryTier.alert|false',
        'SummaryTier.list|false',
        'SummaryTier.silent|false',
        'SummaryTier.silent|true',
        'SummaryTier.silent|false',
        'SummaryTier.alert|false',
        'SummaryTier.alert|false',
      ]);
      expect(bar.model.calls.first['recap'], 'r');
      expect(bar.model.calls.last['text'], '');
    });

    test('a question: the prompt, its items, a permission prompt, and the reviewed path from the welcome', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({
        't': 'question',
        'agentId': 'a',
        'name': 'A',
        'id': 'toolu_1',
        'questions': [
          {
            'key': 'k1',
            'q': 'Which database?',
            'options': ['Dev', 'Staging'],
          },
          {
            'key': 'k2',
            'q': 'Which checks?',
            'options': ['Lint', 'Types', 'Tests'],
            'multi': true,
            'canText': true,
          },
        ],
      });
      final call = bar.model.named('question').single;
      expect(call['id'], 'a');
      expect(call['request'], 'toolu_1');
      expect(call['text'], 'Which database?');
      expect(call['permission'], false);
      expect(call['review'], true);
      String item(AskItem i) => '${i.key}|${i.q}|${i.options.join('/')}|${i.multi}|${i.whole}';
      expect((call['items'] as List<AskItem>).map(item), [
        'k1|Which database?|Dev/Staging|false|true',
        'k2|Which checks?|Lint/Types/Tests|true|true',
      ]);

      bar.model.calls.clear();
      for (final mark in ['true', 'false', '1', '"true"']) {
        bar.transport.sayRaw(
          '{"t":"question","agentId":"a","id":"r","permission":$mark,"questions":[{"key":"k",'
          '"q":"Approve Bash command: npm run deploy:staging","options":["Yes","No"]}]}',
        );
      }
      expect(bar.model.calls.map((c) => c['permission']), [true, false, false, false]);

      // A daemon without question.review: plain answers.
      final old = _Bar();
      await old.session({
        't': 'welcome',
        'machine': {'id': 'm1', 'name': 'Mac'},
      });
      old.transport.say({
        't': 'question',
        'agentId': 'a',
        'id': 'r',
        'questions': [
          {
            'key': 'k',
            'q': 'x',
            'options': ['a'],
          },
        ],
      });
      expect(old.model.named('question').single['review'], false);
    });

    test('a question the daemon\'s inbox would not hold comes with no items', () async {
      final bar = _Bar();
      await bar.session();
      const bad = [
        '[]',
        '[{"key":"k","q":"x","options":[]}]',
        '[{"key":"k","q":"x","options":["1","2","3","4","5","6","7"]}]',
        '[{"key":"k","q":"x","options":[""]}]',
        '[{"key":"k","q":"x","options":[1]}]',
        '[{"key":"","q":"x","options":["a"]}]',
        '[{"q":"x","options":["a"]}]',
        '[{"key":"k","q":"","options":["a"]}]',
        '[{"key":"k","options":["a"]}]',
        '[{"key":"k","q":"x","options":["a"]},{"key":"k","q":"y","options":["b"]}]',
        '[{"key":"1","q":"x","options":["a"]},{"key":"2","q":"x","options":["a"]},{"key":"3","q":"x","options":["a"]},'
            '{"key":"4","q":"x","options":["a"]},{"key":"5","q":"x","options":["a"]}]',
        '["x"]',
        '{}',
      ];
      for (final q in bad) {
        bar.transport.sayRaw('{"t":"question","agentId":"a","id":"r","questions":$q}');
      }
      expect(bar.model.calls, hasLength(bad.length));
      expect(bar.model.calls.every((c) => (c['items'] as List).isEmpty), isTrue);
      expect(bar.model.calls.last['text'], 'Needs your answer');
      // No request id: not a question at all.
      bar.model.calls.clear();
      bar.transport.say({'t': 'question', 'agentId': 'a', 'questions': []});
      expect(bar.model.calls, isEmpty);
    });

    test('four questions of six options is the most; a long key is no key, long words are cut and not whole', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({
        't': 'question',
        'agentId': 'a',
        'id': 'r',
        'questions': [
          {
            'key': '1',
            'q': 'x',
            'options': ['a', 'b', 'c', 'd', 'e', 'f'],
          },
          {
            'key': '2',
            'q': 'x',
            'options': ['a'],
          },
          {
            'key': '3',
            'q': 'x',
            'options': ['a'],
          },
          {
            'key': '4',
            'q': 'x',
            'options': ['a', 'b', 'c', 'd', 'e', 'f'],
          },
        ],
      });
      final items = bar.model.named('question').single['items'] as List<AskItem>;
      expect(items, hasLength(4));
      expect(items[3].options.last, 'f');

      bar.model.calls.clear();
      bar.transport.say({
        't': 'question',
        'agentId': 'a',
        'id': 'r',
        'questions': [
          {
            'key': _rep('k', 256),
            'q': _rep('é', 300),
            'options': ['Yes', 'No'],
          },
          {
            'key': 'k',
            'q': 'x',
            'options': [_rep('é', 200)],
          },
        ],
      });
      final cut = bar.model.named('question').single['items'] as List<AskItem>;
      expect(cut[0].key, isNull);
      expect(cut[0].whole, isFalse);
      expect(utf8.encode(cut[0].q).length, lessThanOrEqualTo(239));
      expect(cut[1].key, 'k');
      expect(cut[1].whole, isFalse);
      expect(utf8.encode(cut[1].options.single).length, inInclusiveRange(94, 95));
      expect(_whole(cut[1].options.single), isTrue);

      bar.model.calls.clear();
      bar.transport.say({
        't': 'question',
        'agentId': 'a',
        'id': 'r',
        'questions': [
          {
            'key': _rep('k', 255),
            'q': 'x',
            'options': ['a'],
          },
        ],
      });
      final kept = (bar.model.named('question').single['items'] as List<AskItem>).single;
      expect(kept.key, hasLength(255));
      expect(kept.whole, isTrue);
    });

    test('question.close needs the request it closes', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({'t': 'question.close', 'agentId': 'a', 'id': 'toolu_1'});
      bar.transport.say({'t': 'question.close', 'agentId': 'b'});
      bar.transport.say({'t': 'question.close', 'agentId': 'b', 'id': ''});
      bar.transport.say({'t': 'question.close', 'agentId': 'b', 'id': _rep('r', 64)});
      expect(bar.model.calls.map((c) => '${c.name}|${c['id']}'), ['close|a']);
    });

    test('question.state: the question whole, an answer already in, the daemon\'s refusal', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.sayRaw(
        '{"t":"question.state","agentId":"a","requestId":"q7","name":"A","engine":"claude",'
        '"machine":"Mac","ok":true,"id":"toolu_1","token":"0b6f4a52-91e1-4c55-8d0e-2d0e4f8a1c3e","questions":['
        '{"key":"k1","q":"Which database?","options":["Dev","Staging"],"multi":false,"canText":false}],'
        '"submitted":false}',
      );
      var c = bar.model.named('state').single;
      expect(
        [c['id'], c['fetch'], c['ok'], c['request'], c['token'], c['submitted']],
        ['a', 'q7', true, 'toolu_1', '0b6f4a52-91e1-4c55-8d0e-2d0e4f8a1c3e', false],
      );
      expect((c['items'] as List<AskItem>).single.options, ['Dev', 'Staging']);

      bar.model.calls.clear();
      bar.transport.sayRaw(
        '{"t":"question.state","agentId":"a","requestId":"q8","ok":true,"id":"r","token":"t",'
        '"questions":[{"key":"k","q":"x","options":["a"]}],"submitted":true}',
      );
      expect(bar.model.named('state').single['submitted'], true);

      bar.model.calls.clear();
      bar.transport.sayRaw(
        '{"t":"question.state","agentId":"a","requestId":"q9","ok":false,'
        '"error":"No readable question. Check the terminal."}',
      );
      c = bar.model.named('state').single;
      expect(
        [c['ok'], c['error'], c['request'], c['token']],
        [false, 'No readable question. Check the terminal.', '', ''],
      );
    });

    test('question.state that is ok but has nothing to answer with is not ok; not a read of ours is nothing', () async {
      final bar = _Bar();
      await bar.session();
      final long = _rep('t', 64);
      final broken = [
        '"id":"r","questions":[{"key":"k","q":"x","options":["a"]}]',
        '"id":"r","token":"","questions":[{"key":"k","q":"x","options":["a"]}]',
        '"token":"t","questions":[{"key":"k","q":"x","options":["a"]}]',
        '"id":"r","token":"t","questions":[]',
        '"id":"r","token":"t"',
        '"id":"r","token":"$long","questions":[{"key":"k","q":"x","options":["a"]}]',
        '"id":"$long","token":"t","questions":[{"key":"k","q":"x","options":["a"]}]',
      ];
      for (final b in broken) {
        bar.transport.sayRaw('{"t":"question.state","agentId":"a","requestId":"q","ok":true,$b}');
      }
      expect(bar.model.calls, hasLength(broken.length));
      expect(bar.model.calls.every((c) => c['ok'] == false && c['error'] == '' && c['request'] == ''), isTrue);
      bar.model.calls.clear();
      bar.transport.sayRaw('{"t":"question.state","agentId":"a","ok":false,"error":"x"}');
      bar.transport.sayRaw('{"t":"question.state","agentId":"a","requestId":"$long","ok":false,"error":"x"}');
      bar.transport.sayRaw('{"t":"question.state","requestId":"q","ok":false,"error":"x"}');
      expect(bar.model.calls, isEmpty);
    });

    test('answer.receipt: taken, pending, refused in the daemon\'s words; not ours is nothing', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({'t': 'answer.receipt', 'agentId': 'a', 'token': 'tok', 'requestId': 'q7', 'ok': true});
      bar.transport.say({
        't': 'answer.receipt',
        'agentId': 'a',
        'token': 'tok',
        'requestId': 'q7',
        'ok': true,
        'pending': true,
      });
      bar.transport.say({
        't': 'answer.receipt',
        'agentId': 'a',
        'token': 'tok',
        'requestId': 'q7',
        'ok': false,
        'error': 'This question changed. Open it again.',
      });
      bar.transport.say({
        't': 'answer.receipt',
        'agentId': 'a',
        'token': 'tok',
        'requestId': 'q7',
        'ok': false,
        'pending': true,
      });
      expect(bar.model.calls.map((c) => '${c['fetch']}|${c['token']}|${c['ok']}|${c['pending']}|${c['error']}'), [
        'q7|tok|true|false|',
        'q7|tok|true|true|',
        'q7|tok|false|false|This question changed. Open it again.',
        'q7|tok|false|false|',
      ]);
      bar.model.calls.clear();
      final long = _rep('t', 64);
      bar.transport.say({'t': 'answer.receipt', 'agentId': 'a', 'requestId': 'q7', 'ok': true});
      bar.transport.say({'t': 'answer.receipt', 'agentId': 'a', 'token': 'tok', 'ok': true});
      bar.transport.say({'t': 'answer.receipt', 'agentId': 'a', 'token': long, 'requestId': 'q7', 'ok': true});
      bar.transport.say({'t': 'answer.receipt', 'agentId': 'a', 'token': 'tok', 'requestId': long, 'ok': true});
      expect(bar.model.calls, isEmpty);
    });

    test('toast: a line the daemon wants shown; one with no text is nothing', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({
        't': 'toast',
        'text': 'This agent is in Orca. Answering it from the device comes in an update.',
      });
      bar.transport.say({'t': 'toast'});
      expect(bar.model.calls.map((c) => c['text']), [
        'This agent is in Orca. Answering it from the device comes in an update.',
      ]);
    });

    test('what the Max does not take is counted and ignored', () async {
      final bar = _Bar();
      await bar.session();
      const round = [
        '{"t":"carry.state","agentId":"a","carryId":"c1","state":"ready"}',
        '{"t":"draft.state","agentId":"a","draftId":"d","text":"x"}',
        '{"t":"visit.state","agentId":"a","visitId":"v"}',
        '{"t":"selection.state","agentId":"a"}',
        '{"t":"metrics.state","requestId":"r"}',
        '{"t":"models","agentId":"a","items":[]}',
        '{"t":"wifi.configure","ssid":"x","password":"y"}',
        '{"t":"no.such.message"}',
        '{"t":"turn.whatever","agentId":"a"}',
      ];
      final unknown = bar.link.unknown;
      for (final r in round) {
        bar.transport.sayRaw(r);
      }
      // Known, and dropped as the Max's glue drops them.
      bar.transport.sayRaw('{"t":"swarms","items":[{"id":"s1","agents":1}]}');
      bar.transport.sayRaw('{"t":"machines.begin"}');
      bar.transport.sayRaw('{"t":"notif.replace","items":[]}');
      expect(bar.model.calls, isEmpty);
      expect(bar.transport.written, isEmpty);
      expect(bar.link.unknown, unknown + round.length);
      bar.transport.bytes(encodeCableFrame(kCableTypePcm, [1, 2, 3])!);
      bar.transport.bytes(encodeCableFrame(0x05, [1, 2, 3])!);
      expect(bar.link.unknown, unknown + round.length + 2);
    });

    test('agent.updated asks for the ring again', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.say({'t': 'agent.updated', 'agentId': 'a'});
      expect(bar.transport.texts, ['{"t":"agents.list"}']);
    });

    test('a deep frame, a non-object and a truncated one are refused before parsing', () async {
      final bar = _Bar();
      await bar.session();
      final bad = bar.link.bad;
      bar.transport.sayRaw('{"t":"x","v":${_rep('[', 40)}}');
      bar.transport.sayRaw('[1,2]');
      bar.transport.sayRaw('{"t":"turn.done"');
      bar.transport.sayRaw('{"t":"focus","agentId":"a"} x');
      bar.transport.sayRaw('{"v":1}');
      expect(bar.model.calls, isEmpty);
      expect(bar.link.bad, bad + 5);
    });
  });

  group('what the bar sends', () {
    test('agent.open and app.pick', () async {
      final bar = _Bar();
      await bar.session();
      bar.link.openAgent('a1');
      bar.link.openAgent('');
      bar.link.pickApp('orca');
      bar.link.pickApp('terminal-app');
      bar.link.pickApp('0123456789abcdef');
      for (final bad in ['', '0123456789abcdefg', 'Orca', 'or ca', 'or"ca', 'orcaé']) {
        bar.link.pickApp(bad);
      }
      expect(bar.transport.texts, [
        '{"t":"agent.open","agentId":"a1"}',
        '{"t":"app.pick","app":"orca"}',
        '{"t":"app.pick","app":"terminal-app"}',
        '{"t":"app.pick","app":"0123456789abcdef"}',
      ]);
    });

    test('answer, question.read and answer.reviewed, byte for byte as the C sends them', () async {
      final bar = _Bar();
      await bar.session();
      bar.link.questionRead('a', 'toolu_1', 'q7');
      bar.link.answerReviewed('a', 'tok', 'q8', [1, 6]);
      bar.link.answer('a', 'toolu_1', {'Which database?': 'Dev', 'k2': 'Lint, Tests'});
      expect(bar.transport.texts, [
        '{"t":"question.read","agentId":"a","requestId":"q7"}',
        '{"t":"answer.reviewed","agentId":"a","token":"tok","requestId":"q8","choices":[1,6]}',
        '{"t":"answer","agentId":"a","requestId":"toolu_1","answers":{"Which database?":"Dev","k2":"Lint, Tests"}}',
      ]);
      await pumpEventQueue();
      expect(bar.model.calls, isEmpty);
    });

    test('a malformed answer is never sent, and the model hears it was not', () async {
      final bar = _Bar();
      await bar.session();
      final long = _rep('r', 65);
      bar.link.questionRead('', 'q', 'q');
      bar.link.questionRead('a', 'q', '');
      bar.link.questionRead('a', 'q', long);
      bar.link.questionRead(_rep('a', 48), 'q', 'q');
      bar.link.answerReviewed('a', '', 'q', [1, 2]);
      bar.link.answerReviewed('a', 't', '', [1, 2]);
      bar.link.answerReviewed('a', 't', 'q', []);
      bar.link.answerReviewed('a', 't', 'q', [1, 1, 1, 1, 1]);
      bar.link.answerReviewed('a', 't', 'q', [1, 0]);
      bar.link.answerReviewed('a', 't', 'q', [64]);
      bar.link.answerReviewed('a', 't', long, [1]);
      bar.link.answer('a', 'r', {});
      bar.link.answer('a', 'r', {'': 'x'});
      bar.link.answer('a', '', {'k': 'v'});
      bar.link.answer('', 'r', {'k': 'v'});
      expect(bar.transport.written, isEmpty);
      // Told after the model's own call returns, never inside it.
      expect(bar.model.calls, isEmpty);
      await pumpEventQueue();
      expect(bar.model.named('state'), hasLength(4));
      expect(bar.model.named('state').every((c) => c['ok'] == false && c['error'] == 'Not sent'), isTrue);
      expect(bar.model.named('receipt'), hasLength(7));
      expect(bar.model.named('receipt').every((c) => c['ok'] == false && c['error'] == 'Not sent'), isTrue);
      expect(bar.model.named('toast').map((c) => c['text']), List.filled(4, 'Not sent'));
    });

    test('an answer the cable does not take is "Not sent"', () async {
      final bar = _Bar();
      await bar.session();
      bar.transport.accepting = false;
      bar.link.answerReviewed('a', 'tok', 'q8', [1]);
      await pumpEventQueue();
      final receipt = bar.model.named('receipt').single;
      expect([receipt['fetch'], receipt['token'], receipt['ok'], receipt['error']], ['q8', 'tok', false, 'Not sent']);
    });

    test('New Harness opens the computer\'s form, and a refusal is shown in the daemon\'s words', () async {
      final bar = _Bar();
      await bar.session();
      bar.link.newHarness();
      final open = bar.transport.messages.single;
      expect(open.keys, ['t', 'requestId', 'formId', 'surface', 'op', 'revision', 'delta']);
      expect(
        [open['t'], open['requestId'], open['surface'], open['op'], open['revision'], open['delta']],
        ['form', 'form-1', 'new', 'open', 0, 0],
      );
      expect(formIdOk(open['formId'] as String), isTrue);
      expect(open['formId'] as String, matches(RegExp(r'^form-[0-9a-f]{8}-[0-9a-f]{8}$')));

      // A reply to another request is not this one's.
      bar.transport.say({
        't': 'form.state',
        'requestId': 'form-9',
        'formId': open['formId'],
        'ok': false,
        'active': false,
        'error': 'Nope.',
      });
      expect(bar.model.calls, isEmpty);
      bar.transport.say({
        't': 'form.state',
        'requestId': 'form-1',
        'formId': open['formId'],
        'ok': false,
        'active': false,
        'error': 'Open Harness on this computer.',
      });
      expect(bar.model.calls.map((c) => '${c.name}|${c['text']}'), ['toast|Open Harness on this computer.']);

      // Open: the person carries on at the computer.
      bar.model.calls.clear();
      bar.link.newHarness();
      bar.transport.say({
        't': 'form.state',
        'requestId': 'form-2',
        'formId': bar.transport.messages.last['formId'],
        'ok': true,
        'active': true,
        'revision': 1,
        'position': 0,
        'total': 3,
        'busy': false,
        'enabled': true,
      });
      expect(bar.model.calls, isEmpty);
    });

    test('New Harness is not asked of a computer that does not offer it', () async {
      final bar = _Bar();
      await bar.session({
        't': 'welcome',
        'machine': {'id': 'm1', 'name': 'Mac'},
      });
      bar.link.newHarness();
      expect(bar.transport.written, isEmpty);
    });
  });
}

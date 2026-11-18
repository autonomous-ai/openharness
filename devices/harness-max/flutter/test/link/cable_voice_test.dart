// A recording over the cable, through the link's BarLink calls with a mic fed by hand: voice.begin once the mic is
// open, 1024-byte PCM frames, voice.end on send, voice.abort on a discard, the daemon's reply, and every way it ends
// early (pro_voice.c).
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/link/bar_link.dart';
import 'package:harness_max_bar/link/cable/cable_frame.dart';
import 'package:harness_max_bar/link/cable/cable_link.dart';
import 'package:harness_max_bar/link/cable/cable_voice.dart';

import 'support/cable_fakes.dart';

class _Bar {
  _Bar({bool withMic = true}) : mic = withMic ? FakeMic() : null {
    link = CableLink(model, transport: transport, mic: mic, clock: () => t, tickEvery: null, log: (_) {});
  }
  final model = RecordingModel();
  final transport = FakeTransport();
  final FakeMic? mic;
  late final CableLink link;
  int t = 1000;

  Future<void> session() async {
    await link.start();
    transport.connect();
    transport.say({
      't': 'welcome',
      'machine': {'id': 'm1', 'name': 'Mac'},
    });
    model.calls.clear();
    transport.clear();
  }

  /// Talking to [agentId], the mic open and voice.begin out.
  Future<String> recording([String agentId = 'a']) async {
    await session();
    link.startTalk(agentId);
    await pumpEventQueue();
    final begin = transport.messages.single;
    expect(begin['t'], 'voice.begin');
    model.calls.clear();
    transport.clear();
    return begin['uploadId'] as String;
  }

  void advance(int ms) {
    t += ms;
    link.tick();
  }

  /// [ms] go by with the daemon pinging every 5 s, as it does: the link stays up.
  void wait(int ms) {
    while (ms > 0) {
      final step = ms < 5000 ? ms : 5000;
      transport.say({'t': 'ping'});
      advance(step);
      ms -= step;
    }
  }

  /// The voice's own texts: the link's hellos and pongs left out.
  List<String> get said => [
    for (final text in transport.texts)
      if (!_linkKinds.contains(jsonDecode(text)['t'])) text,
  ];

  List<TalkLink> get talk => [for (final c in model.named('talk')) c['state'] as TalkLink];
  List<String> get toasts => [for (final c in model.named('toast')) c['text'] as String];

  /// What went out for the voice, in order: a JSON kind, or `pcm:<bytes>`.
  List<String> get out => [
    for (final (type, payload) in transport.frames)
      type == kCableTypeJson ? jsonDecode(utf8.decode(payload))['t'] as String : 'pcm:${payload.length}',
  ].where((k) => !_linkKinds.contains(k)).toList();
}

const _linkKinds = {'hello', 'pong'};

List<int> _bytes(int n, [int seed = 1]) => [for (var i = 0; i < n; i++) (i * 7 + seed) & 0xFF];

void main() {
  test('voice.begin goes out once the mic is open, naming the agent, the language and the rate', () async {
    final bar = _Bar();
    await bar.session();
    final opening = bar.mic!.opening = Completer<bool>();
    bar.link.startTalk('a1');
    expect(bar.model.calls, isEmpty);
    await pumpEventQueue();
    expect(bar.talk, [TalkLink.recording]);
    expect(bar.transport.written, isEmpty);
    opening.complete(true);
    await pumpEventQueue();
    final text = bar.transport.texts.single;
    final upload = jsonDecode(text)['uploadId'] as String;
    expect(upload, matches(RegExp(r'^[0-9a-f]{16}$')));
    expect(text, '{"t":"voice.begin","agentId":"a1","lang":"en","sr":16000,"uploadId":"$upload"}');
    expect(bar.link.voice.upload, upload);
  });

  test('with no agent the daemon routes the words itself', () async {
    final bar = _Bar();
    await bar.session();
    bar.link.startTalk('');
    await pumpEventQueue();
    expect(bar.transport.messages.single.keys, ['t', 'lang', 'sr', 'uploadId']);
  });

  test('each recording has its own upload id', () async {
    final bar = _Bar();
    final first = await bar.recording();
    bar.link.cancelTalk();
    await pumpEventQueue();
    bar.transport.clear();
    bar.link.startTalk('a');
    await pumpEventQueue();
    expect(bar.transport.messages.single['uploadId'], isNot(first));
  });

  test(
    'the PCM goes out in 1024-byte frames, what the mic gave before the begin too; the levels reach the model',
    () async {
      final bar = _Bar();
      await bar.session();
      final opening = bar.mic!.opening = Completer<bool>();
      bar.link.startTalk('a');
      await pumpEventQueue();
      bar.mic!.speak(_bytes(1500));
      bar.mic!.level(0.25);
      expect(bar.transport.written, isEmpty);
      opening.complete(true);
      await pumpEventQueue();
      expect(bar.out, ['voice.begin', 'pcm:1024']);
      bar.mic!.speak(_bytes(600, 3));
      bar.mic!.level(0.75);
      expect(bar.out, ['voice.begin', 'pcm:1024', 'pcm:1024']);
      expect(bar.transport.pcm.expand((b) => b).toList(), [..._bytes(1500), ..._bytes(600, 3)].sublist(0, 2048));
      expect([for (final c in bar.model.named('level')) c['level']], [0.25, 0.75]);
    },
  );

  test('send: the mic closes, the rest of the PCM and voice.end go out, and the bar waits for the reply', () async {
    final bar = _Bar();
    final upload = await bar.recording();
    bar.mic!.speak(_bytes(1100));
    bar.link.sendTalk();
    // Levels after the send are the room, not the clip.
    bar.mic!.level(1.0);
    await pumpEventQueue();
    expect(bar.talk, [TalkLink.sending]);
    expect(bar.mic!.isOpen, isFalse);
    expect(bar.out, ['pcm:1024', 'pcm:76', 'voice.end']);
    expect(bar.transport.texts.last, '{"t":"voice.end","uploadId":"$upload"}');
    expect(bar.model.named('level'), isEmpty);
    expect(bar.link.voice.open, isTrue);

    // The transcript ends it; the clip reached its agent.
    bar.transport.say({'t': 'voice.transcript', 'agentId': 'a', 'uploadId': upload, 'text': 'run the tests'});
    expect(bar.talk, [TalkLink.sending, TalkLink.idle]);
    expect(bar.link.voice.open, isFalse);
    expect(bar.toasts, isEmpty);
  });

  test('an odd byte at the end is not half a sample on the cable', () async {
    final bar = _Bar();
    await bar.recording();
    bar.mic!.speak(_bytes(3));
    bar.link.sendTalk();
    await pumpEventQueue();
    expect(bar.out, ['pcm:2', 'voice.end']);
  });

  test('a send twice is one send', () async {
    final bar = _Bar();
    await bar.recording();
    bar.link.sendTalk();
    bar.link.sendTalk();
    await pumpEventQueue();
    bar.link.sendTalk();
    await pumpEventQueue();
    expect(bar.out, ['voice.end']);
    expect(bar.talk, [TalkLink.sending]);
  });

  test('cancel: voice.abort, the mic closed, the bar idle', () async {
    final bar = _Bar();
    final upload = await bar.recording();
    bar.mic!.speak(_bytes(100));
    bar.link.cancelTalk();
    expect(bar.transport.texts, ['{"t":"voice.abort","uploadId":"$upload","why":"discarded"}']);
    await pumpEventQueue();
    expect(bar.talk, [TalkLink.idle]);
    expect(bar.mic!.isOpen, isFalse);
    // Nothing more goes out for it.
    bar.mic!.speak(_bytes(2048));
    bar.wait(kVoiceReplyMs);
    expect(bar.out, ['voice.abort']);
    bar.link.cancelTalk();
    await pumpEventQueue();
    expect(bar.talk, [TalkLink.idle]);
  });

  test('a send before the mic opened: nothing was recorded, "Not sent", and the mic does not stay open', () async {
    final bar = _Bar();
    await bar.session();
    final opening = bar.mic!.opening = Completer<bool>();
    bar.link.startTalk('a');
    await pumpEventQueue();
    bar.link.sendTalk();
    await pumpEventQueue();
    expect(bar.talk, [TalkLink.recording, TalkLink.idle]);
    expect(bar.toasts, ['Not sent']);
    opening.complete(true);
    await pumpEventQueue();
    expect(bar.mic!.isOpen, isFalse);
    expect(bar.transport.written, isEmpty);
  });

  test('a mic that does not open says so', () async {
    final bar = _Bar();
    await bar.session();
    bar.mic!.opensOk = false;
    bar.link.startTalk('a');
    await pumpEventQueue();
    expect(bar.talk, [TalkLink.recording, TalkLink.idle]);
    expect(bar.toasts, ['The microphone did not start.']);
    expect(bar.transport.written, isEmpty);
    expect(bar.link.voice.open, isFalse);
  });

  test('a mic that never answers is given up after 5 s', () async {
    final bar = _Bar();
    await bar.session();
    final opening = bar.mic!.opening = Completer<bool>();
    bar.link.startTalk('a');
    await pumpEventQueue();
    bar.advance(kVoiceStartMs);
    expect(bar.toasts, isEmpty);
    bar.advance(1);
    expect(bar.toasts, ['The microphone did not start.']);
    expect(bar.talk, [TalkLink.recording, TalkLink.idle]);
    opening.complete(true);
    await pumpEventQueue();
    expect(bar.mic!.isOpen, isFalse);
    expect(bar.out, isEmpty);
  });

  test('no talk without a computer, without a mic, or while the last message is still sending', () async {
    final alone = _Bar();
    await alone.link.start();
    alone.link.startTalk('a');
    await pumpEventQueue();
    expect(alone.toasts, ['Not connected']);
    expect(alone.talk, [TalkLink.idle]);
    expect(alone.mic!.opens, 0);

    final deaf = _Bar(withMic: false);
    await deaf.session();
    deaf.link.startTalk('a');
    deaf.link.sendTalk();
    deaf.link.cancelTalk();
    await pumpEventQueue();
    expect(deaf.toasts, ["Can't talk right now"]);
    expect(deaf.talk, [TalkLink.idle]);
    expect(deaf.transport.written, isEmpty);

    final busy = _Bar();
    await busy.recording();
    busy.link.sendTalk();
    await pumpEventQueue();
    busy.model.calls.clear();
    busy.transport.clear();
    busy.link.startTalk('b');
    await pumpEventQueue();
    expect(busy.toasts, ['Still sending the last message']);
    expect(busy.talk, [TalkLink.sending]);
    expect(busy.transport.written, isEmpty);
    expect(busy.mic!.opens, 1);
  });

  test('no reply in 65 s: dropped, the daemon told, and the person told to look at the computer', () async {
    final bar = _Bar();
    final upload = await bar.recording();
    bar.link.sendTalk();
    await pumpEventQueue();
    bar.model.calls.clear();
    bar.transport.clear();
    bar.wait(kVoiceReplyMs - 1);
    expect(bar.model.calls, isEmpty);
    bar.advance(1);
    expect(bar.said, ['{"t":"voice.abort","uploadId":"$upload","why":"discarded"}']);
    expect(bar.talk, [TalkLink.idle]);
    expect(bar.toasts, ['No response yet. Check Harness on your computer.']);
  });

  test('voice.error ends it in the daemon\'s words, or "Voice failed"', () async {
    final bar = _Bar();
    var upload = await bar.recording();
    bar.link.sendTalk();
    await pumpEventQueue();
    bar.transport.say({'t': 'voice.error', 'uploadId': upload, 'message': 'Transcription is not set up.'});
    expect(bar.talk, [TalkLink.sending, TalkLink.idle]);
    expect(bar.toasts, ['Transcription is not set up.']);

    bar.model.calls.clear();
    bar.link.startTalk('a');
    await pumpEventQueue();
    upload = bar.link.voice.upload;
    bar.transport.say({'t': 'voice.error', 'uploadId': upload});
    expect(bar.toasts, ['Voice failed']);
    expect(bar.link.voice.open, isFalse);
  });

  test('a reply naming another upload is not this recording\'s; one with no upload id is', () async {
    final bar = _Bar();
    await bar.recording();
    bar.link.sendTalk();
    await pumpEventQueue();
    bar.model.calls.clear();
    bar.transport.say({'t': 'voice.transcript', 'agentId': 'a', 'uploadId': 'ffffffffffffffff', 'text': 'x'});
    bar.transport.say({'t': 'voice.error', 'uploadId': 'ffffffffffffffff', 'message': 'x'});
    expect(bar.model.calls, isEmpty);
    expect(bar.link.voice.open, isTrue);
    bar.transport.say({'t': 'voice.transcript', 'agentId': 'a', 'text': 'x'});
    expect(bar.talk, [TalkLink.idle]);
    // With nothing in flight a reply is nothing.
    bar.transport.say({'t': 'voice.error', 'message': 'late'});
    expect(bar.toasts, isEmpty);
  });

  test('a route the daemon was unsure of is confirmed', () async {
    final bar = _Bar();
    final upload = await bar.recording();
    bar.link.sendTalk();
    await pumpEventQueue();
    bar.transport.clear();
    bar.transport.say({
      't': 'voice.transcript',
      'agentId': 'b',
      'uploadId': upload,
      'text': 'x',
      'needsConfirm': true,
      'routeId': 'route-1',
    });
    expect(bar.transport.texts, ['{"t":"voice.confirm","routeId":"route-1","agentId":"b"}']);
    expect(bar.talk.last, TalkLink.idle);
  });

  test('the link going ends the recording quietly: idle before the link is down', () async {
    final bar = _Bar();
    await bar.recording();
    bar.transport.close();
    expect(bar.model.calls.map((c) => '${c.name}:${c['state'] ?? c['up']}'), ['talk:TalkLink.idle', 'link:false']);
    await pumpEventQueue();
    expect(bar.mic!.isOpen, isFalse);
    expect(bar.link.voice.open, isFalse);
  });

  test('the daemon going quiet while a sent clip waits ends it too', () async {
    final bar = _Bar();
    await bar.recording();
    bar.link.sendTalk();
    await pumpEventQueue();
    bar.model.calls.clear();
    bar.advance(15001);
    expect(bar.model.calls.map((c) => c.name), ['talk', 'link']);
    expect(bar.talk, [TalkLink.idle]);
  });

  test('a mic that dies mid-recording: the daemon drops the clip, the person tries again', () async {
    final bar = _Bar();
    final upload = await bar.recording();
    bar.mic!.speak(_bytes(10));
    bar.mic!.die();
    expect(bar.transport.texts, ['{"t":"voice.abort","uploadId":"$upload","why":"capture or cable interrupted"}']);
    expect(bar.talk, [TalkLink.idle]);
    expect(bar.toasts, ['Recording stopped. Please try again.']);
    await pumpEventQueue();
    expect(bar.mic!.isOpen, isFalse);
  });

  test('a cable that stops taking the PCM ends the recording', () async {
    final bar = _Bar();
    await bar.recording();
    bar.transport.accepting = false;
    bar.mic!.speak(_bytes(1024));
    expect(bar.talk, [TalkLink.idle]);
    expect(bar.toasts, ['Recording stopped. Please try again.']);
    expect(bar.link.voice.open, isFalse);
  });

  test('a voice.begin the cable does not take is no recording', () async {
    final bar = _Bar();
    await bar.session();
    bar.transport.accepting = false;
    bar.link.startTalk('a');
    await pumpEventQueue();
    expect(bar.talk, [TalkLink.recording, TalkLink.idle]);
    expect(bar.toasts, ['Recording stopped. Please try again.']);
    expect(bar.mic!.isOpen, isFalse);
  });

  test('a voice.end the cable does not take is "Not sent", and nothing waits for a reply', () async {
    final bar = _Bar();
    await bar.recording();
    bar.transport.accepting = false;
    bar.link.sendTalk();
    await pumpEventQueue();
    expect(bar.talk, [TalkLink.sending, TalkLink.idle]);
    expect(bar.toasts, ['Not sent']);
    expect(bar.link.voice.open, isFalse);
  });

  test('ten minutes is the cap: the clip is sent', () async {
    final bar = _Bar();
    final upload = await bar.recording();
    bar.wait(kVoiceCapMs - 1);
    expect(bar.model.calls, isEmpty);
    bar.advance(1);
    expect(bar.talk, [TalkLink.sending]);
    await pumpEventQueue();
    expect(bar.said, ['{"t":"voice.end","uploadId":"$upload"}']);
  });

  test('the link is not re-plugged under a recording', () async {
    final bar = _Bar();
    await bar.link.start();
    bar.transport.connect();
    bar.transport.say({
      't': 'welcome',
      'machine': {'id': 'm1'},
    });
    bar.link.startTalk('a');
    await pumpEventQueue();
    // The daemon goes quiet: the session ends and with it the recording; only then may the far end be re-plugged.
    bar.advance(15001);
    expect(bar.link.voice.open, isFalse);
    bar.advance(kReplugAloneMs);
    expect(bar.transport.replugs, 1);
  });

  test('the PCM a recording sends is the mic\'s, byte for byte', () async {
    final bar = _Bar();
    await bar.recording();
    final said = _bytes(5000, 9);
    for (var i = 0; i < said.length; i += 333) {
      bar.mic!.speak(said.sublist(i, i + 333 > said.length ? said.length : i + 333));
    }
    bar.link.sendTalk();
    await pumpEventQueue();
    expect(bar.transport.pcm.map((b) => b.length), [1024, 1024, 1024, 1024, 904]);
    expect(Uint8List.fromList(bar.transport.pcm.expand((b) => b).toList()), said);
  });
}

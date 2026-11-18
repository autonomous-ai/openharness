// A recording over the cable: the Pro's voice state machine (main/audio/pro_voice.c) over its recorder (pro_recorder.c),
// on a Mic. voice.begin once the mic is open, the PCM in 1024-byte frames, voice.end on send, voice.abort on a discard,
// and the daemon's voice.transcript or voice.error ends it. The bar's talk follows it through BarModel.onTalkLink.
import 'dart:async';
import 'dart:math';
import 'dart:typed_data';

import '../../model/bar_model.dart';
import '../bar_link.dart';
import '../mic.dart';
import 'cable_json.dart';

/// One PCM frame of the recording (pro_recorder.c VOICE_CHUNK).
const int kVoiceChunk = 1024;

/// The 600 s cap, the wait for the daemon's reply to a sent clip, a mic that never opened (pro_voice.c).
const int kVoiceCapMs = 600000;
const int kVoiceReplyMs = 65000;
const int kVoiceStartMs = 5000;

/// The language the C reads from its settings when none was set: the factory default.
const String kVoiceLang = 'en';

enum _Phase {
  /// The mic is opening; voice.begin has not gone out.
  starting,

  /// voice.begin went out; the PCM streams.
  recording,

  /// Sent by the person: the mic closes and the rest of the PCM and voice.end go out.
  ending,

  /// voice.end went out; the daemon's reply is awaited.
  waiting,
}

class _Recording {
  _Recording(this.agentId, this.upload, this.startedMs);
  final String agentId, upload;
  final int startedMs;
  _Phase phase = _Phase.starting;
  bool began = false;
  int replyBy = 0;
  final BytesBuilder pcm = BytesBuilder(copy: false);
  StreamSubscription<Uint8List>? pcmSub;
  StreamSubscription<double>? levelSub;
}

class CableVoice {
  CableVoice({
    required this.model,
    required this.mic,
    required this.sendJson,
    required this.sendPcm,
    required this.now,
    Random? random,
  }) : _random = random ?? Random();

  final BarModel model;
  final Mic? mic;
  final bool Function(Map<String, Object?> message) sendJson;
  final bool Function(Uint8List pcm) sendPcm;
  final int Function() now;
  final Random _random;
  _Recording? _rec;

  /// A recording, or a sent one still waiting for its reply.
  bool get open => _rec != null;

  /// The upload id of the recording in flight ("" for none).
  String get upload => _rec?.upload ?? '';

  /// BarLink.startTalk. [linked]: a computer is on the cable.
  void start(String agentId, {required bool linked}) {
    final why = !linked
        ? 'Not connected'
        : _rec != null
        ? 'Still sending the last message'
        : this.mic == null
        ? "Can't talk right now"
        : null;
    if (why != null) {
      final state = _talkState;
      // After the model's own call returns: it may still be setting up the page this answers.
      scheduleMicrotask(() {
        model.onToast(why);
        model.onTalkLink(state);
      });
      return;
    }
    final mic = this.mic!;
    final r = _Recording(agentId, _newUpload(), now());
    _rec = r;
    scheduleMicrotask(() {
      if (_rec == r) model.onTalkLink(TalkLink.recording);
    });
    r.pcmSub = mic.pcm.listen((chunk) => _onPcm(r, chunk), onError: (Object _) => _died(r));
    r.levelSub = mic.levels.listen((level) {
      if (_rec == r && (r.phase == _Phase.starting || r.phase == _Phase.recording)) model.onLevel(level);
    });
    _open(r, mic);
  }

  /// BarLink.sendTalk: stop and send. Before the mic opened nothing was recorded: dropped, "Not sent".
  void send() {
    final r = _rec;
    if (r == null || r.phase == _Phase.ending || r.phase == _Phase.waiting) return;
    if (!r.began) {
      _discard(r, 'discarded');
      scheduleMicrotask(() {
        model.onToast('Not sent');
        model.onTalkLink(TalkLink.idle);
      });
      return;
    }
    r.phase = _Phase.ending;
    scheduleMicrotask(() {
      if (_rec == r) model.onTalkLink(TalkLink.sending);
    });
    _end(r);
  }

  /// BarLink.cancelTalk: stop, send nothing, and tell the daemon to drop what it has.
  void cancel() {
    final r = _rec;
    if (r == null) return;
    _discard(r, 'discarded');
    scheduleMicrotask(() => model.onTalkLink(TalkLink.idle));
  }

  /// The cable went: end the recording without telling the daemon, which is gone.
  void linkLost() {
    final r = _rec;
    if (r == null) return;
    _finish(r);
    model.onTalkLink(TalkLink.idle);
  }

  /// The link stops: the mic closes, the model hears nothing more.
  Future<void> dispose() async {
    final r = _rec;
    if (r != null) _finish(r);
  }

  /// The clocks (pro_voice_tick): the 600 s cap sends; a reply that never came, or a mic that never opened, drops it.
  void tick() {
    final r = _rec;
    if (r == null) return;
    final t = now();
    if (r.phase == _Phase.recording && t - r.startedMs >= kVoiceCapMs) {
      r.phase = _Phase.ending;
      model.onTalkLink(TalkLink.sending);
      _end(r);
    } else if (r.phase == _Phase.waiting && t - r.replyBy >= 0) {
      _fail(r, 'No response yet. Check Harness on your computer.', 'discarded');
    } else if (r.phase == _Phase.starting && t - r.startedMs > kVoiceStartMs) {
      _fail(r, 'The microphone did not start.', 'discarded');
    }
  }

  /// voice.transcript: the clip reached its agent. A reply naming another upload is not this recording's.
  void onTranscript(String? agentId, Map<String, Object?> p) {
    final r = _rec;
    final upload = strOf(p, 'uploadId');
    if (r == null || (upload != null && upload != r.upload)) return;
    // A route the daemon was unsure of waits for a yes; the bar has nothing to ask, so it confirms.
    final route = strOf(p, 'routeId');
    if (flagOf(p, 'needsConfirm') && route != null && agentId != null) {
      sendJson({'t': 'voice.confirm', 'routeId': route, 'agentId': agentId});
    }
    _finish(r);
    model.onTalkLink(TalkLink.idle);
  }

  /// voice.error: the daemon's words, shown.
  void onError(Map<String, Object?> p) {
    final r = _rec;
    final upload = strOf(p, 'uploadId');
    if (r == null || (upload != null && upload != r.upload)) return;
    final message = cutOf(p, 'message', 128);
    _finish(r);
    model.onTalkLink(TalkLink.idle);
    model.onToast(message != null && message.isNotEmpty ? message : 'Voice failed');
  }

  TalkLink get _talkState {
    final r = _rec;
    if (r == null) return TalkLink.idle;
    return r.phase == _Phase.ending || r.phase == _Phase.waiting ? TalkLink.sending : TalkLink.recording;
  }

  String _newUpload() {
    String hex8() => _random.nextInt(1 << 32).toRadixString(16).padLeft(8, '0');
    return '${hex8()}${hex8()}';
  }

  Future<void> _open(_Recording r, Mic mic) async {
    var ok = false;
    try {
      ok = await mic.open();
    } catch (_) {
      ok = false;
    }
    if (_rec != r) {
      // Dropped while the mic opened: it must not stay open for a recording nobody holds.
      if (ok) await _close(mic);
      return;
    }
    if (!ok) {
      _finish(r);
      model.onTalkLink(TalkLink.idle);
      model.onToast('The microphone did not start.');
      return;
    }
    r.began = sendJson({
      't': 'voice.begin',
      // Left out without an agent: the daemon then routes the words itself.
      if (r.agentId.isNotEmpty) 'agentId': r.agentId,
      'lang': kVoiceLang,
      'sr': mic.sampleRate,
      'uploadId': r.upload,
    });
    if (!r.began) {
      _fail(r, 'Recording stopped. Please try again.', null);
      return;
    }
    r.phase = _Phase.recording;
    _flush(r, all: false);
  }

  void _onPcm(_Recording r, Uint8List chunk) {
    if (_rec != r || r.phase == _Phase.waiting) return;
    r.pcm.add(chunk);
    if (r.began) _flush(r, all: false);
  }

  // Whole frames out; [all]: the end of the clip, the rest too (an even count: whole samples).
  void _flush(_Recording r, {required bool all}) {
    final bytes = r.pcm.takeBytes();
    var at = 0;
    while (bytes.length - at >= kVoiceChunk || (all && bytes.length - at >= 2)) {
      final n = bytes.length - at >= kVoiceChunk ? kVoiceChunk : (bytes.length - at) & ~1;
      if (!sendPcm(Uint8List.sublistView(bytes, at, at + n))) {
        // The cable is not taking it: the clip is broken, and the daemon is told.
        _fail(r, 'Recording stopped. Please try again.', 'capture or cable interrupted');
        return;
      }
      at += n;
    }
    if (!all && at < bytes.length) r.pcm.add(Uint8List.sublistView(bytes, at));
  }

  // The mic dies under a recording (arecord exited): as the C's dead recorder.
  void _died(_Recording r) {
    if (_rec != r || (r.phase != _Phase.starting && r.phase != _Phase.recording)) return;
    _fail(r, 'Recording stopped. Please try again.', 'capture or cable interrupted');
  }

  Future<void> _end(_Recording r) async {
    // The mic's last bytes arrive before its close returns, and go out before voice.end.
    await _close(mic!);
    if (_rec != r) return;
    await r.pcmSub?.cancel();
    await r.levelSub?.cancel();
    r.pcmSub = r.levelSub = null;
    if (_rec != r) return;
    _flush(r, all: true);
    if (_rec != r) return;
    if (!sendJson({'t': 'voice.end', 'uploadId': r.upload})) {
      _fail(r, 'Not sent', null);
      return;
    }
    r.phase = _Phase.waiting;
    r.replyBy = now() + kVoiceReplyMs;
  }

  // Ends it and says why. [why]: the voice.abort reason, or null to tell the daemon nothing.
  void _fail(_Recording r, String notice, String? why) {
    if (why != null) {
      _discard(r, why);
    } else {
      _finish(r);
    }
    model.onTalkLink(TalkLink.idle);
    model.onToast(notice);
  }

  void _discard(_Recording r, String why) {
    _finish(r);
    if (r.began) sendJson({'t': 'voice.abort', 'uploadId': r.upload, 'why': why});
  }

  void _finish(_Recording r) {
    if (_rec != r) return;
    _rec = null;
    r.pcmSub?.cancel();
    r.levelSub?.cancel();
    r.pcmSub = r.levelSub = null;
    final mic = this.mic;
    if (mic != null) _close(mic);
  }

  Future<void> _close(Mic mic) async {
    try {
      await mic.close();
    } catch (_) {
      // A mic that fails to close has nothing more to give; the recording is over either way.
    }
  }
}

// The live link: the Harness cable protocol to the computer's daemon, over USB (the board is a USB device on its
// Type-C port) or TCP port 7531 (port of devices/harness-pro/firmware/main/cable/ and the Max's linux/cable).
//
// What the Max does with each daemon frame is max_app.c's glue: pro_cable parses, pro_app_* becomes max_ui_*, which is
// BarModel's on* here; what the model sends (max_ui_take's outbox, the taps' agent.open and app.pick, the recorder) is
// the BarLink methods. Everything runs on the UI isolate: the transport's events, the frames, the model's inputs.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../bar_link.dart';
import '../mic.dart';
import 'cable_frame.dart';
import 'cable_json.dart';
import 'cable_transport.dart';
import 'cable_voice.dart';

/// mode: "usb" or "tcp".
BarLink createCableLink(BarModel model, {required String mode, Mic? mic}) =>
    CableLink(model, transport: mode == 'usb' ? UsbTransport() : TcpTransport(), mic: mic);

// ---- the vocabulary's caps, in bytes with the C's NUL (pro_app_api.h, cable_types.h) ----
const int kIdMax = 48;
const int kNameMax = 40;
const int kEngineMax = 12;
const int kAgentsMax = 32;
const int kAppsMax = 16;
const int kAppIdBytes = 17;
const int kVerbBytes = 128;
const int kActionBytes = 192;
const int kStepBytes = 121;
const int kRecapBytes = 2048;
const int kQuestionBytes = 240;
const int kToastBytes = 160;
const int kAskItems = 4;
const int kAskOptions = 6;
const int kOptionBytes = 96;
const int kKeyBytes = 256;
const int kTokenBytes = 64;

/// The hello's protocol version (pro_cable.h): 3 knows question.close.
const int kCableProto = 3;

/// The hello's fw: the app's version (pubspec.yaml).
const String kBarFirmware = '0.3.0';

// ---- session timing (pro_cable.c) ----
/// The daemon pings every 5 s while alive, so this long without a frame is a daemon gone.
const int kSilenceMs = 15000;

/// The hello often while alone; slowly once a session is up (a keepalive that also greets a daemon that restarted).
const int kHelloAloneMs = 2000;
const int kHelloSessionMs = 15000;

/// A frame whose bytes stop this long has lost its tail: dropped, and the decoder resyncs.
const int kFrameIdleMs = 300;

/// At most one snapshot request (`resync`) this often.
const int kResyncEveryMs = 2000;

/// A far end that holds the link this long without a session is stuck: it is dropped (the C's self re-plug), and the
/// wait doubles up to 10 min.
const int kReplugAloneMs = 30000;
const int kReplugMaxMs = 600000;

/// How often the link's clocks run.
const Duration kTickEvery = Duration(milliseconds: 100);

class CableLink implements BarLink {
  CableLink(
    this.model, {
    required this.transport,
    Mic? mic,
    int Function()? clock,
    Random? random,
    String? hostName,
    this.tickEvery = kTickEvery,
    this.log = _stderr,
  }) : _random = random ?? Random(),
       _clock = clock ?? _monotonic(),
       _mac = macOf(hostName ?? Platform.localHostname) {
    voice = CableVoice(
      model: model,
      mic: mic,
      sendJson: _sendJson,
      sendPcm: (pcm) => _send(kCableTypePcm, pcm),
      now: now,
      random: _random,
    );
  }

  final BarModel model;
  final CableTransport transport;

  /// How often start() runs [tick]; null: the caller ticks (the tests' clock).
  final Duration? tickEvery;
  final void Function(String line) log;
  final Random _random;
  final String _mac;
  final int Function() _clock;
  late final CableVoice voice;
  final CableDecoder decoder = CableDecoder();
  Timer? _ticker;
  bool _started = false;

  /// Messages dropped as malformed, and ignored as unknown (the C's counters).
  int bad = 0, unknown = 0;

  /// Frames the daemon's `seq` showed missing, and self re-plugs.
  int seqGaps = 0, replugs = 0;

  bool _session = false;
  Set<String> _features = const {};
  String _machineName = '', _machineId = '';
  bool _offersNew = false;
  int _lastRxMs = 0, _lastBytesMs = 0, _nextHelloMs = 0;
  int _seqLast = -1;
  bool _seqOn = false, _resyncPending = false;
  int _resyncSeen = 0, _lastResyncMs = -kResyncEveryMs;
  int _replugSince = 0, _replugWait = kReplugAloneMs;
  final List<AgentRow> _rows = [];
  bool _building = false;
  int _formSerial = 0;
  String? _formRequest;

  /// Monotonic milliseconds.
  int now() => _clock();

  /// A welcome arrived and the daemon has not gone quiet.
  bool get connected => _session;

  /// The welcome named this feature ("form", "question.review", "resync", "player.library").
  bool supports(String feature) => _session && _features.contains(feature);

  // ---- BarLink ----

  @override
  Future<void> start() async {
    if (_started) return;
    _started = true;
    _replugSince = _lastBytesMs = now();
    await transport.start(onConnected: _connected, onBytes: onBytes, onClosed: _closed);
    final every = tickEvery;
    if (every != null) _ticker = Timer.periodic(every, (_) => tick());
  }

  @override
  Future<void> stop() async {
    _ticker?.cancel();
    _ticker = null;
    _started = false;
    _session = false;
    await voice.dispose();
    await transport.stop();
  }

  @override
  void openAgent(String agentId) {
    if (agentId.isEmpty) return;
    _sendJson({'t': 'agent.open', 'agentId': agentId});
  }

  @override
  void pickApp(String appId) {
    if (!appIdOk(appId)) return;
    _sendJson({'t': 'app.pick', 'app': appId});
  }

  @override
  void answer(String agentId, String requestId, Map<String, String> answers) {
    final ok =
        _agentOk(agentId) &&
        tokenFits(requestId) &&
        answers.isNotEmpty &&
        answers.length <= kAskItems &&
        answers.keys.every((k) => k.isNotEmpty) &&
        _sendJson({'t': 'answer', 'agentId': agentId, 'requestId': requestId, 'answers': answers});
    // Nothing went: the person may send the same again (max_ask_unsent's "Not sent").
    if (!ok) scheduleMicrotask(() => model.onToast('Not sent'));
  }

  @override
  void questionRead(String agentId, String requestId, String fetch) {
    // The read is named by `fetch`, which question.state echoes as its requestId (pro_cable_question_read).
    final ok =
        _agentOk(agentId) &&
        tokenFits(fetch) &&
        _sendJson({'t': 'question.read', 'agentId': agentId, 'requestId': fetch});
    if (!ok) scheduleMicrotask(() => model.onQuestionState(agentId, fetch, ok: false, error: 'Not sent'));
  }

  @override
  void answerReviewed(String agentId, String token, String fetch, List<int> choices) {
    // Every question answered, by its options: a mask of at least one of six bits each.
    final ok =
        _agentOk(agentId) &&
        tokenFits(token) &&
        tokenFits(fetch) &&
        choices.isNotEmpty &&
        choices.length <= kAskItems &&
        choices.every((c) => c > 0 && c < (1 << kAskOptions)) &&
        _sendJson({'t': 'answer.reviewed', 'agentId': agentId, 'token': token, 'requestId': fetch, 'choices': choices});
    if (!ok) {
      scheduleMicrotask(() => model.onAnswerReceipt(agentId, fetch, ok: false, token: token, error: 'Not sent'));
    }
  }

  @override
  void startTalk(String agentId) => voice.start(agentId, linked: _session);

  @override
  void sendTalk() => voice.send();

  @override
  void cancelTalk() => voice.cancel();

  /// New Harness opens the computer's own form (max_ui_form_open), under a name of its own: the person fills it there.
  @override
  void newHarness() {
    if (!supports('form')) return;
    String hex8(int v) => (v & 0xFFFFFFFF).toRadixString(16).padLeft(8, '0');
    final formId = 'form-${hex8(_random.nextInt(1 << 32))}-${hex8(now())}';
    final request = 'form-${++_formSerial}';
    _formRequest = request;
    final ok = _sendJson({
      't': 'form',
      'requestId': request,
      'formId': formId,
      'surface': 'new',
      'op': 'open',
      'revision': 0,
      'delta': 0,
    });
    if (!ok) scheduleMicrotask(() => model.onToast('Not sent'));
  }

  // ---- the transport ----

  void _connected() {
    decoder.reset();
    _lastBytesMs = _replugSince = now();
    _nextHelloMs = now();
    _hello();
  }

  void _closed(String why) {
    decoder.reset();
    _sessionDown(why);
  }

  /// Bytes from the far end (the transport's, and the tests').
  void onBytes(Uint8List data) {
    // A partial frame from before a gap is stale even when the gap ends with this read.
    if (decoder.pending > 0 && now() - _lastBytesMs >= kFrameIdleMs) decoder.expire(_onFrame);
    decoder.feed(data, _onFrame);
    _lastBytesMs = now();
  }

  /// The clocks, about ten times a second: a stale partial frame, a resync, a stuck far end, the daemon's silence, the
  /// hello's cadence and the recording's own.
  void tick() {
    final t = now();
    if (decoder.pending > 0 && t - _lastBytesMs >= kFrameIdleMs) {
      decoder.expire(_onFrame);
      _lastBytesMs = t;
    }
    _resync(t);
    _replugTick(t);
    if (_session && t - _lastRxMs > kSilenceMs) _sessionDown('silence');
    if (transport.connected && t - _nextHelloMs >= 0) _hello();
    voice.tick();
  }

  void _hello() {
    _sendJson(helloMessage(_mac));
    _nextHelloMs = now() + (_session ? kHelloSessionMs : kHelloAloneMs);
  }

  bool _send(int type, Uint8List payload) {
    final frame = encodeCableFrame(type, payload);
    if (frame == null) {
      log('refusing to send a ${payload.length}-byte payload (max $kCableMaxPayload)');
      return false;
    }
    return transport.write(frame);
  }

  bool _sendJson(Map<String, Object?> message) => _send(kCableTypeJson, utf8.encode(jsonEncode(message)));

  // ---- frames in ----

  void _onFrame(int version, int type, Uint8List payload) {
    // PCM travels the other way; firmware slices are never taken by this bar.
    if (type != kCableTypeJson) {
      unknown++;
      return;
    }
    final root = decodeCableJson(payload);
    if (root == null) {
      bad++;
      log('frame did not parse: ${payload.length} B');
      return;
    }
    _lastRxMs = now();
    final kind = strOf(root, 't');
    _trackSeq(root, kind == 'welcome');
    try {
      _handle(root, kind);
    } catch (e) {
      // A model that throws on one frame must not take the link down with it.
      log('$kind failed: $e');
    }
  }

  void _handle(Map<String, Object?> root, String? t) {
    if (t == null) {
      bad++;
      return;
    }
    final p = payloadOf(root);
    if (t == 'welcome') return _sessionUp(p);
    if (t == 'ping') {
      _sendJson({'t': 'pong'});
      return;
    }
    // Everything else belongs to a session: a stray frame must not build a ring on a bar that says "Not connected".
    if (!_session) {
      unknown++;
      return;
    }
    switch (t) {
      case 'agents.begin':
        _rows.clear();
        _building = true;
        return;
      case 'agent':
        return _agent(p);
      case 'agents.end':
        return _agentsEnd();
      case 'apps':
        return _apps(p);
      case 'agent.updated':
        // The cheapest correct answer: ask again.
        _sendJson({'t': 'agents.list'});
        return;
      case 'form.state':
        return _formState(p);
      case 'toast':
        final text = cutOf(p, 'text', kToastBytes);
        if (text != null) model.onToast(text);
        return;
      // The Max has no machines, tabs, library, notices list or turn stats (max_app.c drops them).
      case 'machines.begin' || 'machine' || 'machines.end' || 'machine.updated' || 'swarms' || 'player.library':
      case 'player.context' || 'notif.replace' || 'notif.seen':
        return;
    }
    final agentId = strOf(p, 'agentId');
    // An oversized id must not become another agent through a cut.
    if (agentId != null && utf8Bytes(agentId) >= kIdMax) {
      bad++;
      return;
    }
    if (t == 'voice.transcript') return voice.onTranscript(agentId, p);
    if (t == 'voice.error') return voice.onError(p);
    if (agentId != null && agentId.isNotEmpty && _agentFrame(t, agentId, p)) return;
    unknown++;
  }

  // The frames about one agent; false for a kind this bar does not take.
  bool _agentFrame(String t, String id, Map<String, Object?> p) {
    switch (t) {
      case 'focus':
        model.onFocus(id);
      case 'turn.started':
        model.onTurn(id, 'started', cutOf(p, 'text', kVerbBytes) ?? '', elapsedS: 0);
      case 'turn.activity':
        _activity(id, p);
      case 'turn.done':
        model.onTurn(id, 'done', '', elapsedS: 0);
      case 'turn.error':
        model.onTurn(id, 'error', cutOf(p, 'message', kRecapBytes) ?? '', elapsedS: 0);
      case 'turn.stats':
        break;
      case 'summary':
        model.onSummary(
          id,
          cutOf(p, 'text', kRecapBytes) ?? '',
          recap: cutOf(p, 'recap', kRecapBytes) ?? '',
          restore: flagOf(p, 'restore'),
          tier: tierOf(p),
        );
      case 'question':
        _question(id, p);
      case 'question.close':
        final request = strOf(p, 'id');
        if (request != null && request.isNotEmpty && utf8Bytes(request) < kTokenBytes) model.onQuestionClose(id);
      case 'question.state':
        _questionState(id, p);
      case 'answer.receipt':
        _answerReceipt(id, p);
      default:
        return false;
    }
    return true;
  }

  // In this order: the spinner word, the progress sentence (with the clock), then the step.
  void _activity(String id, Map<String, Object?> p) {
    final verb = cutOf(p, 'text', kVerbBytes);
    if (verb != null && verb.isNotEmpty) model.onTurn(id, 'verb', verb);
    final action = cutOf(p, 'action', kActionBytes);
    final elapsed = elapsedOf(p);
    if (action != null || elapsed >= 0) model.onTurn(id, 'activity', action ?? '', elapsedS: elapsed);
    final step = cutOf(p, 'step', kStepBytes);
    if (step != null && step.isNotEmpty) model.onTurn(id, 'step', step);
  }

  // One row of the ring. Ids are routing targets: a cut or a repeated one would point a name at another agent.
  void _agent(Map<String, Object?> p) {
    final id = strOf(p, 'id');
    if (!_building || id == null || id.isEmpty || utf8Bytes(id) >= kIdMax || _rows.length >= kAgentsMax) return;
    if (_rows.any((r) => r.id == id)) return;
    final name = strOf(p, 'name');
    final engine = strOf(p, 'engine');
    // The agent's nearest app: one too long to be an app id is none, never cut into another.
    final host = strOf(p, 'host');
    final caps = strOf(p, 'caps');
    _rows.add(
      AgentRow(
        id: id,
        name: cutUtf8(name != null && name.isNotEmpty ? name : id, kNameMax),
        engine: engine == null ? '' : cutUtf8(engine, kEngineMax),
        host: host != null && utf8Bytes(host) < kAppIdBytes ? host : '',
        // The letters it grants, read whole: a long string never grants more by being cut.
        caps: caps == null ? null : 'svfa'.split('').where(caps.contains).join(),
      ),
    );
  }

  void _agentsEnd() {
    if (!_building) return;
    _building = false;
    model.onAgents(List.of(_rows));
  }

  // apps {shown, apps:[{id, name, count, waiting}]}: an id the bar could not send back, or a second one, is dropped.
  void _apps(Map<String, Object?> p) {
    final list = p['apps'];
    if (list is! List) {
      bad++;
      return;
    }
    final rows = <AppInfo>[];
    for (final it in list) {
      if (rows.length >= kAppsMax) break;
      final id = strOf(it, 'id');
      if (id == null || !appIdOk(id) || rows.any((r) => r.id == id)) continue;
      rows.add(
        AppInfo(
          id: id,
          name: cutUtf8(strOf(it, 'name') ?? '', kNameMax),
          count: appCountOf(it, 'count'),
          waiting: appCountOf(it, 'waiting'),
        ),
      );
    }
    final shown = strOf(p, 'shown');
    model.onApps(shown != null && appIdOk(shown) ? shown : '', rows);
  }

  // question {agentId, id, questions:[{key, q, options, multi}], permission}: the prompt, then the whole request.
  void _question(String id, Map<String, Object?> p) {
    final request = strOf(p, 'id');
    if (request == null) return;
    final questions = p['questions'];
    final first = questions is List && questions.isNotEmpty ? questions.first : null;
    final prompt = strOf(first, 'q');
    model.onQuestion(
      id,
      request,
      cutUtf8(prompt ?? 'Needs your answer', kQuestionBytes),
      items: readAskItems(questions),
      permission: flagOf(p, 'permission'),
      review: supports('question.review'),
    );
  }

  // question.state: the reply to questionRead, named by the read's own id.
  void _questionState(String id, Map<String, Object?> p) {
    final fetch = strOf(p, 'requestId');
    if (fetch == null || !tokenFits(fetch)) return;
    if (!flagOf(p, 'ok')) {
      model.onQuestionState(id, fetch, ok: false, error: cutOf(p, 'error', kVerbBytes) ?? '');
      return;
    }
    final request = strOf(p, 'id'), token = strOf(p, 'token');
    final items = readAskItems(p['questions']);
    if (request != null && token != null && tokenFits(request) && tokenFits(token) && items.isNotEmpty) {
      model.onQuestionState(
        id,
        fetch,
        ok: true,
        requestId: request,
        token: token,
        submitted: flagOf(p, 'submitted'),
        items: items,
      );
    } else {
      // Nothing to answer with.
      model.onQuestionState(id, fetch, ok: false);
    }
  }

  void _answerReceipt(String id, Map<String, Object?> p) {
    final fetch = strOf(p, 'requestId'), token = strOf(p, 'token');
    if (fetch == null || token == null || !tokenFits(fetch) || !tokenFits(token)) return;
    final ok = flagOf(p, 'ok');
    model.onAnswerReceipt(
      id,
      fetch,
      ok: ok,
      token: token,
      pending: ok && flagOf(p, 'pending'),
      error: ok ? '' : cutOf(p, 'error', kVerbBytes) ?? '',
    );
  }

  // form.state: only the reply to this bar's latest open; a refusal is shown in the daemon's words.
  void _formState(Map<String, Object?> p) {
    final request = strOf(p, 'requestId'), formId = strOf(p, 'formId');
    if (request == null || formId == null || !tokenFits(request) || !formIdOk(formId) || request != _formRequest) {
      return;
    }
    _formRequest = null;
    if (flagOf(p, 'ok')) return;
    final error = cutOf(p, 'error', kToastBytes);
    if (error != null && error.isNotEmpty) model.onToast(error);
  }

  // ---- the session ----

  void _sessionUp(Map<String, Object?> p) {
    _features = featuresOf(p);
    final machine = p['machine'];
    _machineName = cutUtf8(strOf(machine, 'name') ?? 'Machine', kNameMax);
    // The cabled computer's identity: a welcome that names another one is a changed host on a live link.
    final previous = _machineId;
    final mid = strOf(machine, 'id');
    _machineId = mid == null ? '' : cutUtf8(mid, kIdMax);
    final was = _session;
    final moved = was && previous != _machineId;
    _session = true;
    final offersNew = _features.contains('form');
    if (!was) {
      log('session up: $_machineName');
      if (replugs > 0) log('came back after $replugs re-plug(s)');
      replugs = 0;
    }
    if (was && !moved) {
      // The same computer greeting again: only what the bar shows of it may have changed.
      if (offersNew != _offersNew) {
        _offersNew = offersNew;
        model.onLink(true, computer: _machineName, offersNew: offersNew);
      }
      return;
    }
    // Anything held belonged to another host: a half-streamed ring must not become current.
    _building = false;
    _rows.clear();
    _formRequest = null;
    _offersNew = offersNew;
    model.onLink(true, computer: _machineName, offersNew: offersNew);
    // Asked for explicitly: a bar that greets with the same mac and version reads as a keepalive and gets nothing.
    _sendJson({'t': 'machines.list'});
    _sendJson({'t': 'agents.list'});
  }

  void _sessionDown(String why) {
    if (!_session) return;
    _session = false;
    _features = const {};
    _building = false;
    _rows.clear();
    _formRequest = null;
    _machineName = _machineId = '';
    _offersNew = false;
    _seqLast = -1;
    _seqOn = false;
    _resyncPending = false;
    decoder.reset();
    log('session down ($why)');
    // The recording first: the cable is dead, so it ends without a word to the daemon.
    voice.linkLost();
    model.onLink(false);
  }

  // A `seq` that does not follow the last one means frames in between never arrived: count it and ask for a snapshot.
  void _trackSeq(Map<String, Object?> root, bool welcome) {
    final v = numOf(root, 'seq');
    final ok = v != null && v >= 0 && v < 4294967296;
    if (welcome) _seqOn = ok;
    if (!_seqOn || !ok) return;
    final seq = v.toInt();
    if (!welcome && _seqLast >= 0 && seq != _seqLast + 1) {
      seqGaps++;
      _resyncPending = true;
    }
    _seqLast = seq;
  }

  // A frame lost on the way in (a bad CRC or a seq gap) may have been a ring push: the whole snapshot, at most every 2 s.
  void _resync(int t) {
    if (!_session || (decoder.corruptFrames == _resyncSeen && !_resyncPending)) return;
    if (t - _lastResyncMs < kResyncEveryMs) return;
    _resyncSeen = decoder.corruptFrames;
    _resyncPending = false;
    _lastResyncMs = t;
    if (_features.contains('resync')) {
      _sendJson({'t': 'resync'});
    } else {
      _sendJson({'t': 'swarms.list'});
      _sendJson({'t': 'agents.list'});
    }
  }

  // A far end that holds the link without a session for long is stuck: drop it so it starts over. Never mid-recording,
  // nor with a frame half in (a link alive mid-message).
  void _replugTick(int t) {
    if (_session) _replugWait = kReplugAloneMs;
    if (_session || !transport.connected || voice.open) {
      _replugSince = t;
      return;
    }
    if (t - _replugSince < _replugWait || decoder.pending > 0) return;
    replugs++;
    log('no session for ${(t - _replugSince) ~/ 1000} s with the far end there: re-plug #$replugs');
    _replugSince = t;
    _replugWait = _replugWait < kReplugMaxMs ~/ 2 ? _replugWait * 2 : kReplugMaxMs;
    decoder.reset();
    transport.replug();
  }

  bool _agentOk(String id) => id.isNotEmpty && utf8Bytes(id) < kIdMax;
}

void _stderr(String line) => stderr.writeln('cable: $line');

int Function() _monotonic() {
  final watch = Stopwatch()..start();
  return () => watch.elapsedMilliseconds;
}

// ---- the parts of the vocabulary with rules of their own (pro_cable.c) ----

/// The hello as the Max says it (pro_cable.c send_hello, board "max"): the Pro's capabilities, and appFilter v1, which
/// the daemon answers with `apps` and one app's ring. No `ota`: the daemon has no image for this bar and must never
/// offer one. No `settings`: the bar keeps none.
Map<String, Object?> helloMessage(String mac) => {
  't': 'hello',
  'fw': kBarFirmware,
  'product': 'harness',
  'proto': kCableProto,
  'hw': 'harness-max-flutter',
  'board': 'max',
  'swarms': 'members-v1',
  'recap': 'long-v1',
  'activity': 'steps-v1',
  'stats': 'turn-v1',
  'player': 'library-v1',
  'appFilter': 'v1',
  'mac': mac,
};

/// The bar's mac as the Linux build makes one (esp.c esp_read_mac): FNV-1a of the host name over 48 bits, locally
/// administered. The daemon tells devices apart by it, and the board keeps it across boots.
String macOf(String host) {
  // The C's offset, digit for digit (1469598103934665603), so this bar keeps the C build's mac on the same board.
  var h = 1469598103934665603;
  for (final c in utf8.encode(host)) {
    h = (h ^ c) * 0x100000001b3;
  }
  final bytes = [for (var i = 0; i < 6; i++) (h >> (8 * i)) & 0xFF];
  bytes[0] = (bytes[0] & 0xFC) | 0x02;
  return bytes.map((b) => b.toRadixString(16).toUpperCase().padLeft(2, '0')).join(':');
}

/// welcome.features as the C reads them: unknown names ignored; more than 16 entries, or one that is not a string,
/// makes the whole list none.
Set<String> featuresOf(Map<String, Object?> welcome) {
  final list = welcome['features'];
  if (list is! List || list.length > 16 || list.any((f) => f is! String)) return const {};
  const known = {'player.library', 'resync', 'form', 'question.review'};
  return {
    for (final f in list)
      if (known.contains(f)) f as String,
  };
}

/// An app id the daemon takes back in app.pick: 1..16 of [a-z0-9-].
bool appIdOk(String id) => id.isNotEmpty && id.length < kAppIdBytes && RegExp(r'^[a-z0-9-]+$').hasMatch(id);

/// A request id or a token: 1..63 bytes (the daemon refuses a requestId over 64).
bool tokenFits(String s) => s.isNotEmpty && utf8Bytes(s) < kTokenBytes;

/// The daemon's formId: [A-Za-z0-9-]{1,48}.
bool formIdOk(String id) => RegExp(r'^[A-Za-z0-9-]{1,48}$').hasMatch(id);

/// A count as the bar holds it: a number, 0..999 (a fraction is cut); anything else is 0.
int appCountOf(Object? o, String key) {
  final v = numOf(o, key);
  if (v == null || !(v > 0)) return 0;
  return v > 999 ? 999 : v.toInt();
}

/// elapsedSeconds: a whole 0..2592000; anything else is -1 (the model keeps its own clock).
int elapsedOf(Map<String, Object?> p) {
  final v = numOf(p, 'elapsedSeconds');
  if (v == null || v < 0 || v > 2592000 || v != v.truncate()) return -1;
  return v.toInt();
}

/// How loud a finished turn is. A restore is history filled back in, never news. No tier (an older daemon): quiet and
/// silent are silent, anything else an alert.
SummaryTier tierOf(Map<String, Object?> p) {
  if (flagOf(p, 'restore')) return SummaryTier.silent;
  switch (strOf(p, 'tier')) {
    case 'alert':
      return SummaryTier.alert;
    case 'list':
      return SummaryTier.list;
    case 'silent':
      return SummaryTier.silent;
  }
  return flagOf(p, 'quiet') || flagOf(p, 'silent') ? SummaryTier.silent : SummaryTier.alert;
}

/// `questions` as the daemon's inbox takes them: 1..4, each with a key, a prompt and 1..6 non-empty options, the keys
/// unique. Anything else is a request whose answer cannot be checked against what was asked: no items.
List<AskItem> readAskItems(Object? questions) {
  if (questions is! List || questions.isEmpty || questions.length > kAskItems) return const [];
  final items = <AskItem>[];
  final keys = <String>{};
  for (final it in questions) {
    final key = strOf(it, 'key'), q = strOf(it, 'q');
    final options = it is Map ? it['options'] : null;
    if (key == null || key.isEmpty || q == null || q.isEmpty || options is! List) return const [];
    if (options.isEmpty || options.length > kAskOptions || !keys.add(key)) return const [];
    if (options.any((o) => o is! String || o.isEmpty)) return const [];
    // A cut key or option would answer something nobody was asked: only a whole one can be echoed back.
    final keyWhole = utf8Bytes(key) < kKeyBytes;
    final words = options.cast<String>();
    items.add(
      AskItem(
        key: keyWhole ? key : null,
        q: cutUtf8(q, kQuestionBytes),
        options: [for (final o in words) cutUtf8(o, kOptionBytes)],
        multi: flagOf(it, 'multi'),
        whole: keyWhole && words.every((o) => utf8Bytes(o) < kOptionBytes),
      ),
    );
  }
  return items;
}

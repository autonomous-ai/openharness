// What the link tests stand in for: a BarModel that records its inputs, a far end that records the frames written to
// it, and a mic fed by hand.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:harness_max_bar/link/bar_link.dart';
import 'package:harness_max_bar/link/cable/cable_frame.dart';
import 'package:harness_max_bar/link/cable/cable_transport.dart';
import 'package:harness_max_bar/link/mic.dart';
import 'package:harness_max_bar/model/bar_model.dart';
import 'package:harness_max_bar/model/types.dart';

/// One model input: its name and its arguments.
class Call {
  Call(this.name, this.args);
  final String name;
  final Map<String, Object?> args;
  Object? operator [](String key) => args[key];
  @override
  String toString() => '$name $args';
}

/// The model's inputs, in order, as calls; nothing else of the model runs.
class RecordingModel extends BarModel {
  final List<Call> calls = [];
  final _calls = StreamController<Call>.broadcast(sync: true);

  List<Call> named(String name) => calls.where((c) => c.name == name).toList();

  /// The next call of [name] (one already recorded counts), within a bound.
  Future<Call> next(String name, {Duration within = const Duration(seconds: 5)}) {
    final have = named(name);
    if (have.isNotEmpty) return Future.value(have.first);
    return _calls.stream.firstWhere((c) => c.name == name).timeout(within);
  }

  void _add(String name, Map<String, Object?> args) {
    final call = Call(name, args);
    calls.add(call);
    _calls.add(call);
  }

  @override
  void onLink(bool up, {String computer = '', bool offersNew = false}) =>
      _add('link', {'up': up, 'computer': computer, 'offersNew': offersNew});
  @override
  void onAgents(List<AgentRow> rows) => _add('agents', {'rows': rows});
  @override
  void onApps(String shown, List<AppInfo> rows) => _add('apps', {'shown': shown, 'rows': rows});
  @override
  void onTurn(String agentId, String kind, String text, {int elapsedS = -1}) =>
      _add('turn', {'id': agentId, 'kind': kind, 'text': text, 'elapsed': elapsedS});
  @override
  void onSummary(
    String agentId,
    String text, {
    String recap = '',
    bool restore = false,
    SummaryTier tier = SummaryTier.alert,
  }) => _add('summary', {'id': agentId, 'text': text, 'recap': recap, 'restore': restore, 'tier': tier});
  @override
  void onQuestion(
    String agentId,
    String requestId,
    String text, {
    List<AskItem> items = const [],
    bool permission = false,
    bool review = false,
  }) => _add('question', {
    'id': agentId,
    'request': requestId,
    'text': text,
    'items': items,
    'permission': permission,
    'review': review,
  });
  @override
  void onQuestionClose(String agentId) => _add('close', {'id': agentId});
  @override
  void onQuestionState(
    String agentId,
    String fetch, {
    required bool ok,
    String requestId = '',
    String token = '',
    bool submitted = false,
    String error = '',
    List<AskItem> items = const [],
  }) => _add('state', {
    'id': agentId,
    'fetch': fetch,
    'ok': ok,
    'request': requestId,
    'token': token,
    'submitted': submitted,
    'error': error,
    'items': items,
  });
  @override
  void onAnswerReceipt(
    String agentId,
    String fetch, {
    required bool ok,
    String token = '',
    bool pending = false,
    String error = '',
  }) => _add('receipt', {'id': agentId, 'fetch': fetch, 'ok': ok, 'token': token, 'pending': pending, 'error': error});
  @override
  void onFocus(String agentId) => _add('focus', {'id': agentId});
  @override
  void onToast(String text) => _add('toast', {'text': text});
  @override
  void onTalkLink(TalkLink state) => _add('talk', {'state': state});
  @override
  void onLevel(double level) => _add('level', {'level': level});
}

/// The far end, by hand: connect it, feed it the daemon's frames, read what the bar wrote.
class FakeTransport implements CableTransport {
  void Function()? _onConnected;
  void Function(Uint8List bytes)? _onBytes;
  void Function(String why)? _onClosed;
  final List<Uint8List> written = [];
  bool _connected = false;
  int replugs = 0;

  /// False: writes are refused, as by a far end that stopped reading.
  bool accepting = true;

  @override
  Future<void> start({
    required void Function() onConnected,
    required void Function(Uint8List bytes) onBytes,
    required void Function(String why) onClosed,
  }) async {
    _onConnected = onConnected;
    _onBytes = onBytes;
    _onClosed = onClosed;
  }

  void connect() {
    _connected = true;
    _onConnected!();
  }

  void close() {
    _connected = false;
    _onClosed!('closed');
  }

  void bytes(List<int> data) => _onBytes!(Uint8List.fromList(data));

  /// One daemon message, framed.
  void say(Map<String, Object?> message) => bytes(encodeCableFrame(kCableTypeJson, utf8.encode(jsonEncode(message)))!);

  /// One daemon message as raw JSON text, framed.
  void sayRaw(String json) => bytes(encodeCableFrame(kCableTypeJson, utf8.encode(json))!);

  @override
  bool get connected => _connected;

  @override
  bool write(Uint8List frame) {
    if (!_connected || !accepting) return false;
    written.add(frame);
    return true;
  }

  @override
  void replug() => replugs++;

  @override
  Future<void> stop() async {}

  /// Every frame written, decoded: (type, payload).
  List<(int, Uint8List)> get frames {
    final out = <(int, Uint8List)>[];
    final d = CableDecoder();
    for (final f in written) {
      d.feed(f, (_, type, payload) => out.add((type, payload)));
    }
    return out;
  }

  /// The JSON texts written, byte for byte.
  List<String> get texts => [
    for (final (type, payload) in frames)
      if (type == kCableTypeJson) utf8.decode(payload),
  ];

  /// The JSON messages written.
  List<Map<String, Object?>> get messages => [for (final t in texts) jsonDecode(t) as Map<String, Object?>];

  /// The message kinds written, in order.
  List<String> get kinds => [for (final m in messages) m['t'] as String];

  /// The PCM frames written.
  List<Uint8List> get pcm => [
    for (final (type, payload) in frames)
      if (type == kCableTypePcm) payload,
  ];

  void clear() => written.clear();
}

/// A mic the test feeds.
class FakeMic implements Mic {
  final _pcm = StreamController<Uint8List>.broadcast(sync: true);
  final _levels = StreamController<double>.broadcast(sync: true);
  bool isOpen = false;
  int opens = 0, closes = 0;

  /// What open() answers; a test may hold it to look at the bar while the mic opens.
  Completer<bool>? opening;
  bool opensOk = true;

  @override
  int get sampleRate => 16000;
  @override
  Stream<Uint8List> get pcm => _pcm.stream;
  @override
  Stream<double> get levels => _levels.stream;

  @override
  Future<bool> open() async {
    opens++;
    final ok = opening != null ? await opening!.future : opensOk;
    isOpen = ok;
    return ok;
  }

  @override
  Future<void> close() async {
    closes++;
    isOpen = false;
  }

  void speak(List<int> bytes) => _pcm.add(Uint8List.fromList(bytes));
  void level(double l) => _levels.add(l);
  void die() => _pcm.addError(StateError('the microphone stopped'));
}

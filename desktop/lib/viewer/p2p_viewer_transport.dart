import 'dart:async';

import '../logging/app_log.dart';
import '../ws/viewer_p2p.dart';

// Byte-identical as mobile/lib/surface/ and desktop/lib/viewer/p2p_viewer_transport.dart — there
// is no shared Dart package. Change both together.

/// A viewer surface's requests (`ViewerSurfaceRequest`) over the p2p viewer channel when it is
/// up, over the WS long-poll ([ws]) otherwise. One per surface.
///
/// On the channel (cli/src/lib/interactiveViewer.ts `push`) the first frame request opens a push:
/// the machine sends frames down, at most two un-acked, and each frame request takes the newest
/// one not yet shown, acking it. Input goes up as `surface_input` while a push runs and its
/// `surface_state` / `surface_error` comes back over the relay ([states]). A channel lost
/// mid-request retries a frame request over WS (an input is settled, never replayed, unless the
/// machine says it was not applied); the push reopens at the next frame request once the channel
/// is back. Each open names an id the machine echoes on everything it says about that
/// push, so what it says about a push this one replaced is told apart from what it says about this.
class P2pViewerTransport {
  P2pViewerTransport({
    required this.p2p,
    required this.ws,
    required Stream<Map<String, dynamic>> states,
  }) {
    _states = states.listen(_onState);
  }

  final ViewerP2p? Function() p2p;
  final Future<Map<String, dynamic>> Function(Map<String, dynamic> payload) ws;

  late final StreamSubscription<Map<String, dynamic>> _states;
  ViewerP2p? _bound;
  StreamSubscription<bool>? _readiness;
  ViewerP2p? _pushing;
  StreamSubscription<ViewerFrame>? _frames;
  Timer? _keepalive, _silent;
  bool _refused =
      false; // a push that never sent a frame: WS until the channel comes back
  bool _closed = false;
  String? _openId; // the running push's open, which the machine echoes
  var _opens = 0;
  Map<String, dynamic>?
  _shape; // the last frame request's surface fields, for a reopen
  bool _editable = false; // the last editable an input's answer reported
  final _buffer = <ViewerFrame>[];
  ({Map<String, dynamic> payload, Completer<Map<String, dynamic>> reply})?
  _waiting;
  final _inputs =
      <
        String,
        ({Map<String, dynamic> payload, Completer<Map<String, dynamic>> reply})
      >{};
  var _nextInput = 0;
  String? _surfaceId;
  int? _shown; // the newest frame handed over, on either path
  List<dynamic>? _hostActions;
  Future<void>? _wsPoll;
  final _latency = <({int? after, Stopwatch clock, String path})>[];

  /// 'p2p' while frames are pushed, 'ws' otherwise.
  String get path => _pushing != null ? 'p2p' : 'ws';

  Future<Map<String, dynamic>> call(Map<String, dynamic> payload) {
    // Closed: a late request on either path would only reopen a push or recreate the surface on
    // the machine with nobody left to end it.
    if (_closed && payload['op'] != 'close') {
      return Future.value({'error': 'VIEWER_CLOSED'});
    }
    _surfaceId ??= payload['surfaceId'] as String?;
    final channel = _channel();
    return switch (payload['op']) {
      'frame' => _frame(channel, payload),
      'input' => _input(channel, payload),
      'close' => _close(payload),
      _ => ws(payload),
    };
  }

  /// The viewer channel when it is up. Follows its readiness, and a replaced one counts as lost.
  ViewerP2p? _channel() {
    final channel = p2p();
    if (channel != _bound) {
      _lost();
      _readiness?.cancel();
      _bound = channel;
      _readiness = channel?.readiness.listen((ready) {
        if (!ready) return _lost();
        _refused = false;
        // Re-emitted under a running push when the link behind it was replaced (TURN -> direct):
        // a frame in flight on the old link is gone, and the credit with it. Reopen from the last
        // frame shown, or the session would keep a stale image until the page changes again.
        final shape = _shape;
        if (_pushing != null && shape != null && !_closed) {
          if (!_open(channel, {...shape, 'after': _shown ?? 0})) _lost();
        }
      });
    }
    return channel != null && channel.ready ? channel : null;
  }

  Future<Map<String, dynamic>> _frame(
    ViewerP2p? channel,
    Map<String, dynamic> payload,
  ) async {
    if (channel == null || _refused) return _poll(payload);
    _shape = {...payload}
      ..remove('op')
      ..remove('reload')
      ..remove('events');
    // A Retry's page reload is applied by an open, so it reopens a push already running.
    if (_pushing == null || payload['reload'] == true) {
      // A WS frame request reaching the machine after the open would stop the push it found.
      await _wsPoll;
      // Closed meanwhile: an open now would start a push nobody ends.
      if (_closed) return {'error': 'VIEWER_CLOSED'};
      if (!channel.ready || !_open(channel, payload)) return _poll(payload);
    }
    if (_buffer.isNotEmpty) return _take(_buffer.last);
    final reply = Completer<Map<String, dynamic>>();
    _waiting = (payload: payload, reply: reply);
    return reply.future;
  }

  Future<Map<String, dynamic>> _poll(Map<String, dynamic> payload) {
    _stopPush();
    final poll = ws(payload).then((reply) {
      final seq = reply['seq'];
      if (seq is int && reply['unchanged'] != true && reply['error'] == null) {
        _shown = seq;
        _measured(seq);
      }
      return reply;
    });
    _wsPoll = poll.then<void>((_) {}, onError: (_) {});
    return poll;
  }

  bool _open(ViewerP2p channel, Map<String, dynamic> payload) {
    _stopPush();
    // Subscribed before the open: parts for a surface nobody listens to are dropped.
    _frames = channel.frames(_surfaceId!).listen(_onFrame);
    _pushing = channel;
    _openId = '${++_opens}';
    final open = {
      ...payload,
      'after': payload['after'] ?? _shown ?? 0,
      'open': _openId,
    }..remove('op');
    if (!channel.send('surface_open', open)) {
      _stopPush();
      return false;
    }
    // The machine lets a push go after 30 s without a word, so a hidden client releases it. While
    // a frame is awaited the surface is on screen: repeat the last ack.
    _keepalive = Timer.periodic(const Duration(seconds: 10), (_) {
      if (_waiting != null) _ack(_shown ?? 0);
    });
    // A lost open is never answered: a first frame that takes as long as a WS request may wait
    // means WS, for this request and on. Only the first: a reopen on a still page rightly waits
    // for a change.
    if (_shown == null) {
      _silent = Timer(const Duration(seconds: 25), () {
        _refused = true;
        _lost();
      });
    }
    return true;
  }

  void _onFrame(ViewerFrame frame) {
    _silent?.cancel();
    final waiting = _waiting;
    if (waiting == null) {
      _buffer.add(frame);
      return;
    }
    _waiting = null;
    waiting.reply.complete(_take(frame));
  }

  /// Hands [frame] over, acking it (cumulatively: anything buffered before it is skipped).
  Map<String, dynamic> _take(ViewerFrame frame) {
    _buffer.clear();
    _shown = frame.seq;
    _ack(frame.seq);
    _measured(frame.seq);
    final actions = _hostActions;
    _hostActions = null;
    return {
      'bytes': frame.jpeg,
      'mime': 'image/jpeg',
      'seq': frame.seq,
      'width': frame.width,
      'height': frame.height,
      'scale': frame.scale,
      'hostActions': ?actions,
    };
  }

  void _ack(int seq) => _pushing?.send('surface_ack', {
    'surfaceId': _surfaceId,
    'seq': seq,
    'open': _openId,
  });

  /// The channel went: the push is over, and inputs it carried may be lost with it, so they
  /// settle at once; a frame request waiting on it goes over WS.
  void _lost() {
    _settleInputs();
    _fallBack();
  }

  /// The push is over: a frame request waiting on it goes over WS, which recreates the surface on
  /// the machine if it went; the next frame request reopens the push. Inputs in flight are left
  /// alone when the machine ended it: it still answers each, and says whether it was applied.
  void _fallBack() {
    final waiting = _waiting;
    _waiting = null;
    if (waiting == null) return _stopPush();
    waiting.reply.complete(
      _poll({...waiting.payload, if (_shown != null) 'after': _shown}),
    );
  }

  void _stopPush() {
    _frames?.cancel();
    _frames = null;
    _keepalive?.cancel();
    _silent?.cancel();
    _keepalive = _silent = null;
    _pushing = _openId = null;
    _buffer.clear();
    // Navigation the push asked for goes with it: the next push or poll brings the current one.
    _hostActions = null;
  }

  /// Inputs a dying channel may have lost, applied or not: settled at once, never replayed (a
  /// replay could apply them twice), so the session's next input is not held behind them for
  /// 25 s. A late answer over the relay then finds no id and is dropped.
  void _settleInputs() {
    final pending = [..._inputs.values];
    _inputs.clear();
    for (final input in pending) {
      if (!input.reply.isCompleted) {
        input.reply.complete({'ok': true, 'editable': _editable});
      }
    }
  }

  void _pushFailed(Map<String, dynamic> answer) {
    final waiting = _waiting;
    _waiting = null;
    _stopPush();
    waiting?.reply.complete(answer);
  }

  Future<Map<String, dynamic>> _input(
    ViewerP2p? channel,
    Map<String, dynamic> payload,
  ) {
    final id = '${++_nextInput}';
    // Only while a push runs: the machine takes surface_input for a push it has, and answers
    // anything else VIEWER_CLOSED. A refused push has none, so input goes by WS too.
    final pushing = _pushing;
    final sent =
        channel != null &&
        pushing == channel &&
        channel.send(
          'surface_input',
          {...payload, 'input': id, 'open': _openId}..remove('op'),
        );
    _latency.add((
      after: _shown,
      clock: Stopwatch()..start(),
      path: sent ? channel.via : 'ws',
    ));
    if (_latency.length > 16) _latency.removeAt(0);
    if (!sent) return ws(payload);
    final reply = Completer<Map<String, dynamic>>();
    _inputs[id] = (payload: payload, reply: reply);
    return reply.future
        .timeout(const Duration(seconds: 25))
        .whenComplete(() => _inputs.remove(id));
  }

  void _onState(Map<String, dynamic> state) {
    if (_surfaceId == null || state['surfaceId'] != _surfaceId) return;
    final failed = state['type'] == 'surface_error';
    final answer = failed
        ? {'error': state['error'], 'detail': state['detail']}
        : ({'ok': true, ...state}..remove('type'));
    final current = _openId != null && state['open'] == _openId;
    final input = state['input'];
    if (input is String) {
      if (!failed && state['editable'] is bool) _editable = state['editable'];
      final pending = _inputs.remove(input);
      if (pending == null || pending.reply.isCompleted) return;
      if (failed && _ended.contains(state['error'])) {
        // `unapplied`: refused before anything reached Chrome (no push, or the viewers off), so WS
        // takes it. Without it the surface went while the input ran, and a replay would apply it
        // twice: settled like an input a lost channel took.
        pending.reply.complete(
          state['unapplied'] == true
              ? ws(pending.payload)
              : {'ok': true, 'editable': _editable},
        );
        if (current) _fallBack();
        return;
      }
      pending.reply.complete(answer);
      return;
    }
    // Another open's: one this replaced, or none now.
    if (!current) return;
    if (failed) {
      // A limit or a bad request is the session's to show. Anything else ended the push on the
      // machine (its viewers restarted or are off, the channel refused a frame, Chrome failed):
      // WS from the last frame shown, which says so itself if it is real, and then a reopen.
      if (_shownErrors.contains(state['error'])) return _pushFailed(answer);
      return _fallBack();
    }
    final actions = state['hostActions'];
    if (actions is! List) return;
    final waiting = _waiting;
    if (waiting == null) {
      // The session takes at most 8 per reply; the newest navigation is the one that matters.
      final held = [...?_hostActions, ...actions];
      _hostActions = held.length > 8 ? held.sublist(held.length - 8) : held;
      return;
    }
    // A static page pushes no frames, and its navigation must not wait for one.
    _waiting = null;
    waiting.reply.complete({
      'unchanged': true,
      'seq': ?_shown,
      'hostActions': actions,
    });
  }

  /// Push errors that are the session's to show; any other ends the push and falls back.
  static const _shownErrors = {'VIEWER_LIMIT', 'INVALID_VIEWER_REQUEST'};

  /// Input errors that mean the push is gone: replayed over WS only when also `unapplied`.
  static const _ended = {'VIEWER_CLOSED', 'VIEWERS_UNAVAILABLE'};

  void _measured(int seq) {
    _latency.removeWhere((input) {
      final after = input.after;
      if (after != null && seq <= after) return false;
      appLog.info(
        'viewer',
        'input via ${input.path}: ${input.clock.elapsedMilliseconds} ms to frame $seq',
      );
      return true;
    });
  }

  Future<Map<String, dynamic>> _close(Map<String, dynamic> payload) {
    final pushing = _pushing;
    _closed = true;
    _settleInputs();
    final waiting = _waiting;
    _waiting = null;
    waiting?.reply.complete({'error': 'VIEWER_CLOSED'});
    _stopPush();
    _readiness?.cancel();
    _states.cancel();
    final sent =
        pushing != null &&
        pushing.send('surface_close', {'surfaceId': payload['surfaceId']});
    return sent ? Future.value({'closed': true}) : ws(payload);
  }
}

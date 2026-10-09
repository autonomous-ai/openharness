import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/viewer/p2p_viewer_transport.dart';
import 'package:harness/ws/viewer_p2p.dart';

// Copied from mobile/test/surface/p2p_viewer_transport_test.dart: keep the two identical apart from the imports.

const surface = '0123456789abcdef0123456789abcdef';

/// A recorded `(type, payload)` as a list, which `equals` compares deeply (a record's map is compared by identity).
List<Object> flat((String, Map<String, dynamic>) sent) => [sent.$1, sent.$2];

/// A viewer channel with no WebRTC behind it: records what goes up, pushes what the test says.
class FakeViewerP2p implements ViewerP2p {
  @override
  bool ready = true;
  @override
  String via = 'direct';
  final sent = <(String, Map<String, dynamic>)>[];
  final calls = <String>[];
  final _readiness = StreamController<bool>.broadcast(sync: true);
  StreamController<ViewerFrame>? _frames;

  @override
  bool send(String type, Map<String, dynamic> payload) {
    calls.add(type);
    if (!ready) return false;
    sent.add((type, payload));
    return true;
  }

  @override
  Stream<ViewerFrame> frames(String surfaceId) {
    calls.add('frames $surfaceId');
    return (_frames = StreamController<ViewerFrame>.broadcast(
      sync: true,
    )).stream;
  }

  @override
  Stream<bool> get readiness => _readiness.stream;

  void push(int seq) => _frames!.add(
    ViewerFrame(
      streamId: 's',
      seq: seq,
      width: 800,
      height: 600,
      scale: 2,
      jpeg: Uint8List.fromList([seq]),
    ),
  );

  void drop() => _readiness.add(ready = false);
  void up() => _readiness.add(ready = true);
  Iterable<String> get types => sent.map((s) => s.$1);
}

class _Log implements AppLog {
  final lines = <String>[];
  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => lines.add('$category $message');
}

Map<String, dynamic> shape(
  String op, [
  Map<String, dynamic> extra = const {},
]) => {
  'surfaceId': surface,
  'agentId': 'a',
  'width': 800,
  'height': 600,
  'dark': true,
  'scale': 2.0,
  'mobile': false,
  'touch': false,
  'op': op,
  ...extra,
};

Map<String, dynamic> picture(int seq) => {
  'data': base64Encode([seq]),
  'mime': 'image/jpeg',
  'seq': seq,
};

void main() {
  late FakeViewerP2p channel;
  late StreamController<Map<String, dynamic>> states;
  late List<Map<String, dynamic>> wsCalls;
  late List<Completer<Map<String, dynamic>>> wsReplies;
  late _Log log;

  setUp(() {
    channel = FakeViewerP2p();
    states = StreamController<Map<String, dynamic>>.broadcast(sync: true);
    wsCalls = [];
    wsReplies = [];
    log = _Log();
    appLog = log;
  });
  tearDown(() => appLog = const NoopAppLog());

  P2pViewerTransport transport({ViewerP2p? Function()? p2p}) =>
      P2pViewerTransport(
        p2p: p2p ?? () => channel,
        ws: (payload) {
          wsCalls.add(payload);
          final reply = Completer<Map<String, dynamic>>();
          wsReplies.add(reply);
          return reply.future;
        },
        states: states.stream,
      );

  /// The id the latest surface_open named; the machine echoes it on what it says about that push.
  String openId() =>
      channel.sent.lastWhere((sent) => sent.$1 == 'surface_open').$2['open']
          as String;

  /// Opens a push and takes its first frame (seq 1).
  Future<P2pViewerTransport> pushing() async {
    final t = transport();
    final first = t(shape('frame'));
    await pumpEventQueue();
    channel.push(1);
    await first;
    return t;
  }

  test('uses WS when there is no viewer channel or it is not up', () async {
    final none = transport(p2p: () => null);
    unawaited(none(shape('frame', {'after': 3})));
    expect(wsCalls.single, shape('frame', {'after': 3}));
    expect(none.path, 'ws');

    channel.ready = false;
    unawaited(transport()(shape('input', {'events': []})));
    expect(wsCalls.last, shape('input', {'events': []}));
    expect(channel.sent, isEmpty);
  });

  test('the first frame request opens a push; later ones take the newest pushed frame', () async {
    final t = transport();
    final first = t(shape('frame', {'reload': false, 'events': []}));
    await pumpEventQueue();
    // Subscribed before the open: parts for a surface nobody listens to are dropped.
    expect(channel.calls, ['frames $surface', 'surface_open']);
    final open = channel.sent.single.$2;
    expect((open['open'] as String).length, inInclusiveRange(1, 64));
    expect(
      open,
      {
        ...shape('frame', {'reload': false, 'events': []}),
        'after': 0,
        'open': open['open'],
      }..remove('op'),
    );
    expect(t.path, 'p2p');

    channel.push(1);
    final reply = await first;
    expect(reply['bytes'], [1]);
    expect(reply, containsPair('mime', 'image/jpeg'));
    expect(reply, containsPair('seq', 1));
    expect(reply, containsPair('width', 800));
    expect(reply, containsPair('height', 600));
    expect(reply, containsPair('scale', 2.0));
    expect(flat(channel.sent.last), [
      'surface_ack',
      {'surfaceId': surface, 'seq': 1, 'open': open['open']},
    ]);

    // Buffered frames are taken first: the newest, acked cumulatively.
    channel.push(2);
    channel.push(3);
    final buffered = await t(shape('frame', {'after': 1}));
    expect(buffered['seq'], 3);
    expect(flat(channel.sent.last), [
      'surface_ack',
      {'surfaceId': surface, 'seq': 3, 'open': open['open']},
    ]);

    final waiting = t(shape('frame', {'after': 3}));
    channel.push(4);
    expect((await waiting)['seq'], 4);
    expect(channel.types.where((type) => type == 'surface_open'), hasLength(1));
    expect(wsCalls, isEmpty);
  });

  test('input goes up as surface_input while a push runs, and its surface_state or surface_error answers it', () async {
    final t = await pushing();
    final events = [
      {'type': 'text', 'text': 'x'},
    ];
    final reply = t(shape('input', {'events': events}));
    final (type, sent) = channel.sent.last;
    expect(type, 'surface_input');
    final id = sent['input'] as String;
    expect(id.length, inInclusiveRange(1, 64));
    expect(
      sent,
      {
        ...shape('input', {'events': events}),
        'input': id,
        'open': openId(),
      }..remove('op'),
    );

    // Another input's answer, or another surface's, is not this one's.
    states.add({
      'type': 'surface_state',
      'surfaceId': surface,
      'input': '$id-other',
      'seq': 9,
      'editable': false,
    });
    states.add({
      'type': 'surface_state',
      'surfaceId': 'f' * 32,
      'input': id,
      'seq': 9,
      'editable': false,
    });
    states.add({
      'type': 'surface_state',
      'surfaceId': surface,
      'input': id,
      'seq': 5,
      'editable': true,
      'clipboard': 'hi',
    });
    final answer = await reply;
    expect(answer, containsPair('ok', true));
    expect(answer, containsPair('seq', 5));
    expect(answer, containsPair('editable', true));
    expect(answer, containsPair('clipboard', 'hi'));

    final failing = t(shape('input', {'events': events}));
    final second = channel.sent.last.$2['input'] as String;
    expect(second, isNot(id));
    states.add({
      'type': 'surface_error',
      'surfaceId': surface,
      'input': second,
      'error': 'VIEWER_BUSY',
      'detail': 'Busy.',
    });
    expect(await failing, {'error': 'VIEWER_BUSY', 'detail': 'Busy.'});
    expect(wsCalls, isEmpty);
  });

  test('input over the channel times out like the WS request', () {
    fakeAsync((async) {
      final t = transport();
      t(shape('frame'));
      async.flushMicrotasks();
      channel.push(1);
      async.flushMicrotasks();
      Object? failure;
      t(shape('input', {'events': []})).catchError((Object e) {
        failure = e;
        return <String, dynamic>{};
      });
      async.elapse(const Duration(seconds: 24));
      expect(failure, isNull);
      async.elapse(const Duration(seconds: 2));
      expect(failure, isA<TimeoutException>());
    });
  });

  test('a lost viewer channel falls back to WS', () async {
    final t = await pushing();
    final waiting = t(shape('frame', {'after': 1}));
    await pumpEventQueue();
    channel.drop();
    await pumpEventQueue();
    // The waiting request is retried over WS from the last frame shown.
    expect(wsCalls.single, shape('frame', {'after': 1}));
    wsReplies.single.complete(picture(2));
    expect((await waiting)['seq'], 2);
    expect(t.path, 'ws');

    // Later requests stay on WS, with no ack or open on the channel, until it is back.
    final calls = channel.calls.length;
    final polled = t(shape('frame', {'after': 2}));
    expect(wsCalls, hasLength(2));
    wsReplies.last.complete(picture(3));
    expect((await polled)['seq'], 3);
    expect(channel.calls, hasLength(calls));

    channel.up();
    unawaited(t(shape('frame', {'after': 3})));
    await pumpEventQueue();
    expect(channel.sent.last.$1, 'surface_open');
    expect(channel.sent.last.$2['after'], 3);
    expect(wsCalls, hasLength(2));
  });

  test('a push never opens while a WS poll is still out', () async {
    channel.ready = false;
    final t = transport();
    final poll = t(shape('frame'));
    channel.up();
    unawaited(t(shape('frame', {'after': 1})));
    await pumpEventQueue();
    // A late WS frame request would stop the push it found on the machine.
    expect(channel.sent, isEmpty);
    wsReplies.single.complete(picture(1));
    await poll;
    await pumpEventQueue();
    expect(channel.types, ['surface_open']);
  });

  test('repeats the last ack every 10 s while a frame is awaited, and stops after falling back', () {
    fakeAsync((async) {
      final t = transport();
      t(shape('frame'));
      async.flushMicrotasks();
      channel.push(1);
      async.flushMicrotasks();
      final open = openId();
      // Nobody asking for frames (a session in error, gone quiet): the machine may let it go.
      channel.sent.clear();
      async.elapse(const Duration(seconds: 10));
      expect(channel.sent, isEmpty);
      t(shape('frame', {'after': 1}));
      async.flushMicrotasks();
      async.elapse(const Duration(seconds: 10));
      expect(channel.sent.map(flat), [
        [
          'surface_ack',
          {'surfaceId': surface, 'seq': 1, 'open': open},
        ],
      ]);
      channel.drop();
      async.flushMicrotasks();
      channel.up();
      channel.sent.clear();
      async.elapse(const Duration(seconds: 30));
      expect(channel.sent, isEmpty);
    });
  });

  test('a first open that brings no frame in 25 s goes to WS until the channel comes back', () {
    fakeAsync((async) {
      final t = transport();
      t(shape('frame'));
      async.flushMicrotasks();
      async.elapse(const Duration(seconds: 24));
      expect(wsCalls, isEmpty);
      async.elapse(const Duration(seconds: 1));
      expect(wsCalls.single, shape('frame'));
      wsReplies.single.complete(picture(1));
      async.flushMicrotasks();
      t(shape('frame', {'after': 1}));
      async.flushMicrotasks();
      expect(wsCalls, hasLength(2));
      Iterable<String> opens() =>
          channel.types.where((type) => type == 'surface_open');
      expect(opens(), hasLength(1));
      // Input follows the frames to WS.
      t(shape('input', {'events': []}));
      expect(wsCalls.last['op'], 'input');
      expect(channel.types.where((type) => type == 'surface_input'), isEmpty);
      wsReplies.last.complete({'ok': true, 'seq': 1});
      channel.drop();
      channel.up();
      wsReplies[1].complete(picture(2));
      async.flushMicrotasks();
      t(shape('frame', {'after': 2}));
      async.flushMicrotasks();
      expect(opens(), hasLength(2));
      // A reopen on a still page waits for a change: no deadline.
      async.elapse(const Duration(minutes: 1));
      expect(wsCalls, hasLength(3));
    });
  });

  test(
    'a Retry reopens a running push, which applies its page reload',
    () async {
      final t = await pushing();
      unawaited(t(shape('frame', {'after': 1, 'reload': true})));
      await pumpEventQueue();
      expect(
        channel.types.where((type) => type == 'surface_open'),
        hasLength(2),
      );
      expect(channel.sent.last.$2, containsPair('reload', true));
      channel.push(2);
      expect(channel.sent.last.$1, 'surface_ack');
    },
  );

  test(
    'host actions in a surface_state reach the waiting frame request',
    () async {
      final t = await pushing();
      final waiting = t(shape('frame', {'after': 1}));
      await pumpEventQueue();
      final actions = [
        {'action': 'assistant'},
      ];
      states.add({
        'type': 'surface_state',
        'surfaceId': surface,
        'seq': 7,
        'hostActions': actions,
        'open': openId(),
      });
      expect(await waiting, {
        'unchanged': true,
        'seq': 1,
        'hostActions': actions,
      });
    },
  );

  test('VIEWER_CLOSED for the current open falls back to a WS poll from the last frame shown; the next frame request reopens', () async {
    final t = await pushing();
    final waiting = t(shape('frame', {'after': 1}));
    await pumpEventQueue();
    // The machine ended the push (its viewers restarted, the channel refused a frame): no Try again.
    states.add({
      'type': 'surface_error',
      'surfaceId': surface,
      'error': 'VIEWER_CLOSED',
      'open': openId(),
    });
    expect(wsCalls.single, shape('frame', {'after': 1}));
    expect(t.path, 'ws');
    wsReplies.single.complete(picture(2));
    expect((await waiting)['seq'], 2);
    final next = t(shape('frame', {'after': 2}));
    await pumpEventQueue();
    expect(channel.types.where((type) => type == 'surface_open'), hasLength(2));
    expect(channel.sent.last.$2, containsPair('after', 2));
    channel.push(3);
    expect((await next)['seq'], 3);
    expect(t.path, 'p2p');
  });

  test('VIEWERS_UNAVAILABLE falls back too, and with no frame waiting just ends the push', () async {
    final t = await pushing();
    states.add({
      'type': 'surface_error',
      'surfaceId': surface,
      'error': 'VIEWERS_UNAVAILABLE',
      'open': openId(),
    });
    expect(t.path, 'ws');
    expect(wsCalls, isEmpty);
    // A late frame of the ended push is nobody's.
    unawaited(t(shape('frame', {'after': 1})));
    await pumpEventQueue();
    expect(channel.types.where((type) => type == 'surface_open'), hasLength(2));
  });

  test('an error naming an open a reopen replaced is ignored', () async {
    final t = await pushing();
    final old = openId();
    // Retry's reload reopens; the old push's VIEWER_CLOSED comes over the relay after it.
    final reply = t(shape('frame', {'after': 1, 'reload': true}));
    await pumpEventQueue();
    expect(openId(), isNot(old));
    for (final open in [old, null]) {
      states.add({
        'type': 'surface_error',
        'surfaceId': surface,
        'error': 'VIEWER_CLOSED',
        'open': ?open,
      });
    }
    // Nor does an old open's host action reach the new push's frame.
    states.add({
      'type': 'surface_state',
      'surfaceId': surface,
      'seq': 1,
      'hostActions': [
        {'action': 'old'},
      ],
      'open': old,
    });
    expect(t.path, 'p2p');
    expect(wsCalls, isEmpty);
    channel.push(2);
    final shown = await reply;
    expect(shown['seq'], 2);
    expect(shown.containsKey('hostActions'), isFalse);
  });

  test(
    'a limit or invalid error for the current open is shown at once',
    () async {
      for (final error in ['VIEWER_LIMIT', 'INVALID_VIEWER_REQUEST']) {
        final t = transport();
        final reply = t(shape('frame'));
        await pumpEventQueue();
        states.add({
          'type': 'surface_error',
          'surfaceId': surface,
          'error': error,
          'detail': 'Close another viewer to open this one.',
          'open': openId(),
        });
        expect(await reply.timeout(const Duration(seconds: 1)), {
          'error': error,
          'detail': 'Close another viewer to open this one.',
        });
        expect(t.path, 'ws');
        expect(wsCalls, isEmpty);
      }
    },
  );

  test('an input the machine had no push for goes again over WS, and ends the push', () async {
    final t = await pushing();
    final input = t(shape('input', {'events': []}));
    states.add({
      'type': 'surface_error',
      'surfaceId': surface,
      'input': channel.sent.last.$2['input'],
      'error': 'VIEWER_CLOSED',
      'unapplied': true,
      'open': openId(),
    });
    expect(wsCalls.single, shape('input', {'events': []}));
    expect(t.path, 'ws');
    wsReplies.single.complete({'ok': true, 'seq': 2, 'editable': false});
    expect(await input, {'ok': true, 'seq': 2, 'editable': false});
    // While no push runs, input goes over WS.
    unawaited(t(shape('input', {'events': []})));
    expect(wsCalls, hasLength(2));
    expect(
      channel.types.where((type) => type == 'surface_input'),
      hasLength(1),
    );
  });

  test('an input error without unapplied may have been applied: it settles ok and is not replayed', () async {
    final t = await pushing();
    final first = t(shape('input', {'events': []}));
    states.add({
      'type': 'surface_state',
      'surfaceId': surface,
      'input': channel.sent.last.$2['input'],
      'seq': 1,
      'editable': true,
    });
    await first;
    // The surface went while its commands ran: a replay over WS would type them twice.
    for (final error in ['VIEWER_CLOSED', 'VIEWERS_UNAVAILABLE']) {
      final input = t(shape('input', {'events': []}));
      states.add({
        'type': 'surface_error',
        'surfaceId': surface,
        'input': channel.sent.last.$2['input'],
        'error': error,
        'open': openId(),
      });
      expect(await input.timeout(const Duration(seconds: 1)), {
        'ok': true,
        'editable': true,
      });
      expect(wsCalls, isEmpty);
      // The push ended with the surface; the next frame request reopens it.
      expect(t.path, 'ws');
      final reopen = t(shape('frame', {'after': 1}));
      await pumpEventQueue();
      channel.push(2);
      await reopen;
    }
    // The core's VIEWERS_UNAVAILABLE for an input that reached no viewer says unapplied: WS takes it.
    final input = t(shape('input', {'events': []}));
    states.add({
      'type': 'surface_error',
      'surfaceId': surface,
      'input': channel.sent.last.$2['input'],
      'error': 'VIEWERS_UNAVAILABLE',
      'unapplied': true,
      'open': openId(),
    });
    expect(wsCalls.single, shape('input', {'events': []}));
    wsReplies.single.complete({'ok': true, 'seq': 3, 'editable': false});
    expect(await input, {'ok': true, 'seq': 3, 'editable': false});
  });

  test('inputs in flight when the machine ends the push each get their own answer, so none is lost', () async {
    final t = await pushing();
    final first = t(
      shape('input', {
        'events': [
          {'type': 'text', 'text': 'a'},
        ],
      }),
    );
    final a = channel.sent.last.$2['input'];
    final second = t(
      shape('input', {
        'events': [
          {'type': 'text', 'text': 'b'},
        ],
      }),
    );
    final b = channel.sent.last.$2['input'];
    // The viewers restarted: the push ends, but the inputs are not settled here, since the machine
    // still answers each one and says whether it was applied.
    states.add({
      'type': 'surface_error',
      'surfaceId': surface,
      'error': 'VIEWER_CLOSED',
      'open': openId(),
    });
    expect(t.path, 'ws');
    for (final id in [a, b]) {
      states.add({
        'type': 'surface_error',
        'surfaceId': surface,
        'input': id,
        'error': 'VIEWER_CLOSED',
        'unapplied': true,
      });
    }
    expect(wsCalls.map((c) => c['events']), [
      [
        {'type': 'text', 'text': 'a'},
      ],
      [
        {'type': 'text', 'text': 'b'},
      ],
    ]);
    wsReplies[0].complete({'ok': true, 'seq': 2, 'editable': false});
    wsReplies[1].complete({'ok': true, 'seq': 3, 'editable': false});
    expect((await first)['seq'], 2);
    expect((await second)['seq'], 3);
  });

  test(
    'after close, frame and input requests send nothing on either path',
    () async {
      final t = await pushing();
      await t({'surfaceId': surface, 'agentId': 'a', 'op': 'close'});
      final sent = channel.calls.length;
      expect(await t(shape('input', {'events': []})), {
        'error': 'VIEWER_CLOSED',
      });
      expect(await t(shape('frame', {'after': 1})), {'error': 'VIEWER_CLOSED'});
      channel.drop();
      expect(await t(shape('frame', {'after': 1})), {'error': 'VIEWER_CLOSED'});
      expect(await t(shape('input', {'events': []})), {
        'error': 'VIEWER_CLOSED',
      });
      expect(channel.calls, hasLength(sent));
      expect(wsCalls, isEmpty);
    },
  );

  test('an input in flight when the channel dies settles at once and is not replayed', () async {
    final t = await pushing();
    final first = t(shape('input', {'events': []}));
    states.add({
      'type': 'surface_state',
      'surfaceId': surface,
      'input': channel.sent.last.$2['input'],
      'seq': 1,
      'editable': true,
    });
    await first;
    final pending = t(
      shape('input', {
        'events': [
          {'type': 'text', 'text': 'x'},
        ],
      }),
    );
    final id = channel.sent.last.$2['input'];
    channel.drop();
    expect(await pending.timeout(const Duration(seconds: 1)), {
      'ok': true,
      'editable': true,
    });
    // Its answer arriving late over the relay finds nobody waiting.
    states.add({
      'type': 'surface_state',
      'surfaceId': surface,
      'input': id,
      'seq': 2,
      'editable': false,
    });
    unawaited(t(shape('input', {'events': []})));
    expect(wsCalls.single['op'], 'input');
    expect(
      channel.types.where((type) => type == 'surface_input'),
      hasLength(2),
    );
  });

  test(
    'a link replaced under a running push reopens it from the last frame shown',
    () async {
      final t = await pushing();
      final waiting = t(shape('frame', {'after': 1}));
      await pumpEventQueue();
      channel.up(); // readiness re-emitted: TURN -> direct
      final opens = channel.sent
          .where((sent) => sent.$1 == 'surface_open')
          .toList();
      expect(opens, hasLength(2));
      expect(opens.last.$2['after'], 1);
      expect(opens.last.$2.containsKey('reload'), isFalse);
      channel.push(2);
      expect((await waiting)['seq'], 2);
    },
  );

  test(
    'host actions held for the next frame are bounded and go with the push',
    () async {
      final t = await pushing();
      for (var i = 0; i < 10; i++) {
        states.add({
          'type': 'surface_state',
          'surfaceId': surface,
          'seq': 1,
          'hostActions': [
            {'action': 'a$i'},
          ],
          'open': openId(),
        });
      }
      channel.push(2);
      final reply = await t(shape('frame', {'after': 1}));
      expect(reply['hostActions'], [
        for (var i = 2; i < 10; i++) {'action': 'a$i'},
      ]);
      states.add({
        'type': 'surface_state',
        'surfaceId': surface,
        'seq': 2,
        'hostActions': [
          {'action': 'late'},
        ],
        'open': openId(),
      });
      channel.drop();
      channel.up();
      final next = t(shape('frame', {'after': 2}));
      await pumpEventQueue();
      channel.push(3);
      expect((await next).containsKey('hostActions'), isFalse);
    },
  );

  test('close settles inputs in flight and a waiting frame request, and nothing opens after it', () async {
    final pushed = await pushing();
    final input = pushed(shape('input', {'events': []}));
    final waiting = pushed(shape('frame', {'after': 1}));
    await pumpEventQueue();
    unawaited(pushed({'surfaceId': surface, 'agentId': 'a', 'op': 'close'}));
    expect(await input.timeout(const Duration(seconds: 1)), {
      'ok': true,
      'editable': false,
    });
    expect(await waiting.timeout(const Duration(seconds: 1)), {
      'error': 'VIEWER_CLOSED',
    });

    channel = FakeViewerP2p()..ready = false;
    final t = transport();
    final poll = t(shape('frame'));
    channel.up();
    unawaited(t(shape('frame', {'after': 1})));
    await pumpEventQueue();
    unawaited(t({'surfaceId': surface, 'agentId': 'a', 'op': 'close'}));
    wsReplies.first.complete(picture(1));
    await poll;
    await pumpEventQueue();
    expect(channel.sent, isEmpty);
  });

  test(
    'close ends the push on the channel, or over WS when that is the path',
    () async {
      final t = await pushing();
      final closed = await t({
        'surfaceId': surface,
        'agentId': 'a',
        'op': 'close',
      });
      expect(closed, {'closed': true});
      expect(flat(channel.sent.last), [
        'surface_close',
        {'surfaceId': surface},
      ]);
      expect(wsCalls, isEmpty);

      final ws = transport(p2p: () => null);
      unawaited(ws({'surfaceId': surface, 'agentId': 'a', 'op': 'close'}));
      expect(wsCalls.single, {
        'surfaceId': surface,
        'agentId': 'a',
        'op': 'close',
      });
    },
  );

  test(
    'logs each input with its path and the time to the next frame',
    () async {
      final t = await pushing();
      channel.via = 'turn';
      final input = t(shape('input', {'events': []}));
      states.add({
        'type': 'surface_state',
        'surfaceId': surface,
        'input': channel.sent.last.$2['input'],
        'seq': 1,
        'editable': false,
      });
      await input;
      expect(log.lines.where((l) => l.startsWith('viewer')), isEmpty);
      channel.push(2);
      await t(shape('frame', {'after': 1}));
      final lines = log.lines
          .where((l) => l.startsWith('viewer input'))
          .toList();
      expect(lines, hasLength(1));
      expect(lines.single, contains('turn'));
      expect(lines.single, matches(RegExp(r'\d+ ms')));

      final ws = transport(p2p: () => null);
      final wsInput = ws(shape('input', {'events': []}));
      wsReplies.last.complete({'ok': true, 'seq': 4});
      await wsInput;
      final frame = ws(shape('frame', {'after': 4}));
      wsReplies.last.complete(picture(5));
      await frame;
      expect(
        log.lines.where((l) => l.startsWith('viewer input')).last,
        contains('ws'),
      );
    },
  );
}

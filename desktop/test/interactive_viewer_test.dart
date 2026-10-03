import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/viewer/interactive_viewer.dart';
import 'package:harness/ws/ws_conn.dart';

Map<String, dynamic> picture() => {
  'data': base64Encode([1, 2, 3]),
  'mime': 'image/jpeg',
  'width': 800,
  'height': 600,
};

void main() {
  testWidgets('host navigation is delivered once and ignored after disposal', (
    tester,
  ) async {
    final actions = <Map<String, dynamic>>[];
    final replies = <Completer<Map<String, dynamic>>>[];
    final session = InteractiveViewerSession((payload) {
      if (payload['op'] == 'close') return Future.value({'closed': true});
      final reply = Completer<Map<String, dynamic>>();
      replies.add(reply);
      return reply.future;
    }, onHostAction: actions.add);
    session.configure(const Size(800, 600), false);
    await tester.pump(const Duration(milliseconds: 1));
    replies.first.complete({
      ...picture(),
      'hostActions': [
        {'action': 'assistant'},
      ],
    });
    await tester.pump(const Duration(milliseconds: 1));
    expect(actions, [
      {'action': 'assistant'},
    ]);
    session.input({'type': 'text', 'text': 'next'});
    await tester.pump(const Duration(milliseconds: 1));
    session.dispose();
    replies.last.complete({
      ...picture(),
      'hostActions': [
        {'action': 'assistant'},
      ],
    });
    await tester.pump(const Duration(milliseconds: 1));
    expect(actions, hasLength(1));
  });
  testWidgets('one frame in flight; queued input arrives once and in order', (
    tester,
  ) async {
    final requests = <Map<String, dynamic>>[];
    final replies = <Completer<Map<String, dynamic>>>[];
    final session = InteractiveViewerSession((payload) {
      requests.add(payload);
      if (payload['op'] == 'close') return Future.value({'closed': true});
      final reply = Completer<Map<String, dynamic>>();
      replies.add(reply);
      return reply.future;
    });
    session.configure(const Size(800, 600), true);
    await tester.pump(const Duration(milliseconds: 1));
    expect(requests, hasLength(1));
    await tester.pump(const Duration(seconds: 2));
    expect(requests, hasLength(1));
    replies[0].complete(picture());
    await tester.pump(const Duration(milliseconds: 1));
    expect(session.image, [1, 2, 3]);
    session.input({'type': 'text', 'text': 'first'});
    await tester.pump(const Duration(milliseconds: 1));
    session.input({'type': 'text', 'text': 'second'});
    expect(requests, hasLength(2));
    expect(requests[1]['events'], [
      {'type': 'text', 'text': 'first'},
    ]);
    replies[1].complete(picture());
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump(const Duration(milliseconds: 1));
    expect(requests, hasLength(3));
    expect(requests[2]['events'], [
      {'type': 'text', 'text': 'second'},
    ]);
    session.dispose();
    expect(requests.last['op'], 'close');
    expect(requests.last['surfaceId'], requests.first['surfaceId']);
    replies[2].complete(picture());
    await tester.pump(const Duration(milliseconds: 1));
    expect(tester.takeException(), isNull);
  });

  testWidgets('an interrupted request never replays stale input on Retry', (
    tester,
  ) async {
    final requests = <Map<String, dynamic>>[];
    var fail = false;
    final session = InteractiveViewerSession((payload) async {
      requests.add(payload);
      if (fail) throw StateError('disconnected');
      return picture();
    });
    session.configure(const Size(800, 600), false);
    await tester.pump(const Duration(milliseconds: 1));
    fail = true;
    session.input({'type': 'text', 'text': 'do not replay'});
    await tester.pump(const Duration(milliseconds: 1));
    expect(session.error, contains('disconnected'));
    final before = requests.length;
    await tester.pump(const Duration(seconds: 10));
    expect(requests, hasLength(before));
    fail = false;
    session.reload();
    await tester.pump(const Duration(milliseconds: 1));
    expect(requests.last['events'], isEmpty);
    expect(requests.last['reload'], true);
    expect(session.error, isNull);
    session.dispose();
  });

  testWidgets(
    'bounds geometry, coalesces motion, and stops after invalid replies',
    (tester) async {
      final requests = <Map<String, dynamic>>[];
      var invalid = false;
      final session = InteractiveViewerSession((payload) async {
        requests.add(payload);
        return invalid ? {'data': 'bad!', 'mime': 'image/jpeg'} : picture();
      });
      session.configure(const Size(9000, 40), true);
      await tester.pump(const Duration(milliseconds: 1));
      expect(requests.first['width'], 1920);
      expect(requests.first['height'], 120);
      for (var i = 0; i < 100; i++) {
        session.input({'type': 'pointer', 'event': 'mouseMoved', 'x': i});
      }
      session.input({'type': 'pointer', 'event': 'mousePressed'});
      session.input({'type': 'pointer', 'event': 'mouseMoved', 'x': 100});
      invalid = true;
      await tester.pump(const Duration(milliseconds: 1));
      expect(requests.last['events'], [
        {'type': 'pointer', 'event': 'mouseMoved', 'x': 99},
        {'type': 'pointer', 'event': 'mousePressed'},
        {'type': 'pointer', 'event': 'mouseMoved', 'x': 100},
      ]);
      expect(session.error, isNotNull);
      final before = requests.length;
      await tester.pump(const Duration(seconds: 10));
      expect(requests, hasLength(before));
      session.dispose();
    },
  );
  testWidgets(
    'renderer refusals preserve recovery guidance from the real RPC transport',
    (tester) async {
      final session = InteractiveViewerSession((payload) async {
        if (payload['op'] == 'close') return {'closed': true};
        throw const WsRequestFailure(
          responseType: 'viewer_surface_result',
          code: 'VIEWER_LIMIT',
          detail: 'Close another viewer to open this one.',
        );
      });
      session.configure(const Size(800, 600), false);
      await tester.pump(const Duration(milliseconds: 1));
      expect(session.error, 'Close another viewer to open this one.');
      session.dispose();
    },
  );
}

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

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
  Map<String, dynamic> streamed(int seq) => {...picture(), 'seq': seq, 'scale': 2};

  testWidgets('stays inside v1 until the machine answers with seq', (tester) async {
    final requests = <Map<String, dynamic>>[];
    final session = InteractiveViewerSession((payload) async {
      requests.add(payload);
      return picture();
    });
    session.configure(const Size(3000, 2000), true, scale: 2);
    await tester.pump(const Duration(milliseconds: 1));
    expect(requests.first['width'], 1920);
    expect(requests.first['height'], 1200);
    expect(requests.first.containsKey('after'), isFalse);
    expect(session.isV2, isFalse);
    session.dispose();
  });

  testWidgets('long-polls after seq and sends input as its own request', (tester) async {
    final requests = <Map<String, dynamic>>[];
    final polls = <Completer<Map<String, dynamic>>>[];
    final session = InteractiveViewerSession((payload) {
      requests.add(payload);
      if (payload['op'] == 'close') return Future.value({'closed': true});
      if (payload['op'] == 'input') return Future.value({'ok': true, 'seq': 1, 'editable': true});
      final reply = Completer<Map<String, dynamic>>();
      polls.add(reply);
      return reply.future;
    });
    session.configure(const Size(800, 600), true, scale: 2);
    await tester.pump(const Duration(milliseconds: 1));
    polls[0].complete(streamed(1));
    await tester.pump(const Duration(milliseconds: 1));
    expect(session.isV2, isTrue);
    expect(requests.last, containsPair('after', 1));
    expect(requests.last, containsPair('scale', 2.0));
    session.input({'type': 'text', 'text': 'hi'});
    await tester.pump(const Duration(milliseconds: 1));
    final input = requests.lastWhere((r) => r['op'] == 'input');
    expect(input['events'], [{'type': 'text', 'text': 'hi'}]);
    expect(session.editable, isTrue);
    polls.last.complete({'seq': 1, 'unchanged': true});
    await tester.pump(const Duration(milliseconds: 1));
    expect(requests.last['op'], 'frame');
    session.dispose();
  });

  testWidgets('a resize goes out as an empty input, debounced', (tester) async {
    final requests = <Map<String, dynamic>>[];
    final session = InteractiveViewerSession((payload) {
      requests.add(payload);
      if (payload['op'] == 'input') return Future.value({'ok': true, 'seq': 1});
      if (requests.where((r) => r['op'] == 'frame').length == 1) return Future.value(streamed(1));
      return Completer<Map<String, dynamic>>().future; // a poll that keeps waiting
    });
    session.configure(const Size(800, 600), true);
    await tester.pump(const Duration(milliseconds: 1));
    session.configure(const Size(900, 600), true);
    session.configure(const Size(1000, 600), true);
    await tester.pump(const Duration(milliseconds: 50));
    expect(requests.where((r) => r['op'] == 'input'), isEmpty);
    await tester.pump(const Duration(milliseconds: 100));
    final resize = requests.where((r) => r['op'] == 'input').toList();
    expect(resize, hasLength(1));
    expect(resize.single['width'], 1000);
    expect(resize.single['events'], isEmpty);
    session.dispose();
  });

  testWidgets('a resize that lands while input is in flight goes out when it returns', (tester) async {
    final requests = <Map<String, dynamic>>[];
    final typing = Completer<Map<String, dynamic>>();
    final session = InteractiveViewerSession((payload) {
      requests.add(payload);
      if (payload['op'] == 'close') return Future.value({'closed': true});
      if (payload['op'] == 'input') {
        return requests.where((r) => r['op'] == 'input').length == 1 ? typing.future : Future.value({'ok': true, 'seq': 1});
      }
      if (requests.where((r) => r['op'] == 'frame').length == 1) return Future.value(streamed(1));
      return Completer<Map<String, dynamic>>().future; // a poll that keeps waiting
    });
    session.configure(const Size(800, 600), true);
    await tester.pump(const Duration(milliseconds: 1));
    session.input({'type': 'text', 'text': 'a'});
    await tester.pump(const Duration(milliseconds: 1));
    session.configure(const Size(1000, 600), true);
    await tester.pump(const Duration(milliseconds: 150)); // the resize timer fires while typing is in flight
    typing.complete({'ok': true, 'seq': 1});
    await tester.pump(const Duration(milliseconds: 1));
    final inputs = requests.where((r) => r['op'] == 'input').toList();
    expect(inputs, hasLength(2));
    expect(inputs.last['width'], 1000);
    expect(inputs.last['events'], isEmpty);
    session.dispose();
  });

  testWidgets('a copied selection lands on the clipboard callback', (tester) async {
    final copied = <String>[];
    final session = InteractiveViewerSession((payload) {
      if (payload['op'] == 'input') return Future.value({'ok': true, 'seq': 1, 'clipboard': 'hello'});
      if (payload['op'] == 'close') return Future.value({'closed': true});
      return payload.containsKey('after') ? Completer<Map<String, dynamic>>().future : Future.value(streamed(1));
    }, onClipboard: copied.add);
    session.configure(const Size(800, 600), true);
    await tester.pump(const Duration(milliseconds: 1));
    session.input({'type': 'copy'});
    await tester.pump(const Duration(milliseconds: 1));
    expect(copied, ['hello']);
    session.dispose();
  });

  testWidgets('host actions on an unchanged v2 reply are delivered', (tester) async {
    final actions = <Map<String, dynamic>>[];
    var polls = 0;
    final session = InteractiveViewerSession((payload) {
      if (payload['op'] == 'close') return Future.value({'closed': true});
      if (payload.containsKey('after')) {
        if (++polls > 1) return Completer<Map<String, dynamic>>().future;
        return Future.value({'seq': 1, 'unchanged': true, 'hostActions': [{'action': 'assistant'}]});
      }
      return Future.value(streamed(1));
    }, onHostAction: actions.add);
    session.configure(const Size(800, 600), true);
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump(const Duration(milliseconds: 1));
    expect(actions, [{'action': 'assistant'}]);
    session.dispose();
  });

  testWidgets('a pushed frame arrives as bytes; base64 data still works', (tester) async {
    final replies = <Completer<Map<String, dynamic>>>[];
    final session = InteractiveViewerSession((payload) {
      if (payload['op'] != 'frame') return Future.value({'ok': true});
      replies.add(Completer());
      return replies.last.future;
    });
    session.configure(const Size(800, 600), true);
    await tester.pump(const Duration(milliseconds: 1));
    replies.last.complete({'bytes': Uint8List.fromList([7, 8]), 'mime': 'image/jpeg', 'seq': 1});
    await tester.pump(const Duration(milliseconds: 1));
    expect(session.error, isNull);
    expect(session.image, [7, 8]);
    replies.last.complete(streamed(2));
    await tester.pump(const Duration(milliseconds: 1));
    expect(session.image, [1, 2, 3]);
    session.dispose();
  });
}

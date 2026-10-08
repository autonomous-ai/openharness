import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/community/viewer_picture.dart';

void main() {
  test('keeps the second frame, after the viewer has drawn, and closes the surface', () async {
    final calls = <Map<String, dynamic>>[];
    var frames = 0;
    final picture = await captureViewer((payload) async {
      calls.add(payload);
      if (payload['op'] == 'close') return {'closed': true};
      return {'mime': 'image/jpeg', 'data': 'frame${++frames}'};
    }, settle: Duration.zero);
    expect(picture, 'frame2');
    expect(calls.map((c) => c['op']), ['frame', 'frame', 'close']);
    expect(calls.first, containsPair('width', 1280));
    expect(calls.first['surfaceId'], calls.last['surfaceId']);
  });

  test('gives nothing when the viewer cannot be pictured', () async {
    Future<String?> capture(Map<String, dynamic> reply) => captureViewer(
      (payload) async => payload['op'] == 'close' ? {} : reply,
      settle: Duration.zero,
    );
    expect(await capture({'error': 'VIEWER_UNAVAILABLE'}), isNull);
    expect(await capture({'mime': 'image/png', 'data': 'x'}), isNull);
    expect(
      await captureViewer(
        (_) => Future.error(StateError('Reconnect')),
        settle: Duration.zero,
      ),
      isNull,
    );
  });

  test(
    'a viewer that does not answer is given up on, not waited for',
    () async {
      final never = Completer<Map<String, dynamic>>();
      final picture = await captureViewer(
        (payload) => payload['op'] == 'close' ? Future.value({}) : never.future,
        settle: Duration.zero,
        timeout: const Duration(milliseconds: 20),
      );
      expect(picture, isNull);
    },
  );

  test('a poster page carries the picture and escapes the title', () {
    final page = viewerPosterPage('<Lamp> & "light"', 'AAAA');
    expect(page, contains('src="data:image/jpeg;base64,AAAA"'));
    expect(page, contains('&lt;Lamp&gt; &amp; &quot;light&quot;'));
    expect(page, isNot(contains('<Lamp>')));
  });
}

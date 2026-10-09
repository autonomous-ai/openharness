import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/surface/interactive_viewer_session.dart';
import 'package:harness_mobile/surface/touch_viewer_surface.dart';

Map<String, dynamic> streamed(int seq) => {
  'data': base64Encode([1, 2, 3]),
  'mime': 'image/jpeg',
  'width': 390,
  'height': 700,
  'scale': 3,
  'seq': seq,
};

void main() {
  testWidgets('a phone surface asks for mobile layout and touch', (tester) async {
    final requests = <Map<String, dynamic>>[];
    final session = InteractiveViewerSession((payload) {
      requests.add(payload);
      return payload.containsKey('after')
          ? Completer<Map<String, dynamic>>().future
          : Future.value(streamed(1));
    }, mobile: true, touch: true);
    session.configure(const Size(390, 700), true, scale: 3);
    await tester.pump(const Duration(milliseconds: 1));
    expect(requests.first, containsPair('mobile', true));
    expect(requests.first, containsPair('touch', true));
    expect(requests.last, containsPair('scale', 3.0));
    session.dispose();
  });

  testWidgets('a drag becomes touch events with moves coalesced', (tester) async {
    final inputs = <Map<String, dynamic>>[];
    final session = InteractiveViewerSession((payload) {
      if (payload['op'] == 'input') {
        inputs.addAll((payload['events'] as List).cast<Map<String, dynamic>>());
        return Future.value({'ok': true, 'seq': 1});
      }
      if (payload['op'] == 'close') return Future.value({'closed': true});
      return payload.containsKey('after')
          ? Completer<Map<String, dynamic>>().future
          : Future.value(streamed(1));
    }, mobile: true, touch: true);
    await tester.pumpWidget(MaterialApp(
      home: SizedBox(width: 390, height: 700, child: TouchViewerSurface(session: session)),
    ));
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump(const Duration(milliseconds: 1));
    final gesture = await tester.startGesture(const Offset(195, 350));
    await gesture.moveBy(const Offset(0, -40));
    await gesture.moveBy(const Offset(0, -40));
    await gesture.up();
    await tester.pump(const Duration(milliseconds: 1));
    final kinds = inputs.map((e) => e['event']).toList();
    expect(kinds.first, 'touchStart');
    expect(kinds.last, 'touchEnd');
    expect(inputs.last['points'], hasLength(1));
    expect(inputs.every((e) => e['type'] == 'touch'), isTrue);
    session.dispose();
  });

  // A session whose input replies are scripted; frames are the 3-byte fake, polls never answer.
  InteractiveViewerSession rig(
    List<List<Map<String, dynamic>>> batches, {
    Future<Map<String, dynamic>> Function()? reply,
  }) => InteractiveViewerSession((payload) {
    if (payload['op'] == 'input') {
      batches.add((payload['events'] as List).cast<Map<String, dynamic>>());
      return reply != null ? reply() : Future.value({'ok': true, 'seq': 1});
    }
    if (payload['op'] == 'close') return Future.value({'closed': true});
    return payload.containsKey('after')
        ? Completer<Map<String, dynamic>>().future
        : Future.value(streamed(1));
  }, mobile: true, touch: true);

  Future<void> mount(WidgetTester tester, InteractiveViewerSession session) async {
    await tester.pumpWidget(MaterialApp(
      home: SizedBox(width: 390, height: 700, child: TouchViewerSurface(session: session)),
    ));
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump(const Duration(milliseconds: 1));
  }

  testWidgets('moves queued behind a pending input request coalesce into one', (tester) async {
    final batches = <List<Map<String, dynamic>>>[];
    final pending = Completer<Map<String, dynamic>>();
    var first = true;
    final session = rig(batches, reply: () {
      if (!first) return Future.value({'ok': true, 'seq': 1});
      first = false;
      return pending.future;
    });
    await mount(tester, session);
    final g = await tester.startGesture(const Offset(195, 350));
    await g.moveBy(const Offset(0, -10));
    await g.moveBy(const Offset(0, -10));
    await g.moveBy(const Offset(0, -10));
    pending.complete({'ok': true, 'seq': 1});
    await tester.pump(const Duration(milliseconds: 1));
    await g.up();
    await tester.pump(const Duration(milliseconds: 1));
    expect(batches.first.map((e) => e['event']), ['touchStart']);
    expect(batches[1].map((e) => e['event']), ['touchMove']);
    session.dispose();
  });

  testWidgets('a sixth finger is ignored on down, move and up', (tester) async {
    final batches = <List<Map<String, dynamic>>>[];
    final session = rig(batches);
    await mount(tester, session);
    final fingers = <TestGesture>[];
    for (var i = 0; i < 5; i++) {
      fingers.add(await tester.startGesture(Offset(50.0 + i * 40, 300), pointer: i + 1));
      await tester.pump(const Duration(milliseconds: 1));
    }
    final before = batches.expand((b) => b).length;
    final sixth = await tester.startGesture(const Offset(300, 500), pointer: 6);
    await sixth.moveBy(const Offset(10, 0));
    await sixth.up();
    await tester.pump(const Duration(milliseconds: 1));
    expect(batches.expand((b) => b).length, before);
    expect(batches.expand((b) => b).every((e) => (e['points'] as List).length <= 5), isTrue);
    for (final f in fingers) {
      await f.up();
    }
    session.dispose();
  });

  // Chrome releases the points a touchEnd lists: naming the finger still down released it instead.
  testWidgets('lifting one of two fingers sends touchEnd with the lifted point', (tester) async {
    final batches = <List<Map<String, dynamic>>>[];
    final session = rig(batches);
    await mount(tester, session);
    final a = await tester.startGesture(const Offset(100, 300), pointer: 1);
    await tester.pump(const Duration(milliseconds: 1));
    final b = await tester.startGesture(const Offset(200, 300), pointer: 2);
    await tester.pump(const Duration(milliseconds: 1));
    await a.up();
    await tester.pump(const Duration(milliseconds: 1));
    final last = batches.expand((x) => x).last;
    expect(last['event'], 'touchEnd');
    expect(last['points'], hasLength(1));
    expect((last['points'] as List).single['id'], 1);
    await b.up();
    await tester.pump(const Duration(milliseconds: 1));
    final end = batches.expand((x) => x).last;
    expect(end['event'], 'touchEnd');
    expect((end['points'] as List).single['id'], 2);
    session.dispose();
  });

  testWidgets('on a v1 machine one finger drives the mouse and touch is never sent', (tester) async {
    final events = <Map<String, dynamic>>[];
    // A v1 machine: frame replies carry no seq and input rides on the frame requests.
    final session = InteractiveViewerSession((payload) {
      if (payload['op'] == 'close') return Future.value({'closed': true});
      events.addAll((payload['events'] as List? ?? const []).cast<Map<String, dynamic>>());
      return Future.value({'data': base64Encode([1, 2, 3]), 'mime': 'image/jpeg', 'width': 390, 'height': 700});
    }, mobile: true, touch: true);
    await mount(tester, session);
    expect(session.isV2, isFalse);
    final a = await tester.startGesture(const Offset(195, 350), pointer: 1);
    await tester.pump(const Duration(milliseconds: 1));
    final b = await tester.startGesture(const Offset(100, 100), pointer: 2);
    await a.moveBy(const Offset(0, -35));
    await b.moveBy(const Offset(10, 0));
    await b.up();
    await a.up();
    await tester.pump(const Duration(milliseconds: 1));
    expect(events.map((e) => e['type']).toSet(), {'pointer'});
    expect(events.map((e) => e['event']), ['mousePressed', 'mouseMoved', 'mouseReleased']);
    // The surface fills the 800×600 test screen.
    expect(events.first, {
      'type': 'pointer', 'event': 'mousePressed', 'x': 195 / 800, 'y': 350 / 600,
      'buttons': 1, 'button': 'left', 'clickCount': 1, 'modifiers': 0,
    });
    expect(events[1], containsPair('clickCount', 0));
    expect(events[1], containsPair('y', 315 / 600));
    expect(events.last, containsPair('buttons', 0));
    expect(events.last, containsPair('clickCount', 1));
    session.dispose();
  });

  testWidgets('the keyboard follows editable and a tap brings it back', (tester) async {
    final batches = <List<Map<String, dynamic>>>[];
    final session = rig(batches, reply: () => Future.value({'ok': true, 'seq': 1, 'editable': true}));
    await mount(tester, session);
    final g = await tester.startGesture(const Offset(195, 350));
    await g.up();
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump(const Duration(milliseconds: 1));
    expect(tester.testTextInput.isVisible, isTrue);
    tester.testTextInput.hide();
    expect(tester.testTextInput.isVisible, isFalse);
    final t = await tester.startGesture(const Offset(195, 350));
    await t.up();
    await tester.pump(const Duration(milliseconds: 1));
    expect(tester.testTextInput.isVisible, isTrue);
    expect(session.focusInput, isNotNull);
    session.dispose();
  });

  testWidgets('an error screen drops stale fingers and re-requests the keyboard after Retry', (tester) async {
    final batches = <List<Map<String, dynamic>>>[];
    var editable = true;
    final session = rig(batches, reply: () => Future.value({'ok': true, 'seq': 1, 'editable': editable}));
    await mount(tester, session);
    // Fingers 1-5 go down, then the page errors out and the Listener unmounts mid-gesture.
    for (var i = 1; i <= 5; i++) {
      await tester.startGesture(Offset(50.0 + i * 40, 300), pointer: i);
    }
    await tester.pump(const Duration(milliseconds: 1));
    session.error = 'boom';
    // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
    session.notifyListeners();
    await tester.pump();
    expect(find.text('boom'), findsOneWidget);
    session.error = null;
    // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
    session.notifyListeners();
    await tester.pump();
    batches.clear();
    editable = true;
    final g = await tester.startGesture(const Offset(195, 350), pointer: 9);
    await g.up();
    await tester.pump(const Duration(milliseconds: 1));
    expect(batches.expand((b) => b).map((e) => e['event']), contains('touchStart'));
    expect(tester.testTextInput.isVisible, isTrue);
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

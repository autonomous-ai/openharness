import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/web/parts/deferred_part.dart';

/// A part whose download the test finishes by hand, like a slow phone link.
class _Download {
  var calls = 0;
  Completer<void> pending = Completer<void>();

  Future<void> call() {
    calls++;
    return pending.future;
  }

  void fail() =>
      pending.completeError(Exception('net::ERR_INTERNET_DISCONNECTED'));

  void next() => pending = Completer<void>();
}

Widget _host(DeferredPart part) => MaterialApp(
  home: Scaffold(
    body: DeferredPartView(part: part, builder: (_) => const Text('Finder')),
  ),
);

void main() {
  testWidgets('waits with a loading line, then draws the part', (tester) async {
    final download = _Download();
    await tester.pumpWidget(_host(DeferredPart(download.call)));

    expect(find.text('Loading…'), findsOneWidget);
    expect(find.text('Finder'), findsNothing);

    download.pending.complete();
    await tester.pump();

    expect(find.text('Finder'), findsOneWidget);
    expect(find.text('Loading…'), findsNothing);
  });

  testWidgets('a failed download says so and Retry downloads it again', (
    tester,
  ) async {
    final download = _Download();
    await tester.pumpWidget(_host(DeferredPart(download.call)));
    download.fail();
    await tester.pump();

    expect(find.text('Could not load this part of Harness'), findsOneWidget);
    expect(find.text('Finder'), findsNothing);

    download.next();
    await tester.tap(find.text('Retry'));
    await tester.pump();
    expect(download.calls, 2);
    expect(find.text('Loading…'), findsOneWidget);

    download.pending.complete();
    await tester.pump();
    expect(find.text('Finder'), findsOneWidget);
  });

  testWidgets(
    'a part already downloaded draws at once, with no loading frame',
    (tester) async {
      final download = _Download()..pending.complete();
      final part = DeferredPart(download.call);
      await part.load();

      await tester.pumpWidget(_host(part));

      expect(find.text('Finder'), findsOneWidget);
      expect(download.calls, 1);
    },
  );

  testWidgets('two places opening one part download it once', (tester) async {
    final download = _Download();
    final part = DeferredPart(download.call);
    await tester.pumpWidget(
      MaterialApp(
        home: Column(
          children: [
            DeferredPartView(part: part, builder: (_) => const Text('one')),
            DeferredPartView(part: part, builder: (_) => const Text('two')),
          ],
        ),
      ),
    );
    download.pending.complete();
    await tester.pump();

    expect(download.calls, 1);
    expect(find.text('one'), findsOneWidget);
    expect(find.text('two'), findsOneWidget);
  });

  testWidgets('Retry is a 44 px target on a phone', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final download = _Download();
    await tester.pumpWidget(_host(DeferredPart(download.call)));
    download.fail();
    await tester.pump();

    final retry = tester.getSize(
      find.ancestor(of: find.text('Retry'), matching: find.byType(TextButton)),
    );
    expect(retry.width, greaterThanOrEqualTo(44));
    expect(retry.height, greaterThanOrEqualTo(44));
  });

  test('a run that needs the part waits for it and fails as it does', () async {
    final download = _Download();
    final part = DeferredPart(download.call);

    final run = part.run(() => 'opened');
    download.fail();
    await expectLater(run, throwsException);

    download.next();
    final again = part.run(() => 'opened');
    download.pending.complete();
    expect(await again, 'opened');
    expect(download.calls, 2);
  });
}

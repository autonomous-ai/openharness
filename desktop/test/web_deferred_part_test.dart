import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/web/parts/deferred_part.dart';

/// A part whose download the test finishes by hand, like a slow phone link.
/// Asked again while a download is pending, it hands back that same download,
/// as dart2js's loadLibrary does; [next] starts a fresh one after a failure.
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

Widget _host(DeferredPart part, {VoidCallback? reload}) => MaterialApp(
  home: Scaffold(
    body: DeferredPartView(
      part: part,
      reload: reload ?? () {},
      builder: (_) => const Text('Finder'),
    ),
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

  testWidgets('it stands on its own above any page, as the workspace does', (
    tester,
  ) async {
    final download = _Download();
    await tester.pumpWidget(
      MaterialApp(
        home: DeferredPartView(
          part: DeferredPart(download.call),
          builder: (_) => const Text('Finder'),
        ),
      ),
    );
    download.fail();
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.text('Retry'), findsOneWidget);
    // Not the bare framework's missing-Material style: underlined in yellow.
    for (final line in [
      'Could not load this part of Harness',
      'Check the connection, then retry.',
    ]) {
      final drawn = tester.widget<RichText>(
        find.descendant(of: find.text(line), matching: find.byType(RichText)),
      );
      expect(drawn.text.style?.decoration, isNot(TextDecoration.underline));
    }
  });

  testWidgets('a download that stalls offers Reload after about 20 s', (
    tester,
  ) async {
    final download = _Download();
    var reloads = 0;
    await tester.pumpWidget(
      _host(DeferredPart(download.call), reload: () => reloads++),
    );

    await tester.pump(const Duration(seconds: 19));
    expect(find.text('Reload'), findsNothing);
    await tester.pump(const Duration(seconds: 2));
    expect(find.text('Still loading this part of Harness'), findsOneWidget);
    expect(find.text('Loading…'), findsNothing);
    // Asking dart2js again would only wait on the same download.
    expect(find.text('Retry'), findsNothing);

    await tester.tap(find.text('Reload'));
    expect(reloads, 1);
    expect(download.calls, 1);

    // A stalled download that lands after all still draws the part.
    download.pending.complete();
    await tester.pump();
    expect(find.text('Finder'), findsOneWidget);
  });

  testWidgets(
    'a Retry that fails again says Harness may have been updated, and offers Reload',
    (tester) async {
      final download = _Download();
      var reloads = 0;
      await tester.pumpWidget(
        _host(DeferredPart(download.call), reload: () => reloads++),
      );
      download.fail();
      await tester.pump();
      expect(find.text('Reload'), findsNothing);

      download.next();
      await tester.tap(find.text('Retry'));
      await tester.pump();
      download.fail();
      await tester.pump();

      expect(
        find.text(
          'Harness may have been updated since this page opened. '
          'Reload the page to get the new version.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('Reload'));
      expect(reloads, 1);
      expect(find.text('Retry'), findsOneWidget);
    },
  );

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
}

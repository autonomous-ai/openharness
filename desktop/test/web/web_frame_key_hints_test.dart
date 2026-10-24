@TestOn('browser')
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/shortcuts_browser.dart';
import 'package:harness/web/web_entry.dart';
import 'package:harness/widgets/key_hints.dart';

void main() {
  // The frame stands above the Navigator, as `HarnessApp` places it, so every
  // screen and route of the browser build reads key hints off (audit S8).
  testWidgets('the web frame turns key hints off on every screen', (
    tester,
  ) async {
    final hints = <bool>[];
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: navigator,
        builder: (context, child) => appFrame(child!),
        home: Builder(
          builder: (context) {
            hints.add(KeyHints.visibleOf(context));
            return const SizedBox.shrink();
          },
        ),
      ),
    );
    expect(hints.last, isFalse);

    unawaited(
      navigator.currentState!.push(
        MaterialPageRoute<void>(
          builder: (_) => Scaffold(body: ShortcutsBrowser(onClose: () {})),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('shortcuts-search')), findsOneWidget);
    expect(find.text('↑↓ Browse'), findsNothing);
    expect(find.text('Return Practice'), findsNothing);
  });
}

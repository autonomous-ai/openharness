import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/buddy_sandbox_prompt.dart';

class _Fake implements BuddySandboxInstaller {
  _Fake({this.isReady = false, this.failure});
  final bool isReady;
  String? failure;
  final Completer<void> gate = Completer<void>();
  void Function(String line)? say;
  int installs = 0;

  @override
  Future<bool> ready() async => isReady;

  @override
  Future<String?> install(void Function(String line) progress) async {
    installs++;
    say = progress;
    await gate.future;
    return failure;
  }
}

void main() {
  setUp(resetBuddySandboxPromptForTest);

  Future<List<int>> pump(WidgetTester tester, _Fake fake) async {
    final restarts = <int>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: BuddySandboxPrompt(
            installer: fake,
            restart: () async => restarts.add(1),
          ),
        ),
      ),
    );
    await tester.pump();
    return restarts;
  }

  testWidgets('says nothing where it is already set up', (tester) async {
    await pump(tester, _Fake(isReady: true));
    expect(find.byKey(const ValueKey('buddy-sandbox-prompt')), findsNothing);
  });

  testWidgets('asks once, tells them what Windows will do, then restarts the '
      'Buddy', (tester) async {
    final fake = _Fake();
    final restarts = await pump(tester, fake);
    expect(find.text(kBuddySandboxQuestion), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('buddy-sandbox-allow')));
    await tester.pump();
    expect(find.textContaining('Windows will ask you once'), findsOneWidget);
    expect(find.byKey(const ValueKey('buddy-sandbox-allow')), findsNothing);
    fake.say!('Letting your Buddy read your files.');
    await tester.pump();
    expect(find.text('Letting your Buddy read your files.'), findsOneWidget);
    fake.gate.complete();
    await tester.pumpAndSettle();
    expect(restarts, [1]);
    expect(find.byKey(const ValueKey('buddy-sandbox-prompt')), findsNothing);
  });

  testWidgets('shows why it failed, restarts nothing, and can try again', (
    tester,
  ) async {
    final fake = _Fake(failure: 'Windows did not get a yes.');
    final restarts = await pump(tester, fake);
    await tester.tap(find.byKey(const ValueKey('buddy-sandbox-allow')));
    await tester.pump();
    fake.gate.complete();
    await tester.pumpAndSettle();
    expect(find.text('Windows did not get a yes.'), findsOneWidget);
    expect(restarts, isEmpty);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets('Not now holds for every Buddy bar while the app runs', (
    tester,
  ) async {
    await pump(tester, _Fake());
    await tester.tap(find.byKey(const ValueKey('buddy-sandbox-not-now')));
    await tester.pump();
    expect(find.byKey(const ValueKey('buddy-sandbox-prompt')), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await pump(tester, _Fake());
    expect(find.byKey(const ValueKey('buddy-sandbox-prompt')), findsNothing);
  });
}

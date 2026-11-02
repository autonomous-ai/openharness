import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/swarm_accounts.dart';

const work = SwarmAccount(
  engine: 'claude',
  path: '/h/.claude-work',
  label: 'Work',
  offered: false,
);
const two = SwarmAccount(
  engine: 'codex',
  path: '/h/.codex-two',
  label: 'Two',
  offered: true,
);

void main() {
  Future<void> open(
    WidgetTester tester, {
    required Future<List<SwarmAccount>> Function() load,
    Future<String?> Function(SwarmAccount, bool)? set,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SwarmAccountsDialog(
            load: load,
            setOffered: set ?? (_, _) async => null,
          ),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets(
    'says who can spend an offered account before anything is offered',
    (tester) async {
      await open(tester, load: () async => [work, two]);
      expect(
        find.textContaining(
          'Other people’s PMs on this Mac can run on an offered account and spend its usage.',
        ),
        findsOneWidget,
      );
      expect(
        find.textContaining('keeps running until someone moves it'),
        findsOneWidget,
      );
      expect(find.text('Claude · Work'), findsOneWidget);
      expect(find.text('Not offered'), findsOneWidget);
      expect(find.text('Codex · Two'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Offer'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Withdraw'), findsOneWidget);
    },
  );

  testWidgets(
    'offers and withdraws only what was pressed, and reads the list back',
    (tester) async {
      final asked = <(String, bool)>[];
      var rows = [work, two];
      await open(
        tester,
        load: () async => rows,
        set: (a, on) async {
          asked.add((a.label, on));
          rows = [
            for (final r in rows)
              r.label == a.label
                  ? SwarmAccount(
                      engine: r.engine,
                      path: r.path,
                      label: r.label,
                      offered: on,
                    )
                  : r,
          ];
          return null;
        },
      );
      expect(asked, isEmpty);
      await tester.tap(find.widgetWithText(TextButton, 'Offer'));
      await tester.pump();
      expect(asked, [('Work', true)]);
      expect(find.widgetWithText(TextButton, 'Offer'), findsNothing);
      await tester.tap(find.widgetWithText(TextButton, 'Withdraw').first);
      await tester.pump();
      expect(asked, [('Work', true), ('Work', false)]);
    },
  );

  testWidgets('a refusal is shown and changes nothing', (tester) async {
    await open(
      tester,
      load: () async => [work],
      set: (_, _) async => 'That account’s folder is gone.',
    );
    await tester.tap(find.widgetWithText(TextButton, 'Offer'));
    await tester.pump();
    expect(find.text('That account’s folder is gone.'), findsOneWidget);
    expect(find.text('Not offered'), findsOneWidget);
  });

  testWidgets('a failed read is no stuck Loading, and Try again recovers', (
    tester,
  ) async {
    var fail = true;
    await open(
      tester,
      load: () async {
        if (fail) throw StateError('unreachable');
        return [work];
      },
    );
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(
      find.text('Couldn’t read this computer’s accounts.'),
      findsOneWidget,
    );
    fail = false;
    await tester.tap(find.text('Try again'));
    await tester.pump();
    expect(find.text('Claude · Work'), findsOneWidget);
    expect(find.text('Couldn’t read this computer’s accounts.'), findsNothing);
  });

  testWidgets('says so when no other account is on this computer', (
    tester,
  ) async {
    await open(tester, load: () async => const []);
    expect(
      find.text('No other accounts on this computer yet.'),
      findsOneWidget,
    );
  });

  testWidgets('a second press while one is on its way sends nothing', (
    tester,
  ) async {
    final gate = Completer<String?>();
    var calls = 0;
    await open(
      tester,
      load: () async => [work],
      set: (_, _) {
        calls++;
        return gate.future;
      },
    );
    await tester.tap(find.widgetWithText(TextButton, 'Offer'));
    await tester.pump();
    await tester.tap(
      find.widgetWithText(TextButton, 'Offer'),
      warnIfMissed: false,
    );
    await tester.pump();
    expect(calls, 1);
    gate.complete(null);
    await tester.pump();
  });

  testWidgets(
    'an answer that arrives after the dialog closed changes nothing',
    (tester) async {
      final gate = Completer<List<SwarmAccount>>();
      await open(tester, load: () => gate.future);
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      gate.complete([work]);
      await tester.pump();
      expect(tester.takeException(), isNull);
    },
  );
}

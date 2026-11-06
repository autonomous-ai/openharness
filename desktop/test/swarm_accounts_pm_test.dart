import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/pm_accounts.dart';
import 'package:harness/super_tabs/swarm_accounts.dart';

PmAccount account(
  String id, {
  bool use = true,
  bool signedIn = true,
  List<String> here = const [],
  int five = 100,
  int week = 100,
  DateTime? resets,
}) => PmAccount(
  id: id,
  label: id,
  email: '$id@x.test',
  pmMayUse: use,
  pmHere: here,
  signedIn: signedIn,
  windows: [
    PmWindow(name: '5-hour', leftPercent: five),
    PmWindow(name: 'weekly', leftPercent: week, resetsAt: resets),
  ],
);

void main() {
  Future<void> open(
    WidgetTester tester, {
    Future<List<PmAccount>?> Function()? pm,
    Future<String?> Function(List<String>, bool)? use,
    Future<List<PmMove>?> Function()? moves,
  }) async {
    await tester.binding.setSurfaceSize(const Size(900, 1400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SwarmAccountsDialog(
            load: () async => const [],
            setOffered: (_, _) async => null,
            loadPm: pm,
            setPmUse: use,
            loadMoves: moves,
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
  }

  testWidgets('ticks call setPmAccountUse for that account only', (
    tester,
  ) async {
    final asked = <String>[];
    await open(
      tester,
      pm: () async => [account('a'), account('b', use: false)],
      use: (ids, on) async {
        asked.add('${ids.join(',')}:$on');
        return null;
      },
    );
    await tester.tap(find.byKey(const ValueKey('pm-use-b')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('pm-use-a')));
    await tester.pump();
    expect(asked, ['b:true', 'a:false']);
  });

  testWidgets('shows both windows', (tester) async {
    await open(tester, pm: () async => [account('a', five: 72, week: 58)]);
    expect(find.text('5-hour 72% left'), findsOneWidget);
    expect(find.text('Week 58% left'), findsOneWidget);
  });

  testWidgets('a chip per state', (tester) async {
    final reset = DateTime.now().add(const Duration(days: 3));
    await open(
      tester,
      pm: () async => [
        account('here', here: ['River']),
        account('ready'),
        account('out', week: 0, resets: reset),
        account('off', signedIn: false),
      ],
    );
    expect(find.text('PM is here'), findsOneWidget);
    expect(find.text('Ready'), findsOneWidget);
    expect(find.textContaining('Out until '), findsOneWidget);
    expect(find.text('Sign in again'), findsOneWidget);
    expect(
      find.textContaining('moves to the ticked account with the most'),
      findsOneWidget,
    );
  });

  testWidgets('an older CLI hides all of it without an error', (tester) async {
    await open(tester, pm: () async => null, moves: () async => null);
    expect(find.text('PM may use'), findsNothing);
    expect(find.text('Moves'), findsNothing);
    expect(find.byType(Checkbox), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('moves are listed newest first', (tester) async {
    final now = DateTime.now();
    PmMove move(Duration ago, String from, String to) => PmMove(
      at: now.subtract(ago),
      pm: 'River',
      from: from,
      to: to,
      why: 'low',
      window: 'weekly',
      leftPercent: 4,
      awayMs: 9000,
      ok: true,
    );
    await open(
      tester,
      pm: () async => [account('old'), account('mid'), account('new')],
      moves: () async => [
        move(const Duration(days: 2), 'old', 'mid'),
        move(const Duration(minutes: 5), 'mid', 'new'),
      ],
    );
    expect(find.text('Moves'), findsOneWidget);
    final newer = tester
        .getTopLeft(find.textContaining('mid@x.test → new@x.test'))
        .dy;
    final older = tester
        .getTopLeft(find.textContaining('old@x.test → mid@x.test'))
        .dy;
    expect(newer, lessThan(older));
    expect(find.textContaining('9 s'), findsNWidgets(2));
  });
}

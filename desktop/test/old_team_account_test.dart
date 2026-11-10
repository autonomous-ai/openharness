import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_cli_runner.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/old_team_account.dart';

void main() {
  setUp(() => OldTeamAccountAsk.askedThisLaunch = false);

  /// The workspace as the app shell wraps it, on a computer where [here] says
  /// whether an old Team account is, removing it with [remove].
  Future<void> openWorkspace(
    WidgetTester tester, {
    required Future<bool> Function() here,
    required Future<TeamAccountRemoval> Function() remove,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: OldTeamAccountAsk(
            here: here,
            remove: remove,
            child: const Text('workspace'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  const line =
      'An old Harness Team account is still on this computer. Remove it.';

  testWidgets(
    'asks at once on a computer with one, removes it with its one action, and says so',
    (tester) async {
      var removals = 0;
      final done = Completer<TeamAccountRemoval>();
      await openWorkspace(
        tester,
        here: () async => true,
        remove: () {
          removals++;
          return done.future;
        },
      );
      expect(find.text(line), findsOneWidget);
      // One action, and nothing closes it before it has run.
      expect(find.byKey(const Key('old-team-account-close')), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text(line), findsOneWidget);

      await tester.tap(find.text('Remove'));
      await tester.pump();
      expect(
        find.text('Waiting for the administrator prompt…'),
        findsOneWidget,
      );
      expect(find.text('Remove'), findsNothing);
      done.complete(const TeamAccountRemoval.removed());
      await tester.pumpAndSettle();
      expect(find.text('Removed.'), findsOneWidget);
      expect(removals, 1);

      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      expect(find.text(line), findsNothing);
      expect(find.text('workspace'), findsOneWidget);
    },
  );

  testWidgets(
    'shows a cancelled or refused removal in the CLI\'s words, and Retry runs it again',
    (tester) async {
      final answers = [
        const TeamAccountRemoval.failed(
          'CANCELLED',
          'Nothing was removed: the administrator prompt was cancelled.',
        ),
        const TeamAccountRemoval.failed(
          'KEPT',
          'macOS kept the account. Delete "Harness Team" in System Settings > Users & Groups, then try again.',
        ),
        const TeamAccountRemoval.removed(
          left: 'the rest of C:\\Users\\harnessteam is removed at the next restart',
        ),
      ];
      await openWorkspace(
        tester,
        here: () async => true,
        remove: () async => answers.removeAt(0),
      );
      await tester.tap(find.text('Remove'));
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Nothing was removed: the administrator prompt was cancelled.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(find.textContaining('macOS kept the account.'), findsOneWidget);
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Removed. the rest of C:\\Users\\harnessteam is removed at the next restart.',
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets('a cancelled dialog closes, and this launch asks no more', (
    tester,
  ) async {
    var asked = 0;
    Future<bool> here() async {
      asked++;
      return true;
    }

    await openWorkspace(
      tester,
      here: here,
      remove: () async => const TeamAccountRemoval.failed(
        'CANCELLED',
        'Nothing was removed: the administrator prompt was cancelled.',
      ),
    );
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();
    expect(find.text(line), findsNothing);
    // The workspace built again (signed out and back): not asked twice.
    await tester.pumpWidget(const SizedBox());
    await openWorkspace(tester, here: here, remove: () async => throw 'no');
    expect(find.text(line), findsNothing);
    expect(asked, 1);
    // The next launch asks again.
    OldTeamAccountAsk.askedThisLaunch = false;
    await tester.pumpWidget(const SizedBox());
    await openWorkspace(tester, here: here, remove: () async => throw 'no');
    expect(find.text(line), findsOneWidget);
    expect(asked, 2);
  });

  testWidgets('asks nothing on a computer without one', (tester) async {
    await openWorkspace(
      tester,
      here: () async => false,
      remove: () async => throw 'never',
    );
    expect(find.text(line), findsNothing);
    expect(find.text('workspace'), findsOneWidget);
  });

  group('whether there is one', () {
    late Directory dir;
    setUp(() => dir = Directory.systemTemp.createTempSync('team-config-'));
    tearDown(() => dir.deleteSync(recursive: true));
    String config(String text) =>
        (File('${dir.path}/team.json')..writeAsStringSync(text)).path;

    test('is a config naming this account as the owner', () async {
      final path = config('{"version":1,"user":"harnessteam","owner":"ken"}');
      expect(
        await oldTeamAccountHere(path: path, user: 'ken', windows: false),
        isTrue,
      );
      expect(
        await oldTeamAccountHere(path: path, user: 'mai', windows: false),
        isFalse,
      );
      // Windows' names are not case-sensitive.
      expect(
        await oldTeamAccountHere(path: path, user: 'Ken', windows: true),
        isTrue,
      );
      expect(
        await oldTeamAccountHere(path: path, user: 'Ken', windows: false),
        isFalse,
      );
    });

    test('is any config the app cannot read, for the CLI to judge', () async {
      expect(
        await oldTeamAccountHere(path: config('not json'), user: 'ken'),
        isTrue,
      );
      expect(
        await oldTeamAccountHere(path: config('{"version":1}'), user: 'ken'),
        isTrue,
      );
    });

    test('is none without a config', () async {
      expect(
        await oldTeamAccountHere(path: '${dir.path}/missing.json', user: 'ken'),
        isFalse,
      );
    });
  });

  test('runs this app\'s own CLI, its internal removal command, and reads its answer', () async {
    final home = Directory.systemTemp.createTempSync('team-cli-');
    addTearDown(() => home.deleteSync(recursive: true));
    final ran = <List<String>>[];
    final runner = HarnessCliRunner(
      harnessHome: home,
      environment: const {'PATH': '/usr/bin'},
      isWindows: false,
      runProcess: (executable, arguments, {environment}) async {
        ran.add(arguments);
        return ProcessResult(
          1,
          1,
          '{"ok":false,"code":"NO_PROMPT","message":"No administrator prompt can be shown here."}\n',
          '',
        );
      },
    );
    final answer = await removeOldTeamAccount(runner: runner);
    expect(ran.single.last, '__remove-team-account');
    expect(
      (answer.code, answer.message),
      ('NO_PROMPT', 'No administrator prompt can be shown here.'),
    );
    final failing = HarnessCliRunner(
      harnessHome: home,
      isWindows: false,
      runProcess: (executable, arguments, {environment}) async =>
          throw ProcessException('harness', arguments, 'not found'),
    );
    expect((await removeOldTeamAccount(runner: failing)).message, 'not found');
  });

  group('the CLI\'s answer', () {
    test('is its last JSON line', () {
      expect(
        TeamAccountRemoval.parse('{"ok":true,"removed":true}\n', '').removed,
        isTrue,
      );
      final kept = TeamAccountRemoval.parse(
        'noise\n{"ok":false,"code":"KEPT","message":"macOS kept the account."}\n',
        '',
      );
      expect((kept.code, kept.message), ('KEPT', 'macOS kept the account.'));
      expect(
        TeamAccountRemoval.parse(
          '{"ok":true,"removed":true,"left":"later"}',
          '',
        ).left,
        'later',
      );
    });

    test('from an older CLI without the command is a failure in its words', () {
      final old = TeamAccountRemoval.parse(
        '',
        'Unknown command: __remove-team-account\nUsage: harness …',
      );
      expect(
        (old.code, old.message),
        (
          'FAILED',
          'Harness on this computer needs its update first. Try again later.',
        ),
      );
      expect(
        TeamAccountRemoval.parse('', 'node: out of memory\n').message,
        'node: out of memory',
      );
      expect(
        TeamAccountRemoval.parse('', '').message,
        'Harness could not run the removal.',
      );
    });
  });
}

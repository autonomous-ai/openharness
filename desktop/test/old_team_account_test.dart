import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_cli_runner.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
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
    final keymap = AppKeymap();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        // As the app wraps every screen, and the workspace hears keys: Escape
        // goes through the keymap.
        builder: (context, child) => KeymapProvider(
          keymap: keymap,
          child: KeymapHost(
            keymap: keymap,
            actions: const {},
            enabled: () => true,
            child: child!,
          ),
        ),
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
  const cancelled = TeamAccountRemoval.failed(
    'CANCELLED',
    'Nothing was removed: the administrator prompt was cancelled.',
  );

  /// A click on the veil, outside the dialog.
  Future<void> tapOutside(WidgetTester tester) async {
    await tester.tapAt(const Offset(4, 4));
    await tester.pumpAndSettle();
  }

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
      // One action, and nothing closes it before it has run: not Escape, not
      // a click outside it.
      expect(find.byKey(const Key('old-team-account-close')), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text(line), findsOneWidget);
      await tapOutside(tester);
      expect(find.text(line), findsOneWidget);

      await tester.tap(find.text('Remove'));
      await tester.pump();
      expect(
        find.text('Waiting for the administrator prompt…'),
        findsOneWidget,
      );
      expect(find.text('Remove'), findsNothing);
      await tapOutside(tester);
      expect(
        find.text('Waiting for the administrator prompt…'),
        findsOneWidget,
      );
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
        cancelled,
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
      expect(find.text(cancelled.message!), findsOneWidget);
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(find.textContaining('macOS kept the account.'), findsOneWidget);
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Removed. The rest of C:\\Users\\harnessteam is removed at the next restart.',
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets('a removed or failed dialog closes on Escape too', (
    tester,
  ) async {
    await openWorkspace(
      tester,
      here: () async => true,
      remove: () async => cancelled,
    );
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text(line), findsNothing);
  });

  testWidgets('a closed dialog is not asked again this launch, but the next', (
    tester,
  ) async {
    var asked = 0;
    Future<bool> here() async {
      asked++;
      return true;
    }

    await openWorkspace(tester, here: here, remove: () async => cancelled);
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();
    expect(find.text(line), findsNothing);
    // The workspace built again (signed out and back): not asked twice.
    await tester.pumpWidget(const SizedBox());
    await openWorkspace(tester, here: here, remove: () async => cancelled);
    expect(find.text(line), findsNothing);
    expect(asked, 1);
    // The next launch asks again.
    OldTeamAccountAsk.askedThisLaunch = false;
    await tester.pumpWidget(const SizedBox());
    await openWorkspace(tester, here: here, remove: () async => cancelled);
    expect(find.text(line), findsOneWidget);
    expect(asked, 2);
  });

  testWidgets(
    'a workspace gone before the check answered leaves the ask to the next',
    (tester) async {
      final answer = Completer<bool>();
      await tester.pumpWidget(
        MaterialApp(
          home: OldTeamAccountAsk(
            here: () => answer.future,
            remove: () async => cancelled,
            child: const Text('workspace'),
          ),
        ),
      );
      await tester.pumpWidget(const SizedBox());
      answer.complete(true);
      await tester.pump();
      expect(OldTeamAccountAsk.askedThisLaunch, isFalse);
      await openWorkspace(
        tester,
        here: () async => true,
        remove: () async => cancelled,
      );
      expect(find.text(line), findsOneWidget);
    },
  );

  testWidgets('a check that throws asks nothing and breaks nothing', (
    tester,
  ) async {
    await openWorkspace(
      tester,
      here: () async => throw StateError('unreadable'),
      remove: () async => cancelled,
    );
    expect(find.text(line), findsNothing);
    expect(find.text('workspace'), findsOneWidget);
  });

  testWidgets('says so when the account had already gone', (tester) async {
    await openWorkspace(
      tester,
      here: () async => true,
      remove: () async => const TeamAccountRemoval.removed(wasThere: false),
    );
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    expect(find.text('Already removed.'), findsOneWidget);
    expect(find.text('Removed.'), findsNothing);
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
    Future<bool> here(
      String path, {
      String? user,
      String? home,
      bool windows = false,
    }) => oldTeamAccountHere(
      path: path,
      user: user,
      home: home ?? '/nowhere',
      windows: windows,
    );

    test('is a config naming this account as the owner', () async {
      final path = config('{"version":1,"user":"harnessteam","owner":"ken"}');
      expect(await here(path, user: 'ken'), isTrue);
      expect(await here(path, user: 'mai'), isFalse);
      // Windows' names are not case-sensitive.
      expect(await here(path, user: 'Ken', windows: true), isTrue);
      expect(await here(path, user: 'Ken'), isFalse);
    });

    test('is a config naming this account\'s home as the owner\'s', () async {
      final path = config('{"owner":"ken","ownerHome":"/Users/ken"}');
      expect(await here(path, user: 'kenneth', home: '/Users/ken'), isTrue);
      expect(await here(path, user: 'mai', home: '/Users/mai'), isFalse);
    });

    test('is any config the app cannot read, for the CLI to judge', () async {
      expect(await here(config('not json'), user: 'ken'), isTrue);
      expect(await here(config('{"version":1}'), user: 'ken'), isTrue);
    });

    test('is none without a config', () async {
      expect(await here('${dir.path}/missing.json', user: 'ken'), isFalse);
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
    TeamAccountRemoval parse(
      String stdout, [
      String stderr = '',
      int exit = 0,
    ]) => TeamAccountRemoval.parse(stdout, stderr, exit);

    test('is its last JSON line', () {
      expect(parse('{"ok":true,"removed":true}\n').removed, isTrue);
      final kept = parse(
        'noise\n{"ok":false,"code":"KEPT","message":"macOS kept the account."}\n',
      );
      expect((kept.code, kept.message), ('KEPT', 'macOS kept the account.'));
      expect(parse('{"ok":true,"removed":true,"left":"later"}').left, 'later');
      expect(parse('{"ok":true,"removed":false}').wasThere, isFalse);
      // A field of another type is left out, never a failure of a removal
      // that went.
      final odd = parse('{"ok":true,"removed":true,"left":["a"]}');
      expect((odd.removed, odd.left), (true, null));
    });

    test('from an older CLI without the command is a failure in its words', () {
      final old = parse(
        '',
        'Unknown command: __remove-team-account\nUsage: harness …',
        1,
      );
      expect(
        (old.code, old.message),
        (
          'FAILED',
          'Harness on this computer needs its update first. Try again later.',
        ),
      );
      expect(
        parse('', 'node: out of memory\n', 1).message,
        'node: out of memory',
      );
      expect(
        parse('', '', 1).message,
        'Harness could not run the removal (exit 1).',
      );
    });
  });
}

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/link_machine_dialog.dart';

import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/widgets/link_another_machine_dialog.dart';

import 'keymap_host_test.dart' show key, MemoryKeymap;
import 'support/password_cli.dart';

const passwordKey = Key('remote-password-field');
const confirmKey = Key('remote-password-confirm-field');

Future<void> _pumpDialog(
  WidgetTester tester,
  AppNotifier notifier, {
  Size size = const Size(900, 700),
  double scale = 1,
  AppKeymap? keymap,
  bool nested = false,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final opener = Scaffold(
    body: Builder(
      builder: (context) => TextButton(
        onPressed: () => nested
            ? showLinkAnotherMachineDialog(context, notifier)
            : showLinkMachineDialog(context, notifier),
        child: const Text('open'),
      ),
    ),
  );
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
      home: keymap == null
          ? opener
          : KeymapProvider(
              keymap: keymap,
              child: KeymapHost(
                keymap: keymap,
                actions: const {},
                enabled: () => false,
                child: opener,
              ),
            ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  if (nested) {
    await tester.enterText(
      find.byKey(const Key('link-machine-search')),
      'password',
    );
    await tester.tap(find.text('This computer’s password').first);
    await tester.pumpAndSettle();
  }
}

TextField field(WidgetTester tester, Key key) =>
    tester.widget<TextField>(find.byKey(key));
Future<void> enterPassword(WidgetTester tester) async {
  tester.testTextInput.enterText('fixture password');
  await key(tester, LogicalKeyboardKey.enter);
  expect(field(tester, confirmKey).focusNode!.hasFocus, isTrue);
  tester.testTextInput.enterText('fixture password');
  await key(tester, LogicalKeyboardKey.enter);
  await tester.pumpAndSettle();
}

void main() {
  AppNotifier notifier({PasswordCli? cliLink}) => AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    cliLink: cliLink ?? PasswordCli(),
  );

  testWidgets('shows the terminal password form when no password is set', (
    tester,
  ) async {
    final appNotifier = notifier();
    await _pumpDialog(tester, appNotifier);

    expect(find.text('This computer’s password'), findsOneWidget);
    expect(
      find.text(
        'Use this password on the other machine to link to this computer.',
      ),
      findsOneWidget,
    );
    expect(find.byKey(const Key('remote-password-field')), findsOneWidget);
    expect(
      find.byKey(const Key('remote-password-confirm-field')),
      findsOneWidget,
    );
    expect(find.byKey(const Key('remote-password-set-button')), findsOneWidget);

    // The paste-to-link card moved to LinkMachineScreen — it must not be duplicated here.
    expect(
      find.byKey(const Key('remote-password-connect-field')),
      findsNothing,
    );
    expect(
      find.byKey(const Key('remote-password-connect-button')),
      findsNothing,
    );
    appNotifier.dispose();
  });

  testWidgets(
    'setting a password shows the fingerprint summary and Change/Clear',
    (tester) async {
      final appNotifier = notifier(cliLink: PasswordCli());
      await _pumpDialog(tester, appNotifier);

      await tester.enterText(
        find.byKey(const Key('remote-password-field')),
        'correct horse battery staple',
      );
      await tester.enterText(
        find.byKey(const Key('remote-password-confirm-field')),
        'correct horse battery staple',
      );
      await tester.tap(find.byKey(const Key('remote-password-set-button')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('remote-password-field')), findsNothing);
      expect(find.text('Remote password is set'), findsOneWidget);
      expect(find.text('1535·C035·9474·FE9D'), findsOneWidget);
      expect(
        find.byKey(const Key('remote-password-change-button')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('remote-password-clear-button')),
        findsOneWidget,
      );
      appNotifier.dispose();
    },
  );

  testWidgets(
    'mismatched passwords show an inline error and do not call setRemotePassword',
    (tester) async {
      final appNotifier = notifier();
      await _pumpDialog(tester, appNotifier);

      await tester.enterText(
        find.byKey(const Key('remote-password-field')),
        'password-one',
      );
      await tester.enterText(
        find.byKey(const Key('remote-password-confirm-field')),
        'password-two',
      );
      await tester.tap(find.byKey(const Key('remote-password-set-button')));
      await tester.pumpAndSettle();

      expect(find.text('Passwords do not match'), findsOneWidget);
      expect(find.byKey(const Key('remote-password-field')), findsOneWidget);
      appNotifier.dispose();
    },
  );

  testWidgets('an already-set password loads straight into the summary view', (
    tester,
  ) async {
    final appNotifier = notifier(
      cliLink: PasswordCli()
        ..status = const RemotePasswordStatus(
          hasPassword: true,
          fingerprint: 'AAAA·BBBB·CCCC·DDDD',
        ),
    );
    await _pumpDialog(tester, appNotifier);

    expect(find.text('Remote password is set'), findsOneWidget);
    expect(find.text('AAAA·BBBB·CCCC·DDDD'), findsOneWidget);
    expect(find.byKey(const Key('remote-password-field')), findsNothing);
    appNotifier.dispose();
  });

  testWidgets(
    'clearing asks for confirmation and shows the CLI error on failure',
    (tester) async {
      final appNotifier = notifier(
        cliLink: PasswordCli()
          ..status = const RemotePasswordStatus(
            hasPassword: true,
            fingerprint: 'AAAA·BBBB·CCCC·DDDD',
          )
          ..clearError = 'Could not run the Harness CLI: not found',
      );
      await _pumpDialog(tester, appNotifier);

      await tester.tap(find.byKey(const Key('remote-password-clear-button')));
      await tester.pumpAndSettle();

      // Destructive action: a confirm dialog, not an immediate clear.
      expect(find.text('Clear remote password'), findsOneWidget);
      await tester.tap(
        find.byKey(const Key('remote-password-clear-confirm-button')),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('Could not run the Harness CLI: not found'),
        findsOneWidget,
      );
      // Still set — the clear failed, so the summary (not the form) should still show.
      expect(find.text('Remote password is set'), findsOneWidget);
      appNotifier.dispose();
    },
  );

  testWidgets(
    'Enter advances and submits once; reopening joins the pending change',
    (tester) async {
      final cli = PasswordCli()
        ..setReply = Completer<RemotePasswordSetResult>();
      final app = notifier(cliLink: cli);
      addTearDown(app.dispose);
      await _pumpDialog(tester, app);
      expect(field(tester, passwordKey).focusNode!.hasFocus, isTrue);
      await enterPassword(tester);
      expect(cli.passwords, ['fixture password']);
      expect(field(tester, passwordKey).readOnly, isTrue);
      expect(field(tester, confirmKey).focusNode!.hasFocus, isTrue);
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await key(tester, LogicalKeyboardKey.enter);
      expect(cli.passwords, hasLength(1));
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Setting password…'), findsOneWidget);
      expect(find.byKey(passwordKey), findsNothing);
      expect(cli.reads, 1);
      cli.setReply!.complete(cli.setResult);
      await tester.pumpAndSettle();
      expect(find.text('Remote password is set'), findsOneWidget);
      expect(find.text('1535·C035·9474·FE9D'), findsOneWidget);
      expect(app.pendingRemotePasswordChange, isNull);
    },
  );

  testWidgets(
    'unknown password status stays distinct from unset and retries by keyboard',
    (tester) async {
      final cli = PasswordCli()
        ..statusFailure = StateError('fixture secret must not be printed');
      final app = notifier(cliLink: cli);
      addTearDown(app.dispose);
      await _pumpDialog(tester, app);
      expect(find.byKey(passwordKey), findsNothing);
      expect(
        find.text('Could not read this computer’s password status. Try again.'),
        findsOneWidget,
      );
      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, 'Retry'))
            .focusNode!
            .hasFocus,
        isTrue,
      );
      cli.statusFailure = null;
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(field(tester, passwordKey).focusNode!.hasFocus, isTrue);
      expect(cli.reads, 2);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'mismatch and CLI errors keep the input and restore retry focus',
    (tester) async {
      final cli = PasswordCli()..setFailure = StateError('fixture secret');
      final app = notifier(cliLink: cli);
      addTearDown(app.dispose);
      await _pumpDialog(tester, app);
      tester.testTextInput.enterText('fixture password');
      await key(tester, LogicalKeyboardKey.enter);
      tester.testTextInput.enterText('different');
      await key(tester, LogicalKeyboardKey.enter);
      expect(cli.passwords, isEmpty);
      expect(find.text('Passwords do not match'), findsOneWidget);
      expect(field(tester, confirmKey).focusNode!.hasFocus, isTrue);
      tester.testTextInput.enterText('fixture password');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(
        find.text('Could not set the password. Try again.'),
        findsOneWidget,
      );
      expect(field(tester, passwordKey).controller!.text, 'fixture password');
      expect(field(tester, confirmKey).focusNode!.hasFocus, isTrue);
      expect(field(tester, confirmKey).readOnly, isFalse);
      cli.setFailure = null;
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(cli.passwords, hasLength(2));
      expect(find.text('Password set.'), findsOneWidget);
    },
  );

  testWidgets(
    'composition owns Enter and Escape; native Next and Done retain key focus',
    (tester) async {
      final cli = PasswordCli();
      final app = notifier(cliLink: cli);
      addTearDown(app.dispose);
      await _pumpDialog(tester, app);
      final input = field(tester, passwordKey);
      input.controller!.value = const TextEditingValue(
        text: 'password',
        selection: TextSelection.collapsed(offset: 8),
        composing: TextRange(start: 0, end: 8),
      );
      await key(tester, LogicalKeyboardKey.enter);
      await key(tester, LogicalKeyboardKey.escape);
      expect(input.focusNode!.hasFocus, isTrue);
      expect(cli.passwords, isEmpty);
      input.controller!.clearComposing();
      await tester.testTextInput.receiveAction(TextInputAction.next);
      await tester.pump();
      expect(field(tester, confirmKey).focusNode!.hasFocus, isTrue);
      tester.testTextInput.enterText('password');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(cli.passwords, ['password']);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('This computer’s password'), findsNothing);
    },
  );

  testWidgets('clear defaults to Cancel and survives closing while pending', (
    tester,
  ) async {
    final cli = PasswordCli()
      ..status = const RemotePasswordStatus(hasPassword: true)
      ..clearReply = Completer<String?>();
    final app = notifier(cliLink: cli);
    addTearDown(app.dispose);
    await _pumpDialog(tester, app);
    await tester.tap(find.byKey(const Key('remote-password-clear-button')));
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Prevent new links using this password? Existing links and sessions stay connected.',
      ),
      findsOneWidget,
    );
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(cli.clears, 0);
    expect(find.text('Remote password is set'), findsOneWidget);
    await tester.tap(find.byKey(const Key('remote-password-clear-button')));
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.tab);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(cli.clears, 1);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Clearing password…'), findsOneWidget);
    cli.clearReply!.complete(null);
    await tester.pumpAndSettle();
    expect(field(tester, passwordKey).focusNode!.hasFocus, isTrue);
    expect(find.text('Password cleared.'), findsOneWidget);
  });

  testWidgets(
    'links remain separate; unlink failure is visible and keyboard retryable',
    (tester) async {
      final cli = PasswordCli()
        ..links = CliLinkListResult(
          machines: [
            LinkedMachine(
              machineId: 'build-box',
              fingerprint: 'AAAA·BBBB',
              linkedAt: '2026-09-19 12:00',
            ),
          ],
        )
        ..unlinkError = 'Machine is busy. Try again.';
      final app = notifier(cliLink: cli);
      addTearDown(app.dispose);
      await _pumpDialog(tester, app);
      expect(find.text('build-box'), findsNothing);
      expect(cli.lists, 0);
      await tester.tap(find.byKey(const Key('remote-password-links-button')));
      await tester.pumpAndSettle();
      expect(find.text('Links from this computer'), findsOneWidget);
      await tester.tap(find.byKey(const Key('unlink-build-box')));
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Machine is busy. Try again.'), findsOneWidget);
      expect(app.linkedMachines, hasLength(1));
      cli.unlinkError = null;
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(cli.unlinks, ['build-box', 'build-box']);
      expect(find.text('No machines linked yet.'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(field(tester, passwordKey).focusNode!.hasFocus, isTrue);
    },
  );

  testWidgets(
    'short window and enlarged text keep both password prompts and Escape usable',
    (tester) async {
      final cli = PasswordCli();
      final app = notifier(cliLink: cli);
      addTearDown(app.dispose);
      await _pumpDialog(tester, app, size: const Size(480, 360), scale: 1.7);
      expect(field(tester, passwordKey).focusNode!.hasFocus, isTrue);
      await enterPassword(tester);
      expect(cli.passwords, ['fixture password']);
      expect(tester.takeException(), isNull);
      expect(find.text('esc  close').hitTestable(), findsOneWidget);
    },
  );

  testWidgets(
    'nested password prompt follows live keymap and keeps parent query',
    (tester) async {
      final cli = PasswordCli();
      final app = notifier(cliLink: cli);
      final map = MemoryKeymap()
        ..apply(
          jsonEncode({
            'bindings': [
              {'keys': 'enter', 'command': null, 'when': 'picker'},
              {'keys': 'escape', 'command': null, 'when': 'picker'},
              {'keys': 'f8', 'command': 'picker.accept', 'when': 'picker'},
              {'keys': 'f7', 'command': 'picker.cancel', 'when': 'picker'},
            ],
          }),
        );
      addTearDown(app.dispose);
      addTearDown(map.dispose);
      await _pumpDialog(tester, app, keymap: map, nested: true);
      tester.testTextInput.enterText('fixture password');
      await key(tester, LogicalKeyboardKey.enter);
      await key(tester, LogicalKeyboardKey.escape);
      expect(field(tester, passwordKey).focusNode!.hasFocus, isTrue);
      expect(
        find.textContaining(
          RegExp('f8  confirm password', caseSensitive: false),
        ),
        findsOneWidget,
      );
      await key(tester, LogicalKeyboardKey.f8);
      expect(field(tester, confirmKey).focusNode!.hasFocus, isTrue);
      tester.testTextInput.enterText('fixture password');
      await key(tester, LogicalKeyboardKey.f8);
      await tester.pumpAndSettle();
      expect(cli.passwords, ['fixture password']);
      // The summary owns Enter now; a detached field must not resubmit.
      await key(tester, LogicalKeyboardKey.f8);
      await tester.pumpAndSettle();
      expect(field(tester, passwordKey).focusNode!.hasFocus, isTrue);
      expect(field(tester, passwordKey).controller!.text, isEmpty);
      expect(cli.passwords, hasLength(1));
      await key(tester, LogicalKeyboardKey.f7);
      await tester.pumpAndSettle();
      map.apply(
        jsonEncode({
          'bindings': [
            {'keys': 'f4', 'command': 'picker.cancel', 'when': 'picker'},
          ],
        }),
      );
      await tester.pump();
      expect(
        find.textContaining(RegExp('f4  close', caseSensitive: false)),
        findsOneWidget,
      );
      await key(tester, LogicalKeyboardKey.f4);
      await tester.pumpAndSettle();
      final search = tester.widget<TextField>(
        find.byKey(const Key('link-machine-search')),
      );
      expect(search.controller!.text, 'password');
      expect(search.focusNode!.hasFocus, isTrue);
    },
  );
}

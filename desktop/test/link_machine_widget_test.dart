import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/link_machine_screen.dart';

import 'keymap_host_test.dart' show key;

class _FakeCliLink implements CliLink {
  final Future<CliLinkConnectResult> Function(String machineId, String password)
  onConnect;
  _FakeCliLink(this.onConnect);

  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) {
    onProgress?.call('exchanging');
    return onConnect(machineId, password);
  }

  @override
  Future<RemotePasswordSetResult> setRemotePassword(String password) async =>
      const RemotePasswordSetResult();

  @override
  Future<RemotePasswordStatus> remotePasswordStatus() async =>
      const RemotePasswordStatus(hasPassword: false);

  @override
  Future<String?> clearRemotePassword() async => null;

  @override
  Future<CliLinkListResult> list() async => const CliLinkListResult();

  @override
  Future<String?> unlink(String machineId) async => null;
}

void main() {
  const machine = Machine(
    machineId: 'remote-1',
    apiKey: '',
    authMode: MachineAuthMode.remote,
    name: 'remote-mac',
    status: 'online',
  );

  AppNotifier notifierFor(_FakeCliLink cliLink) {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      cliLink: cliLink,
    );
    notifier.machines = [machine];
    notifier.machineStates[machine.machineId] = MachineState(machine)
      ..needsLink = true
      ..agentLoadStatus = AgentLoadStatus.needsLink;
    return notifier;
  }

  test(
    'pending handshakes coalesce by machine and ignore a disposed session',
    () async {
      final pending = Completer<CliLinkConnectResult>();
      var calls = 0;
      final notifier = notifierFor(
        _FakeCliLink((_, _) {
          calls++;
          return pending.future;
        }),
      );
      final first = notifier.connectWithPassword(
        machine.machineId,
        'test password',
      );
      final second = notifier.connectWithPassword(
        machine.machineId,
        'another password',
      );
      expect(second, same(first));
      expect(calls, 1);
      expect(notifier.machineLinkStage(machine.machineId), 'exchanging');
      notifier.dispose();
      pending.complete(
        CliLinkConnectResult(linkedMachineId: machine.machineId),
      );
      expect(await first, 'This connection request is no longer active.');
      expect(notifier.machineStates[machine.machineId]!.needsLink, isTrue);
    },
  );

  testWidgets('link prompt accepts typing immediately and submits only once', (
    tester,
  ) async {
    final pending = Completer<CliLinkConnectResult>();
    final passwords = <String>[];
    final notifier = notifierFor(
      _FakeCliLink((_, password) {
        passwords.add(password);
        return pending.future;
      }),
    );
    addTearDown(notifier.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LinkMachineScreen(
            notifier: notifier,
            machineState: notifier.machineStates[machine.machineId]!,
          ),
        ),
      ),
    );
    await tester.pump();
    final field = find.byKey(const Key('remote-password-connect-field'));
    expect(tester.widget<TextField>(field).focusNode?.hasFocus, isTrue);
    tester.testTextInput.enterText('test remote password');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    expect(passwords, ['test remote password']);
    await tester.pump();
    expect(tester.widget<TextField>(field).readOnly, isTrue);
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    pending.complete(const CliLinkConnectResult(error: 'Incorrect password'));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    expect(tester.widget<TextField>(field).readOnly, isFalse);
    expect(
      tester.widget<TextField>(field).controller!.text,
      'test remote password',
    );
    expect(find.text('Incorrect password'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a failed link process unlocks the prompt for keyboard retry', (
    tester,
  ) async {
    var calls = 0;
    final notifier = notifierFor(
      _FakeCliLink((machineId, _) async {
        if (++calls == 1) throw StateError('CLI process failed');
        return CliLinkConnectResult(linkedMachineId: machineId);
      }),
    );
    addTearDown(notifier.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LinkMachineScreen(
            notifier: notifier,
            machineState: notifier.machineStates[machine.machineId]!,
          ),
        ),
      ),
    );
    final field = find.byKey(const Key('remote-password-connect-field'));
    await tester.enterText(field, 'fixture password');
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(
      find.text('Could not link this machine. Try again.'),
      findsOneWidget,
    );
    expect(notifier.pendingMachineLink(machine.machineId), isNull);
    expect(tester.widget<TextField>(field).readOnly, isFalse);
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    await key(tester, LogicalKeyboardKey.keyU, ctrl: true);
    expect(tester.widget<TextField>(field).controller!.text, isEmpty);
    expect(find.text('Could not link this machine. Try again.'), findsNothing);
    await key(tester, LogicalKeyboardKey.keyY, ctrl: true);
    expect(
      tester.widget<TextField>(field).controller!.text,
      'fixture password',
    );
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(calls, 2);
    expect(notifier.machineStates[machine.machineId]!.needsLink, isFalse);
    expect(tester.widget<TextField>(field).controller!.text, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  test(
    'links to different machines progress and finish independently',
    () async {
      const other = Machine(
        machineId: 'remote-2',
        authMode: MachineAuthMode.remote,
        name: 'remote-server',
      );
      final replies = <String, Completer<CliLinkConnectResult>>{};
      final notifier = notifierFor(
        _FakeCliLink((id, _) => (replies[id] = Completer()).future),
      );
      addTearDown(notifier.dispose);
      notifier.machineStates[other.machineId] = MachineState(other)
        ..needsLink = true;
      final first = notifier.connectWithPassword(machine.machineId, 'first');
      final second = notifier.connectWithPassword(other.machineId, 'second');
      expect(replies.keys, containsAll([machine.machineId, other.machineId]));
      replies[other.machineId]!.complete(
        const CliLinkConnectResult(error: 'Incorrect password'),
      );
      expect(await second, 'Incorrect password');
      expect(notifier.pendingMachineLink(other.machineId), isNull);
      expect(notifier.machineStates[other.machineId]!.needsLink, isTrue);
      expect(notifier.pendingMachineLink(machine.machineId), same(first));
      replies[machine.machineId]!.complete(
        CliLinkConnectResult(linkedMachineId: machine.machineId),
      );
      expect(await first, isNull);
      expect(notifier.pendingMachineLink(machine.machineId), isNull);
      expect(notifier.machineStates[machine.machineId]!.needsLink, isFalse);
    },
  );

  testWidgets('link prompt leaves Enter and Escape with active composition', (
    tester,
  ) async {
    var calls = 0;
    final notifier = notifierFor(
      _FakeCliLink((_, _) async {
        calls++;
        return const CliLinkConnectResult(error: 'Not submitted');
      }),
    );
    addTearDown(notifier.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showLinkMachineScreenDialog(
                context,
                notifier,
                machine.machineId,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    final field = find.byKey(const Key('remote-password-connect-field'));
    expect(
      tester.widget<TextField>(field).focusNode!.hasFocus,
      isTrue,
      reason: FocusManager.instance.primaryFocus?.toString(),
    );
    await tester.enterText(field, '日本語');
    final controller = tester.widget<TextField>(field).controller!;
    controller.value = controller.value.copyWith(
      composing: const TextRange(start: 0, end: 3),
    );
    await key(tester, LogicalKeyboardKey.enter);
    await key(tester, LogicalKeyboardKey.escape);
    expect(calls, 0);
    expect(field, findsOneWidget);
    expect(notifier.isLinkPromptDismissed(machine.machineId), isFalse);
    controller.value = controller.value.copyWith(composing: TextRange.empty);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(field, findsNothing);
    expect(notifier.isLinkPromptDismissed(machine.machineId), isTrue);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'closing and reopening joins the pending link without another request',
    (tester) async {
      final pending = Completer<CliLinkConnectResult>();
      var calls = 0;
      final notifier = notifierFor(
        _FakeCliLink((_, _) {
          calls++;
          return pending.future;
        }),
      );
      addTearDown(notifier.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showLinkMachineScreenDialog(
                  context,
                  notifier,
                  machine.machineId,
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      final field = find.byKey(const Key('remote-password-connect-field'));
      await tester.enterText(field, 'test password');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pump();
      await tester.tap(find.text('open'));
      await tester.pump();
      await tester.pump();
      expect(tester.widget<TextField>(field).readOnly, isTrue);
      expect(calls, 1);
      pending.complete(
        const CliLinkConnectResult(error: 'Try another password'),
      );
      await tester.pumpAndSettle();
      expect(find.text('Try another password'), findsOneWidget);
      expect(tester.widget<TextField>(field).readOnly, isFalse);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(calls, 1);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('shows a clear password prompt for the target machine', (
    tester,
  ) async {
    final notifier = notifierFor(
      _FakeCliLink((_, _) async => const CliLinkConnectResult()),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LinkMachineScreen(
            notifier: notifier,
            machineState: notifier.machineStates[machine.machineId]!,
          ),
        ),
      ),
    );

    expect(find.text('Link this machine'), findsOneWidget);
    expect(
      find.text('Enter the remote password set on this machine.'),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('remote-password-connect-field')),
      findsOneWidget,
    );
    expect(find.text('Remote password for remote-mac'), findsOneWidget);
    expect(find.text('enter  link machine'), findsOneWidget);
    expect(
      find.text(
        'Your previous agent will reconnect automatically after linking.',
      ),
      findsOneWidget,
    );
    expect(find.text('Machine ID: remote-1'), findsNothing);

    await tester.tap(find.byKey(const Key('link-troubleshooting-details')));
    await tester.pump();
    expect(find.text('Machine ID: remote-1'), findsOneWidget);

    // The close key guide remains clickable as well as keyboard accessible.
    expect(find.text('esc  close'), findsOneWidget);
    notifier.dispose();
  });

  testWidgets('tapping Close dismisses the link prompt', (tester) async {
    final notifier = notifierFor(
      _FakeCliLink((_, _) async => const CliLinkConnectResult()),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LinkMachineScreen(
            notifier: notifier,
            machineState: notifier.machineStates[machine.machineId]!,
          ),
        ),
      ),
    );

    expect(notifier.isLinkPromptDismissed(machine.machineId), isFalse);
    await tester.tap(find.text('esc  close'));
    await tester.pump();
    expect(notifier.isLinkPromptDismissed(machine.machineId), isTrue);
    notifier.dispose();
  });

  testWidgets(
    'submitting a password calls connectWithPassword and clears needsLink on success',
    (tester) async {
      String? connectedPassword;
      final notifier = notifierFor(
        _FakeCliLink((machineId, password) async {
          connectedPassword = password;
          return CliLinkConnectResult(linkedMachineId: machineId);
        }),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LinkMachineScreen(
              notifier: notifier,
              machineState: notifier.machineStates[machine.machineId]!,
            ),
          ),
        ),
      );

      await tester.enterText(
        find.byKey(const Key('remote-password-connect-field')),
        'correct horse battery staple',
      );
      await tester.tap(find.text('enter  link machine'));
      await tester.pumpAndSettle();

      expect(connectedPassword, 'correct horse battery staple');
      expect(notifier.machineStates[machine.machineId]!.needsLink, isFalse);
      notifier.dispose();
    },
  );

  testWidgets('shows the CLI error inline and keeps needsLink on failure', (
    tester,
  ) async {
    final notifier = notifierFor(
      _FakeCliLink(
        (_, _) async => const CliLinkConnectResult(error: 'Incorrect password'),
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LinkMachineScreen(
            notifier: notifier,
            machineState: notifier.machineStates[machine.machineId]!,
          ),
        ),
      ),
    );

    await tester.enterText(
      find.byKey(const Key('remote-password-connect-field')),
      'wrong-password',
    );
    await tester.tap(find.text('enter  link machine'));
    await tester.pumpAndSettle();

    expect(find.text('Incorrect password'), findsOneWidget);
    expect(notifier.machineStates[machine.machineId]!.needsLink, isTrue);
    notifier.dispose();
  });
}

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';

import 'support/password_cli.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late PasswordCli cli;
  late AppNotifier app;
  setUp(() {
    cli = PasswordCli();
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      cliLink: cli,
    );
  });
  tearDown(() => app.dispose());

  test(
    'a pending change rejects competing mutations while status joins it',
    () async {
      cli.setReply = Completer<RemotePasswordSetResult>();
      final first = app.setRemotePassword('fixture password');
      final pending = app.pendingRemotePasswordChange!;
      final status = app.remotePasswordStatus();
      expect(await app.clearRemotePassword(), contains('already in progress'));
      expect(
        (await app.setRemotePassword('another fixture')).error,
        contains('already in progress'),
      );
      expect(cli.passwords, ['fixture password']);
      expect(cli.clears, 0);
      expect(cli.reads, 0);
      cli.setReply!.complete(cli.setResult);
      expect((await first).error, isNull);
      expect((await pending).hasPassword, isTrue);
      expect((await status).fingerprint, '1535·C035·9474·FE9D');
      expect(app.pendingRemotePasswordChange, isNull);
    },
  );

  test(
    'a stale status read cannot overwrite a completed password change',
    () async {
      final slow = Completer<RemotePasswordStatus>();
      cli.statusReply = slow;
      final reading = app.remotePasswordStatus();
      cli.statusReply = null;
      await app.setRemotePassword('fixture password');
      slow.complete(const RemotePasswordStatus());
      final result = await reading;
      expect(result.hasPassword, isTrue);
      expect(result.fingerprint, '1535·C035·9474·FE9D');
      expect(cli.reads, 2);
    },
  );

  test(
    'unexpected change failure releases the operation and can be retried',
    () async {
      cli.clearFailure = StateError('fixture secret');
      expect(
        await app.clearRemotePassword(),
        'Could not clear the password. Try again.',
      );
      expect(app.pendingRemotePasswordChange, isNull);
      cli.clearFailure = null;
      expect(await app.clearRemotePassword(), isNull);
      expect(cli.clears, 2);
    },
  );

  test(
    'pending changes complete safely after their notifier is disposed',
    () async {
      final disposed = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLink: cli,
      );
      cli.setReply = Completer<RemotePasswordSetResult>();
      final request = disposed.setRemotePassword('fixture password');
      disposed.dispose();
      cli.setReply!.complete(cli.setResult);
      expect((await request).error, contains('no longer active'));
      expect(disposed.pendingRemotePasswordChange, isNull);
    },
  );

  test(
    'linked machine refresh joins its request and keeps known rows on failure',
    () async {
      final machine = LinkedMachine(
        machineId: 'build',
        fingerprint: 'fixture',
        linkedAt: '2026-09-19 12:00',
      );
      cli.links = CliLinkListResult(machines: [machine]);
      await app.refreshLinkedMachines();
      cli.listReply = Completer<CliLinkListResult>();
      final first = app.refreshLinkedMachines();
      final second = app.refreshLinkedMachines();
      expect(identical(first, second), isTrue);
      expect(cli.lists, 2);
      cli.listReply!.complete(
        const CliLinkListResult(error: 'Cannot load links'),
      );
      await first;
      expect(app.linkedMachines, [machine]);
      expect(app.linkedMachinesError, 'Cannot load links');
      expect(app.linkedMachinesLoading, isFalse);
      cli.listReply = null;
      cli.listFailure = StateError('fixture');
      await app.refreshLinkedMachines();
      expect(app.linkedMachines, [machine]);
      expect(
        app.linkedMachinesError,
        'Could not load linked machines. Try again.',
      );
      expect(app.linkedMachinesLoading, isFalse);
    },
  );

  test('unlink joins its request and does not restore removed rows on refresh failure', () async {
    final machine = LinkedMachine(
      machineId: 'build',
      fingerprint: 'fixture',
      linkedAt: '2026-09-19 12:00',
    );
    cli.links = CliLinkListResult(machines: [machine]);
    await app.refreshLinkedMachines();
    cli.unlinkReply = Completer<String?>();
    final first = app.unlinkMachine('build');
    final second = app.unlinkMachine('build');
    expect(identical(first, second), isTrue);
    expect(app.unlinkingMachine('build'), isTrue);
    cli.listFailure = StateError('fixture');
    cli.unlinkReply!.complete(null);
    expect(await first, isNull);
    expect(app.unlinkingMachine('build'), isFalse);
    expect(cli.unlinks, ['build']);
    expect(app.linkedMachines, isEmpty);
    expect(app.linkedMachinesError, isNotNull);
  });
}

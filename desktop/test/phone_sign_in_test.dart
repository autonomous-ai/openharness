import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/auth/phone_sign_in.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/harness_cli_runner.dart';
import 'package:harness/viewer/direct_auth_api.dart';
import 'package:harness/viewer/qr_sign_in.dart';

/// Signing in by a QR a signed-in phone approves: the CLI's (`harness login --qr`, driven over NDJSON
/// with the account question answered on stdin) and a viewer's own (`viewer/qr_sign_in.dart`).

class _Runner extends HarnessCliRunner {
  _Runner(this.process);
  final _Process process;
  List<String>? arguments;
  @override
  Future<Process> start(List<String> arguments) async {
    this.arguments = arguments;
    return process;
  }
}

class _Process implements Process {
  final output = StreamController<List<int>>();
  final errors = StreamController<List<int>>();
  final input = StreamController<List<int>>();
  late final IOSink _stdin = IOSink(input.sink);
  final ended = Completer<int>();
  final written = <String>[];

  _Process() {
    input.stream.transform(utf8.decoder).listen(written.add);
  }

  void emit(Map<String, dynamic> event) =>
      output.add(utf8.encode('${jsonEncode(event)}\n'));
  void finish([int exitCode = 0]) {
    unawaited(output.close());
    unawaited(errors.close());
    if (!ended.isCompleted) ended.complete(exitCode);
  }

  @override
  Stream<List<int>> get stdout => output.stream;
  @override
  Stream<List<int>> get stderr => errors.stream;
  @override
  IOSink get stdin => _stdin;
  @override
  Future<int> get exitCode => ended.future;
  bool killed = false;
  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) {
    killed = true;
    return true;
  }

  @override
  int get pid => 1;
}

class _Api extends DirectAuthApi {
  _Api(this.polls) : super(config: AppConfig.dev);
  final List<String> polls;
  final calls = <String>[];
  @override
  Future<({String code, String pollToken, int expiresIn})> qrStart({
    required String label,
  }) async {
    calls.add('start:$label');
    return (code: 'hnq_code', pollToken: 'hnp_poll', expiresIn: 120);
  }

  @override
  Future<({String status, String? email})> qrPoll(String pollToken) async {
    calls.add('poll');
    final next = polls.isEmpty ? 'pending' : polls.removeAt(0);
    return (status: next, email: next == 'approved' ? 'dee@example.com' : null);
  }

  @override
  Future<int?> qrExtend(String pollToken) async {
    calls.add('extend');
    return 120;
  }

  @override
  Future<IssuedTokens> qrClaim(String pollToken) async {
    calls.add('claim');
    return const IssuedTokens(
      token: 'hna_x',
      refreshToken: 'hnr_x',
      expiresIn: 3600,
    );
  }

  @override
  Future<void> qrCancel(String pollToken) async => calls.add('cancel');
}

void main() {
  group('CliLogin.loginWithPhone', () {
    test('shows the QR, answers the account question on stdin, and finishes on success', () async {
      final process = _Process();
      final runner = _Runner(process);
      final links = <String>[];
      final asked = <String>[];
      final done = CliLogin(runner: runner).loginWithPhone(
        onQr: (link, _) => links.add(link),
        onConfirm: (email) async {
          asked.add(email);
          return true;
        },
      );
      await Future<void>.delayed(Duration.zero);
      expect(runner.arguments, [
        'login',
        '--force',
        '--json',
        '--qr',
        '--entry-point=desktop',
      ]);
      process.emit({
        'type': 'qr',
        'url': 'https://harness.autonomous.ai/signin#k=hnq_x',
        'expiresIn': 120,
      });
      process.emit({'type': 'confirm', 'email': 'dee@example.com'});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(process.written.join(), 'yes\n');
      process.emit({
        'type': 'result',
        'status': 'success',
        'email': 'dee@example.com',
      });
      process.finish();
      await done;
      expect(links, ['https://harness.autonomous.ai/signin#k=hnq_x']);
      expect(asked, ['dee@example.com']);
    });

    test('a wait behind another sign-in is shown until the CLI moves on', () async {
      final process = _Process();
      final login = CliLogin(runner: _Runner(process));
      final done = login.loginWithPhone(onQr: (_, _) {}, onConfirm: (_) async => false);
      await Future<void>.delayed(Duration.zero);
      process.emit({'type': 'waiting', 'message': 'Another sign-in on this computer is still running — waiting for it to finish…'});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(login.waitingNote.value, startsWith('Another sign-in'));
      process.emit({'type': 'qr', 'url': 'https://harness.autonomous.ai/signin#k=hnq_x', 'expiresIn': 120});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(login.waitingNote.value, isNull);
      process.emit({'type': 'result', 'status': 'error', 'code': 'CANCELLED', 'message': 'x'});
      process.finish(1);
      await expectLater(done, throwsA(isA<PhoneSignInException>()));
      expect(login.waitingNote.value, isNull);
    });

    test('says no on stdin when the person refuses the account, and reports why it ended', () async {
      final process = _Process();
      final done = CliLogin(runner: _Runner(process))
          .loginWithPhone(onQr: (_, _) {}, onConfirm: (_) async => false);
      await Future<void>.delayed(Duration.zero);
      process.emit({'type': 'confirm', 'email': 'someone@example.com'});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(process.written.join(), 'no\n');
      process.emit({
        'type': 'result',
        'status': 'error',
        'code': 'CANCELLED',
        'message': 'Not signed in as someone@example.com.',
      });
      process.finish(1);
      await expectLater(
        done,
        throwsA(
          isA<PhoneSignInException>().having(
            (e) => e.code,
            'code',
            'CANCELLED',
          ),
        ),
      );
    });

    test('a CLI from before --qr starts SSO instead: stops it and says the CLI is too old', () async {
      final process = _Process();
      final done = CliLogin(runner: _Runner(process)).loginWithPhone(
        onQr: (_, _) => fail('no QR from an old CLI'),
        onConfirm: (_) async => fail('nothing to confirm'),
      );
      await Future<void>.delayed(Duration.zero);
      process.emit({
        'type': 'authorize_url',
        'url': 'https://sso.example/authorize',
      });
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(process.killed, isTrue);
      process.finish(143);
      await expectLater(
        done,
        throwsA(
          isA<PhoneSignInException>().having(
            (e) => e.code,
            'code',
            'CLI_TOO_OLD',
          ),
        ),
      );
    });
  });

  group('viewerQrSignIn', () {
    test('claims only after the person confirms the account', () async {
      final api = _Api(['pending', 'approved']);
      final links = <String>[];
      final tokens = await viewerQrSignIn(
        api: api,
        label: 'Browser',
        onQr: (link, _) => links.add(link),
        onConfirm: (email) async => email == 'dee@example.com',
        stillCurrent: () => true,
        sleep: (_) async {},
      );
      expect(tokens.token, 'hna_x');
      expect(links, [phoneSignInLink('hnq_code')]);
      expect(api.calls, ['start:Browser', 'poll', 'poll', 'claim']);
    });

    test('a refusal claims nothing and takes the QR back', () async {
      final api = _Api(['approved']);
      await expectLater(
        viewerQrSignIn(
          api: api,
          label: 'b',
          onQr: (_, _) {},
          onConfirm: (_) async => false,
          stillCurrent: () => true,
          sleep: (_) async {},
        ),
        throwsA(
          isA<PhoneSignInException>().having(
            (e) => e.code,
            'code',
            'CANCELLED',
          ),
        ),
      );
      expect(api.calls, isNot(contains('claim')));
      expect(api.calls, contains('cancel'));
    });

    test('a denial on the phone ends it', () async {
      await expectLater(
        viewerQrSignIn(
          api: _Api(['denied']),
          label: 'b',
          onQr: (_, _) {},
          onConfirm: (_) async => true,
          stillCurrent: () => true,
          sleep: (_) async {},
        ),
        throwsA(
          isA<PhoneSignInException>().having((e) => e.code, 'code', 'DENIED'),
        ),
      );
    });

    test('keeps the same code alive while it waits', () async {
      var clock = DateTime(2026);
      final api = _Api([...List.filled(60, 'pending'), 'approved']);
      final links = <String>[];
      await viewerQrSignIn(
        api: api,
        label: 'b',
        onQr: (link, _) => links.add(link),
        onConfirm: (_) async => true,
        stillCurrent: () => true,
        sleep: (d) async => clock = clock.add(d),
        now: () => clock,
      );
      expect(api.calls, contains('extend'));
      expect(links.toSet(), {phoneSignInLink('hnq_code')});
    });
  });
}

import 'dart:async';

import 'package:harness/auth/cli_link.dart';

/// In-memory CLI for password UI/native fixtures. Never invokes a process or
/// reads a Harness home. Every password used with this fake is fixture text.
class PasswordCli implements CliLink {
  RemotePasswordStatus status = const RemotePasswordStatus();
  RemotePasswordSetResult setResult = const RemotePasswordSetResult(
    fingerprint: '1535·C035·9474·FE9D',
  );
  String? clearError, unlinkError;
  CliLinkListResult links = const CliLinkListResult();
  final passwords = <String>[];
  final unlinks = <String>[];
  int reads = 0, clears = 0, lists = 0;
  Completer<RemotePasswordStatus>? statusReply;
  Completer<RemotePasswordSetResult>? setReply;
  Completer<String?>? clearReply, unlinkReply;
  Completer<CliLinkListResult>? listReply;
  Object? statusFailure, setFailure, clearFailure, listFailure, unlinkFailure;

  @override
  Future<RemotePasswordStatus> remotePasswordStatus() async {
    reads++;
    if (statusFailure case final error?) throw error;
    return statusReply?.future ?? status;
  }

  @override
  Future<RemotePasswordSetResult> setRemotePassword(String password) async {
    passwords.add(password);
    if (setFailure case final error?) throw error;
    final result = await (setReply?.future ?? Future.value(setResult));
    if (result.error == null) {
      status = RemotePasswordStatus(
        hasPassword: true,
        fingerprint: result.fingerprint,
      );
    }
    return result;
  }

  @override
  Future<String?> clearRemotePassword() async {
    clears++;
    if (clearFailure case final error?) throw error;
    final error = await (clearReply?.future ?? Future.value(clearError));
    if (error == null) status = const RemotePasswordStatus();
    return error;
  }

  @override
  Future<CliLinkListResult> list() async {
    lists++;
    if (listFailure case final error?) throw error;
    return listReply?.future ?? links;
  }

  @override
  Future<String?> unlink(String machineId) async {
    unlinks.add(machineId);
    if (unlinkFailure case final error?) throw error;
    final error = await (unlinkReply?.future ?? Future.value(unlinkError));
    if (error == null) {
      links = CliLinkListResult(
        machines: links.machines
            .where((machine) => machine.machineId != machineId)
            .toList(),
      );
    }
    return error;
  }

  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) async => const CliLinkConnectResult();
}

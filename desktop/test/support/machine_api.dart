import 'dart:async';

import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';

/// Account edits stay entirely in memory; this client never opens a socket.
class MachineApi extends ApiClient {
  MachineApi() : super(config: AppConfig.dev, session: AuthSession());
  final renames = <(String, String)>[];
  final deletes = <String>[];
  Completer<String?>? renameReply;
  Completer<void>? deleteReply;
  Object? renameFailure, deleteFailure;
  String? canonicalName;

  @override
  Future<String?> renameMachine({
    required String machineId,
    required String name,
  }) async {
    renames.add((machineId, name));
    if (renameFailure case final error?) throw error;
    return renameReply?.future ?? canonicalName;
  }

  @override
  Future<void> deleteMachine({required String machineId}) async {
    deletes.add(machineId);
    if (deleteFailure case final error?) throw error;
    await deleteReply?.future;
  }
}

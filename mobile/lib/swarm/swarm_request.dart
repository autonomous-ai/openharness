import 'dart:math';
import 'dart:typed_data';

import 'package:dio/dio.dart' show CancelToken;

/// One Swarm backend call: what `AppNotifier.swarmRequest` does, and what the
/// readers here are handed so their tests need no machine.
typedef SwarmRequest = Future<Object?> Function(
  String method,
  String path, {
  Map<String, dynamic>? body,
});

/// A Swarm call that did not answer: the backend's refusal, the forwarding
/// machine's, or none to forward through. [code] is for the code to branch on;
/// [message] is the sentence to show.
///
/// The desktop's `SuperTabFailure` (`desktop/lib/super_tabs/controller.dart`),
/// so a refusal reads the same on both.
class SuperTabFailure implements Exception {
  const SuperTabFailure(this.code, this.message, {this.statusCode = 0});
  final String code, message;
  final int statusCode;
  @override
  String toString() => message;
}

/// A fresh receipt for one command: the backend runs a command once per
/// operation id, so a retry under the same id is the same command.
String superTabOperationId() {
  final random = Random.secure();
  return List.generate(
    16,
    (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}

/// Sends one file for a message in [conversationId] of Swarm [tabId] and
/// answers the backend's `{attachment: {...}}` — `ApiClient.uploadSwarmAttachment`,
/// and what the chats here are handed so their tests need no backend.
/// [onProgress] is told the part sent, from 0 to 1. A refusal throws a
/// [SuperTabFailure] carrying the backend's code.
typedef SwarmUpload = Future<Map<String, dynamic>> Function({
  required String tabId,
  required String conversationId,
  required String name,
  required String mime,
  required Uint8List bytes,
  required CancelToken cancel,
  required void Function(double sent) onProgress,
});

/// The upload of a phone that cannot reach the backend with a file.
Future<Map<String, dynamic>> refuseSwarmUpload({
  required String tabId,
  required String conversationId,
  required String name,
  required String mime,
  required Uint8List bytes,
  required CancelToken cancel,
  required void Function(double sent) onProgress,
}) => Future.error(
  const SuperTabFailure('UPLOAD_UNAVAILABLE', 'Files can’t be sent from here.'),
);

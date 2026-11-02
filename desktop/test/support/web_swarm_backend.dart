import 'dart:async';

import 'package:dio/dio.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/super_tabs/controller.dart';

import '../swarm_state_test.dart' show MemoryStore;
import 'super_tab_fixture.dart';

/// The backend, as the browser's own sign-in reaches it: each Swarm call is
/// answered by [server] inside the backend's `{success, data|error}` envelope.
class WebSwarmBackend extends ApiClient {
  WebSwarmBackend(this.server)
    : super(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
      );
  final ConversationServer server;
  final calls = <String>[];

  /// The person lost the Swarm: every read is refused, as the backend
  /// refuses one they may no longer read.
  bool forbidden = false;

  /// No answer at all: the browser is offline or the backend unreachable.
  bool down = false;

  /// While set, every call waits for it: a slow answer.
  Completer<void>? hold;

  @override
  Future<Response<dynamic>> superTabCall(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    calls.add('$method $path');
    final options = RequestOptions(path: path, method: method);
    await hold?.future;
    if (down) {
      throw DioException(
        requestOptions: options,
        type: DioExceptionType.connectionError,
      );
    }
    if (forbidden) {
      return Response(
        requestOptions: options,
        statusCode: 403,
        data: {
          'success': false,
          'error': {'code': 'FORBIDDEN', 'message': 'Forbidden'},
        },
      );
    }
    try {
      final data = await server.request(method, path, body: body);
      return Response(
        requestOptions: options,
        statusCode: 200,
        data: {'success': true, 'data': data},
      );
    } on SuperTabFailure catch (failure) {
      return Response(
        requestOptions: options,
        statusCode: failure.statusCode == 0 ? 400 : failure.statusCode,
        data: {
          'success': false,
          'error': {'code': failure.code, 'message': failure.message},
        },
      );
    }
  }
}

import 'dart:convert';

import 'package:dio/dio.dart';

import '../api/access_token_source.dart';
import '../api/api_client.dart';
import 'client.dart';
import 'controller.dart';

/// The Swarm routes the web may call with the browser's own sign-in: the
/// same set, and the same spelling, a machine's daemon relays
/// (cli/src/superTabs/service.ts, `action: backend`). Anything else is
/// refused before it is sent, so this transport never signs another route.
final _swarmRoute = RegExp(
  r'^/api/super-tabs(?:/[A-Za-z0-9_-]+)*(?:\?[A-Za-z0-9_=&%-]+)?$',
);

/// The web's Swarm transport (docs/specs/2026-10-30-web-swarm-direct.md):
/// each call goes straight to the backend, signed as the person in this
/// browser, and is answered as a machine's relay answered it — the backend's
/// `data`, or a [SuperTabFailure] with its code, message and status.
SuperTabTransport superTabBackendTransport(ApiClient Function() api) =>
    (method, path, {body}) async {
      if ((method != 'GET' && method != 'POST') ||
          !_swarmRoute.hasMatch(path)) {
        throw const SuperTabFailure(
          'INVALID_REQUEST',
          'Choose a Super Tab endpoint.',
        );
      }
      final Response<dynamic> response;
      try {
        response = await api().superTabCall(method, path, body: body);
      } on DioException catch (error) {
        throw _unanswered(error);
      }
      return _answer(response);
    };

SuperTabFailure _unanswered(DioException error) {
  final cause = error.error;
  if (cause is AccessTokenFailure && cause.signedOut) {
    return const SuperTabFailure('SIGNED_OUT', 'Sign in to use Swarm.');
  }
  return const SuperTabFailure(
    'NETWORK',
    'Could not reach Harness. Check your connection.',
  );
}

/// As `backend()` in cli/src/superTabs/wire.ts reads the backend.
Object? _answer(Response<dynamic> response) {
  final status = response.statusCode ?? 0;
  var body = response.data;
  if (body is String) {
    try {
      body = jsonDecode(body);
    } catch (_) {}
  }
  final envelope = body is Map ? body : const {};
  if (status == 426) {
    throw SuperTabFailure(
      'UPDATE_REQUIRED',
      SuperTabController.updateMessage,
      statusCode: 426,
    );
  }
  if (status < 200 || status >= 300 || envelope['success'] != true) {
    final error = envelope['error'];
    final code = error is Map ? error['code'] : envelope['code'];
    final message = error is Map ? error['message'] : envelope['message'];
    throw SuperTabFailure(
      code is String && code.isNotEmpty ? code : 'BACKEND_UNAVAILABLE',
      message is String && message.isNotEmpty
          ? message
          : 'Could not reach this Swarm.',
      statusCode: status,
    );
  }
  return envelope['data'];
}

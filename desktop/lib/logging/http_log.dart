import 'package:dio/dio.dart';

import 'app_log.dart';
import 'redact.dart';

/// The app's HTTP calls, in the same timeline as everything else it does.
///
/// One line per finished request — `GET /api/machines → 200 (118ms)` — under
/// the `api` category, which is what makes it a lens of its own in Settings ▸
/// Debug. The shape is deliberately Grid's (`CommandLogNotifier._mirrorToAppLog`),
/// so the two products' logs read alike.
///
/// **Headers and bodies are not logged.** An `Authorization` header is a live
/// credential; a body can carry one too. A URL can carry
/// one in its query, so the line goes through [redactSecretsInText] first.
///
/// Successful calls log at `debug`, because the status rail polls every 60s
/// and a day of that is not news; a failure logs at `warn`, where it
/// joins the Failed lens.
Dio attachHttpLog(Dio dio) {
  dio.interceptors.add(_HttpLogInterceptor());
  return dio;
}

/// Key under which the request's start time rides along on its own options —
/// the only place an interceptor can keep per-request state.
const String _startedAtKey = 'harnessLogStartedAt';

/// Statuses a request expects as ROUTINE, as a `Set<int>` in its
/// `Options.extra` under this key: they log at `debug` like a success.
///
/// For a poll whose "not yet" is an HTTP error by design — Add Phone asks the
/// daemon `POST /api/pair` every 1.5 s, and "no phone is waiting" is a 409.
/// Logged at `warn`, a minute with the dialog open was forty lines in the
/// Failed lens about nothing going wrong.
const String httpLogRoutineStatusesKey = 'harnessLogRoutineStatuses';

class _HttpLogInterceptor extends Interceptor {
  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    options.extra[_startedAtKey] = DateTime.now();
    handler.next(options);
  }

  @override
  void onResponse(
    Response<dynamic> response,
    ResponseInterceptorHandler handler,
  ) {
    final status = response.statusCode;
    // `validateStatus` lets 4xx and 5xx through as responses in both of this
    // app's clients, so "it answered" is not the same as "it worked".
    final routine = response.requestOptions.extra[httpLogRoutineStatusesKey];
    final failed =
        (status == null || status < 200 || status >= 300) &&
        !(routine is Set<int> && routine.contains(status));
    final line =
        '${_line(response.requestOptions)} → $status'
        '${_took(response.requestOptions)}';
    failed ? appLog.warn('api', line) : appLog.debug('api', line);
    handler.next(response);
  }

  @override
  void onError(DioException error, ErrorInterceptorHandler handler) {
    appLog.warn(
      'api',
      '${_line(error.requestOptions)} → failed${_took(error.requestOptions)}',
      error: error.message ?? error.type.name,
    );
    handler.next(error);
  }

  static String _line(RequestOptions options) =>
      redactSecretsInText('${options.method} ${options.uri}');

  static String _took(RequestOptions options) {
    final started = options.extra[_startedAtKey];
    if (started is! DateTime) return '';
    return ' (${DateTime.now().difference(started).inMilliseconds}ms)';
  }
}

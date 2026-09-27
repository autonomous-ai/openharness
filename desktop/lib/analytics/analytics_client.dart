import 'dart:async';

import 'package:dio/dio.dart';

import 'analytics_config.dart';

/// What one send attempt came to.
enum AnalyticsSendResult {
  /// The server took it.
  sent,

  /// Worth trying again with the same body — a timeout, an offline machine, a
  /// 429 or a 5xx. The event stays at the head of the queue.
  retry,

  /// The server refused the event itself (a 4xx that isn't 408 or 429). Sending
  /// it again would fail identically, so it is dropped and logged: that is our
  /// instrumentation being wrong, not the network.
  rejected,
}

/// Posts one event to Autonomous Analytics.
///
/// An interface rather than a bare function so the queue can be exercised
/// against a fake, which is how `test/analytics_test.dart` reaches every branch
/// without a socket.
abstract interface class AnalyticsClient {
  /// Sends [payload] as `POST …/event_tracking`. Never throws; a transport
  /// failure comes back as [AnalyticsSendResult.retry].
  Future<AnalyticsSendResult> send(Map<String, Object?> payload);

  /// Releases the underlying connection. Called once, when the app quits.
  void dispose();
}

/// Real [AnalyticsClient] using Dio on both native and browser targets.
///
/// Deliberately not the app's Dio [ApiClient]: that one carries the CLI's base
/// URL and unwraps `{success, data|error}` envelopes, neither of which applies
/// to a third-party ingest host. One HTTP client for the life of the app, so a
/// burst of events reuses the connection instead of paying a TLS handshake per
/// click.
class HttpAnalyticsClient implements AnalyticsClient {
  HttpAnalyticsClient(this._config);

  final AnalyticsConfig _config;
  late final Dio _client = Dio(
    BaseOptions(
      connectTimeout: AnalyticsLimits.requestTimeout,
      receiveTimeout: AnalyticsLimits.requestTimeout,
      sendTimeout: AnalyticsLimits.requestTimeout,
      validateStatus: (status) => status != null,
      headers: {'Authorization': _config.writeKey},
    ),
  );
  bool _disposed = false;

  @override
  Future<AnalyticsSendResult> send(Map<String, Object?> payload) async {
    if (_disposed) return AnalyticsSendResult.rejected;
    try {
      final response = await _client.post<dynamic>(
        _config.endpoint.toString(),
        data: payload,
      );
      return _resultFor(response.statusCode ?? 0);
    } on TimeoutException {
      return AnalyticsSendResult.retry;
    } on DioException {
      return AnalyticsSendResult.retry;
    } on Object {
      // Anything left (a bad URL, a TLS failure) would fail the same way every
      // time, so it is the event that goes, not the queue behind it.
      return AnalyticsSendResult.rejected;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _client.close(force: true);
  }

  /// 408 and 429 are "come back later", not "you are wrong" — they retry with
  /// the rest of the transport failures.
  static AnalyticsSendResult _resultFor(int status) => switch (status) {
    >= 200 && < 300 => AnalyticsSendResult.sent,
    408 || 429 => AnalyticsSendResult.retry,
    >= 500 => AnalyticsSendResult.retry,
    _ => AnalyticsSendResult.rejected,
  };
}

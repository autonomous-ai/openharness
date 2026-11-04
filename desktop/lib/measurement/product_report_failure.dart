import 'product_health_contract.dart';

/// Only a fixed category survives the transport boundary. Never retain the
/// response, URL, error message, credentials, or report in a collector error.
class ProductReportFailure implements Exception {
  const ProductReportFailure(
    this.measure, {
    this.permanent = false,
    this.backOff = false,
    this.retryAfter,
  });
  final ProductHealthMeasure measure;
  final bool permanent;
  final bool backOff;
  final Duration? retryAfter;

  /// [backOff]: a busy or failing answer (429, 5xx), after which the next
  /// report waits, and not before [retryAfter] when the answer gave one.
  factory ProductReportFailure.http(
    int? status,
    Object? code, {
    Duration? retryAfter,
  }) {
    final busy = status != null && (status == 429 || status >= 500);
    return ProductReportFailure(
      _measure(status, code),
      permanent: status == 400 || status == 413,
      backOff: busy,
      retryAfter: busy ? retryAfter : null,
    );
  }

  static ProductHealthMeasure _measure(int? status, Object? code) {
    if (status == 504 && code == 'BACKEND_TIMEOUT') {
      return ProductHealthMeasure.reportFailureTimeout;
    }
    if (status == 502 && code == 'BACKEND_UNREACHABLE') {
      return ProductHealthMeasure.reportFailureUnreachable;
    }
    if (status == 401 ||
        status == 403 ||
        code == 'AUTH_UNAVAILABLE' ||
        code == 'AUTH_SERVICE_UNAVAILABLE' ||
        code == 'ACCOUNT_CHANGED') {
      return ProductHealthMeasure.reportFailureAuth;
    }
    if (status == 400) return ProductHealthMeasure.reportFailureInvalid;
    if (status == 413) return ProductHealthMeasure.reportFailureTooLarge;
    // A busy backend answers these 429 since 2026-10-28 (503 before): the
    // cause is kept either way, as the CLI does (cli/src/gateway/reportFailure.ts).
    if ((status == 429 || status == 503) && code == 'USAGE_WRITE_CONFLICT') {
      return ProductHealthMeasure.reportFailureWriteConflict;
    }
    if ((status == 429 || status == 503) &&
        code == 'USAGE_TRANSACTION_FAILED') {
      return ProductHealthMeasure.reportFailureTransaction;
    }
    if (status == 429) return ProductHealthMeasure.reportFailureRateLimited;
    if (status != null && status >= 500 && status < 600) {
      return ProductHealthMeasure.reportFailureServer;
    }
    return ProductHealthMeasure.reportFailureOther;
  }

  @override
  String toString() => 'Product usage delivery unavailable';
}

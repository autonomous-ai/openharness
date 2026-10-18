import 'product_health_contract.dart';

/// Only a fixed category survives the transport boundary. Never retain the
/// response, URL, error message, credentials, or report in a collector error.
class ProductReportFailure implements Exception {
  const ProductReportFailure(this.measure, {this.permanent = false});
  final ProductHealthMeasure measure;
  final bool permanent;

  factory ProductReportFailure.http(int? status, Object? code) {
    if (status == 504 && code == 'BACKEND_TIMEOUT') {
      return const ProductReportFailure(
        ProductHealthMeasure.reportFailureTimeout,
      );
    }
    if (status == 502 && code == 'BACKEND_UNREACHABLE') {
      return const ProductReportFailure(
        ProductHealthMeasure.reportFailureUnreachable,
      );
    }
    if (status == 401 ||
        status == 403 ||
        code == 'AUTH_UNAVAILABLE' ||
        code == 'ACCOUNT_CHANGED') {
      return const ProductReportFailure(ProductHealthMeasure.reportFailureAuth);
    }
    if (status == 400) {
      return const ProductReportFailure(
        ProductHealthMeasure.reportFailureInvalid,
        permanent: true,
      );
    }
    if (status == 413) {
      return const ProductReportFailure(
        ProductHealthMeasure.reportFailureTooLarge,
        permanent: true,
      );
    }
    if (status == 429) {
      return const ProductReportFailure(
        ProductHealthMeasure.reportFailureRateLimited,
      );
    }
    if (status == 503 && code == 'USAGE_WRITE_CONFLICT') {
      return const ProductReportFailure(
        ProductHealthMeasure.reportFailureWriteConflict,
      );
    }
    if (status == 503 && code == 'USAGE_TRANSACTION_FAILED') {
      return const ProductReportFailure(
        ProductHealthMeasure.reportFailureTransaction,
      );
    }
    if (status != null && status >= 500 && status < 600) {
      return const ProductReportFailure(
        ProductHealthMeasure.reportFailureServer,
      );
    }
    return const ProductReportFailure(ProductHealthMeasure.reportFailureOther);
  }

  @override
  String toString() => 'Product usage delivery unavailable';
}

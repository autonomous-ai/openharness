import 'package:dio/dio.dart';

import 'product_report_failure.dart';
import 'setup_transport.dart';

/// Keep the shared credential-free transport intact. Desktop's collector only
/// needs to know whether retrying this immutable packet can ever succeed.
Future<Map<String, dynamic>> sendDesktopSetupMeasurement(
  String base,
  Map<String, dynamic> report,
) async {
  try {
    return await sendSetupMeasurement(base, report);
  } on DioException catch (error) {
    final body = error.response?.data;
    throw ProductReportFailure.http(
      error.response?.statusCode,
      body is Map && body['error'] is Map
          ? (body['error'] as Map)['code']
          : null,
    );
  }
}

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/harness_os/setup_hotspot.dart';

/// A locked device's page whose first connections fail, as one does while macOS moves its routes
/// onto the hotspot just joined.
class _Flaky implements HttpClientAdapter {
  _Flaky(this.failures);
  int failures;
  int asked = 0;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    asked++;
    if (failures > 0) {
      failures--;
      throw DioException(
        requestOptions: options,
        type: DioExceptionType.connectionError,
      );
    }
    return ResponseBody.fromString(
      jsonEncode({'error': 'WRONG_PASSWORD', 'message': 'Wrong password.'}),
      401,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  SetupHotspot hotspot(_Flaky box) => SetupHotspot(
    dio: Dio(
      BaseOptions(
        baseUrl: 'http://${SetupHotspot.address}',
        validateStatus: (_) => true,
      ),
    )..httpClientAdapter = box,
  );

  setUp(() => SetupHotspot.retryAfter = Duration.zero);
  tearDown(() => SetupHotspot.retryAfter = const Duration(seconds: 2));

  test(
    'a check whose connection fails right after the join is asked again',
    () async {
      final box = _Flaky(2);
      expect(await hotspot(box).check('nope'), 'Wrong password.');
      expect(box.asked, 3);
    },
  );

  test('a page still unreachable after that is the hotspot lost', () async {
    final box = _Flaky(5);
    await expectLater(
      hotspot(box).check('nope'),
      throwsA(
        isA<SetupException>().having(
          (e) => e.message,
          'message',
          SetupHotspot.lostHotspot,
        ),
      ),
    );
    expect(box.asked, 3);
  });
}

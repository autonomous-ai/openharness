import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

/// One canned answer: a status and a JSON body, or a failure to connect.
typedef FakeReply = ({int status, Object? body});

/// A Dio adapter that answers from [replies] by path, and remembers what was sent.
class FakeHttp implements HttpClientAdapter {
  FakeHttp(this.replies);

  /// Path → reply. A path with no entry fails the way a dropped network does.
  final Map<String, FakeReply> replies;
  final sent = <({String path, Map<String, Object?> body})>[];

  Dio dio() => Dio(
    BaseOptions(
      baseUrl: 'https://fake.invalid',
      validateStatus: (status) => status != null && status < 600,
    ),
  )..httpClientAdapter = this;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final data = options.data;
    sent.add((
      path: options.path,
      body: data is Map ? Map<String, Object?>.from(data) : const {},
    ));
    final reply = replies[options.path];
    if (reply == null) {
      throw DioException.connectionError(
        requestOptions: options,
        reason: 'offline',
      );
    }
    return ResponseBody.fromString(
      jsonEncode(reply.body),
      reply.status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

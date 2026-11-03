import 'dart:convert';
import 'dart:typed_data';

/// A `multipart/form-data` body holding [fields], then one file, as plain bytes.
///
/// Built by hand rather than with Dio's `FormData`, because a `FormData` can be
/// sent exactly once: [BearerAuthInterceptor] answers a 401 by refreshing the
/// token and re-sending the SAME request, and a finalized `FormData` throws
/// there instead of going out again. Bytes go out as many times as asked.
///
/// Names are escaped as Dio's `FormData` escapes them (a quote and a line break
/// percent-encoded), so a file's name cannot end its header early.
({Uint8List bytes, String contentType}) multipartFileBody({
  Map<String, String> fields = const {},
  required String field,
  required String filename,
  required String fileContentType,
  required Uint8List file,
  required String boundary,
}) {
  final head = StringBuffer();
  for (final MapEntry(:key, :value) in fields.entries) {
    head
      ..write('--$boundary\r\n')
      ..write('Content-Disposition: form-data; name="${_escape(key)}"\r\n\r\n')
      ..write('$value\r\n');
  }
  head
    ..write('--$boundary\r\n')
    ..write(
      'Content-Disposition: form-data; name="${_escape(field)}"; '
      'filename="${_escape(filename)}"\r\n',
    )
    ..write('Content-Type: $fileContentType\r\n\r\n');
  final bytes =
      (BytesBuilder(copy: false)
            ..add(utf8.encode(head.toString()))
            ..add(file)
            ..add(utf8.encode('\r\n--$boundary--\r\n')))
          .takeBytes();
  return (bytes: bytes, contentType: 'multipart/form-data; boundary=$boundary');
}

String _escape(String value) => value
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .replaceAll('"', '%22');

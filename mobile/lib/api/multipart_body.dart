import 'dart:convert';
import 'dart:typed_data';

/// A `multipart/form-data` body holding one file, as plain bytes.
///
/// Built by hand rather than with Dio's `FormData`, because a `FormData` can be
/// sent exactly once: [BearerAuthInterceptor] answers a 401 by refreshing the
/// token and re-sending the SAME request, and a finalized `FormData` throws
/// there instead of going out again. Bytes go out as many times as asked.
({Uint8List bytes, String contentType}) multipartFileBody({
  required String field,
  required String filename,
  required String fileContentType,
  required Uint8List file,
  required String boundary,
}) {
  final head =
      '--$boundary\r\n'
      'Content-Disposition: form-data; name="$field"; filename="$filename"\r\n'
      'Content-Type: $fileContentType\r\n\r\n';
  final bytes =
      (BytesBuilder(copy: false)
            ..add(utf8.encode(head))
            ..add(file)
            ..add(utf8.encode('\r\n--$boundary--\r\n')))
          .takeBytes();
  return (bytes: bytes, contentType: 'multipart/form-data; boundary=$boundary');
}

import 'dart:convert';
import 'dart:math';

import 'package:harness/e2ee/bytes.dart' show hexOf;
import 'package:harness/e2ee/primitives.dart' show sha256;

List<Map<String, dynamic>> inventoryPages(Map<String, dynamic> value) =>
    inventoryBytePages(utf8.encode(jsonEncode(value)));

List<Map<String, dynamic>> inventoryBytePages(List<int> bytes) {
  const chunkBytes = 128 * 1024;
  final digest = hexOf(sha256(bytes));
  return [
    for (var offset = 0; offset < bytes.length; offset += chunkBytes)
      {
        'inventoryPage': {
          'version': 1,
          'id': 'test-snapshot',
          'offset': offset,
          'totalBytes': bytes.length,
          'sha256': digest,
          'data': base64Encode(
            bytes.sublist(offset, min(bytes.length, offset + chunkBytes)),
          ),
          'nextOffset': offset + chunkBytes < bytes.length
              ? offset + chunkBytes
              : null,
        },
      },
  ];
}

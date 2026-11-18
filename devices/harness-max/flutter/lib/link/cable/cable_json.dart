// The daemon's JSON as the device reads it: the shape guard (cable_json_guard.c), byte caps cut on a character
// (pro_cable.c copy_cut) and the field readers, so a Dart string holds exactly what the C would hold.
import 'dart:convert';
import 'dart:typed_data';

import 'cable_frame.dart';

const int kJsonDepth = 12;
const int kJsonTokens = 512;

/// The C's guard before cJSON: one object, nesting at most [kJsonDepth], at most [kJsonTokens] values, keys and
/// containers, no raw control character. Bounds what a flat array or a deep one can cost before it is parsed.
bool cableJsonGuard(Uint8List bytes) {
  if (bytes.isEmpty || bytes.length > kCableMaxPayload) return false;
  final stack = <int>[];
  var tokens = 0;
  var string = false, escaped = false, started = false, finished = false, atom = false;
  for (final c in bytes) {
    if (string) {
      if (c < 0x20) return false;
      if (escaped) {
        escaped = false;
      } else if (c == 0x5C) {
        escaped = true;
      } else if (c == 0x22) {
        string = false;
      }
      continue;
    }
    if (c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D) {
      atom = false;
      continue;
    }
    if (c < 0x20 || finished) return false;
    if (!started) {
      if (c != 0x7B) return false;
      started = true;
    }
    if (c == 0x22) {
      if (++tokens > kJsonTokens) return false;
      string = true;
      atom = false;
    } else if (c == 0x7B || c == 0x5B) {
      if (++tokens > kJsonTokens || stack.length == kJsonDepth) return false;
      stack.add(c);
      atom = false;
    } else if (c == 0x7D || c == 0x5D) {
      if (stack.isEmpty || stack.last != (c == 0x7D ? 0x7B : 0x5B)) return false;
      stack.removeLast();
      if (stack.isEmpty) finished = true;
      atom = false;
    } else if (c == 0x3A || c == 0x2C) {
      atom = false;
    } else if (!atom) {
      if (++tokens > kJsonTokens) return false;
      atom = true;
    }
  }
  return finished && !string && stack.isEmpty;
}

/// A frame's JSON object, or null when the guard refuses it or it is not one object.
Map<String, Object?>? decodeCableJson(Uint8List payload) {
  if (!cableJsonGuard(payload)) return null;
  try {
    final value = jsonDecode(utf8.decode(payload, allowMalformed: true));
    return value is Map<String, Object?> ? value : null;
  } on FormatException {
    return null;
  }
}

/// UTF-8 bytes of [s]: every cap below is in bytes, as the C's buffers are.
int utf8Bytes(String s) => utf8.encode(s).length;

/// [s] in a buffer of [cap] bytes, NUL included: at most cap - 1 bytes, never splitting a character.
String cutUtf8(String s, int cap) {
  final bytes = utf8.encode(s);
  if (bytes.length < cap) return s;
  var n = cap - 1;
  while (n > 0 && (bytes[n] & 0xC0) == 0x80) {
    n--;
  }
  return utf8.decode(bytes.sublist(0, n), allowMalformed: true);
}

/// The message's fields: `p` when present (an object, or nothing at all when it is not one), else the message itself.
Map<String, Object?> payloadOf(Map<String, Object?> root) {
  if (!root.containsKey('p')) return root;
  final p = root['p'];
  return p is Map<String, Object?> ? p : const {};
}

/// A string field, or null when absent or not a string.
String? strOf(Object? o, String key) {
  if (o is! Map) return null;
  final v = o[key];
  return v is String ? v : null;
}

/// A string field cut to [cap] bytes, or null when absent.
String? cutOf(Object? o, String key, int cap) {
  final s = strOf(o, key);
  return s == null ? null : cutUtf8(s, cap);
}

/// Exactly `true` (cJSON_IsTrue): absent, 1 and "true" are false.
bool flagOf(Object? o, String key) => o is Map && o[key] == true;

/// A finite number field, or null.
num? numOf(Object? o, String key) {
  if (o is! Map) return null;
  final v = o[key];
  return v is num && v.isFinite ? v : null;
}

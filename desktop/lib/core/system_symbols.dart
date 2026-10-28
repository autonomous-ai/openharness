import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// AppKit's own SF Symbols, which the Mac runner draws as one-ink PNGs for
/// Flutter to tint (`MainFlutterWindow.swift`). Only the Mac app has them:
/// elsewhere, for a name this macOS lacks, and when the call fails, there is
/// no picture and the caller draws its catalogue icon instead.
class SystemSymbols {
  SystemSymbols({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(channelName);

  static const channelName = 'harness/system_symbols';
  static final shared = SystemSymbols();

  final MethodChannel _channel;
  final _drawn = <String, Uint8List?>{};
  final _drawing = <String, Future<Uint8List?>>{};

  bool get available =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

  static String _key(String name, double size, double scale) =>
      '$name@$size@$scale';

  /// [name] as already drawn at [size] points and [scale], or null.
  Uint8List? drawn(
    String name, {
    required double size,
    required double scale,
  }) => _drawn[_key(name, size, scale)];

  /// [name] drawn at [size] points for a [scale]× screen; null when there is
  /// none. Each is asked once.
  Future<Uint8List?> png(
    String name, {
    required double size,
    required double scale,
  }) {
    final key = _key(name, size, scale);
    if (_drawn.containsKey(key)) return SynchronousFuture(_drawn[key]);
    if (!available) return SynchronousFuture(null);
    return _drawing[key] ??= () async {
      Uint8List? bytes;
      try {
        bytes = await _channel.invokeMethod<Uint8List>('png', {
          'name': name,
          'size': size,
          'scale': scale,
        });
      } catch (_) {
        bytes = null;
      }
      _drawing.remove(key);
      return _drawn[key] = bytes;
    }();
  }
}

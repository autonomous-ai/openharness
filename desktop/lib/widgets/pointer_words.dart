import 'package:flutter/foundation.dart';

/// What a person does to a control, said as they do it: "Click" with a mouse,
/// "Tap" on a phone or tablet's browser. Desktop runs on macOS, Linux and
/// Windows only, so its wording never changes.
String clickWord({TargetPlatform? platform, bool capital = true}) {
  final touch = switch (platform ?? defaultTargetPlatform) {
    TargetPlatform.iOS || TargetPlatform.android => true,
    _ => false,
  };
  return switch ((touch, capital)) {
    (true, true) => 'Tap',
    (true, false) => 'tap',
    (false, true) => 'Click',
    (false, false) => 'click',
  };
}

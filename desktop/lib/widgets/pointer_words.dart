import 'package:flutter/foundation.dart';

/// What a person does to a control, said as they do it: "Click" with a mouse,
/// "Tap" on a phone or tablet's browser. Desktop runs on macOS, Linux and
/// Windows only, so its wording never changes.
String clickWord({TargetPlatform? platform, bool capital = true}) =>
    switch ((isPhoneOrTablet(platform), capital)) {
      (true, true) => 'Tap',
      (true, false) => 'tap',
      (false, true) => 'Click',
      (false, false) => 'click',
    };

/// Whether [platform] (this one when absent) is a phone's or a tablet's, iOS
/// or Android: a browser there is used by touch. Desktop never is.
bool isPhoneOrTablet([TargetPlatform? platform]) =>
    switch (platform ?? defaultTargetPlatform) {
      TargetPlatform.iOS || TargetPlatform.android => true,
      _ => false,
    };

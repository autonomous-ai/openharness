import 'package:web/web.dart' as web;

import 'web_form_factor.dart' show browserLabelFrom, mobileUserAgent;

bool detectMobileWeb() {
  final ua = web.window.navigator.userAgent;
  if (mobileUserAgent(ua)) return true;
  // A touch-only screen the width of a phone, whatever it claims to be.
  return web.window.matchMedia('(pointer: coarse)').matches &&
      web.window.innerWidth < 600;
}

String browserLabel() => browserLabelFrom(web.window.navigator.userAgent);

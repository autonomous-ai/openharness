import 'package:web/web.dart' as web;

import 'browser_login.dart';

class DirectLogin extends BrowserLogin {
  DirectLogin({required super.auth}) : super(browser: _WebLoginBrowser());
}

class _WebLoginBrowser implements LoginBrowser {
  static const _key = 'harness.web.v1.auth_transaction';
  @override
  Uri get uri => Uri.parse(web.window.location.href);
  @override
  String? get transaction => web.window.sessionStorage.getItem(_key);
  @override
  set transaction(String? value) {
    if (value == null) {
      web.window.sessionStorage.removeItem(_key);
    } else {
      web.window.sessionStorage.setItem(_key, value);
    }
  }

  @override
  void replaceLocation(String path) =>
      web.window.history.replaceState(null, '', path);
}

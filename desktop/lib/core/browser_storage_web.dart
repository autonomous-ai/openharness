import 'package:web/web.dart' as web;

String? readBrowserPreference(String key) =>
    web.window.localStorage.getItem('harness.web.v1.$key');
void writeBrowserPreference(String key, String value) =>
    web.window.localStorage.setItem('harness.web.v1.$key', value);

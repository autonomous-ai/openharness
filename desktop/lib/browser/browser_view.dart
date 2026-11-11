import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../logging/app_log.dart';

/// The bundled noVNC page (desktop/tool/browser_viewer) in the native webview. It speaks JSON both ways: the page
/// posts through its `HarnessBrowser` channel, and the host calls `window.harnessBrowserReceive`.
class BrowserView {
  BrowserView() {
    unawaited(_load());
  }

  static const asset = 'assets/browser/browser_viewer.html';

  final _controller = WebViewController();

  // Held until the bridge listens, so the page's ready is never missed.
  final _messages = StreamController<Map<String, Object?>>();

  Stream<Map<String, Object?>> get messages => _messages.stream;

  Future<void> _load() async {
    try {
      await _controller.setJavaScriptMode(JavaScriptMode.unrestricted);
      await _controller.addJavaScriptChannel(
        'HarnessBrowser',
        onMessageReceived: (message) {
          final decoded = jsonDecode(message.message);
          if (decoded is Map<String, Object?>) _messages.add(decoded);
        },
      );
      // The page is self-contained and never navigates: nothing in it may take the webview anywhere else.
      await _controller.setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) => request.url == 'about:blank'
              ? NavigationDecision.navigate
              : NavigationDecision.prevent,
        ),
      );
      await _controller.loadHtmlString(await rootBundle.loadString(asset));
    } catch (error) {
      // The bridge waits for the page's ready, and says this computer can't show it.
      appLog.warn('browser', 'viewer page did not load: $error');
    }
  }

  void post(Map<String, Object?> message) {
    // Not awaited, so one call that fails (noVNC refusing bytes) never holds the next; the page reports its own
    // disconnect.
    _controller
        .runJavaScript('window.harnessBrowserReceive(${jsonEncode(message)})')
        .catchError((Object error) {
          appLog.warn('browser', 'viewer page refused a message: $error');
        });
  }

  Widget build(BuildContext context) => WebViewWidget(controller: _controller);
}

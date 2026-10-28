import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

/// A webview platform with no native view: records what the app asks of each controller and lets a
/// test play the navigation callbacks WKWebView would make.
class FakeWebViewPlatform extends WebViewPlatform {
  final controllers = <FakeWebViewController>[];

  /// While set, adding a JavaScript channel waits for it, as the native call does.
  Completer<void>? channelGate;

  @override
  PlatformWebViewController createPlatformWebViewController(
    PlatformWebViewControllerCreationParams params,
  ) {
    final controller = FakeWebViewController(params, this);
    controllers.add(controller);
    return controller;
  }

  @override
  PlatformNavigationDelegate createPlatformNavigationDelegate(
    PlatformNavigationDelegateCreationParams params,
  ) => FakeNavigationDelegate(params);

  @override
  PlatformWebViewWidget createPlatformWebViewWidget(
    PlatformWebViewWidgetCreationParams params,
  ) => _FakeWebViewWidget(params);
}

class FakeWebViewController extends PlatformWebViewController {
  FakeWebViewController(super.params, this._platform) : super.implementation();

  final FakeWebViewPlatform _platform;
  final loads = <Uri>[];
  final scripts = <String>[];
  int reloads = 0;
  FakeNavigationDelegate? delegate;

  @override
  Future<void> setJavaScriptMode(JavaScriptMode javaScriptMode) async {}

  @override
  Future<void> setPlatformNavigationDelegate(
    PlatformNavigationDelegate handler,
  ) async {
    delegate = handler as FakeNavigationDelegate;
  }

  @override
  Future<void> addJavaScriptChannel(
    JavaScriptChannelParams javaScriptChannelParams,
  ) async {
    await _platform.channelGate?.future;
  }

  @override
  Future<void> loadRequest(LoadRequestParams params) async {
    loads.add(params.uri);
  }

  @override
  Future<void> reload() async {
    reloads++;
  }

  @override
  Future<void> runJavaScript(String javaScript) async {
    scripts.add(javaScript);
  }

  @override
  Future<String?> currentUrl() async =>
      loads.isEmpty ? null : loads.last.toString();

  @override
  Future<void> setBackgroundColor(Color color) async {}
}

class FakeNavigationDelegate extends PlatformNavigationDelegate {
  FakeNavigationDelegate(super.params) : super.implementation();

  PageEventCallback? onPageStarted, onPageFinished;
  WebResourceErrorCallback? onWebResourceError;

  @override
  Future<void> setOnPageStarted(PageEventCallback onPageStarted) async {
    this.onPageStarted = onPageStarted;
  }

  @override
  Future<void> setOnPageFinished(PageEventCallback onPageFinished) async {
    this.onPageFinished = onPageFinished;
  }

  @override
  Future<void> setOnWebResourceError(
    WebResourceErrorCallback onWebResourceError,
  ) async {
    this.onWebResourceError = onWebResourceError;
  }
}

class _FakeWebViewWidget extends PlatformWebViewWidget {
  _FakeWebViewWidget(super.params) : super.implementation();

  @override
  Widget build(BuildContext context) =>
      const SizedBox.expand(key: ValueKey('fake-webview'));
}

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import '../core/dsh_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;

Future<void> showStoreDemo(
  BuildContext context, {
  required DshEntry entry,
  required StoreExample example,
}) async {
  if (example.video == null) return;
  await showDialog<void>(
    context: context,
    builder: (_) => StoreDemoDialog(
      name: entry.name,
      video: example.video!,
      caption: example.caption,
    ),
  );
}

/// A trusted local player document. No remote page or script is executed.
String storeDemoHtml(String video) {
  final source = const HtmlEscape().convert(video);
  return '''<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src https:; style-src 'unsafe-inline'; script-src 'nonce-harness-recording'">
<style>html,body{margin:0;width:100%;height:100%;background:#111316;overflow:hidden}video{width:100%;height:100%;object-fit:contain}</style>
</head><body><video id="recording" controls playsinline autoplay preload="none" aria-label="Recorded harness session"><source src="$source" type="video/mp4"></video>
<script nonce="harness-recording">document.querySelector('video').addEventListener('error',()=>DemoStatus.postMessage('error'));document.querySelector('source').addEventListener('error',()=>DemoStatus.postMessage('error'));</script>
</body></html>''';
}

/// GitHub's file page offers browser playback; its raw endpoint may download.
Uri storeDemoBrowserUri(String video) {
  final uri = Uri.parse(video);
  final parts = uri.pathSegments;
  if (uri.host == 'raw.githubusercontent.com' && parts.length >= 4) {
    return Uri.https(
      'github.com',
      [parts[0], parts[1], 'blob', ...parts.skip(2)].join('/'),
    );
  }
  return uri;
}

class StoreDemoDialog extends StatefulWidget {
  const StoreDemoDialog({
    super.key,
    required this.name,
    required this.video,
    this.caption,
  });

  final String name;
  final String video;
  final String? caption;

  @override
  State<StoreDemoDialog> createState() => _StoreDemoDialogState();
}

class _StoreDemoDialogState extends State<StoreDemoDialog>
    with WidgetsBindingObserver {
  WebViewController? _controller;
  bool _failed = false;
  bool _loading = true;
  bool _openingBrowser = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (WebViewPlatform.instance != null) _start();
  }

  Future<void> _start() async {
    try {
      final controller = WebViewController.fromPlatformCreationParams(
        WebViewPlatform.instance is WebKitWebViewPlatform
            ? WebKitWebViewControllerCreationParams(
                allowsInlineMediaPlayback: true,
                mediaTypesRequiringUserAction: const <PlaybackMediaTypes>{},
              )
            : const PlatformWebViewControllerCreationParams(),
      );
      _controller = controller;
      await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
      await controller.addJavaScriptChannel(
        'DemoStatus',
        onMessageReceived: (message) {
          if (mounted && message.message == 'error') {
            setState(() => _failed = true);
          }
        },
      );
      await controller.setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) => request.url == 'about:blank'
              ? NavigationDecision.navigate
              : NavigationDecision.prevent,
          onPageFinished: (_) {
            if (mounted) setState(() => _loading = false);
          },
          onWebResourceError: (error) {
            if (mounted && error.isForMainFrame != false) {
              setState(() => _failed = true);
            }
          },
        ),
      );
      if (!mounted) return;
      await controller.loadHtmlString(storeDemoHtml(widget.video));
      if (mounted) setState(() {});
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  void _pause() {
    _controller
        ?.runJavaScript("document.querySelector('video')?.pause()")
        .ignore();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) _pause();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _pause();
    // Native views can outlive the Flutter route; remove the media on every close path.
    _controller?.loadHtmlString('').ignore();
    super.dispose();
  }

  Future<void> _openBrowser() async {
    if (_openingBrowser) return;
    setState(() => _openingBrowser = true);
    _pause();
    var opened = false;
    try {
      opened = await launchUrl(
        storeDemoBrowserUri(widget.video),
        mode: LaunchMode.externalApplication,
      );
    } catch (_) {
      // Leave the recording and its retry action in place.
    }
    if (!mounted) return;
    setState(() => _openingBrowser = false);
    if (!opened) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Could not open the recording. Try again.'),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final size = MediaQuery.sizeOf(context);
    final width = (size.width - 48).clamp(0.0, 1080.0);
    final height = (size.height - 48).clamp(0.0, 820.0);
    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      clipBehavior: Clip.antiAlias,
      child: SizedBox(
        width: width,
        height: height,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 8, 12),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '${widget.name} · Recorded session',
                      style: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  IconButton(
                    key: const ValueKey('store-demo-close'),
                    tooltip: 'Close recording',
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(LucideIcons.x300),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ColoredBox(
                color: const Color(0xFF111316),
                child: _failed || WebViewPlatform.instance == null
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Icon(
                                LucideIcons.film300,
                                size: 36,
                                color: Colors.white70,
                              ),
                              const SizedBox(height: 16),
                              Text(
                                _failed
                                    ? 'This recording could not play here.'
                                    : 'Watch this recording in your browser.',
                                textAlign: TextAlign.center,
                                style: const TextStyle(
                                  color: Colors.white,
                                  fontSize: 16,
                                ),
                              ),
                              const SizedBox(height: 16),
                              FilledButton(
                                onPressed: _openingBrowser
                                    ? null
                                    : _openBrowser,
                                child: const Text('Open recording'),
                              ),
                            ],
                          ),
                        ),
                      )
                    : Stack(
                        children: [
                          if (_controller != null)
                            Positioned.fill(
                              child: WebViewWidget(controller: _controller!),
                            ),
                          if (_loading)
                            const Center(child: CircularProgressIndicator()),
                        ],
                      ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Wrap(
                alignment: WrapAlignment.spaceBetween,
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: 16,
                runSpacing: 8,
                children: [
                  if (widget.caption != null)
                    ConstrainedBox(
                      constraints: BoxConstraints(
                        maxWidth: (width - 32).clamp(0.0, 740.0),
                      ),
                      child: Text(
                        widget.caption!,
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                  TextButton.icon(
                    key: const ValueKey('store-demo-browser'),
                    onPressed: _openingBrowser ? null : _openBrowser,
                    icon: const Icon(LucideIcons.externalLink300, size: 16),
                    label: const Text('Open in browser'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

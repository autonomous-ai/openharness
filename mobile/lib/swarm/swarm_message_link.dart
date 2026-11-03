import 'dart:async';

import 'package:flutter/services.dart';

/// A link to one message of a Swarm: `harness://swarm/<tab>/<conversation>/<message>`,
/// the link Desktop copies (desktop/lib/super_tabs/message_link.dart). It
/// names ids only, so it grants nothing: whoever opens it sees the message
/// only if the Swarm already lets them read that conversation. The message id
/// alone places it, so the link still works for a message in a thread.
class SwarmMessageLink {
  const SwarmMessageLink({
    required this.tabId,
    required this.conversationId,
    required this.messageId,
  });

  final String tabId, conversationId, messageId;

  String get url => 'harness://swarm/$tabId/$conversationId/$messageId';

  static final _id = RegExp(r'^[A-Za-z0-9_-]{1,160}$');

  /// The link [value] is, read as Desktop reads it; null for anything else.
  static SwarmMessageLink? parse(String value) {
    // Desktop's native URL-open limit.
    if (value.length > 240) return null;
    final uri = Uri.tryParse(value);
    if (uri == null ||
        uri.scheme != 'harness' ||
        uri.host != 'swarm' ||
        uri.hasPort ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        uri.pathSegments.length != 3 ||
        !uri.pathSegments.every(_id.hasMatch)) {
      return null;
    }
    final [tab, conversation, message] = uri.pathSegments;
    return SwarmMessageLink(
      tabId: tab,
      conversationId: conversation,
      messageId: message,
    );
  }
}

/// `harness/links`: the message links this phone was asked to open (iOS:
/// `LinkChannel` in AppDelegate.swift; Android: MainActivity.kt). The native
/// side holds each until `take` answers it, so one that launched the app, or
/// came before sign-in, waits for whoever listens next; `arrived` says more
/// wait. [onLink] hears each message link, in order; anything else is
/// dropped.
class SwarmLinkChannel {
  SwarmLinkChannel(this.onLink);

  static const _channel = MethodChannel('harness/links');
  final void Function(SwarmMessageLink) onLink;
  bool _closed = false;

  /// Takes what waits now, and whatever arrives until [close].
  void listen() {
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'arrived') await _take();
      return null;
    });
    unawaited(_take());
  }

  Future<void> _take() async {
    List<String>? taken;
    try {
      taken = await _channel.invokeListMethod<String>('take');
    } on MissingPluginException {
      return;
    } on PlatformException {
      return;
    }
    if (_closed) return;
    for (final value in taken ?? const <String>[]) {
      if (SwarmMessageLink.parse(value) case final link?) onLink(link);
    }
  }

  /// Leaves links waiting for the next listener.
  void close() {
    _closed = true;
    _channel.setMethodCallHandler(null);
  }
}

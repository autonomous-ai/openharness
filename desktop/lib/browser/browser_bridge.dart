import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/services.dart';

import 'browser_stream.dart';
import 'browser_view.dart';

/// Joins the page to its stream: the machine's VNC bytes go into noVNC, and what noVNC sends, and how much of the
/// machine's bytes it has read, go back.
class BrowserBridge {
  BrowserBridge(this._view, this._stream, {required this.mac});

  /// How long the page has to say it loaded.
  static const pageTimeout = Duration(seconds: 15);

  final BrowserView _view;
  final BrowserStream _stream;

  /// ⌘ is sent as Ctrl, and Ctrl+V stays the remote's own key.
  final bool mac;

  StreamSubscription<Map<String, Object?>>? _page;
  StreamSubscription<Uint8List>? _bytes;
  bool _closing = false;

  /// Waits for the page, opens the stream, then joins them. Throws [BrowserStreamError]: the machine's refusal,
  /// [BrowserStreamError.route], or [BrowserStreamError.page] when the page never loaded.
  Future<void> start() async {
    final ready = Completer<void>();
    _page = _view.messages.listen((message) {
      if (message['t'] == 'ready') {
        if (!ready.isCompleted) ready.complete();
      } else {
        _fromPage(message);
      }
    });
    await ready.future.timeout(
      pageTimeout,
      onTimeout: () => throw const BrowserStreamError(BrowserStreamError.page),
    );
    _view.post({'t': 'config', 'mac': mac});
    await _stream.open();
    _view.post({'t': 'open'});
    _bytes = _stream.bytes.listen(
      (bytes) => _view.post({'t': 'data', 'b64': base64Encode(bytes)}),
    );
    unawaited(
      _stream.closed.then((reason) {
        if (!_closing) _view.post({'t': 'closed', 'reason': reason});
      }),
    );
  }

  void _fromPage(Map<String, Object?> message) {
    switch (message) {
      case {'t': 'data', 'b64': final String b64}:
        _stream.write(base64Decode(b64));
      case {'t': 'consumed', 'bytes': final int bytes}:
        _stream.consumed(bytes);
      case {'t': 'copy', 'text': final String text}:
        unawaited(Clipboard.setData(ClipboardData(text: text)));
      case {'t': 'state', 'connected': false}:
        // noVNC closed its side: the machine's exec ends too.
        unawaited(_stream.close());
    }
  }

  /// Sets the remote clipboard to [text] and pastes it there.
  void paste(String text) => _view.post({'t': 'paste', 'text': text});

  Future<void> close() async {
    _closing = true;
    // Told at once, before the page lets go: the machine's exec ends with it.
    final closing = _stream.close();
    await _page?.cancel();
    await _bytes?.cancel();
    await closing;
  }
}

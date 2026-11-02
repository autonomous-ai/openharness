import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Keeps the browser's own context menu off while the pointer is over a widget that opens a menu of its own.
///
/// Several widgets can want it off at once (a tab and a machine row never overlap, but a pointer that moves from one
/// to another reports the new enter and the old exit in either order), so each holds the switch under its own key and
/// the browser's menu comes back only when nobody holds it. Anywhere else (a terminal, a text field) a right-click
/// keeps the browser's Copy and Paste. A computer, where there is no browser menu, does nothing at all.
class BrowserMenuGuard {
  BrowserMenuGuard._();

  static final Set<Object> _holders = {};
  static bool _off = false;

  /// Test seam: pretend to be a browser, and see what the switch is told.
  @visibleForTesting
  static bool? debugWeb;
  @visibleForTesting
  static Future<void> Function(bool off)? debugSink;

  @visibleForTesting
  static void debugReset() {
    _holders.clear();
    _off = false;
    debugWeb = null;
    debugSink = null;
  }

  static bool get _web => debugWeb ?? kIsWeb;

  /// Whether this runs in a browser, where a right-click is not sure to reach the app.
  static bool get inBrowser => _web;

  /// Whether this runs in a phone's or tablet's browser, where nothing can hover.
  static bool get onTouchScreen =>
      _web &&
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS);

  /// Whether the browser's menu is off now.
  static bool get isOff => _off;

  /// [owner] wants the browser's menu off until it releases.
  static void hold(Object owner) {
    if (!_web || !_holders.add(owner)) return;
    _sync();
  }

  /// [owner] no longer needs it off.
  static void release(Object owner) {
    if (!_holders.remove(owner)) return;
    _sync();
  }

  static void _sync() {
    final off = _holders.isNotEmpty;
    if (off == _off) return;
    _off = off;
    final sink = debugSink;
    if (sink != null) {
      unawaited(sink(off));
      return;
    }
    // The channel itself rather than BrowserContextMenu: that one asserts it runs in a browser, which a test is not.
    unawaited(
      SystemChannels.contextMenu.invokeMethod<void>(
        off ? 'disableContextMenu' : 'enableContextMenu',
      ),
    );
  }
}

/// Wraps [child] so the browser's context menu is off while the pointer is over it or pressed on it, and [active].
class BrowserMenuOff extends StatefulWidget {
  const BrowserMenuOff({super.key, required this.active, required this.child});

  /// False when the child has no menu to show (nothing opens, so the browser's menu stays).
  final bool active;
  final Widget child;

  @override
  State<BrowserMenuOff> createState() => _BrowserMenuOffState();
}

class _BrowserMenuOffState extends State<BrowserMenuOff> {
  bool _hovered = false, _pressed = false;

  void _sync() {
    if ((_hovered || _pressed) && widget.active) {
      BrowserMenuGuard.hold(this);
    } else {
      BrowserMenuGuard.release(this);
    }
  }

  @override
  void didUpdateWidget(BrowserMenuOff oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  @override
  void dispose() {
    BrowserMenuGuard.release(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MouseRegion(
    onEnter: (_) {
      _hovered = true;
      _sync();
    },
    onExit: (_) {
      _hovered = false;
      _sync();
    },
    // A finger never hovers: a phone's browser asks for its menu while the finger is still down on a long press.
    child: Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: (_) {
        _pressed = true;
        _sync();
      },
      onPointerUp: (_) {
        _pressed = false;
        _sync();
      },
      onPointerCancel: (_) {
        _pressed = false;
        _sync();
      },
      child: widget.child,
    ),
  );
}

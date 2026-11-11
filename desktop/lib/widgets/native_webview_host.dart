import 'package:flutter/material.dart';

import '../core/runtime_platform.dart';
import 'transient_menus.dart';

/// Detaches the native web view that Linux and Windows draw above the Flutter
/// window (GTK's overlay, WebView2's window) while Flutter draws there. The controller
/// stays with its owner, retaining the loaded page until the widget returns.
class NativeWebViewHost extends StatelessWidget {
  const NativeWebViewHost({
    super.key,
    required this.child,
    this.visible = true,
  });

  final Widget child;
  final bool visible;

  @override
  Widget build(BuildContext context) {
    if (!RuntimePlatform.isLinux && !RuntimePlatform.isWindows) return child;
    final routeCovered = ModalRoute.isCurrentOf(context) == false;
    return ValueListenableBuilder<bool>(
      valueListenable: transientMenusVisible,
      builder: (_, menuVisible, child) =>
          !visible || routeCovered || menuVisible
          ? const SizedBox.shrink()
          : child!,
      child: child,
    );
  }
}

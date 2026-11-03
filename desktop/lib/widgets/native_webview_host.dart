import 'package:flutter/material.dart';

import '../core/runtime_platform.dart';
import 'transient_menus.dart';

/// Detaches GTK's overlay widget while Flutter draws above it. The controller
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
    if (!RuntimePlatform.isLinux) return child;
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

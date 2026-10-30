import 'package:flutter/widgets.dart';

/// The terminal view's clipboard entry points, available only below its panel.
/// Keeping the focus node here prevents a composer or find field in that pane
/// from being mistaken for terminal input. No global target survives disposal.
class TerminalEditActions extends InheritedWidget {
  const TerminalEditActions({
    super.key,
    required this.focusNode,
    required this.copy,
    required this.paste,
    required super.child,
  });

  final FocusNode focusNode;
  final Future<void> Function() copy;
  final Future<void> Function() paste;

  static TerminalEditActions? forFocus(FocusNode? focus) {
    final context = focus?.context;
    if (context == null || !context.mounted) return null;
    final actions = context
        .findAncestorWidgetOfExactType<TerminalEditActions>();
    return identical(actions?.focusNode, focus) ? actions : null;
  }

  @override
  bool updateShouldNotify(TerminalEditActions oldWidget) => false;
}

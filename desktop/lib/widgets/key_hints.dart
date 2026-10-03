import 'package:flutter/widgets.dart';

/// Whether keyboard hints are drawn: a result's accept key, the picker's
/// "Enter select · Esc back" line. Absent means shown — desktop never places
/// one. The mouse-first web build turns them off; the keys work either way.
class KeyHints extends InheritedWidget {
  const KeyHints({super.key, required this.visible, required super.child});

  final bool visible;

  static bool visibleOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<KeyHints>()?.visible ?? true;

  @override
  bool updateShouldNotify(KeyHints oldWidget) => visible != oldWidget.visible;
}

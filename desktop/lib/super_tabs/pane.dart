import 'package:flutter/widgets.dart';

/// A Super Tab's view of an existing terminal. The renderer and session stay
/// shared with ordinary panes; presentation belongs to this placement only.
/// AppNotifier's close policy keeps pane, keyboard and tab dismissal hide-only.
class SuperPane extends InheritedWidget {
  const SuperPane({
    super.key,
    required this.machineId,
    required this.harnessId,
    this.title,
    required super.child,
  });

  final String machineId, harnessId;
  final String? title;

  static SuperPane? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SuperPane>();

  String? titleFor(String machine, String harness) =>
      machine == machineId && harness == harnessId ? title : null;

  @override
  bool updateShouldNotify(SuperPane oldWidget) =>
      machineId != oldWidget.machineId ||
      harnessId != oldWidget.harnessId ||
      title != oldWidget.title;
}

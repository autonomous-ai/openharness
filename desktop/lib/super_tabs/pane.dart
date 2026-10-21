import 'package:flutter/widgets.dart';

/// A Swarm's view of an existing terminal. The renderer and session stay
/// shared with ordinary panes; presentation belongs to this placement only.
/// Group membership owns the visible panes; individual panes cannot be closed.
class SuperPane extends InheritedWidget {
  const SuperPane({
    super.key,
    required this.machineId,
    required this.harnessId,
    this.title,
    this.titles = const {},
    this.failures = const {},
    this.onRetry,
    this.onResume,
    required super.child,
  });

  final String machineId, harnessId;
  final String? title;
  final Map<(String, String?), String> titles, failures;
  final VoidCallback? onRetry;
  final void Function(String machineId, String harnessId)? onResume;

  static SuperPane? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SuperPane>();

  String? titleFor(String machine, String harness) =>
      titles[(machine, harness)] ??
      (machine == machineId && harness == harnessId ? title : null);

  @override
  bool updateShouldNotify(SuperPane oldWidget) =>
      machineId != oldWidget.machineId ||
      harnessId != oldWidget.harnessId ||
      title != oldWidget.title ||
      titles != oldWidget.titles ||
      failures != oldWidget.failures ||
      onResume != oldWidget.onResume;
}

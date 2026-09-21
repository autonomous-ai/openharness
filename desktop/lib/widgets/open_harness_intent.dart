import 'package:flutter/widgets.dart';

/// Store and pane menus use the workspace's creation flow with their context.
class OpenHarnessIntent extends Intent {
  const OpenHarnessIntent(this.engine, this.machineId, {this.task});
  final String engine, machineId;
  final String? task;
}

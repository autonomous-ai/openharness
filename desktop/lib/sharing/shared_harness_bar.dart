import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';

/// What a reader of a shared harness is looking at, most urgent first.
enum SharedPaneStatus {
  ended('Sharing ended'),
  reconnecting('Reconnecting'),
  notRunning('Not running'),
  live('Live');

  const SharedPaneStatus(this.label);
  final String label;

  static SharedPaneStatus of({
    required bool ended,
    required bool connected,
    required bool terminalStopped,
  }) {
    if (ended) return SharedPaneStatus.ended;
    if (!connected) return SharedPaneStatus.reconnecting;
    if (terminalStopped) return SharedPaneStatus.notRunning;
    return SharedPaneStatus.live;
  }

  /// Why the screen may be empty, shown under the bar; null when it is not.
  String? get notice => this == SharedPaneStatus.notRunning
      ? 'The owner’s harness isn’t running right now. '
            'This view reconnects when it starts again.'
      : null;

  Color get color => switch (this) {
    SharedPaneStatus.live => grid.AppPalette.online,
    SharedPaneStatus.reconnecting => grid.AppPalette.warn,
    SharedPaneStatus.notRunning ||
    SharedPaneStatus.ended => grid.AppPalette.textFaint,
  };
}

/// The one bar above a shared harness: name, state and read-only label on the
/// left, the reader's actions on the right. Actions wrap when the pane or text
/// size needs more room, without changing how the output below is sized.
class SharedHarnessBar extends StatelessWidget {
  const SharedHarnessBar({
    super.key,
    required this.name,
    required this.status,
    required this.commentsSelected,
    required this.onToggleComments,
    required this.onClose,
    this.detail,
    this.viewerSelected,
    this.onSelectViewer,
    this.onRetry,
  });

  final String name;
  final String? detail;
  final SharedPaneStatus status;
  final bool commentsSelected;
  final VoidCallback onToggleComments;
  final VoidCallback onClose;

  /// Null hides the Terminal/Viewer switch: the pane shows one of them only.
  final bool? viewerSelected;
  final ValueChanged<bool>? onSelectViewer;
  final VoidCallback? onRetry;

  /// Below this width the actions move to a second row instead of squeezing
  /// the name to nothing.
  static const narrowWidth = 800.0;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: grid.AppSurface.recess,
        border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final close = AppIconButton(
            icon: AppIcons.close,
            tooltip: 'Close shared harness',
            onPressed: onClose,
          );
          final actions = Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: _actions(),
          );
          if (constraints.maxWidth >=
              narrowWidth * grid.appTextScaleOf(context)) {
            return Row(
              children: [
                Expanded(child: _identity()),
                const SizedBox(width: 16),
                actions,
                const SizedBox(width: 8),
                close,
              ],
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: _identity()),
                  const SizedBox(width: 8),
                  close,
                ],
              ),
              const SizedBox(height: 8),
              actions,
            ],
          );
        },
      ),
    );
  }

  Widget _identity() => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Tooltip(
        message: name,
        child: Text(
          name,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: DesktopChrome.control(medium: true),
        ),
      ),
      if (detail case final detail?) ...[
        const SizedBox(height: 4),
        Tooltip(
          message: detail,
          child: Text(
            detail,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.metadata(),
          ),
        ),
      ],
      const SizedBox(height: 4),
      Wrap(
        spacing: 12,
        runSpacing: 4,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              ExcludeSemantics(
                child: Container(
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: status.color,
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Text(status.label, style: DesktopChrome.metadata()),
            ],
          ),
          Text('View only', style: DesktopChrome.metadata()),
        ],
      ),
    ],
  );

  List<Widget> _actions() {
    final viewer = viewerSelected;
    return [
      if (viewer != null && onSelectViewer != null) ...[
        DesktopPill(
          label: 'Terminal',
          selected: !viewer,
          compact: true,
          onPressed: () => onSelectViewer!(false),
        ),
        DesktopPill(
          label: 'Viewer',
          selected: viewer,
          compact: true,
          onPressed: () => onSelectViewer!(true),
        ),
      ],
      if (onRetry case final retry?)
        DesktopPill(label: 'Retry', onPressed: retry, compact: true),
      DesktopPill(
        label: commentsSelected ? 'Watch' : 'Comments',
        onPressed: onToggleComments,
        compact: true,
      ),
    ];
  }
}

/// One quiet line under the bar: why the terminal is empty or has ended.
class SharedHarnessNotice extends StatelessWidget {
  const SharedHarnessNotice(this.message, {super.key});

  final String message;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: grid.AppPalette.divider)),
      ),
      child: Text(message, style: DesktopChrome.metadata()),
    );
  }
}

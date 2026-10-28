import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_menu.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/desktop_prompt_surface.dart';

/// Where every value of a details dialog starts: after the label column and its gap.
const superTabDetailLabelWidth = 120.0;

/// The frame the Swarm's details dialogs share (machine, person, project, Team at a glance, Share Swarm, Add
/// machine): the title with a quiet close, a hairline under it only while content has scrolled beneath it, a
/// scrolling body, and actions at the bottom — [leadingActions] at the left, [actions] at the right, at most one of
/// them filled.
class SuperTabDetailDialog extends StatefulWidget {
  const SuperTabDetailDialog({
    super.key,
    required this.title,
    required this.body,
    this.detail,
    this.leading,
    this.headerActions = const [],
    this.actions = const [],
    this.leadingActions = const [],
    this.footer,
    this.width = grid.AppDesktop.formWidth,
    this.onClose,
  });

  final String title;
  final String? detail;
  final Widget? leading;
  final List<Widget> headerActions;
  final Widget body;
  final List<Widget> actions, leadingActions;

  /// A short status or error kept beside the actions, outside the scroll.
  final Widget? footer;
  final double width;

  /// Defaults to closing the dialog.
  final VoidCallback? onClose;

  @override
  State<SuperTabDetailDialog> createState() => _SuperTabDetailDialogState();
}

class _SuperTabDetailDialogState extends State<SuperTabDetailDialog> {
  final _scroll = ScrollController();
  bool _scrolled = false;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  /// The body's own scroll position, not a nested list's.
  bool _onScroll(Notification notification) {
    final metrics = switch (notification) {
      ScrollNotification(:final metrics, depth: 0) => metrics,
      ScrollMetricsNotification(:final metrics, depth: 0) => metrics,
      _ => null,
    };
    if (metrics == null) return false;
    final scrolled = metrics.pixels > 0;
    if (scrolled != _scrolled) setState(() => _scrolled = scrolled);
    return false;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    const inset = DesktopChrome.panelPadding;
    final hasActions =
        widget.actions.isNotEmpty || widget.leadingActions.isNotEmpty;
    return DesktopChrome(
      child: Dialog(
        insetPadding: const EdgeInsets.all(20),
        backgroundColor: Colors.transparent,
        elevation: 0,
        shape: DesktopChrome.bareDialogShape,
        child: SizedBox(
          width: widget.width,
          child: DesktopDialogSurface(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                DesktopDialogHeader(
                  title: widget.title,
                  detail: widget.detail,
                  leading: widget.leading,
                  trailing: widget.headerActions,
                  onClose: widget.onClose ?? () => Navigator.pop(context),
                  padding: const EdgeInsets.fromLTRB(inset, inset, 16, 12),
                ),
                if (_scrolled)
                  Divider(
                    key: const ValueKey('super-detail-hairline'),
                    height: 1,
                    thickness: 1,
                    color: DesktopChrome.rim,
                  )
                else
                  const SizedBox(height: 1),
                Flexible(
                  child: NotificationListener<Notification>(
                    onNotification: _onScroll,
                    child: Padding(
                      padding: const EdgeInsets.only(left: inset, right: 12),
                      child: DesktopPromptScrollBody(
                        controller: _scroll,
                        child: Padding(
                          padding: const EdgeInsets.only(top: 4, bottom: 4),
                          child: widget.body,
                        ),
                      ),
                    ),
                  ),
                ),
                if (widget.footer case final footer?)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(inset, 12, inset, 0),
                    child: footer,
                  ),
                if (hasActions)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                      inset,
                      DesktopChrome.groupGap,
                      inset,
                      inset,
                    ),
                    // Leading at the left, the rest at the right; with enlarged text the right group wraps beneath.
                    child: Wrap(
                      alignment: widget.leadingActions.isEmpty
                          ? WrapAlignment.end
                          : WrapAlignment.spaceBetween,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      runSpacing: DesktopChrome.controlGap,
                      children: [
                        for (final group in [
                          widget.leadingActions,
                          widget.actions,
                        ])
                          if (group.isNotEmpty)
                            Wrap(
                              spacing: DesktopChrome.controlGap,
                              runSpacing: DesktopChrome.controlGap,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              children: group,
                            ),
                      ],
                    ),
                  )
                else
                  const SizedBox(height: inset - 4),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A label and its value on one line, the value starting at the shared label column; under its label when the
/// dialog is narrow or text is enlarged. [child] replaces the plain value text.
class SuperTabDetailRow extends StatelessWidget {
  const SuperTabDetailRow({
    super.key,
    required this.label,
    this.value,
    this.child,
    this.valueStyle,
  }) : assert(value != null || child != null);

  final String label;
  final String? value;
  final Widget? child;
  final TextStyle? valueStyle;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final content =
          child ?? Text(value!, style: valueStyle ?? DesktopChrome.control());
      final labelText = Text(label, style: DesktopChrome.metadata());
      final stacked =
          constraints.maxWidth < 320 ||
          MediaQuery.textScalerOf(context).scale(13) > 20;
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: stacked
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [labelText, const SizedBox(height: 2), content],
              )
            : Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  SizedBox(width: superTabDetailLabelWidth, child: labelText),
                  Expanded(child: content),
                ],
              ),
      );
    },
  );
}

/// A titled group of rows, 24 points below what precedes it.
class SuperTabDetailSection extends StatelessWidget {
  const SuperTabDetailSection({
    super.key,
    required this.title,
    required this.children,
    this.trailing,
    this.first = false,
  });

  final String title;
  final List<Widget> children;

  /// A count or quiet control at the heading's end.
  final Widget? trailing;

  /// No gap above: the dialog's first section.
  final bool first;

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.only(top: first ? 0 : 24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Expanded(
              child: Semantics(
                header: true,
                child: Text(title, style: DesktopChrome.control(medium: true)),
              ),
            ),
            ?trailing,
          ],
        ),
        const SizedBox(height: 4),
        ...children,
      ],
    ),
  );
}

/// A dialog's less frequent actions behind one quiet ⋯ control, so its footer keeps a single clear action.
class SuperTabMoreActions extends StatelessWidget {
  const SuperTabMoreActions({super.key, required this.items});

  final List<({String label, VoidCallback onPressed})> items;

  @override
  Widget build(BuildContext context) => MenuAnchor(
    consumeOutsideTap: true,
    alignmentOffset: const Offset(0, grid.AppControl.menuGap),
    style: grid.AppMenu.style(minWidth: 200, maxWidth: 280),
    menuChildren: [
      for (final item in items)
        AppMenuItem(
          key: ValueKey('super-detail-more-${item.label}'),
          label: item.label,
          onPressed: item.onPressed,
        ),
    ],
    builder: (context, menu, _) => AppIconButton(
      key: const ValueKey('super-detail-more'),
      icon: AppIcons.ellipsis,
      tooltip: 'More actions',
      color: DesktopChrome.muted,
      onPressed: () => menu.isOpen ? menu.close() : menu.open(),
    ),
  );
}

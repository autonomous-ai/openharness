import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';

/// Shared anatomy for compact desktop forms and confirmations. Callers retain
/// their scrolling, focus, keyboard handling, and operation state.
class DesktopPromptSurface extends StatelessWidget {
  const DesktopPromptSurface({
    super.key,
    required this.body,
    required this.actions,
    this.footer,
    this.width = grid.AppDesktop.formWidth,
  });

  /// Normally [DesktopPromptScrollBody]. Forms may retain their own controller.
  final Widget body;
  final List<Widget> actions;

  /// A short status or recovery message that remains beside the actions.
  final Widget? footer;
  final double width;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return DesktopChrome(
      child: Dialog(
        insetPadding: const EdgeInsets.all(20),
        backgroundColor: Colors.transparent,
        elevation: 0,
        child: SizedBox(
          width: width,
          child: DesktopDialogSurface(
            child: Padding(
              padding: const EdgeInsets.all(DesktopChrome.panelPadding),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Flexible(child: body),
                  if (footer case final footer?) ...[
                    const SizedBox(height: DesktopChrome.groupGap),
                    footer,
                  ],
                  const SizedBox(height: DesktopChrome.groupGap),
                  Wrap(
                    alignment: WrapAlignment.end,
                    spacing: DesktopChrome.controlGap,
                    runSpacing: DesktopChrome.controlGap,
                    children: actions,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Long explanations and enlarged fields disclose their scroll position before
/// the first gesture. One controller owns the body and its draggable thumb;
/// nested editors retain their own scrolling and keyboard behavior.
class DesktopPromptScrollBody extends StatefulWidget {
  const DesktopPromptScrollBody({
    super.key,
    required this.child,
    this.controller,
  });

  final Widget child;
  final ScrollController? controller;

  @override
  State<DesktopPromptScrollBody> createState() =>
      _DesktopPromptScrollBodyState();
}

class _DesktopPromptScrollBodyState extends State<DesktopPromptScrollBody> {
  final _controller = ScrollController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller ?? _controller;
    return ScrollConfiguration(
      behavior: ScrollConfiguration.of(context).copyWith(scrollbars: false),
      child: Scrollbar(
        controller: controller,
        thumbVisibility: true,
        child: SingleChildScrollView(
          controller: controller,
          padding: const EdgeInsetsDirectional.only(end: 12),
          child: widget.child,
        ),
      ),
    );
  }
}

/// Keeps status and recovery details readable without displacing the actions.
/// Longer messages scroll and remain selectable in full; selection does not
/// introduce a Tab stop. Callers retain announcement and operation ownership.
class DesktopPromptMessage extends StatelessWidget {
  const DesktopPromptMessage(this.message, {super.key, this.color});

  final String message;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final style = DesktopChrome.text(size: 13, color: color);
    final measure = TextPainter(
      text: TextSpan(text: 'M\nM\nM', style: style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final maxHeight = measure.height;
    measure.dispose();
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: DesktopPromptScrollBody(
        child: SelectableText(message, style: style),
      ),
    );
  }
}

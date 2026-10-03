import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart';

class SwarmSearchField extends StatefulWidget {
  const SwarmSearchField({
    super.key,
    required this.onChanged,
    this.onSubmitted,
    this.onMove,
    this.autofocus = false,
    this.hintText = 'Search harnesses',
    this.controller,
    this.focusNode,
  });
  final ValueChanged<String> onChanged;
  final VoidCallback? onSubmitted;
  final ValueChanged<int>? onMove;
  final bool autofocus;
  final String hintText;
  final TextEditingController? controller;
  final FocusNode? focusNode;
  @override
  State<SwarmSearchField> createState() => _SwarmSearchFieldState();
}

class _SwarmSearchFieldState extends State<SwarmSearchField> {
  FocusNode? _ownedFocus;
  FocusNode get _focus =>
      widget.focusNode ?? (_ownedFocus ??= FocusNode(debugLabel: 'Find agent'));

  @override
  void initState() {
    super.initState();
    if (widget.autofocus) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        // The dialog veil also requests fallback focus in this frame. The
        // search field must win so the first keystroke starts searching.
        if (mounted && ModalRoute.of(context)?.isCurrent != false) {
          _focus.requestFocus();
        }
      });
    }
  }

  @override
  void dispose() {
    _ownedFocus?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final onMove = widget.onMove;
    final onSubmitted = widget.onSubmitted;
    return CallbackShortcuts(
      bindings: {
        if (onSubmitted != null) ...{
          const SingleActivator(
            LogicalKeyboardKey.enter,
            includeRepeats: false,
          ): onSubmitted,
          const SingleActivator(
            LogicalKeyboardKey.numpadEnter,
            includeRepeats: false,
          ): onSubmitted,
        },
        if (onMove != null) ...{
          const SingleActivator(LogicalKeyboardKey.arrowDown): () => onMove(1),
          const SingleActivator(LogicalKeyboardKey.arrowUp): () => onMove(-1),
          const SingleActivator(LogicalKeyboardKey.keyN, control: true): () =>
              onMove(1),
          const SingleActivator(LogicalKeyboardKey.keyP, control: true): () =>
              onMove(-1),
          const SingleActivator(LogicalKeyboardKey.keyJ, control: true): () =>
              onMove(1),
          const SingleActivator(LogicalKeyboardKey.keyK, control: true): () =>
              onMove(-1),
        },
      },
      child: TextField(
        controller: widget.controller,
        focusNode: _focus,
        autofocus: widget.autofocus,
        onChanged: widget.onChanged,
        onSubmitted: (_) => onSubmitted?.call(),
        style: AppType.body(),
        decoration: InputDecoration(
          hintText: widget.hintText,
          hintStyle: AppType.body(color: AppPalette.textSecondary),
          prefixIcon: const Icon(AppIcons.search, size: 18),
          filled: true,
          fillColor: AppDesktop.field,
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 14,
            vertical: 14,
          ),
        ),
      ),
    );
  }
}

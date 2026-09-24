import 'package:flutter/material.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/swarm_search.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'box_chrome.dart';

/// The shared input for the start page, Open Agent and split searches.
/// Flutter owns the caret and result navigation; native chrome only opens it.
class SwarmSearchInput extends StatelessWidget {
  const SwarmSearchInput({
    super.key,
    required this.inputKey,
    required this.controller,
    required this.focusNode,
    required this.search,
    required this.onClose,
    required this.onChanged,
    this.onOpen,
    this.groupId,
    this.onTapOutside,
    this.showClose = false,
    this.autofocus = true,
    this.hintText,
    this.rounded = false,
    this.prominent = false,
    this.outlined = false,
    this.fillColor,
    this.trailing,
    this.height,
    this.prompt,
    this.terminal = false,
    this.bios = false,
    this.onEmptyBackspace,
  });

  final Key inputKey;
  final TextEditingController controller;
  final FocusNode focusNode;
  final SwarmSearchController? search;
  final VoidCallback onClose;
  final ValueChanged<String> onChanged;
  final VoidCallback? onOpen;
  final Object? groupId;
  final VoidCallback? onTapOutside;
  final bool showClose, autofocus;
  final String? hintText;
  final bool rounded;
  final bool prominent;
  final bool outlined;
  final Color? fillColor;
  final Widget? trailing;

  /// The input's height, when it is not the start page's 56 or 64: New
  /// Harness sizes its agent search to the tiles under it.
  final double? height;

  /// The typed text and the hint; the search glyph grows with it.
  double get fontSize => bios ? terminalFontStore.size : grid.AppType.monoSize;
  final String? prompt;

  /// Plain monospace input in a TerminalBox, without a decorative search glyph.
  /// The active resource prefix can be rendered separately as [prompt].
  final bool terminal;
  final bool bios;
  final VoidCallback? onEmptyBackspace;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      // Command mode changes with the editor value. Result highlights do not,
      // so arrow navigation must not rebuild the text field.
      listenable: controller,
      builder: (context, _) => Actions(
        actions: {
          if (onEmptyBackspace != null)
            DeleteCharacterIntent: _ScopeBackspaceAction(
              controller,
              onEmptyBackspace!,
            ),
        },
        child: _buildInput(context),
      ),
    );
  }

  Widget _buildInput(BuildContext context) {
    final open = search != null;
    final terminalStyle = terminal || prompt != null;
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final style = bios
        ? terminalContentStyle(color: theme.foreground)
        : boxMonoStyle();
    final cell = bios ? terminalCellSizeOf(context) : Size.zero;
    final hint =
        search?.isCommandMode == true ||
            search?.isHelpMode == true ||
            search?.isGroupMode == true
        ? search!.hint
        : hintText ?? search?.hint ?? kSwarmSearchHint;
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.vertical(
        top: Radius.circular(rounded ? (prominent ? 32 : 28) : 12),
        bottom: Radius.circular(
          open && !outlined
              ? 0
              : rounded
              ? (prominent ? 32 : 28)
              : 12,
        ),
      ),
      borderSide: outlined
          ? BorderSide(color: Colors.white.withValues(alpha: .10))
          : BorderSide.none,
    );
    final field = TextField(
      key: inputKey,
      groupId: groupId ?? EditableText,
      controller: controller,
      focusNode: focusNode,
      autofocus: autofocus,
      onTap: onOpen,
      onTapAlwaysCalled: true,
      onTapOutside: onTapOutside == null ? null : (_) => onTapOutside!(),
      onChanged: onChanged,
      style: terminalStyle ? style : grid.AppType.mono(color: Colors.white),
      cursorColor: bios ? theme.cursor : grid.AppPalette.swarmAccent,
      cursorWidth: bios ? cell.width : 2,
      cursorRadius: Radius.zero,
      cursorOpacityAnimates: !bios,
      autocorrect: !bios,
      enableSuggestions: !bios,
      textAlignVertical: TextAlignVertical.center,
      decoration: bios
          ? InputDecoration(
              hintText: hint,
              hintStyle: style.copyWith(
                color: theme.foreground.withValues(alpha: .54),
              ),
              hintMaxLines: 1,
              isDense: true,
              isCollapsed: true,
              constraints: const BoxConstraints(),
              contentPadding: EdgeInsets.zero,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              filled: false,
            )
          : InputDecoration(
              hintText: hint,
              hintStyle: terminalStyle
                  ? style.copyWith(color: kBoxFaint)
                  : grid.AppType.mono(color: Colors.white60),
              hintMaxLines: 1,
              prefixIcon: prompt != null
                  ? Padding(
                      padding: const EdgeInsets.only(left: 14, right: 10),
                      child: Center(
                        widthFactor: 1,
                        heightFactor: 1,
                        child: Text(
                          prompt!,
                          key: const ValueKey('swarm-search-prompt'),
                          textAlign: TextAlign.center,
                          style: style.copyWith(
                            color: grid.AppPalette.swarmAccent,
                          ),
                        ),
                      ),
                    )
                  : terminal
                  ? null
                  : Icon(
                      Icons.search,
                      size: fontSize + 4,
                      color: Colors.white60,
                    ),
              prefixIconConstraints: BoxConstraints(
                minWidth: prompt != null
                    ? 36
                    : fontSize >= 20
                    ? 64
                    : 52,
                minHeight: height ?? (prominent ? 64 : 56),
              ),
              suffixIcon: showClose || trailing != null
                  ? Padding(
                      padding: const EdgeInsets.only(right: 12),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          ?trailing,
                          if (showClose)
                            TextButton(
                              onPressed: onClose,
                              style: TextButton.styleFrom(
                                foregroundColor: Colors.white60,
                                minimumSize: const Size(36, 28),
                              ),
                              child: Text(
                                'esc',
                                style: grid.AppType.monoMeta(),
                              ),
                            ),
                        ],
                      ),
                    )
                  : null,
              // TerminalBox owns the dock surface. An unfilled field also avoids
              // Material's extra inset, keeping the input aligned with result text.
              filled: !terminal,
              fillColor:
                  fillColor ??
                  (terminalStyle
                      ? grid.AppPalette.swarmField
                      : grid.AppPalette.swarmSearchSurface),
              hoverColor: Colors.transparent,
              contentPadding: EdgeInsets.symmetric(
                horizontal: 18,
                vertical: height == null
                    ? (prominent ? 22 : 18)
                    : ((height! - fontSize * 1.2) / 2).clamp(
                        0,
                        double.infinity,
                      ),
              ),
              isDense: true,
              border: terminalStyle ? InputBorder.none : border,
              enabledBorder: terminalStyle ? InputBorder.none : border,
              focusedBorder: terminalStyle ? InputBorder.none : border,
            ),
    );
    if (!bios) return field;
    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: cell.width * 2,
        vertical: cell.height,
      ),
      child: SizedBox(
        height: cell.height,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            SizedBox(
              width: cell.width * 2,
              child: Text(
                prompt ?? '>',
                key: const ValueKey('swarm-search-prompt'),
                textAlign: TextAlign.center,
                style: style,
              ),
            ),
            Expanded(child: field),
          ],
        ),
      ),
    );
  }
}

/// EditableText handles Backspace before an ancestor shortcut can see it.
/// Override its editing action only for an empty, non-composing query.
class _ScopeBackspaceAction extends Action<DeleteCharacterIntent> {
  _ScopeBackspaceAction(this.controller, this.clearScope);
  final TextEditingController controller;
  final VoidCallback clearScope;

  @override
  Object? invoke(DeleteCharacterIntent intent) {
    final value = controller.value;
    if (!intent.forward &&
        value.text.isEmpty &&
        (!value.composing.isValid || value.composing.isCollapsed)) {
      clearScope();
      return null;
    }
    return callingAction?.invoke(intent);
  }
}

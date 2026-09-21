import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shortcuts/app_keymap.dart';

/// Where "Create harness" goes: the ten-minute guide to a first DSH.
const kCreateHarnessGuide =
    'https://github.com/autonomous-ai/openharness#your-first-dsh-in-ten-minutes';

/// The Store's toolbar, laid out like Safari's: history on the left, a compact
/// search field centred on the pane, and the way to make your own on the right.
///
/// No breadcrumb: the rail already says which shelf is open, and every page
/// under it carries its own title.
class StoreSearch extends StatelessWidget {
  const StoreSearch({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.onChanged,
    required this.autofocus,
    required this.onClear,
    required this.onBack,
    required this.onForward,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final ValueChanged<String> onChanged;
  final bool autofocus;
  final VoidCallback onClear;
  final VoidCallback? onBack;
  final VoidCallback? onForward;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return LayoutBuilder(
      builder: (context, box) {
        final padding = box.maxWidth < 680 ? 20.0 : 36.0;
        // A control's height, grown with the text so a scaled label still has air.
        final height = math.max(
          grid.AppControl.height,
          MediaQuery.textScalerOf(context).scale(terminalFontStore.size) + 18,
        );
        return Container(
          key: const ValueKey('store-search-header'),
          color: grid.AppPalette.windowBg,
          padding: EdgeInsets.fromLTRB(padding, 14, padding, 6),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1440),
              child: SizedBox(
                height: height,
                child: CustomMultiChildLayout(
                  delegate: _ToolbarLayout(),
                  children: [
                    LayoutId(
                      id: _Slot.history,
                      child: _History(onBack: onBack, onForward: onForward),
                    ),
                    LayoutId(
                      id: _Slot.search,
                      child: _Field(
                        controller: controller,
                        focusNode: focusNode,
                        onChanged: onChanged,
                        autofocus: autofocus,
                        onClear: onClear,
                      ),
                    ),
                    LayoutId(
                      id: _Slot.create,
                      child: _CreateHarness(
                        height: height,
                        labelled: box.maxWidth >= 520,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

enum _Slot { history, search, create }

/// Centres the field on the whole pane, the way Safari centres its address
/// field on the window, rather than in whatever the two ends leave between
/// them — they are different widths, so the gap between them is off-centre.
/// When the pane is too narrow for that, the field takes the gap instead.
class _ToolbarLayout extends MultiChildLayoutDelegate {
  static const _gap = 12.0;
  static const _widest = 560.0;
  static const _narrowest = 240.0;

  @override
  void performLayout(Size size) {
    final loose = BoxConstraints.loose(size);
    final history = layoutChild(_Slot.history, loose);
    final create = layoutChild(_Slot.create, loose);
    final side = math.max(history.width, create.width) + _gap;
    var width = math.min(_widest, size.width - 2 * side);
    var left = (size.width - width) / 2;
    if (width < _narrowest) {
      left = history.width + _gap;
      width = size.width - history.width - create.width - 2 * _gap;
    }
    layoutChild(
      _Slot.search,
      BoxConstraints.tight(Size(math.max(0, width), size.height)),
    );
    positionChild(_Slot.history, Offset(0, (size.height - history.height) / 2));
    positionChild(_Slot.search, Offset(left, 0));
    positionChild(
      _Slot.create,
      Offset(size.width - create.width, (size.height - create.height) / 2),
    );
  }

  @override
  bool shouldRelayout(_ToolbarLayout oldDelegate) => false;
}

/// Back and forward in one capsule, split by a hairline, as Safari draws them.
class _History extends StatelessWidget {
  const _History({required this.onBack, required this.onForward});

  final VoidCallback? onBack;
  final VoidCallback? onForward;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final back = effectiveCommandHint(context, 'navigation.back');
    final forward = effectiveCommandHint(context, 'navigation.forward');
    return Container(
      height: grid.AppControl.height,
      padding: const EdgeInsets.symmetric(horizontal: 4),
      decoration: BoxDecoration(
        color: grid.AppSurface.recess,
        border: Border.all(color: grid.AppPalette.divider),
        borderRadius: BorderRadius.circular(grid.AppControl.radius),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          AppIconButton(
            key: const ValueKey('store-back'),
            icon: LucideIcons.chevronLeft300,
            tooltip: back == null ? 'Back' : 'Back  $back',
            onPressed: onBack,
            size: 17,
          ),
          Container(
            width: 1,
            height: 14,
            margin: const EdgeInsets.symmetric(horizontal: 3),
            color: grid.AppPalette.divider,
          ),
          AppIconButton(
            key: const ValueKey('store-nav-forward'),
            icon: LucideIcons.chevronRight300,
            tooltip: forward == null ? 'Forward' : 'Forward  $forward',
            onPressed: onForward,
            size: 17,
          ),
        ],
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({
    required this.controller,
    required this.focusNode,
    required this.onChanged,
    required this.autofocus,
    required this.onClear,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final ValueChanged<String> onChanged;
  final bool autofocus;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final shortcut = effectiveCommandHint(context, 'terminal.find');
    return ListenableBuilder(
      listenable: Listenable.merge([focusNode, controller]),
      builder: (context, _) => LayoutBuilder(
        builder: (context, box) => MouseRegion(
          cursor: SystemMouseCursors.text,
          child: GestureDetector(
            // The icon and the padding are part of the field: a click there
            // puts the caret in it, as it would in Safari's.
            onTap: focusNode.requestFocus,
            child: AnimatedContainer(
              key: const ValueKey('store-search-field'),
              duration: grid.AppMotion.hover,
              curve: grid.AppMotion.curve,
              padding: const EdgeInsets.only(left: 11, right: 6),
              decoration: BoxDecoration(
                color: grid.AppSurface.recess,
                border: Border.all(
                  color: focusNode.hasFocus
                      ? grid.AppPalette.accentOnSurface
                      : grid.AppPalette.divider,
                ),
                borderRadius: BorderRadius.circular(grid.AppControl.radius),
              ),
              // Focus is a ring outside the field, as Safari draws it, not a
              // thicker border: that would nudge the text on every focus.
              foregroundDecoration: BoxDecoration(
                border: Border.all(
                  color: focusNode.hasFocus
                      ? grid.AppPalette.accentOnSurface.withValues(alpha: 0.35)
                      : Colors.transparent,
                  width: 2.5,
                  strokeAlign: BorderSide.strokeAlignOutside,
                ),
                borderRadius: BorderRadius.circular(grid.AppControl.radius),
              ),
              child: Row(
                children: [
                  Icon(
                    LucideIcons.search300,
                    size: 15,
                    color: grid.AppPalette.textSecondary,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: TextField(
                      key: const ValueKey('store-search'),
                      controller: controller,
                      focusNode: focusNode,
                      autofocus: autofocus,
                      onChanged: onChanged,
                      textInputAction: TextInputAction.search,
                      textAlignVertical: TextAlignVertical.center,
                      style: terminalTextStyle(
                        color: grid.AppPalette.textPrimary,
                      ),
                      // Bare: the outline around it is this field's border,
                      // so none of the theme's own may draw inside it.
                      decoration: InputDecoration(
                        hintText: 'Search harnesses',
                        hintStyle: terminalTextStyle(
                          color: grid.AppPalette.textSecondary,
                        ),
                        isCollapsed: true,
                        constraints: const BoxConstraints(),
                        // A desktop's compact density takes 8px off a
                        // collapsed field, and the text hangs out of the
                        // bottom of what is left: 4px low in the outline.
                        visualDensity: VisualDensity.standard,
                        filled: false,
                        contentPadding: EdgeInsets.zero,
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        disabledBorder: InputBorder.none,
                      ),
                    ),
                  ),
                  if (controller.text.isNotEmpty)
                    AppIconButton(
                      icon: LucideIcons.x300,
                      tooltip: 'Clear search',
                      onPressed: onClear,
                    )
                  else if (shortcut != null && box.maxWidth > 320)
                    Padding(
                      padding: const EdgeInsets.only(right: 5),
                      child: Text(
                        shortcut,
                        style: terminalTextStyle(
                          color: grid.AppPalette.textFaint,
                        ),
                      ),
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

/// The toolbar's one filled control, in the ink the app gives a primary
/// action (Resume Harness, New Harness), so it reads before the chrome around
/// it. It opens the guide in the browser; the tooltip says so.
class _CreateHarness extends StatelessWidget {
  const _CreateHarness({required this.height, required this.labelled});

  final double height;

  /// Too narrow a pane keeps a plus alone, with the words in its tooltip.
  final bool labelled;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return Tooltip(
      message: 'Your first harness in ten minutes, on GitHub',
      child: FilledButton(
        key: const ValueKey('store-create-harness'),
        onPressed: () => unawaited(
          launchUrl(
            Uri.parse(kCreateHarnessGuide),
            mode: LaunchMode.externalApplication,
          ),
        ),
        style: FilledButton.styleFrom(
          minimumSize: Size(height, height),
          padding: EdgeInsets.symmetric(horizontal: labelled ? 14 : 0),
          backgroundColor: grid.AppPalette.textPrimary,
          foregroundColor: grid.AppPalette.windowBg,
          textStyle: terminalTextStyle(fontWeight: FontWeight.w600),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(grid.AppControl.radius),
          ),
        ),
        child: labelled
            ? const Text('Create Harness')
            : const Icon(LucideIcons.plus300, size: 16),
      ),
    );
  }
}

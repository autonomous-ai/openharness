import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'box_chrome.dart';
import 'swarm_search_input.dart';
import 'swarm_switcher.dart';

/// Named commands use the same search and result navigation as destinations.
class SwarmCommandPicker extends StatefulWidget {
  const SwarmCommandPicker({super.key, required this.search});
  final SwarmSearchController search;

  @override
  State<SwarmCommandPicker> createState() => _SwarmCommandPickerState();
}

class _SwarmCommandPickerState extends State<SwarmCommandPicker> {
  final _query = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Resource commands');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  @override
  void dispose() {
    _query.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _choose(SwarmSearchSelection choice) => Navigator.pop(context, choice);
  void _close() => Navigator.pop(context);

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([
        terminalFontStore,
        grid.AppTheme.palette,
        terminalThemeStore,
      ]),
      builder: (context, _) {
        final cell = terminalCellSizeOf(context);
        final theme = terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        );
        return Dialog(
          key: const ValueKey('resource-command-picker'),
          alignment: const Alignment(0, -0.12),
          insetPadding: EdgeInsets.symmetric(
            horizontal: cell.width * 2,
            vertical: cell.height * 2,
          ),
          elevation: 0,
          surfaceTintColor: Colors.transparent,
          clipBehavior: Clip.antiAlias,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(kTerminalCornerRadius),
            side: terminalPaneBorder(focused: true),
          ),
          backgroundColor: theme.background,
          child: TextSelectionTheme(
            data: TextSelectionThemeData(selectionColor: theme.selection),
            child: SizedBox(
              width: cell.width * 80,
              height: cell.height * 24,
              child: SwarmSearchKeys(
                search: widget.search,
                editing: _query,
                onChoose: _choose,
                onClose: _close,
                onRefocus: _focus.requestFocus,
                child: SwarmSearchResults(
                  search: widget.search,
                  onChoose: _choose,
                  onRefocus: _focus.requestFocus,
                  terminal: true,
                  bios: true,
                  header: SwarmSearchInput(
                    inputKey: const ValueKey('resource-command-input'),
                    controller: _query,
                    focusNode: _focus,
                    search: widget.search,
                    onClose: _close,
                    onChanged: widget.search.setQuery,
                    hintText: 'Search actions',
                    prompt: '>',
                    terminal: true,
                    bios: true,
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

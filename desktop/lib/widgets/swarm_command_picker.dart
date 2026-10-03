import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import 'desktop_chrome.dart';
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
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: widget.search,
      builder: (context, _) {
        return DesktopChrome(
          child: Dialog(
            key: const ValueKey('resource-command-picker'),
            alignment: const Alignment(0, -0.12),
            insetPadding: const EdgeInsets.symmetric(
              horizontal: 20,
              vertical: 24,
            ),
            elevation: grid.AppDesktop.dialogElevation,
            shadowColor: grid.AppDesktop.shadow,
            surfaceTintColor: Colors.transparent,
            clipBehavior: Clip.antiAlias,
            shape: DesktopChrome.shape(),
            backgroundColor: DesktopChrome.surface,
            child: TextSelectionTheme(
              data: TextSelectionThemeData(
                selectionColor: DesktopChrome.selection,
              ),
              child: SizedBox(
                width: 620,
                height: 440,
                child: SwarmSearchKeys(
                  desktop: true,
                  search: widget.search,
                  editing: _query,
                  onChoose: _choose,
                  onClose: _close,
                  onRefocus: _focus.requestFocus,
                  child: Column(
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(20, 8, 12, 8),
                        child: Row(
                          children: [
                            Icon(
                              AppIcons.search,
                              size: 20,
                              color: DesktopChrome.muted,
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: SwarmSearchInput(
                                inputKey: const ValueKey(
                                  'resource-command-input',
                                ),
                                controller: _query,
                                focusNode: _focus,
                                search: widget.search,
                                onClose: _close,
                                onChanged: widget.search.setQuery,
                                hintText: 'Search actions',
                              ),
                            ),
                            ExcludeFocus(
                              child: IconButton(
                                key: const ValueKey('resource-command-close'),
                                tooltip: 'Close actions',
                                onPressed: _close,
                                icon: const Icon(AppIcons.close, size: 18),
                              ),
                            ),
                          ],
                        ),
                      ),
                      Divider(height: 1, color: DesktopChrome.rim),
                      Expanded(
                        child: SwarmSearchResults(
                          search: widget.search,
                          onChoose: _choose,
                          onRefocus: _focus.requestFocus,
                          showPreview: false,
                        ),
                      ),
                      Divider(height: 1, color: DesktopChrome.rim),
                      Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 18,
                          vertical: 12,
                        ),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text.rich(
                            TextSpan(
                              children: [
                                TextSpan(
                                  text: effectiveCommandHint(
                                    context,
                                    'picker.accept',
                                    contextKind: KeymapContext.picker,
                                  ),
                                  style: grid.AppType.monoMeta(
                                    color: DesktopChrome.muted,
                                  ),
                                ),
                                const TextSpan(text: '  Run action     '),
                                TextSpan(
                                  text: effectiveCommandHint(
                                    context,
                                    'picker.cancel',
                                    contextKind: KeymapContext.picker,
                                  ),
                                  style: grid.AppType.monoMeta(
                                    color: DesktopChrome.muted,
                                  ),
                                ),
                                const TextSpan(text: '  Back'),
                              ],
                            ),
                            style: DesktopChrome.text(
                              size: 12,
                              color: DesktopChrome.muted,
                            ),
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
      },
    );
  }
}

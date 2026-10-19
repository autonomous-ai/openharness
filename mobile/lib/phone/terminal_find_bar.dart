import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/terminal_find.dart';

import 'tty.dart';
import 'tty_controls.dart';

/// Find in terminal's bar: the desktop's find bar (`desktop/lib/widgets/terminal_find_bar.dart`) in
/// the phone's face, where the key bar sits — on the keyboard while one is up, at the foot of the
/// terminal while not.
///
/// `/` and the words, how many matched (`3/12`, red when none), ↑ and ↓, and × to put it away —
/// the desktop's pieces and its words, nothing added: the terminal stays the screen.
///
/// The keyboard's search key puts the keyboard away and leaves the bar, as Safari's find in page
/// does: half the screen comes back to read the match in, and ↑ ↓ go on stepping.
class TerminalFindBar extends StatefulWidget {
  const TerminalFindBar({super.key, required this.find, required this.onClose});

  final TerminalFindController find;
  final VoidCallback onClose;

  @override
  State<TerminalFindBar> createState() => _TerminalFindBarState();
}

class _TerminalFindBarState extends State<TerminalFindBar> {
  late final _text = TextEditingController(text: widget.find.query);
  final _focus = FocusNode(debugLabel: 'Find in terminal');

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return ListenableBuilder(
      listenable: widget.find,
      builder: (context, _) {
        final find = widget.find;
        final count = find.count;
        Widget button(
          String label,
          IconData icon,
          VoidCallback? action, {
          Key? key,
        }) => IconButton(
          key: key,
          tooltip: label,
          onPressed: action,
          icon: Icon(icon, size: 20),
          color: tty.text,
          disabledColor: tty.faint,
          visualDensity: VisualDensity.compact,
          constraints: const BoxConstraints.tightFor(width: 40, height: 40),
          padding: EdgeInsets.zero,
        );
        return Material(
          key: const ValueKey('terminal-find-bar'),
          color: tty.ground,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(Tty.origin, 6, 4, 6),
            child: Row(
              children: [
                Expanded(
                  child: TtyField(
                    controller: _text,
                    focus: _focus,
                    hint: 'Find in terminal…',
                    autofocus: true,
                    action: TextInputAction.search,
                    leading: ExcludeSemantics(
                      child: TtyText('/', color: tty.faint),
                    ),
                    onChanged: find.setQuery,
                    onSubmitted: _focus.unfocus,
                    trailing: [
                      Semantics(
                        liveRegion: true,
                        label: find.searching && !find.hasSnapshot
                            ? 'Searching terminal'
                            : find.query.isEmpty
                            ? 'Find in terminal'
                            : count == 0
                            ? 'No matches'
                            : 'Match ${find.selected + 1} of $count',
                        child: ExcludeSemantics(
                          child: Padding(
                            padding: const EdgeInsets.only(left: 6),
                            child: TtyText(
                              find.status,
                              key: const ValueKey('terminal-find-status'),
                              color: find.missed ? tty.red : tty.faint,
                              size: TtySize.meta,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                button(
                  'Previous match',
                  LucideIcons.chevronUp300,
                  count > 0 ? find.previous : null,
                  key: const ValueKey('terminal-find-previous'),
                ),
                button(
                  'Next match',
                  LucideIcons.chevronDown300,
                  count > 0 ? find.next : null,
                  key: const ValueKey('terminal-find-next'),
                ),
                button(
                  'Close find',
                  LucideIcons.x300,
                  widget.onClose,
                  key: const ValueKey('terminal-find-close'),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

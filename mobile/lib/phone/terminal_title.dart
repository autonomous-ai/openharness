import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'tty.dart';
import 'tty_controls.dart';

/// Focus's title: whose terminal this is, in three lines — the harness, where it runs, its branch.
///
/// ```
///  fix-login                         api-fix asking
///  studio:web
///  ⑂ fix/login-refresh
/// ```
///
/// ⚠️ **The whole title is one button: its menu** (rename, restart, paste…). Nothing else is drawn
/// to tap — no `…`, no state words: the terminal says when it is loading. Holding it goes back to
/// the last harness. Find is a swipe right, and `api-fix asking` — a harness elsewhere waiting on
/// you — is the one word that opens it from here. The paired daemon, when there is one, sits at the
/// right end ([daemon]): a tap on it opens its own sheet, not the menu.
///
/// It floats over the terminal's top rows only while the output is followed at its end, and slides
/// away while the history is read back (see `TerminalChromeScroll`) — so it can afford three rows.
class TerminalTitle extends StatelessWidget {
  const TerminalTitle({
    super.key,
    required this.name,
    required this.onTap,
    required this.onFind,
    this.place,
    this.branch,
    this.asking,
    this.onHold,
    this.daemon,
    this.sample = false,
  });

  final String name;
  final bool sample;

  /// `machine:folder` — where the harness works.
  final String? place;

  final String? branch;

  /// Harnesses elsewhere asking — `api-fix asking`, or `2 asking` — in yellow; a tap opens Find.
  final String? asking;

  /// A tap anywhere on the title: the harness's menu.
  final VoidCallback onTap;

  /// What `asking` opens.
  final VoidCallback onFind;

  /// Holding the title: back to the last harness (tmux's `prefix L`, vim's `:b#`).
  final VoidCallback? onHold;

  /// The paired daemon's chip (`daemon_chip.dart`), at the title's right end, centred on its
  /// block. It takes its own taps, keeps its own gap from the names, and draws nothing — taking no
  /// room — outside the signed-in shell or with daemons off.
  final Widget? daemon;

  /// Four terminal rows: three lines of text and half a row of air above and below.
  static double heightOf(Tty tty) => 4 * tty.row;

  /// A long branch shortened in the middle — `fix/login-refresh-token` → `fix/logi…sh-token` — where
  /// both ends say which one it is.
  ///
  /// Cut by characters, not UTF-16 units, for the reason `_windowName` in `terminal_page.dart`
  /// gives: half an emoji is a string the text engine throws on.
  static String _short(String branch) {
    final characters = branch.characters;
    return characters.length <= 30
        ? branch
        : '${characters.take(14)}…${characters.skip(characters.length - 14)}';
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final height = heightOf(tty);
    final meta = tty.style(color: tty.faint, size: TtySize.meta);
    final title = Semantics(
      button: true,
      label: '$name — harness menu',
      child: GestureDetector(
        key: const ValueKey('terminal-title'),
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        onLongPress: onHold == null
            ? null
            : () {
                HapticFeedback.mediumImpact();
                onHold!();
              },
        child: DecoratedBox(
          // No rule under it: the output fades out beneath instead — see the gradient below.
          decoration: BoxDecoration(color: tty.ground),
          // ⚠️ **At least four rows, not exactly four.** The rows are the terminal's, which the
          // text scale does not touch, and the three lines are the app's type, which it does: at
          // Settings ▸ Text size's largest the lines outgrew a fixed box and overflowed it.
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: height),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: tty.style(
                            size: TtySize.title,
                            weight: FontWeight.w600,
                          ),
                        ),
                        if (place case final place? when place.isNotEmpty)
                          Text(
                            place,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: meta,
                          ),
                        if (branch case final branch?
                            when branch.trim().isNotEmpty)
                          Row(
                            children: [
                              Icon(
                                LucideIcons.gitBranch300,
                                size: 12,
                                color: tty.faint,
                              ),
                              const SizedBox(width: 5),
                              Flexible(
                                child: Text(
                                  _short(branch),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: tty.style(
                                    color: tty.faint,
                                    size: TtySize.meta,
                                  ),
                                ),
                              ),
                            ],
                          ),
                      ],
                    ),
                  ),
                  if (sample)
                    Padding(
                      padding: const EdgeInsets.only(left: 12),
                      child: TtyText(
                        'Sample',
                        color: tty.faint,
                        size: TtySize.meta,
                      ),
                    ),
                  if (asking case final asking?)
                    Semantics(
                      button: true,
                      label: '$asking — open Find',
                      excludeSemantics: true,
                      child: GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onTap: () {
                          HapticFeedback.selectionClick();
                          onFind();
                        },
                        child: ConstrainedBox(
                          constraints: BoxConstraints(
                            minHeight: height,
                            minWidth: 44,
                            maxWidth: 170,
                          ),
                          child: Padding(
                            padding: const EdgeInsets.only(left: 12),
                            child: Align(
                              alignment: Alignment.topRight,
                              widthFactor: 1,
                              child: Padding(
                                padding: EdgeInsets.only(top: tty.row * 0.6),
                                child: Text(
                                  asking,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: tty.style(
                                    color: tty.yellow,
                                    size: TtySize.meta,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ?daemon,
                ],
              ),
            ),
          ),
        ),
      ),
    );
    // The output fades out beneath the title rather than stopping at a rule.
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        title,
        IgnorePointer(
          child: Container(
            height: 12,
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [tty.ground, tty.ground.withValues(alpha: 0)],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

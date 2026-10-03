import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../daemons/illustrated_art.dart';
import '../daemons/roster.dart';
import '../terminal/terminal_text.dart';
import 'daemon_slot.dart' show currentTerminalTheme;
import 'daemon_illustration.dart';

/// A local artwork catalogue. It has no zoo, account or pairing writer, so
/// reviewing a species (including Beastie) never discovers or equips it.
class DaemonArtGallery extends StatefulWidget {
  const DaemonArtGallery({
    super.key,
    required this.onBack,
    this.animate = true,
  });

  final VoidCallback onBack;
  final bool animate;

  @override
  State<DaemonArtGallery> createState() => _DaemonArtGalleryState();
}

class _DaemonArtGalleryState extends State<DaemonArtGallery> {
  int _index = 0;
  int _stage = 2;
  int _expression = 0;
  bool _paused = false;

  static const _versions = ['0.1', '1.0', '2.0'];
  static const _stages = ['Hatchling', 'Young', 'Adult'];
  static const _expressions = {
    DaemonMood.idle: 'Resting',
    DaemonMood.work: 'Working',
    DaemonMood.need: 'Needs you',
    DaemonMood.done: 'Happy',
    DaemonMood.fail: 'Sad',
    DaemonMood.back: 'Welcome back',
    DaemonMood.nap: 'Sleeping',
    DaemonMood.boop: 'Booped',
  };

  void _browse(int step) =>
      setState(() => _index = (_index + step) % IllustratedArt.species.length);

  @override
  Widget build(BuildContext context) {
    final theme = currentTerminalTheme();
    final cell = terminalCellSizeOf(context);
    final ink = terminalContentStyle(color: theme.foreground);
    final muted = ink.copyWith(color: theme.foreground.withValues(alpha: .58));
    final species = IllustratedArt.species[_index];
    final name = IllustratedArt.name(species);
    final mood = DaemonMood.values[_expression];
    final expression = _expressions[mood]!;
    final version = _versions[_stage];
    final art = IllustratedArt.daemon(species, version: version, mood: mood);
    Widget action(String key, String label, VoidCallback onPressed) =>
        TextButton(
          key: ValueKey('daemon-gallery-$key'),
          onPressed: onPressed,
          style:
              TextButton.styleFrom(
                foregroundColor: theme.foreground,
                textStyle: ink,
                padding: EdgeInsets.zero,
                minimumSize: Size.zero,
                fixedSize: Size.fromHeight(cell.height),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                shape: const RoundedRectangleBorder(),
                splashFactory: NoSplash.splashFactory,
              ).copyWith(
                overlayColor: WidgetStateProperty.resolveWith(
                  (states) =>
                      states.any(
                        {
                          WidgetState.hovered,
                          WidgetState.focused,
                          WidgetState.pressed,
                        }.contains,
                      )
                      ? theme.selection.withValues(alpha: .5)
                      : Colors.transparent,
                ),
              ),
          child: Text('[ $label ]', semanticsLabel: label),
        );

    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape): widget.onBack,
        const SingleActivator(LogicalKeyboardKey.arrowLeft): () => _browse(-1),
        const SingleActivator(LogicalKeyboardKey.arrowRight): () => _browse(1),
      },
      child: Focus(
        autofocus: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            action('back', 'Back to Zoo', widget.onBack),
            SizedBox(height: cell.height),
            Semantics(
              liveRegion: true,
              child: Text(
                '$name · ${_index + 1} of ${IllustratedArt.species.length}',
                key: const ValueKey('daemon-gallery-name'),
                style: ink,
              ),
            ),
            Text(
              'Preview all ten. Your collection stays as it is.',
              style: muted,
            ),
            SizedBox(height: cell.height / 2),
            Container(
              width: double.infinity,
              color: Color.lerp(theme.background, theme.foreground, .03),
              alignment: Alignment.center,
              child: DaemonIllustration(
                key: const ValueKey('daemon-gallery-portrait'),
                art: art,
                size: 240,
                animate: widget.animate && !_paused,
                semanticsLabel: '$name, ${_stages[_stage]}, $expression',
              ),
            ),
            SizedBox(height: cell.height / 2),
            Wrap(
              spacing: cell.width * 2,
              runSpacing: cell.height / 2,
              children: [
                action('previous', 'Previous', () => _browse(-1)),
                action('next', 'Next', () => _browse(1)),
                action('stage', 'Stage: ${_stages[_stage]}', () {
                  setState(() => _stage = (_stage + 1) % _versions.length);
                }),
                action('expression', 'Expression: $expression', () {
                  setState(
                    () => _expression =
                        (_expression + 1) % DaemonMood.values.length,
                  );
                }),
                if (widget.animate)
                  action('motion', _paused ? 'Play' : 'Pause', () {
                    setState(() => _paused = !_paused);
                  }),
              ],
            ),
            SizedBox(height: cell.height),
            Wrap(
              spacing: cell.width * 2,
              runSpacing: cell.height / 2,
              children: [
                for (final (index, id) in IllustratedArt.species.indexed)
                  Semantics(
                    selected: index == _index,
                    child: ColoredBox(
                      color: index == _index
                          ? theme.selection.withValues(alpha: .35)
                          : Colors.transparent,
                      child: action(id, IllustratedArt.name(id), () {
                        setState(() => _index = index);
                      }),
                    ),
                  ),
              ],
            ),
            SizedBox(height: cell.height),
            Text('← → browse · Tab controls · Esc back', style: muted),
          ],
        ),
      ),
    );
  }
}

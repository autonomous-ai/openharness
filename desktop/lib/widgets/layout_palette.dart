import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../state/pane_preset.dart';
import '../theme/app_theme.dart';

/// ⇧⌘L — pick the shape of the grid.
///
/// Shapes are DRAWN, not listed. "Two over one" and "one over two" are the same
/// four words in a different order, and nobody reads a layout name twice; the
/// little diagram is the whole interface and the label only confirms it.
///
/// Every card describes a distinct concrete arrangement. Automatic defaults
/// resolve to the matching card, instead of adding a duplicate picture.
/// Set while the palette is up, so a second ⇧⌘L can be answered rather than
/// stacking a route.
///
/// It used to be a bool and a bare return. That stopped the palette fading the
/// window to black under a held key — each press laid another dialog and another
/// 30% barrier over the last — but it left ⇧⌘L meaning "open" once and nothing
/// ever after, which is the one thing a person holding a key does not expect.
///
/// THE SAME KEY WALKS THE STRIP. ⇧⌘L opens it, ⇧⌘L again steps to the next shape,
/// Enter takes it. That is how every cycling chord on this OS behaves, and it
/// means the shape can be chosen without the hand leaving the chord it arrived
/// on.
bool Function()? _layoutPaletteAdvance;

/// Advance the visible palette without opening another route behind a dialog.
bool advanceLayoutPalette() => _layoutPaletteAdvance?.call() ?? false;

Future<void> showLayoutPalette(BuildContext context, AppNotifier notifier) {
  if (advanceLayoutPalette()) {
    return Future<void>.value();
  }
  return showAppDialog<void>(
    context: context,
    builder: (context) => _LayoutPalette(notifier: notifier),
  ).whenComplete(() => _layoutPaletteAdvance = null);
}

/// The strip's geometry, in one place.
///
/// Both the [Wrap] that draws the shapes and the keys that walk them read these.
/// They used to be literals in the build method alone, which is why the arrow
/// keys could not tell a row from a column: nothing outside the layout knew how
/// many shapes fitted on a line.
/// Where [at] lands after one press, on a strip [n] long.
///
/// BOTH AXES WRAP. The strip is short and every shape is on screen, so running
/// off one end and appearing at the other cannot be mistaken for a jump to
/// somewhere unseen — and a key that dies at the edge is one people stop
/// trusting, which is the same argument the window's own pane ring rests on.
///
/// Vertical keeps the COLUMN: down from the second shape lands under it, not
/// at the start of the next line. A last row shorter than the others clamps,
/// because there is no shape under that column to land on.
int layoutPaletteMove(int at, int n, int dx, int dy, int perRow) {
  if (n <= 1) return 0;
  if (dx != 0) return (at + dx + n) % n;
  final rows = (n / perRow).ceil();
  if (rows <= 1) return at; // one line has no up and no down
  final col = at % perRow;
  final row = at ~/ perRow;
  final target = ((row + dy + rows) % rows) * perRow + col;
  return target >= n ? n - 1 : target;
}

class _Strip {
  /// Wide enough that a diagram stays readable — see the note on the Wrap.
  static const shape = 108.0;
  static const diagram = 86.0;
  static const gap = 10.0;
  static const sidePadding = 14.0;

  /// The dialog's own width, which changes with how many shapes there are.
  static double width(int choices) {
    final columns = choices > 4 ? 3 : choices.clamp(1, 4);
    return sidePadding * 2 + shape * columns + gap * (columns - 1);
  }

  /// How many shapes sit on one line. The same arithmetic Wrap does.
  static int perRow(int choices, double width, double shape) {
    final room = width - sidePadding * 2;
    final fits = ((room + gap) / (shape + gap)).floor();
    return fits.clamp(1, choices < 1 ? 1 : choices);
  }
}

class _LayoutPalette extends StatefulWidget {
  const _LayoutPalette({required this.notifier});

  final AppNotifier notifier;

  @override
  State<_LayoutPalette> createState() => _LayoutPaletteState();
}

class _LayoutPaletteState extends State<_LayoutPalette> {
  /// An EXPLICIT node, requested after the first frame.
  ///
  /// `autofocus: true` alone was not enough: it only takes the focus when the
  /// enclosing scope has none to give, and by the time this is laid out the
  /// route that opened it has already settled focus somewhere. The symptom was
  /// precise — ⇧⌘L opened the palette and cycled it, because that chord is a
  /// global binding, while the arrow keys did nothing at all, because those are
  /// read HERE and nothing here was listening.
  final FocusNode _keys = FocusNode(debugLabel: 'layout-palette');
  final _shapeKeys = List.generate(6, (_) => GlobalKey());
  int _perRow = 1;
  bool _revealPending = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _keys.requestFocus();
    });
    // Registered here rather than by the opener, so the hook cannot outlive the
    // widget it steps: a stale callback would move a cursor on a palette that
    // is no longer on screen, and the next ⇧⌘L would find the strip already
    // walked.
    _layoutPaletteAdvance = _advance;
  }

  @override
  void dispose() {
    if (_layoutPaletteAdvance == _advance) _layoutPaletteAdvance = null;
    _keys.dispose();
    super.dispose();
  }

  /// Advance one choice with the configured Layout key, without applying it.
  bool _advance() {
    if (!mounted || ModalRoute.isCurrentOf(context) == false) return false;
    final count = widget.notifier.panes.length;
    final choices = PanePreset.forCount(count);
    if (choices.isEmpty) return true;
    // presetFor is keyed on the PANE COUNT, not on how many shapes that count
    // offers — the two are different numbers and only one of them is a key.
    final at = _cursorIn(choices, _currentChoice(count));
    _select((at + 1) % choices.length);
    return true;
  }

  /// Which shape the arrow keys are resting on, which is NOT the same as the
  /// one in use: moving the cursor must not rearrange the grid under someone
  /// still looking at the choices. Applying is Enter, a digit, or a click.
  int? _cursor;

  void _select(int index) {
    if (_cursor == index) return;
    setState(() => _cursor = index);
    if (_revealPending) return;
    _revealPending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _revealPending = false;
      if (!mounted || ModalRoute.isCurrentOf(context) == false) return;
      final target = _shapeKeys[_cursor!].currentContext;
      if (target != null) {
        Scrollable.ensureVisible(
          target,
          alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtEnd,
        );
      }
    });
  }

  /// Where the cursor is, read from state rather than from a captured local.
  ///
  /// Two keys can land inside one frame — an arrow and the Enter that takes it
  /// — and a value closed over at build time would still hold the position
  /// BEFORE the arrow moved, so the palette would apply the shape the cursor
  /// had just left. Reading it here means the answer is always current.
  ///
  /// It starts on the shape already in use, so the first arrow press steps off
  /// that one rather than jumping to the top of the list.
  int _cursorIn(List<PanePreset> choices, PanePreset? current) {
    if (choices.isEmpty) return 0;
    final start = _cursor ?? choices.indexOf(current ?? choices.first);
    return start.clamp(0, choices.length - 1);
  }

  PanePreset? _currentChoice(int count) {
    final notifier = widget.notifier;
    final preset = notifier.presetFor(count);
    if (preset == null || PanePreset.forCount(count).contains(preset)) {
      return preset;
    }
    final actual = notifier.activeSwarm.arranged?.tiles;
    if (actual != null && actual.length == count) {
      return PanePreset.matchingChoice(count, actual);
    }
    final viewport = MediaQuery.sizeOf(context);
    final resolved =
        preset == PanePreset.splitLong && viewport.height > viewport.width
        ? PanePreset.rows
        : preset;
    return PanePreset.matchingChoice(
      count,
      resolved.tilesFor(count, columns: notifier.gridColumns),
    );
  }

  @override
  Widget build(BuildContext context) {
    final notifier = widget.notifier;
    grid.AppTheme.watch(context);
    final count = notifier.panes.length;
    final choices = PanePreset.forCount(count);
    final current = _currentChoice(count);
    final cursor = _cursorIn(choices, current);
    final textScale = MediaQuery.textScalerOf(context).scale(11.5) / 11.5;
    final shapeWidth = (_Strip.shape * textScale).clamp(_Strip.shape, 216.0);
    final paletteWidth =
        _Strip.width(choices.length) * textScale.clamp(1.0, 2.0);

    return KeymapRegion(
      contextKind: KeymapContext.workspace,
      actions: {
        'pane.layout': () {
          _advance();
        },
      },
      child: Dialog(
        backgroundColor: grid.AppGlass.surfaceFill,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(13),
          side: BorderSide(color: grid.AppGlass.hair),
        ),
        child: Focus(
          focusNode: _keys,
          autofocus: true,
          onKeyEvent: (node, event) {
            // Repeats count: holding an arrow should walk the list, the way it
            // does in every other list on this OS.
            if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
              return KeyEventResult.ignored;
            }
            // The keymap handles configured chords before this local handler.
            // Modified digits/arrows must not fall through as a plain selection.
            final keyboard = HardwareKeyboard.instance;
            if (keyboard.isMetaPressed ||
                keyboard.isControlPressed ||
                keyboard.isAltPressed ||
                keyboard.isShiftPressed) {
              return KeyEventResult.ignored;
            }
            if (choices.isEmpty) return KeyEventResult.ignored;

            void apply(PanePreset preset) {
              notifier.setPreset(count, preset);
              Navigator.of(context).pop();
            }

            final at = _cursorIn(choices, current);
            final direction = _direction(event.logicalKey);
            if (direction != null) {
              _select(
                layoutPaletteMove(
                  at,
                  choices.length,
                  direction.$1,
                  direction.$2,
                  _perRow,
                ),
              );
              return KeyEventResult.handled;
            }
            if (_isCommit(event.logicalKey)) {
              apply(choices[at]);
              return KeyEventResult.handled;
            }
            final index = _digit(event.logicalKey);
            if (index == null || index > choices.length) {
              return KeyEventResult.ignored;
            }
            apply(choices[index - 1]);
            return KeyEventResult.handled;
          },
          child: ConstrainedBox(
            // Wide enough that four shapes still get a diagram big enough to read
            // and a label that is not ellipsised into a guess.
            constraints: BoxConstraints(maxWidth: paletteWidth),
            child: LayoutBuilder(
              builder: (context, constraints) {
                // Read the same available width the Wrap uses, including text
                // scaling and a window narrower than the preferred palette.
                _perRow = _Strip.perRow(
                  choices.length,
                  constraints.maxWidth,
                  shapeWidth,
                );
                return SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(18, 16, 18, 12),
                        child: Text(
                          choices.isEmpty ? 'Layout' : 'Layout · $count panes',
                          style: TextStyle(
                            color: grid.AppPalette.textSecondary,
                            fontSize: 11.5,
                            letterSpacing: 0.9,
                            fontWeight: grid.AppFont.medium,
                          ),
                        ),
                      ),
                      if (choices.isEmpty)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(18, 0, 18, 20),
                          child: Text(
                            'One tile has no layout to choose. Open another and the '
                            'shapes appear here.',
                            style: TextStyle(
                              color: grid.AppPalette.textFaint,
                              fontSize: 12.5,
                              height: 1.45,
                            ),
                          ),
                        )
                      else ...[
                        Padding(
                          padding: const EdgeInsets.fromLTRB(
                            _Strip.sidePadding,
                            0,
                            _Strip.sidePadding,
                            6,
                          ),
                          // Wrapped, not a Row: a big grid offers five column counts,
                          // and five diagrams squeezed across one line are five things
                          // nobody can tell apart. 108px keeps a shape readable.
                          child: Wrap(
                            spacing: _Strip.gap,
                            runSpacing: _Strip.gap,
                            children: [
                              for (var i = 0; i < choices.length; i++)
                                SizedBox(
                                  key: _shapeKeys[i],
                                  width: shapeWidth,
                                  child: _ShapeButton(
                                    preset: choices[i],
                                    count: count,
                                    index: i + 1,
                                    selected: choices[i] == current,
                                    cursor: i == cursor,
                                    onTap: () {
                                      notifier.setPreset(count, choices[i]);
                                      Navigator.of(context).pop();
                                    },
                                  ),
                                ),
                            ],
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.fromLTRB(18, 6, 18, 14),
                          child: Text(
                            'Arrows to move · Enter or 1–${choices.length} to apply.\n'
                            'Changing layout resets pane sizes.',
                            style: TextStyle(
                              color: grid.AppPalette.textSecondary,
                              fontSize: 11,
                              height: 1.4,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                );
              },
            ),
          ),
        ),
      ),
    );
  }

  /// Which way an arrow moves the cursor.
  /// Which way a key points, as (dx, dy).
  ///
  /// hjkl beside the arrows, unmodified, for the reason the window binds both: a
  /// hand that reaches for one and a hand that reaches for the other are two
  /// hands on the same keyboard. Bare letters are safe HERE and nowhere else in
  /// this app — a dialog is not a pty, and no shell is waiting behind it.
  ///
  /// UP AND DOWN ARE VERTICAL. They used to be a second spelling of left and
  /// right — every key stepped the list by one — on the reasoning that a
  /// vertical key would do nothing on a single-row palette. What that actually
  /// produced was `j` walking sideways, which is worse than a key that waits:
  /// the motion did not match the arrow on the cap.
  static (int, int)? _direction(LogicalKeyboardKey key) => switch (key) {
    LogicalKeyboardKey.arrowLeft || LogicalKeyboardKey.keyH => (-1, 0),
    LogicalKeyboardKey.arrowRight || LogicalKeyboardKey.keyL => (1, 0),
    LogicalKeyboardKey.arrowUp || LogicalKeyboardKey.keyK => (0, -1),
    LogicalKeyboardKey.arrowDown || LogicalKeyboardKey.keyJ => (0, 1),
    _ => null,
  };

  static bool _isCommit(LogicalKeyboardKey key) =>
      key == LogicalKeyboardKey.enter ||
      key == LogicalKeyboardKey.numpadEnter ||
      key == LogicalKeyboardKey.space;

  static int? _digit(LogicalKeyboardKey key) {
    const digits = [
      LogicalKeyboardKey.digit1,
      LogicalKeyboardKey.digit2,
      LogicalKeyboardKey.digit3,
      LogicalKeyboardKey.digit4,
      LogicalKeyboardKey.digit5,
      LogicalKeyboardKey.digit6,
    ];
    final index = digits.indexOf(key);
    return index < 0 ? null : index + 1;
  }
}

class _ShapeButton extends StatelessWidget {
  const _ShapeButton({
    required this.preset,
    required this.count,
    required this.index,
    required this.selected,
    required this.cursor,
    required this.onTap,
  });

  final PanePreset preset;
  final int count;
  final int index;

  /// The shape the grid is in now.
  final bool selected;

  /// Where the arrow keys are resting. Drawn as a ring rather than as the
  /// selected fill, so "what I am about to pick" never looks like "what is
  /// already in use" — the two are different answers and both are on screen.
  final bool cursor;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.fromLTRB(10, 10, 10, 8),
        decoration: BoxDecoration(
          color: selected
              ? grid.AppSurface.accentWash
              : grid.AppSurface.hoverFill,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: selected ? AppColors.accent : grid.AppGlass.hair,
          ),
        ),
        // Paint focus over the fixed border so moving the highlight does not
        // change the diagram's bounds or the height of the wrapped row.
        foregroundDecoration: cursor
            ? BoxDecoration(
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.accent, width: 2),
              )
            : null,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: _Strip.diagram,
              height: _Strip.diagram * 3 / 4,
              child: CustomPaint(painter: _ShapePainter(preset, count)),
            ),
            const SizedBox(height: 8),
            Text(
              preset.label,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: selected
                    ? grid.AppPalette.textPrimary
                    : grid.AppPalette.textSecondary,
                fontSize: 11.5,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              '$index',
              style: TextStyle(
                fontFamily: grid.AppFont.mono,
                fontSize: 9.5,
                color: grid.AppPalette.textSecondary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The diagram: [PanePreset.tiles], drawn.
///
/// It paints the shape's own description rather than a picture of it, and
/// `pane_preset_test` measures the real grid against the same list — so an
/// illustration that lies about the layout fails a test instead of misleading
/// someone into picking the wrong shape.
class _ShapePainter extends CustomPainter {
  const _ShapePainter(this.preset, this.count);

  final PanePreset preset;
  final int count;

  @override
  void paint(Canvas canvas, Size size) {
    final fill = Paint()..color = AppColors.accent.withValues(alpha: 0.55);
    for (final unit in preset.tilesFor(count)) {
      // Dense layouts must still draw every pane. A fixed 3px inset erased
      // short rows entirely once the diagram contained more than 21 rows.
      final gapX = (unit.width * size.width * .12).clamp(0.0, 1.5);
      final gapY = (unit.height * size.height * .12).clamp(0.0, 1.5);
      final rect = Rect.fromLTRB(
        unit.left * size.width + gapX,
        unit.top * size.height + gapY,
        unit.right * size.width - gapX,
        unit.bottom * size.height - gapY,
      );
      canvas.drawRRect(
        RRect.fromRectAndRadius(rect, const Radius.circular(2)),
        fill,
      );
    }
  }

  @override
  bool shouldRepaint(_ShapePainter old) =>
      old.preset != preset || old.count != count;
}

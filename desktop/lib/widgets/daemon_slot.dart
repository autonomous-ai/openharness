import 'dart:math';

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import '../daemons/daemon_brain.dart';
import '../daemons/daemon_face.dart';
import '../daemons/illustrated_art.dart';
import 'daemon_illustration.dart';
import '../daemons/individuals.dart';
import '../daemons/plates.dart';
import '../daemons/render.dart' show cardWidth;
import '../daemons/roster.dart';
import '../shared/theme/app_theme.dart';
import '../shared/theme/workspace_bar_style.dart';
import '../shortcuts/app_shortcuts.dart' show linuxKeyLabels;
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'box_chrome.dart';
import 'workspace_bar_control.dart';

const daemonTextFeatures = [
  FontFeature.disable('liga'),
  FontFeature.disable('calt'),
];

TerminalTheme currentTerminalTheme() =>
    debugDaemonTerminalTheme ??
    terminalThemeFor(AppTheme.palette.value, terminalThemeStore.value);

/// A terminal theme for review captures and tests: how the light-theme rules
/// (light-safe colours, the grue's patch) are drawn and checked without
/// switching the app's palette.
@visibleForTesting
TerminalTheme? debugDaemonTerminalTheme;

bool isDarkTerminal(TerminalTheme theme) =>
    theme.background.computeLuminance() < .4;

double contrastRatio(Color a, Color b) {
  final la = a.computeLuminance() + .05, lb = b.computeLuminance() + .05;
  return la > lb ? la / lb : lb / la;
}

/// A daemon's one xterm colour, moved toward legible only where the terminal
/// background would swallow it. Colour is a filter over the drawing, never the
/// only signal.
Color readableInk(Color ink, Color background, {double minimum = 3}) {
  if (contrastRatio(ink, background) >= minimum) return ink;
  final toward = background.computeLuminance() > .5
      ? const Color(0xff000000)
      : const Color(0xffffffff);
  for (var step = 1; step <= 20; step++) {
    final candidate = Color.lerp(ink, toward, step / 20)!;
    if (contrastRatio(candidate, background) >= minimum) return candidate;
  }
  return toward;
}

/// A shiny daemon's colour when the roster has none of its own: the same hue,
/// brighter and more saturated.
Color shinyVariant(Color color) {
  final hsl = HSLColor.fromColor(color);
  return hsl
      .withSaturation((hsl.saturation + .3).clamp(0, 1))
      .withLightness((hsl.lightness + .12).clamp(0, .85))
      .toColor();
}

/// Pitch black: where the grue is drawn on every theme.
const daemonPitch = Color(0xff000000);

/// What a daemon is drawn on, when it is not the terminal's own background:
/// the grue lives only in the dark, so wherever it is drawn it brings its own.
Color? daemonBackdrop(DaemonDef def) => def.darkOnly ? daemonPitch : null;

/// A daemon's colour on the terminal background (panel, reveal, zoo, card),
/// never in the status line. A dark theme takes its xterm colour (moved toward
/// legible only below 3:1); a light theme takes the roster's light colour, or
/// the xterm colour darkened until it reaches 4.5:1. A shiny daemon takes the
/// roster's shiny colour, or a brighter one.
Color daemonColor(DaemonDef def, TerminalTheme theme, {bool shiny = false}) {
  final base = shiny ? def.shinyColor ?? shinyVariant(def.color) : def.color;
  final backdrop = daemonBackdrop(def);
  if (backdrop != null) return readableInk(base, backdrop);
  if (isDarkTerminal(theme)) return readableInk(base, theme.background);
  return (shiny ? null : def.lightColor) ??
      readableInk(base, theme.background, minimum: 4.5);
}

/// How a filled daemon is coloured on [background] (the terminal's own, or
/// its backdrop, by default): the plate colour rule down its gradient (the
/// shiny one when [shiny]). On a light background the rule holds, but each
/// stop is darkened until it reads (4.5:1) and a burning glyph (`@`) goes
/// toward black, not white. Null for a daemon drawn in line art.
PlateInk? daemonPlateInk(
  DaemonRoster roster,
  DaemonDef def,
  TerminalTheme theme, {
  bool shiny = false,
  Color? background,
}) {
  final gradient = plateGradient(def, shiny: shiny);
  if (!def.plate || gradient == null) return null;
  final bg = background ?? daemonBackdrop(def) ?? theme.background;
  if (bg.computeLuminance() < .4) {
    return PlateInk(roster, gradient, background: bg);
  }
  return PlateInk(
    roster,
    DaemonGradient(
      readableInk(gradient.top, bg, minimum: 4.5),
      readableInk(gradient.bottom, bg, minimum: 4.5),
    ),
    background: bg,
    burn: const Color(0xff000000),
  );
}

/// How an individual's plate is coloured on [background] (README,
/// "Individuals": "Colour"): its colour family ([traits]; a shiny one's is
/// the species' shiny gradient), its markings in its accent, its extra in the
/// extra's colour, its odd eye. On a light background each stop is darkened
/// until it reads (4.5:1) and a burning glyph goes toward black. Null for a
/// species drawn in line art or without traits.
IndividualInk? daemonIndividualInk(
  DaemonRoster roster,
  DaemonDef def,
  DaemonTraits? traits,
  TerminalTheme theme, {
  bool shiny = false,
  Color? background,
}) {
  final catalogue = def.traits;
  if (!def.plate || catalogue == null) return null;
  final colour = traitColour(def, traits) ?? catalogue.colours.first;
  final gradient = shiny && def.shinyGradient != null
      ? def.shinyGradient!
      : colour.gradient;
  final accent = traits == null ? null : plateHexColor(traits.accent);
  final extra = catalogue.extra(traits?.extra)?.colour;
  final bg = background ?? daemonBackdrop(def) ?? theme.background;
  if (bg.computeLuminance() < .4) {
    return IndividualInk(
      roster,
      gradient,
      accent: accent,
      extra: extra,
      background: bg,
    );
  }
  Color read(Color c) => readableInk(c, bg, minimum: 4.5);
  return IndividualInk(
    roster,
    DaemonGradient(read(gradient.top), read(gradient.bottom)),
    accent: accent == null ? null : read(accent),
    extra: extra == null ? null : read(extra),
    background: bg,
    burn: const Color(0xff000000),
  );
}

/// How an egg plate is coloured on [background] (bake.mjs `eggColor`): its
/// kind's gradient, the light inside ([light]: `plain` while it is earned, a
/// rarity's once it opens), a secret's opening [dim]. On a light background
/// the shell is darkened until it reads and a burning glyph goes toward
/// black; the light keeps its colour.
EggInk daemonEggInk(
  DaemonRoster roster,
  String kind,
  TerminalTheme theme, {
  String light = 'plain',
  bool dim = false,
  Color? background,
}) {
  final bg = background ?? theme.background;
  if (bg.computeLuminance() < .4) {
    return EggInk(roster, kind, light: light, dim: dim, background: bg);
  }
  final g = roster.rules.eggs[kind]?.gradient;
  return EggInk(
    roster,
    kind,
    light: light,
    dim: dim,
    background: bg,
    gradient: g == null
        ? null
        : DaemonGradient(
            readableInk(g.top, bg, minimum: 3),
            readableInk(g.bottom, bg, minimum: 3),
          ),
    burn: const Color(0xff000000),
  );
}

/// One row of a plate as spans: row [r] of a plate [rows] tall, each glyph
/// in [ink]'s colour for its material ([mats], the row's material cells;
/// `.` without). Spaces draw nothing, so they ride along in whichever run
/// they fall in; a run of one colour is one span.
List<InlineSpan> plateRowSpans(
  String row,
  int rows,
  int r,
  PlateCellInk ink,
  TextStyle style, {
  String? mats,
}) {
  final spans = <InlineSpan>[];
  final text = StringBuffer();
  Color? colour;
  void flush() {
    if (text.isEmpty) return;
    spans.add(
      TextSpan(
        text: text.toString(),
        style: colour == null ? style : style.copyWith(color: colour),
      ),
    );
    text.clear();
  }

  for (final (c, ch) in row.split('').indexed) {
    final mat = mats != null && c < mats.length ? mats[c] : '.';
    final glyph = ch == ' ' ? null : ink.cell(rows, r, ch, mat);
    if (glyph != null && colour != null && glyph != colour) flush();
    if (glyph != null) colour = glyph;
    text.write(ch);
  }
  flush();
  return spans;
}

/// A whole plate as spans, row by row ([plateRowSpans]), with its material
/// rows when it has them.
List<InlineSpan> plateSpans(
  List<String> rows,
  PlateCellInk ink,
  TextStyle style, {
  List<String>? mats,
}) => [
  for (final (r, row) in rows.indexed) ...[
    ...plateRowSpans(
      row,
      rows.length,
      r,
      ink,
      style,
      mats: mats != null && r < mats.length ? mats[r] : null,
    ),
    if (r < rows.length - 1) TextSpan(text: '\n', style: style),
  ],
];

/// The slot's ink: the status line's own text colour, whatever the daemon.
/// Daemon colours fail contrast on a status bar and on the message line; they
/// appear only on the terminal background. The grue on a light theme is the
/// one exception: it draws on its own black patch, so it takes its colour.
Color daemonSlotInk(DaemonFace face, TerminalTheme theme) {
  final def = face.def;
  if (def != null && daemonSlotPatch(face, theme) != null) {
    return daemonColor(def, theme);
  }
  return theme.foreground;
}

/// A black eight-cell patch behind the grue on a light theme, so it is a
/// creature in the dark rather than an empty slot.
Color? daemonSlotPatch(DaemonFace face, TerminalTheme theme) {
  final def = face.def;
  if (def == null || !face.showsDaemon || isDarkTerminal(theme)) return null;
  return daemonBackdrop(def);
}

/// A reply's ink: the status line's text, dimmer. Never the alert yellow.
Color daemonDimInk(TerminalTheme theme) =>
    theme.foreground.withValues(alpha: .62);

/// The tab bar's fixed-width creature. Counts and progress belong in its
/// panel. Only this widget repaints on a new face.
class DaemonSlotButton extends StatefulWidget {
  const DaemonSlotButton({
    super.key,
    required this.face,
    required this.onPressed,
    this.selected = false,
    this.tooltip,
    this.onHover,
    this.enabled = true,
  });
  final bool enabled;
  final DaemonFace face;
  final VoidCallback onPressed;
  final bool selected;
  final String Function()? tooltip;
  final ValueChanged<bool>? onHover;

  @override
  State<DaemonSlotButton> createState() => _DaemonSlotButtonState();
}

class _DaemonSlotButtonState extends State<DaemonSlotButton> {
  bool _hovered = false;

  @override
  void didUpdateWidget(DaemonSlotButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.enabled && _hovered) {
      _hovered = false;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !_hovered) widget.onHover?.call(false);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final face = widget.face;
    return ListenableBuilder(
      listenable: Listenable.merge([
        face,
        terminalThemeStore,
        AppTheme.palette,
      ]),
      builder: (context, _) {
        if (!face.visible) return const SizedBox.shrink();
        final theme = currentTerminalTheme();
        final art = IllustratedArt.forFace(face);
        return MouseRegion(
          onEnter: (_) {
            if (!widget.enabled ||
                face.revealing ||
                face.zoo.hatchingEgg != null) {
              return;
            }
            _hovered = true;
            face.look();
            face.seen();
            widget.onHover?.call(true);
          },
          onExit: (_) {
            if (!_hovered) return;
            _hovered = false;
            widget.onHover?.call(false);
          },
          child: Semantics(
            value: face.detail,
            child: WorkspaceBarControl(
              key: const ValueKey('daemon-slot'),
              label: face.label,
              tooltip: art == null
                  ? (widget.tooltip?.call() ?? face.tooltip)
                  : null,
              selected: widget.selected,
              onPressed:
                  !widget.enabled ||
                      face.revealing ||
                      face.zoo.hatchingEgg != null
                  ? null
                  : widget.onPressed,
              builder: (context, emphasized) => SizedBox(
                height: workspaceBarControlHeight(context),
                width: 44,
                child: Center(
                  child: art != null
                      ? DaemonIllustration(
                          key: const ValueKey('daemon-slot-art'),
                          art: art,
                          frame: IllustratedArt.frameForFace(face),
                          size: 32,
                        )
                      : FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Text(
                            face.cell,
                            key: const ValueKey('daemon-slot-glyph'),
                            maxLines: 1,
                            style: workspaceBarTextStyle(
                              color: daemonSlotInk(face, theme),
                              emphasized: emphasized,
                            ).copyWith(fontFeatures: daemonTextFeatures),
                          ),
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

/// How a line the pair harness wrote is drawn: IRC's `<nick>` before its
/// words, so a model speaking never reads as one of the daemon's own facts.
String daemonPairNick(String name) => '<$name> ';

/// The daemon's one line where the status line's context sits: tmux's
/// message line. An alert (a harness needs you, a failure, the pair asking
/// for your key) is in the message yellow; a reply (a boop, its first words,
/// the pair answering you) in the status line's own ink, dimmer. [fallback]
/// shows whenever it is silent. A line from the pair brain is drawn exactly
/// as sent, keys first (`[y/n/g] api@office: npm test`): each offered key in
/// that bracket is clickable (also ⌘⌥ plus the key, handled by the
/// workspace), only while the line shows, and only once it is armed ([brain]
/// says so: the window drew it and its detail a moment ago). Until then its
/// keys are drawn faint and do nothing; `[g]` opens at any time. A line the
/// pair harness wrote starts with its `<nick>`.
class DaemonVoiceLine extends StatelessWidget {
  const DaemonVoiceLine({
    super.key,
    required this.face,
    required this.fallback,
    this.onAnswer,
    this.brain,
  });
  final DaemonFace face;
  final Widget fallback;
  final ValueChanged<String>? onAnswer;
  final DaemonBrain? brain;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([face.voiceLine, ?brain]),
    builder: (context, _) {
      final voice = face.voiceLine.value;
      if (voice == null) return fallback;
      final theme = currentTerminalTheme();
      final ink = face.voiceAlert ? theme.yellow : daemonDimInk(theme);
      TextStyle style([bool emphasized = false]) => workspaceBarTextStyle(
        color: ink,
        emphasized: emphasized,
      ).copyWith(fontFeatures: daemonTextFeatures);
      final actions = face.voiceActions;
      final split = actions.isEmpty
          ? (keys: const <String>[], rest: voice)
          : splitDaemonKeys(voice, actions);
      final sayId = face.voiceSayId;
      final armed = sayId == null || brain == null || brain!.armed(sayId);
      final nick = face.voiceFromPair ? daemonPairNick(face.name) : null;
      final rest = Text.rich(
        TextSpan(
          children: [
            if (nick != null) TextSpan(text: nick, style: style(true)),
            TextSpan(text: split.rest),
          ],
        ),
        key: const ValueKey('daemon-voice-text'),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        textAlign: TextAlign.right,
        style: style(),
      );
      return Semantics(
        key: const ValueKey('daemon-voice'),
        liveRegion: true,
        label: nick == null ? voice : '${face.name} says: $voice',
        child: split.keys.isEmpty
            ? ExcludeSemantics(child: rest)
            : Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  DaemonKeys(
                    keys: split.keys,
                    actions: actions,
                    style: style,
                    onAnswer: onAnswer,
                    armed: armed,
                    chord: true,
                  ),
                  Flexible(child: ExcludeSemantics(child: rest)),
                ],
              ),
      );
    },
  );
}

/// A line's keys, first, as the brain writes them: `[y/n/g] `. Each key that
/// is offered is its own small button ([onAnswer] with the key); a key that
/// is not (a brief's `[y]` after its minute) is drawn and does nothing. A
/// key on a line not yet [armed] is drawn faint and does nothing until it is.
class DaemonKeys extends StatelessWidget {
  const DaemonKeys({
    super.key,
    required this.keys,
    required this.actions,
    required this.style,
    this.onAnswer,
    this.live = true,
    this.armed = true,
    this.chord = false,
    this.idPrefix = 'daemon-answer',
    this.height,
  });
  final List<String> keys;
  final List<DaemonAction> actions;
  final TextStyle Function([bool emphasized]) style;
  final ValueChanged<String>? onAnswer;

  /// Whether y and n still work (g always opens).
  final bool live;

  /// Whether the line has been shown long enough for a key to count
  /// (`daemon_shown`, then 400 ms). `[g]` opens either way.
  final bool armed;

  /// The tooltip names the ⌘⌥ chord (only the status line's line has one).
  final bool chord;
  final String idPrefix;

  /// The row's height: the status line's by default.
  final double? height;

  @override
  Widget build(BuildContext context) {
    final height = this.height ?? workspaceBarControlHeight(context);
    Widget text(String value) => SizedBox(
      height: height,
      child: Center(widthFactor: 1, child: Text(value, style: style())),
    );
    Widget faint(String key) => SizedBox(
      key: ValueKey('$idPrefix-$key-arming'),
      height: height,
      child: Center(
        widthFactor: 1,
        child: Text(
          key,
          style: style().copyWith(
            color: style().color?.withValues(
              alpha: (style().color?.a ?? 1) * .4,
            ),
          ),
        ),
      ),
    );
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        text('['),
        for (final (i, key) in keys.indexed) ...[
          if (i > 0) text('/'),
          if (key != 'g' &&
              !armed &&
              live &&
              onAnswer != null &&
              actions.any((a) => a.key == key))
            faint(key)
          else if (actions.where((a) => a.key == key).firstOrNull
              case final action? when onAnswer != null && (live || key == 'g'))
            WorkspaceBarControl(
              key: ValueKey('$idPrefix-$key'),
              label: action.label,
              tooltip: chord
                  ? '${action.label} ${linuxKeyLabels ? 'Alt+Super+' : '⌘⌥'}${key.toUpperCase()}'
                  : action.label,
              onPressed: () => onAnswer!(key),
              builder: (context, emphasized) => SizedBox(
                height: height,
                child: Center(
                  widthFactor: 1,
                  child: Text(
                    key,
                    style: style(emphasized)
                        .copyWith(decoration: TextDecoration.underline),
                  ),
                ),
              ),
            )
          else
            text(key),
        ],
        text('] '),
      ],
    );
  }
}

/// A card (card.mjs's lines) as selectable text: the portrait rows in the
/// daemon's colour, on its backdrop when it brings one (the grue's black). A
/// filled daemon's portrait plate takes the plate colour instead, glyph by
/// glyph down its gradient ([plate]).
String illustratedCardDetails(List<String> lines, int portraitRows) => [
  for (var i = 1; i < lines.length - 1; i++)
    if (!(i >= 2 && i < 3 + portraitRows))
      lines[i].startsWith('| ') && lines[i].endsWith(' |')
          ? lines[i].substring(2, lines[i].length - 2).trimRight().trimLeft()
          : lines[i],
].join('\n').trim();

class DaemonCardText extends StatelessWidget {
  const DaemonCardText({
    super.key,
    required this.lines,
    required this.portraitRows,
    required this.style,
    required this.colour,
    this.backdrop,
    this.plate,
    this.mats,
    this.illustration,
  });
  final IllustratedArt? illustration;
  final List<String> lines;
  final int portraitRows;
  final TextStyle style;
  final Color colour;
  final Color? backdrop;
  final PlateCellInk? plate;

  /// The portrait's material rows (an individual's own plate), so its
  /// markings, extra and odd eye take their colours.
  final List<String>? mats;

  @override
  Widget build(BuildContext context) {
    if (illustration case final art?) {
      return SizedBox(
        width: 350,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            DaemonIllustration(art: art, size: 260, semanticsLabel: 'Tim'),
            SelectableText(
              illustratedCardDetails(lines, portraitRows),
              style: style,
            ),
          ],
        ),
      );
    }
    // card.mjs: the border, the head and a blank row, then the portrait. Only
    // the inside of those rows takes the daemon's colour; the frame stays ink.
    final art = style.copyWith(color: colour, backgroundColor: backdrop);
    final plate = this.plate;
    final mats = this.mats;
    // The portrait sits centred in the card's inner 38 columns (card.mjs).
    final width = mats?.fold<int>(0, (w, m) => max(w, m.length)) ?? 0;
    final pad = max(0, (cardWidth - 4 - width) ~/ 2);
    String? matsAt(int r) {
      if (mats == null || r >= mats.length) return null;
      return '${'.' * pad}${mats[r]}';
    }

    return SelectableText.rich(
      TextSpan(
        children: [
          for (final (i, line) in lines.indexed) ...[
            if (i >= 3 && i < 3 + portraitRows && line.length > 4) ...[
              TextSpan(text: line.substring(0, 2), style: style),
              if (plate == null)
                TextSpan(text: line.substring(2, line.length - 2), style: art)
              else
                ...plateRowSpans(
                  line.substring(2, line.length - 2),
                  portraitRows,
                  i - 3,
                  plate,
                  style,
                  mats: matsAt(i - 3),
                ),
              TextSpan(text: line.substring(line.length - 2), style: style),
            ] else
              TextSpan(text: line, style: style),
            if (i < lines.length - 1) TextSpan(text: '\n', style: style),
          ],
        ],
      ),
      style: style,
    );
  }
}

/// Everything a key would act on, in full and never cut: the whole command
/// or diff, the whole prompt, a lesson's text, a pair.jsonc. It scrolls past
/// [maxRows]; nothing is ever truncated or summarised.
class DaemonDetailBox extends StatefulWidget {
  const DaemonDetailBox({
    super.key,
    required this.text,
    required this.style,
    required this.rowHeight,
    this.maxRows = 12,
    this.background,
  });
  final String text;
  final TextStyle style;
  final double rowHeight;
  final int maxRows;
  final Color? background;

  @override
  State<DaemonDetailBox> createState() => _DaemonDetailBoxState();
}

class _DaemonDetailBoxState extends State<DaemonDetailBox> {
  final _scroll = ScrollController();

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final rows = '\n'.allMatches(widget.text).length + 1;
    return Container(
      width: double.infinity,
      color: widget.background,
      padding: EdgeInsets.symmetric(horizontal: widget.rowHeight / 3),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: widget.rowHeight * widget.maxRows,
        ),
        child: Scrollbar(
          controller: _scroll,
          thumbVisibility: rows > widget.maxRows,
          child: SingleChildScrollView(
            controller: _scroll,
            child: SelectableText(
              widget.text,
              key: const ValueKey('daemon-detail-text'),
              style: widget.style,
            ),
          ),
        ),
      ),
    );
  }
}

/// A line's `detail` under the status line, as a disclosure: the harness it
/// names, then everything a key on it would do, in full. It opens by itself
/// for a line with keys (a key counts only once this has been seen); `[-]`
/// folds it. [onShown] runs once, after the frame that first drew it open.
class DaemonDetailNotice extends StatefulWidget {
  const DaemonDetailNotice({
    super.key,
    required this.title,
    required this.detail,
    this.actions = const [],
    this.initiallyOpen = true,
    this.onShown,
  });

  /// `api@office · what [y] approves`.
  final String title;
  final String detail;

  /// The line's keys, named in a legend under the detail.
  final List<DaemonAction> actions;
  final bool initiallyOpen;
  final VoidCallback? onShown;

  @override
  State<DaemonDetailNotice> createState() => _DaemonDetailNoticeState();
}

class _DaemonDetailNoticeState extends State<DaemonDetailNotice> {
  late bool _open = widget.initiallyOpen;
  bool _told = false;

  void _tell() {
    if (_told || !_open || widget.onShown == null) return;
    _told = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.onShown!();
    });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    _tell();
    return ListenableBuilder(
      listenable: Listenable.merge([terminalThemeStore, AppTheme.palette]),
      builder: (context, _) {
        final theme = currentTerminalTheme();
        final cell = workspaceBarCellSizeOf(context);
        TextStyle ink(Color color, [bool emphasized = false]) =>
            workspaceBarTextStyle(
              color: color,
              emphasized: emphasized,
            ).copyWith(fontFeatures: daemonTextFeatures);
        final legend = [for (final a in widget.actions) '${a.key} ${a.label}']
            .join(' · ');
        return Material(
          key: const ValueKey('daemon-detail'),
          color: theme.background,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(kTerminalCornerRadius),
            side: terminalPaneBorder(focused: true),
          ),
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: cell.width,
              vertical: cell.height / 2,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                WorkspaceBarControl(
                  key: const ValueKey('daemon-detail-toggle'),
                  label: _open ? 'Hide the detail' : 'Show the detail',
                  tooltip:
                      '${_open ? 'Hide' : 'Show'} details · ${widget.title}',
                  onPressed: () => setState(() => _open = !_open),
                  builder: (context, emphasized) => SizedBox(
                    height: workspaceBarControlHeight(context),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        '${_open ? '[-]' : '[+]'} ${widget.title}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ink(theme.foreground, emphasized),
                      ),
                    ),
                  ),
                ),
                if (_open) ...[
                  DaemonDetailBox(
                    text: widget.detail,
                    style: ink(theme.foreground),
                    rowHeight: cell.height,
                    maxRows: 14,
                    background: Color.lerp(
                      theme.background,
                      theme.foreground,
                      .05,
                    ),
                  ),
                  if (legend.isNotEmpty)
                    Padding(
                      padding: EdgeInsets.only(top: cell.height / 4),
                      child: Text(
                        legend,
                        key: const ValueKey('daemon-detail-legend'),
                        style: ink(daemonDimInk(theme)),
                      ),
                    ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

/// The brief on return (`daemon_brief`), under the status line: the daemon's
/// back line, then at most five items, each exactly as sent. A waiting item's
/// keys come first and work while its keys are [live] (a minute) and once
/// they are [armed]; `[g]` opens the harness at any time. What a keyed item
/// would act on (its dialog, or a `lesson` item's text) shows in full under
/// it, and [onShown] hears each keyed item once it has been drawn.
class DaemonBriefNotice extends StatefulWidget {
  const DaemonBriefNotice({
    super.key,
    required this.name,
    required this.brief,
    this.live = true,
    this.onAnswer,
    this.armed,
    this.arming,
    this.onShown,
  });
  final String name;
  final DaemonBrief brief;
  final bool live;
  final void Function(String id, DaemonAction action, DaemonAbout? about)?
  onAnswer;

  /// Whether a key on an item counts yet; null: always.
  final bool Function(String id)? armed;

  /// Heard when an item arms.
  final Listenable? arming;
  final ValueChanged<String>? onShown;

  @override
  State<DaemonBriefNotice> createState() => _DaemonBriefNoticeState();
}

class _DaemonBriefNoticeState extends State<DaemonBriefNotice> {
  final _told = <String>{};

  static bool _keyed(DaemonBriefItem item) =>
      item.id.isNotEmpty && item.actions.any((a) => a.key != 'g');

  void _tell() {
    final onShown = widget.onShown;
    if (onShown == null || !widget.live) return;
    final fresh = [
      for (final item in widget.brief.items)
        if (_keyed(item) && _told.add(item.id)) item.id,
    ];
    if (fresh.isEmpty) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      for (final id in fresh) {
        onShown(id);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    _tell();
    final brief = widget.brief;
    final name = widget.name;
    return ListenableBuilder(
      listenable: Listenable.merge([
        terminalThemeStore,
        AppTheme.palette,
        ?widget.arming,
      ]),
      builder: (context, _) {
        final theme = currentTerminalTheme();
        final cell = workspaceBarCellSizeOf(context);
        TextStyle ink(Color color) =>
            workspaceBarTextStyle(color: color)
                .copyWith(fontFeatures: daemonTextFeatures);
        return Material(
          color: theme.background,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(kTerminalCornerRadius),
            side: terminalPaneBorder(focused: true),
          ),
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: cell.width,
              vertical: cell.height / 2,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (brief.line.isNotEmpty)
                  Text('$name: ${brief.line}', style: ink(theme.foreground)),
                for (final (i, item) in brief.items.indexed) ...[
                  () {
                    final about = item.about;
                    final actions = [
                      ...item.actions,
                      if (about != null &&
                          !item.actions.any((a) => a.key == 'g'))
                        (key: 'g', label: 'open', choice: 'open'),
                    ];
                    final split = splitDaemonKeys(item.line, actions);
                    final color = switch (item.kind) {
                      'waiting' || 'lesson' => theme.yellow,
                      'failed' => theme.red,
                      _ => daemonDimInk(theme),
                    };
                    TextStyle style([bool emphasized = false]) =>
                        workspaceBarTextStyle(
                          color: color,
                          emphasized: emphasized,
                        ).copyWith(fontFeatures: daemonTextFeatures);
                    final onAnswer = widget.onAnswer;
                    return Row(
                      key: ValueKey('daemon-brief-item-$i'),
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(width: cell.width * 2),
                        if (split.keys.isNotEmpty)
                          DaemonKeys(
                            keys: split.keys,
                            actions: actions,
                            style: style,
                            live: widget.live,
                            armed: widget.armed?.call(item.id) ?? true,
                            idPrefix: 'daemon-brief-key-$i',
                            onAnswer: onAnswer == null
                                ? null
                                : (key) {
                                    final action = actions
                                        .where((a) => a.key == key)
                                        .firstOrNull;
                                    if (action != null) {
                                      onAnswer(item.id, action, about);
                                    }
                                  },
                          ),
                        Flexible(
                          child: Text(
                            split.rest,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: style(),
                          ),
                        ),
                      ],
                    );
                  }(),
                  if ((item.kind == 'lesson' || _keyed(item)) &&
                      item.shows != null)
                    Padding(
                      padding: EdgeInsets.only(left: cell.width * 4),
                      child: DaemonDetailBox(
                        key: ValueKey('daemon-brief-detail-$i'),
                        text: item.shows!,
                        style: ink(daemonDimInk(theme)),
                        rowHeight: cell.height,
                        maxRows: 12,
                      ),
                    ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

/// A short terminal note beside the slot. It never takes focus on arrival.
class DaemonNotice extends StatelessWidget {
  const DaemonNotice({
    super.key,
    required this.message,
    this.action,
    this.onAction,
  });
  final String message;
  final String? action;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([terminalThemeStore, AppTheme.palette]),
      builder: (context, _) {
        final theme = currentTerminalTheme();
        final cell = workspaceBarCellSizeOf(context);
        return Material(
          color: theme.background,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(kTerminalCornerRadius),
            side: terminalPaneBorder(focused: true),
          ),
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: cell.width,
              vertical: cell.height / 2,
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Flexible(
                  child: Semantics(
                    liveRegion: true,
                    child: Text(
                      message,
                      style: workspaceBarTextStyle(color: theme.foreground),
                    ),
                  ),
                ),
                if (action != null && onAction != null) ...[
                  SizedBox(width: cell.width),
                  WorkspaceBarControl(
                    label: action!,
                    onPressed: onAction,
                    builder: (context, emphasized) => SizedBox(
                      width: workspaceBarTextSizeOf(
                        context,
                        '[ $action ]',
                      ).width,
                      height: workspaceBarControlHeight(context),
                      child: Center(
                        child: Text(
                          '[ $action ]',
                          style: workspaceBarTextStyle(
                            color: theme.yellow,
                            emphasized: emphasized,
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

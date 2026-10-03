import 'dart:async';
import 'dart:math';

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show OverflowBoxFit;
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import '../daemons/daemon_brain.dart';
import '../daemons/daemon_face.dart';
import '../daemons/daemon_lessons.dart';
import '../daemons/daemon_lines.dart';
import '../daemons/daemon_settings.dart';
import '../daemons/pair_rules_file.dart';
import '../daemons/individuals.dart';
import '../daemons/illustrated_art.dart';
import '../daemons/plates.dart';
import '../daemons/render.dart';
import '../daemons/roster.dart';
import '../daemons/zoo.dart';
import '../shared/theme/app_theme.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme_store.dart';
import 'daemon_consent.dart';
import 'daemon_portrait.dart';
import 'daemon_illustration.dart';
import 'daemon_art_gallery.dart';
import 'daemon_slot.dart';
import 'desktop_chrome.dart';

part 'daemon_panel_pair.dart';

/// Where each first-egg habit can be practised, when the app has a place.
const daemonHabitCommands = <String, String>{
  'turn': 'agent.new',
  'split': 'pane.split_right',
  'find': 'agent.open',
  'machine': 'machines.list',
  'store': 'app.store',
  'resume': 'harnesses.list',
};

/// Habits that need something besides this computer: a second computer, or
/// answering from another device (which this app cannot even see). Never
/// needed: every egg can come from the habits this computer has.
const daemonHabitsElsewhere = {'machine', 'elsewhere'};

/// The daemon's panel. Before the first hatch: the nest and its habits,
/// the ones possible on this computer first. After: four tabs, like tmux's
/// windows (`1:now* 2:zoo 3:lessons 4:settings`), remembered per computer:
///
/// - **now**: its line, what waits for your key (each with the harness and
///   exactly what the key does), the brief, what it did on its own, the talk;
/// - **zoo**: the portrait or card, lore, the box back, meters and eggs;
/// - **lessons**: what it learned, a lesson's whole text before a yes;
/// - **settings**: quiet, motion, nap, the autonomy dial and the floor, the
///   rules file, and consent.
///
/// 1–4 switch tabs, Escape closes (or leaves rename or the talk box), arrows
/// and j/k move, Enter acts, and on a row with keys, y, n, s or g answer it
/// once the row has been on screen a moment (its keys are faint until then).
class DaemonPanel extends StatefulWidget {
  const DaemonPanel({
    super.key,
    required this.face,
    required this.onClose,
    required this.onHatch,
    required this.onCommand,
    required this.shortcut,
    this.brain,
    this.onAnswer,
    this.onOpenConversation,
    this.onOpenRules,
    this.talkShortcut,
    this.focusTalk = false,
    this.now,
  });
  final DaemonFace face;

  /// What a drop's state is judged at (released, announced, on hold): the
  /// wall clock unless a test gives one.
  final DateTime Function()? now;

  /// This computer's pair brain, when harnessd has one: its asks, brief,
  /// journal, talk and lessons.
  final DaemonBrain? brain;

  /// A key on a line the brain wrote: the line's (or ask's, brief item's or
  /// confirmation's) id, the action, and the harness it is about (`[g]`
  /// opens it).
  final void Function(String id, DaemonAction action, DaemonAbout? about)?
  onAnswer;

  /// Focus the pair harness's own pane (the full conversation), when known.
  final VoidCallback? onOpenConversation;

  /// Open `~/.config/harness/pair.jsonc`, the rules act within rules runs.
  final VoidCallback? onOpenRules;

  /// The Talk to daemon chord, for its hint.
  final String? talkShortcut;

  /// Open on the now tab with the talk box focused (Talk to daemon).
  final bool focusTalk;
  final VoidCallback onClose;
  final ValueChanged<ZooEgg> onHatch;
  final ValueChanged<String> onCommand;
  final String? Function(String command) shortcut;

  @override
  State<DaemonPanel> createState() => _DaemonPanelState();
}

class _DaemonPanelState extends State<DaemonPanel> with _PairSections {
  final _focus = FocusNode(debugLabel: 'Daemon');
  final _nameFocus = FocusNode(debugLabel: 'Daemon nickname');
  final _name = TextEditingController();
  final _items = <String, FocusNode>{};
  final _scroll = ScrollController();
  @override
  final _viewport = GlobalKey(debugLabel: 'Daemon panel viewport');
  List<String> _order = const [];
  String? _viewing;
  bool _renaming = false;
  bool _showDetails = false;
  bool _showGallery = false;
  String? _nameError;
  late Size _cell;

  @override
  DaemonFace get face => widget.face;
  DaemonRoster get roster => face.roster;
  @override
  Zoo get zoo => face.zoo.zoo;

  /// The tab showing, as the settings keep it.
  String get _tab => face.settings.tab;

  @override
  void initState() {
    super.initState();
    if (widget.focusTalk) face.settings.tab = DaemonSettings.tabs.first;
    _initPair();
    _scroll.addListener(_scheduleShown);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (widget.focusTalk && _pairLive) {
        _talkFocus.requestFocus();
      } else {
        _focusFirst();
      }
    });
  }

  @override
  void dispose() {
    _disposePair();
    _scroll.removeListener(_scheduleShown);
    _scroll.dispose();
    _focus.dispose();
    _nameFocus.dispose();
    _name.dispose();
    for (final node in _items.values) {
      node.dispose();
    }
    super.dispose();
  }

  @override
  FocusNode _node(String key) => key == 'talk'
      ? _talkFocus
      : _items.putIfAbsent(key, () => FocusNode(debugLabel: 'Daemon $key'));

  void _focusFirst() {
    // The talk box takes focus only when asked for (Talk to daemon): typing
    // 1–4 or j there would be words, not keys.
    if (_order.every((k) => k == 'talk')) {
      _focus.requestFocus();
      return;
    }
    // A waiting egg first: that is usually why the panel was opened.
    final preferred = _order.contains('hatch')
        ? 'hatch'
        : _order.firstWhere(
            (k) => k.startsWith('egg:'),
            orElse: () => _order.contains('pair')
                ? 'pair'
                : _order.firstWhere(
                    (k) =>
                        k.startsWith('zoo:') ||
                        k.startsWith('habit:') ||
                        k.startsWith('ask:') ||
                        k.startsWith('confirm:') ||
                        k.startsWith('need:'),
                    orElse: () => _order.firstWhere((k) => k != 'talk'),
                  ),
          );
    _node(preferred).requestFocus();
  }

  @override
  void _refocus() => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (mounted) _focusFirst();
  });

  void _move(int direction) {
    if (_order.isEmpty) return;
    final current = _order.indexWhere((k) => _items[k]?.hasFocus == true);
    final next = current < 0
        ? (direction > 0 ? 0 : _order.length - 1)
        : (current + direction) % _order.length;
    final node = _node(_order[next])..requestFocus();
    // The row comes into view: its keys work only where they can be seen.
    final context = node.context;
    if (context != null) {
      unawaited(
        Scrollable.ensureVisible(
          context,
          alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtEnd,
        ),
      );
    }
  }

  void _switchTab(String tab) {
    if (_tab == tab || _renaming) return;
    setState(() {
      face.settings.tab = tab;
      _consentStep = null;
      _showGallery = false;
    });
    if (_scroll.hasClients) _scroll.jumpTo(0);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focusFirst();
    });
  }

  void _closeGallery() {
    setState(() => _showGallery = false);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _node('gallery').requestFocus();
    });
  }

  void _escape() {
    if (_showGallery) {
      _closeGallery();
      return;
    }
    if (_typing) {
      // Out of the talk box, still in the panel.
      _focus.requestFocus();
      return;
    }
    if (_renaming) {
      setState(() => _renaming = false);
      _node('rename').requestFocus();
    } else {
      widget.onClose();
    }
  }

  void _beginRename(ZooDaemon daemon) {
    final name = daemon.name ?? daemon.id;
    _name.value = TextEditingValue(
      text: name,
      selection: TextSelection(baseOffset: 0, extentOffset: name.length),
    );
    setState(() {
      _renaming = true;
      _nameError = null;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _renaming) _nameFocus.requestFocus();
    });
  }

  void _rename(ZooDaemon daemon) {
    final text = _name.text.trim();
    final ok = face.zoo.nickname(
      daemon.uid,
      text.isEmpty || text == daemon.id ? null : text,
    );
    if (!ok) {
      setState(() => _nameError = '1–24 printable ASCII characters.');
      return;
    }
    setState(() => _renaming = false);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _node('rename').requestFocus();
    });
  }

  @override
  TerminalTheme get _theme => currentTerminalTheme();
  TextStyle _artInk([Color? color]) => terminalContentStyle(
    color: color ?? _theme.foreground,
  ).copyWith(fontFeatures: daemonTextFeatures, fontWeight: FontWeight.normal);
  @override
  TextStyle _ink([Color? color]) =>
      DesktopChrome.text(color: color ?? DesktopChrome.foreground, size: 13);
  @override
  Color get _muted => DesktopChrome.muted;

  @override
  ButtonStyle get _buttonStyle =>
      TextButton.styleFrom(
        minimumSize: const Size(0, DesktopChrome.controlHeight),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        foregroundColor: DesktopChrome.foreground,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
        ),
        splashFactory: NoSplash.splashFactory,
        alignment: Alignment.centerLeft,
      ).copyWith(
        side: WidgetStateProperty.resolveWith(
          (states) => BorderSide(
            width: 1.5,
            color: states.contains(WidgetState.focused)
                ? DesktopChrome.accent
                : Colors.transparent,
          ),
        ),
        overlayColor: WidgetStateProperty.resolveWith(
          (states) => DesktopChrome.foreground.withValues(
            alpha: states.contains(WidgetState.disabled)
                ? 0
                : states.contains(WidgetState.pressed)
                ? .12
                : states.contains(WidgetState.hovered)
                ? .05
                : 0,
          ),
        ),
      );

  @override
  Widget _action(
    String key,
    String label,
    VoidCallback? onPressed, {
    String? tooltip,
  }) {
    final button = TextButton(
      key: ValueKey('daemon-$key'),
      focusNode: _node(key),
      onPressed: onPressed,
      style: _buttonStyle,
      child: Text(label, style: _ink(onPressed == null ? _muted : null)),
    );
    return tooltip == null ? button : Tooltip(message: tooltip, child: button);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([
        face,
        face.settings,
        ?widget.brain,
        terminalFontStore,
        terminalThemeStore,
        AppTheme.palette,
      ]),
      builder: (context, _) {
        _cell = terminalCellSizeOf(context);
        final order = <String>[];
        _beginShown();
        final tabbed = !(face.def == null && zoo.daemons.isEmpty);
        final body = _showGallery
            ? [
                _title('Daemon artwork'),
                SizedBox(height: _cell.height),
                DaemonArtGallery(
                  onBack: _closeGallery,
                  animate: face.motionEnabled,
                ),
              ]
            : tabbed
            ? _daemon(order)
            : _nest(order);
        _order = order;
        _endShown();
        return CallbackShortcuts(
          bindings: {
            const SingleActivator(LogicalKeyboardKey.escape): _escape,
            if (!_renaming && !_typing) ...{
              const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
                  _move(1),
              const SingleActivator(LogicalKeyboardKey.arrowRight): () =>
                  _move(1),
              const SingleActivator(LogicalKeyboardKey.keyJ): () => _move(1),
              const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
                  _move(-1),
              const SingleActivator(LogicalKeyboardKey.arrowLeft): () =>
                  _move(-1),
              const SingleActivator(LogicalKeyboardKey.keyK): () => _move(-1),
              if (tabbed)
                for (final (i, tab) in DaemonSettings.tabs.indexed)
                  SingleActivator(_digits[i]): () => _switchTab(tab),
            },
          },
          child: Focus(
            focusNode: _focus,
            autofocus: true,
            child: TextSelectionTheme(
              data: TextSelectionThemeData(
                selectionColor: DesktopChrome.selection,
                cursorColor: DesktopChrome.accent,
              ),
              child: Material(
                key: const ValueKey('daemon-panel'),
                color: DesktopChrome.surface,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(
                    DesktopChrome.dialogRadius,
                  ),
                  side: BorderSide(
                    color: MediaQuery.highContrastOf(context)
                        ? DesktopChrome.foreground.withValues(alpha: .6)
                        : DesktopChrome.rim,
                  ),
                ),
                clipBehavior: Clip.antiAlias,
                child: SingleChildScrollView(
                  key: _viewport,
                  controller: _scroll,
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (face.zoo.isPreview) ...[
                        Text(
                          'Local preview · clears on window close',
                          key: const ValueKey('daemon-preview-label'),
                          style: _ink(_muted),
                        ),
                        const SizedBox(height: 16),
                      ],
                      ...body,
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

  static const _digits = [
    LogicalKeyboardKey.digit1,
    LogicalKeyboardKey.digit2,
    LogicalKeyboardKey.digit3,
    LogicalKeyboardKey.digit4,
  ];

  Widget _title(String title, {Widget? badge}) => Row(
    children: [
      Expanded(
        child: Text(
          title,
          key: const ValueKey('daemon-panel-title'),
          style: DesktopChrome.heading(),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      ?badge,
      const SizedBox(width: 8),
      Tooltip(
        message: 'Close',
        child: IconButton(
          key: const ValueKey('daemon-close'),
          onPressed: widget.onClose,
          tooltip: 'Close daemon',
          style: _buttonStyle,
          icon: const Icon(AppIcons.close, size: 18),
        ),
      ),
    ],
  );

  /// Tabs retain the same click and 1–4 keyboard navigation.
  Widget _tabBar() => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final tab in DaemonSettings.tabs)
          Semantics(
            selected: tab == _tab,
            button: true,
            child: TextButton(
              key: ValueKey('daemon-tab-$tab'),
              onPressed: () => _switchTab(tab),
              style: _buttonStyle.copyWith(
                backgroundColor: WidgetStatePropertyAll(
                  tab == _tab ? DesktopChrome.selection : null,
                ),
              ),
              child: Text(
                '${tab[0].toUpperCase()}${tab.substring(1)}',
                style: DesktopChrome.control(
                  color: tab == _tab ? DesktopChrome.foreground : _muted,
                  medium: tab == _tab,
                ),
              ),
            ),
          ),
      ],
    ),
  );

  /// On the terminal background the nest warms toward yellow as habits are
  /// done (the status line draws it in its own ink).
  Color get _nestInk {
    if (face.revealing || face.eggReady) return _theme.yellow;
    final progress = (face.zoo.habitsCounted / face.zoo.habitsNeeded).clamp(
      0,
      1,
    );
    return Color.lerp(_theme.foreground, _theme.yellow, .28 + .72 * progress)!;
  }

  // ── before the first hatch: the nest and its habits ─────────────────────────

  /// The habits this computer can do first, then the ones that need another
  /// computer or device (never needed for an egg).
  List<DaemonHabit> get _habitsHereFirst => [
    for (final h in roster.rules.habits)
      if (!daemonHabitsElsewhere.contains(h.key)) h,
    for (final h in roster.rules.habits)
      if (daemonHabitsElsewhere.contains(h.key)) h,
  ];

  List<Widget> _nest(List<String> order) {
    final done = zoo.habits.toSet();
    final egg = face.zoo.readyEgg;
    final shown = face.nearestEgg;
    final need = face.zoo.habitsNeeded;
    final left = need - face.zoo.habitsCounted;
    final habits = _habitsHereFirst;
    for (final habit in habits) {
      if (daemonHabitCommands.containsKey(habit.key) &&
          !done.contains(habit.key)) {
        order.add('habit:${habit.key}');
      }
    }
    if (egg != null) order.add('hatch');
    final here = habits
        .where((h) => !daemonHabitsElsewhere.contains(h.key))
        .length;
    return [
      _title(egg != null ? 'Your egg is ready' : 'Your first egg'),
      const SizedBox(height: 16),
      // The egg itself, filled, at its stage: it cracks as habits count.
      if (shown != null && daemonPlates.hasEgg(shown.kind))
        Center(
          child: SizedBox(
            width: _cell.width * 20,
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: ColoredBox(
                color: _theme.background,
                child: DaemonEggPlate(
                  roster: roster,
                  kind: shown.kind,
                  stage: shown.stage,
                  style: _artInk().copyWith(height: 1.0),
                  theme: _theme,
                  animate: face.motionEnabled,
                  textKey: const ValueKey('daemon-panel-egg-plate'),
                  semanticsLabel: egg != null
                      ? 'Your egg, ready to hatch'
                      : 'Your egg, ${_stageWords(shown.stage)}',
                ),
              ),
            ),
          ),
        ),
      if (shown != null) const SizedBox(height: 8),
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: _cell.width * 10,
            child: Text(
              egg != null ? 'Ready' : 'Growing',
              key: const ValueKey('daemon-panel-nest'),
              semanticsLabel: egg != null ? 'Ready to hatch' : 'An egg',
              style: _artInk(_nestInk)
                  .copyWith(backgroundColor: _theme.background),
            ),
          ),
          Expanded(
            child: Text(
              egg != null
                  ? 'Ready. Nothing hatches on its own.'
                  : left <= 0
                  ? 'Ready. The egg is on its way.'
                  : '${face.zoo.habitsCounted} of $need habits: '
                        '${face.zoo.firstEggRule}.',
              key: const ValueKey('daemon-panel-progress'),
              style: _ink(),
            ),
          ),
        ],
      ),
      if (egg == null && here >= need) ...[
        const SizedBox(height: 8),
        Text(
          'all of it can happen on this computer.',
          key: const ValueKey('daemon-panel-here'),
          style: _ink(_muted),
        ),
      ],
      const SizedBox(height: 16),
      for (final habit in habits)
        if (!daemonHabitsElsewhere.contains(habit.key)) _habitRow(habit, done),
      Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Text(
          'with another computer or device (never needed):',
          key: const ValueKey('daemon-panel-elsewhere'),
          style: _ink(_muted),
        ),
      ),
      for (final habit in habits)
        if (daemonHabitsElsewhere.contains(habit.key)) _habitRow(habit, done),
      const SizedBox(height: 16),
      Row(
        children: [
          Expanded(
            child: Text(
              egg != null ? 'enter hatches' : 'j/k move · enter opens',
              style: _ink(_muted),
            ),
          ),
          if (egg != null) _action('hatch', 'Hatch', () => widget.onHatch(egg)),
        ],
      ),
    ];
  }

  Widget _habitRow(DaemonHabit habit, Set<String> done) {
    final complete = done.contains(habit.key);
    final command = daemonHabitCommands[habit.key];
    final elsewhere = daemonHabitsElsewhere.contains(habit.key);
    // Days show their count where other habits show their shortcut.
    final hint = habit.key == 'days'
        ? '${face.zoo.daysUsed.clamp(0, 3)}/3'
        : command == null
        ? null
        : widget.shortcut(command);
    final row = LayoutBuilder(
      builder: (context, constraints) => Row(
        children: [
          Icon(
            complete ? AppIcons.circleCheck : AppIcons.circle,
            size: 18,
            color: complete ? DesktopChrome.accent : _muted,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text.rich(
              TextSpan(
                children: [
                  TextSpan(text: habit.label),
                  // The first egg cannot come without it (`firstEgg.require`).
                  if (!complete &&
                      roster.rules.firstEggRequire.contains(habit.key))
                    TextSpan(text: '  needed', style: _ink(_muted)),
                ],
              ),
              style: _ink(complete || elsewhere ? _muted : null),
            ),
          ),
          if (hint != null &&
              !complete &&
              constraints.maxWidth >= _cell.width * 36) ...[
            const SizedBox(width: 8),
            Text(hint, style: _ink(_muted)),
          ],
        ],
      ),
    );
    if (complete || command == null) {
      return ConstrainedBox(
        key: ValueKey('daemon-habit-${habit.key}'),
        constraints: const BoxConstraints(
          minHeight: DesktopChrome.controlHeight,
        ),
        child: row,
      );
    }
    return TextButton(
      key: ValueKey('daemon-habit-${habit.key}'),
      focusNode: _node('habit:${habit.key}'),
      onPressed: () => widget.onCommand(command),
      style: _buttonStyle,
      child: row,
    );
  }

  // ── after: four tabs ────────────────────────────────────────────────────────

  List<Widget> _daemon(List<String> order) {
    final paired = face.daemon ?? zoo.paired;
    final viewing = zoo.byUid(_viewing) ?? paired;
    final def = roster.byId(viewing?.id);
    if (viewing == null || def == null) return [_title('Daemon')];
    final pairedDef = roster.byId(paired?.id) ?? def;
    final pairedName = paired?.name ?? pairedDef.id;
    final tab = _tab;
    return [
      _title(
        tab == 'zoo'
            ? individualName(def.id, name: viewing.name, serial: viewing.serial)
            : paired?.name == null
            ? pairedDef.id
            : '$pairedName (${pairedDef.id})',
        badge: _autonomyBadge(),
      ),
      _tabBar(),
      const SizedBox(height: 16),
      ...switch (tab) {
        'zoo' => _zooTab(order, viewing, def),
        'lessons' => _lessonsTab(order, pairedName),
        'settings' => _settingsTab(order, pairedName),
        _ => _nowTab(order, pairedDef, pairedName),
      },
    ];
  }

  /// `[act on key]` beside the name whenever the daemon acts above
  /// `suggest`.
  Widget? _autonomyBadge() {
    final level = widget.brain?.autonomy;
    if (!daemonAutonomyAboveSuggest(level)) return null;
    return Tooltip(
      message: 'It acts on its own at this level. The floor still holds.',
      child: Text(
        daemonAutonomyLabel(level!),
        key: const ValueKey('daemon-panel-autonomy-badge'),
        style: _ink(),
      ),
    );
  }

  /// Its line now, and what is not there: yellow only when something needs
  /// you or failed.
  List<Widget> _lineRows(DaemonDef def, String name) {
    final mood = face.mood;
    final spoken = face.voice;
    final nick = face.voiceFromPair ? '$name: ' : '';
    final line = spoken != null
        ? '$nick$spoken'
        : '$name: ${face.currentLine(mood)}';
    final alert = spoken != null
        ? face.voiceAlert
        : mood == DaemonMood.need || mood == DaemonMood.fail;
    return [
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            face.glyph,
            semanticsLabel: '$name, ${DaemonFace.moodWords[mood]}',
            style:
                _artInk(
                  daemonColor(def, _theme, shiny: face.daemon?.shiny ?? false),
                ).copyWith(
                  backgroundColor: daemonBackdrop(def) ?? _theme.background,
                ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: Text(
                line,
                key: const ValueKey('daemon-panel-line'),
                style: _ink(alert ? DesktopChrome.foreground : _muted),
              ),
            ),
          ),
        ],
      ),
      // Asleep or out of reach is not a failure: said calmly, once.
      if (face.away.isNotEmpty) ...[
        const SizedBox(height: 8),
        Text(
          [
            for (final machine in face.away)
              daemonMachineLine(machine.name, machine.status),
          ].join('\n'),
          key: const ValueKey('daemon-panel-away'),
          style: _ink(_muted),
        ),
      ],
    ];
  }

  static String _stageWords(String stage) => switch (stage) {
    'p0' => 'whole',
    'p1' => 'cracking',
    'p2' => 'cracked',
    'p3' => 'splitting, light inside',
    _ => 'ready',
  };

  List<Widget> _nowTab(List<String> order, DaemonDef def, String name) => [
    ..._lineRows(def, name),
    if (_eggKinds.isNotEmpty) ...[
      const SizedBox(height: 8),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final kind in _eggKinds)
            () {
              order.add('egg:$kind');
              return _eggButton(kind);
            }(),
        ],
      ),
    ],
    // Nothing is watched until the person says so (and after a yes, the
    // second step, suggest, until it is answered).
    if (!face.zoo.isPreview && (!zoo.watching || _consentStep != null))
      ..._consentSection(order, name, inline: true),
    ..._pairNowSections(order, name),
  ];

  List<Widget> _zooTab(List<String> order, ZooDaemon viewing, DaemonDef def) {
    final isPair = viewing.uid == zoo.pair || zoo.pair == null;
    final mood = isPair ? face.mood : DaemonMood.idle;
    final colour = daemonColor(def, _theme, shiny: viewing.shiny);
    final backdrop = daemonBackdrop(def);
    final name = individualName(
      def.id,
      name: viewing.name,
      serial: viewing.serial,
    );
    final traits = face.zoo.traitsOf(viewing);
    final plates = face.plates;
    // Its own plates, once harnessd has drawn them; the species plate in its
    // colour family until then.
    final art = plates?.art(viewing, PlateSize.portrait, viewing.version, mood);
    final cardArt = plates?.art(
      viewing,
      PlateSize.portrait,
      viewing.version,
      DaemonMood.idle,
    );
    final portraitRows =
        cardArt?.frames.first.rows.length ??
        cardPortrait(roster, def, viewing.version).length;
    // The portrait's ground, and the card's: faint glyphs mix from it.
    final ground =
        backdrop ?? Color.lerp(_theme.background, _theme.foreground, .03)!;
    final card = zooCardLines(
      roster,
      def,
      version: viewing.version,
      shiny: viewing.shiny,
      name: viewing.name,
      traits: traits,
      hatched: viewing.hatched,
      egg: viewing.egg,
      serial: viewing.serial,
      plate: cardArt?.frames.first.rows,
    );
    final cardGround = Color.lerp(_theme.background, _theme.foreground, .03)!;
    final flags = traits != null && traits.seed != 0 && def.traits != null
        ? individualFlags(roster, def.id, traits)
        : null;
    if (!isPair) order.add('pair');
    order
      ..add('rename')
      ..add('card')
      ..add('details')
      ..add('gallery');
    if (_showCard) order.add('copy');
    for (final d in _shelfOrder) {
      if (zoo.owns(d.id)) order.add('zoo:${d.id}');
    }
    final individuals = zoo.daemons.length > 1
        ? _individualRows(order, viewing)
        : const <Widget>[];
    final eggs = _eggPlates(order);
    return [
      Text(
        '${_speciesName(def.id)} · ${_growthStage(viewing.version)}'
        '${viewing.shiny ? ' · Shiny' : ''}',
        key: const ValueKey('daemon-panel-identity'),
        style: _ink(),
      ),
      Text(
        isPair ? 'Your tab-bar companion' : 'In your collection',
        style: _ink(_muted),
      ),
      SizedBox(height: _cell.height / 2),
      if (_showCard)
        Container(
          width: double.infinity,
          color: cardGround,
          alignment: Alignment.center,
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: DaemonCardText(
              key: const ValueKey('daemon-card-text'),
              lines: card,
              illustration: IllustratedArt.supports(def.id)
                  ? IllustratedArt.daemon(
                      def.id,
                      version: viewing.version,
                      traits: traits,
                    )
                  : null,
              portraitRows: portraitRows,
              style: _artInk(),
              colour: colour,
              backdrop: backdrop,
              mats: cardArt?.frames.first.mats,
              plate:
                  daemonIndividualInk(
                    roster,
                    def,
                    traits,
                    _theme,
                    shiny: viewing.shiny,
                    background: cardGround,
                  ) ??
                  daemonPlateInk(
                    roster,
                    def,
                    _theme,
                    shiny: viewing.shiny,
                    background: cardGround,
                  ),
            ),
          ),
        )
      else
        Container(
          width: double.infinity,
          color: ground,
          padding: EdgeInsets.symmetric(vertical: _cell.height / 2),
          alignment: Alignment.center,
          child: SizedBox(
            height: IllustratedArt.supports(def.id)
                ? switch (viewing.version) {
                    '0.1' => 164.0,
                    '1.0' => 204.0,
                    _ => 240.0,
                  }
                : null,
            child: OverflowBox(
              minHeight: IllustratedArt.supports(def.id) ? 240 : null,
              maxHeight: IllustratedArt.supports(def.id) ? 240 : null,
              fit: OverflowBoxFit.deferToChild,
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: DaemonPortrait(
                  roster: roster,
                  def: def,
                  version: viewing.version,
                  style: _artInk().copyWith(height: 1.15),
                  theme: _theme,
                  mood: mood,
                  shiny: viewing.shiny,
                  background: ground,
                  traits: traits,
                  art: art,
                  // The plate loops its mood (idle by default) while the face
                  // may move; the line portrait's parts step with agent events.
                  animate: face.motionEnabled,
                  t: isPair ? face.portraitT : 0,
                  lid: isPair ? face.lid : null,
                  motion: isPair && face.motionEnabled,
                  textKey: const ValueKey('daemon-portrait'),
                  semanticsLabel:
                      '$name ${viewing.version}, ${DaemonFace.moodWords[mood]}',
                ),
              ),
            ),
          ),
        ),
      SizedBox(height: _cell.height / 2),
      Text(
        _bondLine(viewing),
        key: const ValueKey('daemon-panel-bond'),
        style: _ink(_muted),
      ),
      SizedBox(height: _cell.height / 2),
      if (_renaming) ...[
        TextField(
          key: const ValueKey('daemon-name-input'),
          controller: _name,
          focusNode: _nameFocus,
          maxLength: 24,
          style: _ink(),
          cursorColor: DesktopChrome.accent,
          decoration: InputDecoration(
            labelText: 'Name',
            counterText: '',
            errorText: _nameError,
            errorStyle: _ink(Theme.of(context).colorScheme.error),
          ),
          onSubmitted: (_) => _rename(viewing),
        ),
        Text('enter saves · empty clears · esc cancels', style: _ink(_muted)),
      ] else
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (!isPair)
              _action('pair', 'Choose companion', () {
                face.zoo.pair(viewing.uid);
                setState(() => _viewing = null);
              }, tooltip: 'Put $name in your status line'),
            _action('rename', 'Rename', () => _beginRename(viewing)),
            _action(
              'card',
              _showCard ? 'Portrait' : 'Card',
              () => setState(() {
                _showCard = !_showCard;
                _copyNote = null;
              }),
              tooltip: IllustratedArt.supports(def.id)
                  ? 'Show ${_speciesName(def.id)}’s card'
                  : 'The card people share, as a code block',
            ),
            _action(
              'details',
              _showDetails ? 'Hide details' : 'Details',
              () => setState(() => _showDetails = !_showDetails),
            ),
            if (_showCard)
              _action(
                'copy',
                'Copy',
                () => _copy(
                  card,
                  illustratedRows: IllustratedArt.supports(def.id)
                      ? portraitRows
                      : null,
                ),
                tooltip: IllustratedArt.supports(def.id)
                    ? 'Copy ${_speciesName(def.id)}’s details'
                    : 'Copy the card as a fenced code block',
              ),
          ],
        ),
      if (_copyNote != null) Text(_copyNote!, style: _ink(_muted)),
      if (_showDetails) ...[
        SizedBox(height: _cell.height),
        Text(def.lore, key: const ValueKey('daemon-panel-lore'), style: _ink()),
        SizedBox(height: _cell.height / 2),
        Text(
          '${cardNumber(roster, def)} · ${def.rarity} · v${viewing.version}',
          style: _ink(_muted),
        ),
        if (flags != null)
          Text(
            '$flags\n${oneInText(oneIn(roster, def.id, traits!))}',
            key: const ValueKey('daemon-panel-flags'),
            style: _ink(_muted),
          ),
        Text(
          def.familyYears.isEmpty
              ? def.familyLine
              : '${def.familyLine}\n${def.familyYears}',
          key: const ValueKey('daemon-panel-family'),
          style: _ink(_muted),
        ),
      ],
      SizedBox(height: _cell.height),
      _action('gallery', 'Browse artwork', () {
        setState(() => _showGallery = true);
        if (_scroll.hasClients) _scroll.jumpTo(0);
      }),
      SizedBox(height: _cell.height / 2),
      ..._shelf(viewing.id),
      const SizedBox(height: 8),
      ...individuals,
      const SizedBox(height: 8),
      ...eggs,
      const SizedBox(height: 8),
      ..._meters(),
    ];
  }

  // ── the zoo: individuals by species, and what each species has shown ──────

  /// Every individual you have, grouped by species in the drop's order: a
  /// species line with how many, the traits seen among them (colours,
  /// markings and extras, of how many there are), then one row each: its
  /// name, version and whether it is paired, its flags and `1 in N`.
  List<Widget> _individualRows(List<String> order, ZooDaemon viewing) {
    final species = [
      for (final d in _shelfOrder)
        if (zoo.owns(d.id)) d,
      // Anything owned but not on a shelf that shows (a drop since held).
      for (final d in roster.daemons)
        if (zoo.owns(d.id) && !_shelfOrder.contains(d)) d,
    ];
    if (species.isEmpty) return const [];
    final out = <Widget>[
      Text(
        'individuals · ${zoo.daemons.length}',
        key: const ValueKey('daemon-panel-individuals'),
        style: _ink(_muted),
      ),
    ];
    for (final def in species) {
      final all = zoo.ofSpecies(def.id);
      out
        ..add(const SizedBox(height: 8))
        ..add(
          Text(
            '${cardNumber(roster, def).split('/').first} ${def.id}'
            '  x${all.length}',
            key: ValueKey('daemon-species-${def.id}'),
            style: DesktopChrome.control(medium: true),
          ),
        );
      final log = _traitLog(def, all);
      if (log != null) {
        out.add(
          Text(
            log,
            key: ValueKey('daemon-traitlog-${def.id}'),
            style: _ink(_muted),
          ),
        );
      }
      for (final d in all) {
        order.add('who:${d.uid}');
        out.add(_individualRow(d, def, selected: d.uid == viewing.uid));
      }
    }
    return out;
  }

  /// The traits seen among [all] of species [def], of how many there are:
  /// `  colours 2/6 magenta coral`, `  marks 1/4 spots`, `  extras 0/3`.
  String? _traitLog(DaemonDef def, List<ZooDaemon> all) {
    final t = def.traits;
    if (t == null) return null;
    final rolled = [for (final d in all) ?face.zoo.traitsOf(d)];
    List<String> seen(Iterable<String?> names, Iterable<String?> order) {
      final have = {...names.whereType<String>()};
      return [
        for (final n in order)
          if (n != null && have.contains(n)) n,
      ];
    }

    final colours = seen(
      rolled.map((r) => r.colour),
      t.colours.map((c) => c.name),
    );
    final marks = seen(rolled.map((r) => r.marks), t.marks.map((m) => m.$1));
    final extras = seen(
      rolled.map((r) => r.extra),
      t.extras.map((e) => e.name),
    );
    String line(String label, List<String> names, int of) =>
        '  ${label.padRight(8)}${'${names.length}/$of'.padRight(5)} '
                '${names.join(' ')}'
            .trimRight();
    return [
      line('colours', colours, t.colours.length),
      line('marks', marks, t.marks.where((m) => m.$1 != null).length),
      line('extras', extras, t.extras.where((e) => e.name != null).length),
    ].join('\n');
  }

  /// One individual: `* pip the tim 1.0 · paired`, then `  -c coral --spots
  /// · 1 in 644`. Enter or a click shows it above.
  Widget _individualRow(ZooDaemon d, DaemonDef def, {required bool selected}) {
    final traits = face.zoo.traitsOf(d);
    final paired = d.uid == zoo.pair;
    final flags = traits != null && traits.seed != 0 && def.traits != null
        ? individualFlags(roster, def.id, traits)
        : null;
    final rest = flags == null
        ? null
        : '  ${flags.substring(flags.indexOf(' ') + 1)}'
              ' · ${oneInText(oneIn(roster, def.id, traits!))}';
    return TextButton(
      key: ValueKey('daemon-who-${d.uid}'),
      focusNode: _node('who:${d.uid}'),
      onPressed: () => setState(() => _viewing = d.uid),
      style: _buttonStyle.copyWith(
        fixedSize: const WidgetStatePropertyAll(null),
        backgroundColor: WidgetStatePropertyAll(
          selected ? DesktopChrome.selection : null,
        ),
      ),
      child: Text(
        '${d.shiny ? '*' : ' '} '
        '${individualName(def.id, name: d.name, serial: d.serial)} '
        '${d.version}${paired ? ' · paired' : ''}'
        '${rest == null ? '' : '\n$rest'}',
        style: _ink(),
      ),
    );
  }

  // ── eggs: each being earned at its stage, each waiting ready ─────────────

  /// Every egg as a small filled plate: the ones waiting to be opened
  /// (`p4`, a click hatches), then each being earned, cracked as far as it
  /// has come, with how far (`turn 12/40`).
  List<Widget> _eggPlates(List<String> order) {
    final waiting = [
      for (final kind in _eggKinds)
        (kind, zoo.eggs.where((e) => e.kind == kind).toList()),
    ];
    final earning = face.zoo.eggsBeingEarned;
    if (waiting.isEmpty && earning.isEmpty) return const [];
    Widget plate(String kind, String stage, String label, {Key? key}) => Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: _cell.width * 9,
          height: _cell.height * 3.4,
          child: FittedBox(
            fit: BoxFit.contain,
            child: ColoredBox(
              color: _theme.background,
              child: DaemonEggPlate(
                roster: roster,
                kind: kind,
                stage: stage,
                style: _artInk().copyWith(height: 1.0),
                theme: _theme,
                animate: face.motionEnabled,
                textKey: key,
                semanticsLabel: '${eggName(kind)}, $label',
              ),
            ),
          ),
        ),
        Text(label, style: _ink(_muted), maxLines: 1),
      ],
    );
    return [
      Text(
        'eggs',
        key: const ValueKey('daemon-panel-eggs'),
        style: _ink(_muted),
      ),
      const SizedBox(height: 4),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final (kind, eggs) in waiting)
            () {
              order.add('egg:$kind');
              return Tooltip(
                message: 'Open a ${eggName(kind)} (${eggs.length} waiting)',
                child: TextButton(
                  key: ValueKey('daemon-egg:$kind'),
                  focusNode: _node('egg:$kind'),
                  onPressed: () => widget.onHatch(eggs.first),
                  style: _buttonStyle.copyWith(
                    fixedSize: const WidgetStatePropertyAll(null),
                  ),
                  child: plate(
                    kind,
                    'p4',
                    '$kind x${eggs.length}',
                    key: ValueKey('daemon-egg-plate-$kind-ready'),
                  ),
                ),
              );
            }(),
          for (final e in earning)
            plate(
              e.kind,
              e.stage,
              '${e.kind} ${e.done}/${e.need}',
              key: ValueKey('daemon-egg-plate-${e.kind}'),
            ),
        ],
      ),
    ];
  }

  /// Quiet, motion and nap; then (with a pair brain) the dial, the rules
  /// file and consent.
  List<Widget> _settingsTab(List<String> order, String name) {
    order
      ..add('quiet')
      ..add('motion')
      ..add('nap');
    return [
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          _action(
            'quiet',
            face.quiet ? 'Quiet on' : 'Quiet off',
            () => face.settings.quiet = !face.quiet,
            tooltip: face.quiet
                ? 'It says nothing until you turn this off.'
                : 'Say nothing in the status line until turned off.',
          ),
          _action(
            'motion',
            face.settings.motion ? 'Motion on' : 'Motion off',
            () => face.settings.motion = !face.settings.motion,
            tooltip: face.settings.motion
                ? 'Work frames step with agent events; blinks answer you.'
                : 'Nothing moves. The face still changes with the mood.',
          ),
          _action(
            'nap',
            face.napping ? 'Wake' : 'Nap',
            face.napping ? face.wake : face.nap,
            tooltip: face.napping
                ? 'Wake $name'
                : 'Nap for 15 minutes. A harness needing you wakes it.',
          ),
        ],
      ),
      if (!face.zoo.isPreview) ...[
        ..._autonomySection(order, name),
        ..._consentSection(order, name),
      ],
    ];
  }

  bool _showCard = false;
  String? _copyNote;

  Future<void> _copy(List<String> card, {int? illustratedRows}) async {
    try {
      await Clipboard.setData(
        ClipboardData(
          text: illustratedRows == null
              ? cardCodeBlock(card)
              : illustratedCardDetails(card, illustratedRows),
        ),
      );
      if (mounted) {
        setState(
          () => _copyNote = illustratedRows == null
              ? 'Copied as a code block.'
              : 'Details copied.',
        );
      }
    } catch (_) {
      if (mounted) setState(() => _copyNote = 'Could not copy.');
    }
  }

  /// `bond 2 · 160/300 xp`: levels come from counted turns (README,
  /// "Earning eggs and growing"); the version follows the level.
  String _bondLine(ZooDaemon daemon) {
    final levels = roster.rules.bondLevels;
    final next = daemon.bond + 1 < levels.length
        ? levels[daemon.bond + 1]
        : null;
    return next == null
        ? 'Bond level ${daemon.bond} · ${daemon.xp} XP'
        : 'Bond level ${daemon.bond} · ${daemon.xp} of $next XP';
  }

  // ── the zoo: a box back ─────────────────────────────────────────────────────

  /// The drops that show (README, "Drops"): released ones as box backs, an
  /// announced one as silhouettes and its date. A drop on hold, or not yet
  /// announced, shows nowhere: no shelf, no silhouettes, no count.
  DateTime get _now => (widget.now ?? DateTime.now)();

  List<DaemonDrop> get _shelfDrops => roster.shownDrops(_now);

  /// A drop's numbered slots in order, then its secrets.
  List<DaemonDef> _dropOrder(String drop) => [
    for (final d in roster.daemons)
      if (d.drop == drop && !d.secret) d,
    for (final d in roster.daemons)
      if (d.drop == drop && d.secret) d,
  ];

  /// Every slot that can be chosen: the released drops' daemons.
  List<DaemonDef> get _shelfOrder => [
    for (final drop in _shelfDrops)
      if (drop.releasedAt(_now)) ..._dropOrder(drop.id),
  ];

  double get _shelfWidth =>
      max(120 * appTextScaleOf(context), _cell.width * 10);

  static String _speciesName(String id) =>
      id == 'gnu' ? 'GNU' : '${id[0].toUpperCase()}${id.substring(1)}';

  static String _growthStage(String version) => switch (version) {
    '1.0' => 'Young',
    '2.0' => 'Adult',
    _ => 'Hatchling',
  };

  /// Like the back of a blind box: `#01`…`#09` and `#S`, each owned one as
  /// its sprite at its version in its colour (`x2` for a duplicate), each
  /// empty one `[ ? ]`, a secret `[ ! ]`. A drop announced but not out yet
  /// shows its regulars as `#` silhouettes and the day it comes out.
  List<Widget> _shelf(String viewing) {
    final now = _now;
    return [
      for (final (n, drop) in _shelfDrops.indexed) ...[
        if (n > 0) const SizedBox(height: 8),
        ..._dropShelf(drop, viewing, announced: !drop.releasedAt(now)),
      ],
    ];
  }

  List<Widget> _dropShelf(
    DaemonDrop drop,
    String viewing, {
    required bool announced,
  }) {
    final order = _dropOrder(drop.id);
    final regulars = order.where((d) => !d.secret).toList();
    final have = regulars.where((d) => zoo.owns(d.id)).length;
    final secret = order.any((d) => d.secret && zoo.owns(d.id));
    final first = _shelfDrops.first == drop;
    return [
      Text(
        'Collection · '
        '${announced ? 'Arrives ${drop.release}' : '$have of ${regulars.length} discovered'}'
        '${!announced && secret ? ' + secret' : ''}',
        key: ValueKey(
          first ? 'daemon-panel-zoo' : 'daemon-panel-zoo-${drop.id}',
        ),
        style: _ink(_muted),
      ),
      const SizedBox(height: 8),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final d in order) announced ? _teaser(d) : _slot(d, viewing),
        ],
      ),
    ];
  }

  /// A daemon of a drop announced but not out: its 0.1 sprite as `#`, faint
  /// (a secret stays `[ ! ]`).
  Widget _teaser(DaemonDef d) {
    final faint = _muted;
    return SizedBox(
      width: _shelfWidth,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(cardNumber(roster, d).split('/').first, style: _ink(faint)),
          if (IllustratedArt.supports(d.id) && !d.secret)
            DaemonIllustration(
              key: ValueKey('daemon-zoo-${d.id}'),
              art: IllustratedArt.daemon(d.id),
              size: _cell.height,
              silhouette: faint,
              semanticsLabel: 'Not out yet',
            )
          else
            Text(
              d.secret
                  ? '[ ! ]'
                  : silhouette(
                      renderSprite(
                        roster,
                        d,
                        0,
                        DaemonMood.idle,
                        motion: false,
                      ),
                    ),
              key: ValueKey('daemon-zoo-${d.id}'),
              semanticsLabel: d.secret ? 'A secret' : 'Not out yet',
              style: _artInk(faint)
                  .copyWith(backgroundColor: _theme.background),
            ),
          Text('', style: _ink()),
        ],
      ),
    );
  }

  Widget _slot(DaemonDef d, String viewing) {
    final owned = zoo.daemons.where((z) => z.id == d.id).toList();
    final number = cardNumber(roster, d).split('/').first;
    final faint = _muted;
    Widget cell(List<Widget> rows) => SizedBox(
      width: _shelfWidth,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: rows,
      ),
    );
    if (owned.isEmpty) {
      return Tooltip(
        message: d.secret ? 'A secret. Not yet hatched.' : 'Not yet hatched',
        child: cell([
          Text(number, style: _ink(faint)),
          Text(
            d.secret ? '[ ! ]' : '[ ? ]',
            key: ValueKey('daemon-zoo-${d.id}'),
            semanticsLabel: d.secret ? 'A secret' : 'Not yet hatched',
            style: _artInk(_theme.foreground.withValues(alpha: .35))
                .copyWith(backgroundColor: _theme.background),
          ),
          Text('', style: _ink()),
        ]),
      );
    }
    // The paired one of this species when it is, else the first hatched.
    final first =
        owned.where((z) => z.uid == zoo.pair).firstOrNull ?? owned.first;
    final count = owned.length;
    final selected = d.id == viewing;
    final sprite = renderSprite(
      roster,
      d,
      roster.versionIndex(first.version),
      DaemonMood.idle,
      motion: false,
    );
    final backdrop = daemonBackdrop(d);
    return Tooltip(
      message:
          '${individualName(d.id, name: first.name, serial: first.serial)} '
          '${first.version}'
          '${count > 1 ? ' · x$count' : ''}'
          '${first.uid == zoo.pair ? ' · paired' : ''}',
      child: SizedBox(
        width: _shelfWidth,
        child: TextButton(
          key: ValueKey('daemon-zoo-${d.id}'),
          focusNode: _node('zoo:${d.id}'),
          onPressed: () => setState(() => _viewing = first.uid),
          style: _buttonStyle.copyWith(
            backgroundColor: WidgetStatePropertyAll(
              selected ? DesktopChrome.selection : null,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('$number ${_speciesName(d.id)}', style: _ink()),
              SizedBox(
                height: _cell.height * 2,
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: IllustratedArt.supports(d.id)
                      ? DaemonIllustration(
                          art: IllustratedArt.daemon(
                            d.id,
                            version: first.version,
                            traits: face.zoo.traitsOf(first),
                          ),
                          size: _cell.height * 2,
                          semanticsLabel:
                              '${_speciesName(d.id)} ${_growthStage(first.version)}',
                        )
                      : Text(
                          '${first.shiny ? '*' : ''}$sprite',
                          semanticsLabel:
                              '${d.id} ${_growthStage(first.version)}',
                          style: _artInk(
                            daemonColor(d, _theme, shiny: first.shiny),
                          ).copyWith(backgroundColor: backdrop),
                        ),
                ),
              ),
              Text(
                '${_growthStage(first.version)}${count > 1 ? ' ×$count' : ''}',
                style: _ink(_muted),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Today's counted turns against the daily cap (the eggs show how far
  /// each has come), and the setup egg's habits until it has come.
  List<Widget> _meters() {
    final earn = roster.rules.earn;
    final progress = zoo.progress;
    final into = progress.turns % earn.turnEvery;
    final today = progress.days[localDayOf(DateTime.now())] ?? 0;
    Widget meter(String label, int value, int of) => Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('$label · $value/$of', style: _ink(_muted)),
          const SizedBox(height: 8),
          LinearProgressIndicator(
            value: of <= 0 ? 0 : (value / of).clamp(0.0, 1.0),
            minHeight: 4,
            borderRadius: BorderRadius.circular(2),
            color: DesktopChrome.accent,
            backgroundColor: DesktopChrome.rim,
            semanticsLabel: '$label, $value of $of',
          ),
        ],
      ),
    );
    // The setup egg: habits toward it, until it has come.
    final setup = zoo.firstEgg ? face.zoo.setupProgress : null;
    return [
      Semantics(
        key: const ValueKey('daemon-panel-progress'),
        label:
            '${earn.turnEvery - into} counted turns to the next egg. '
            '$today of ${earn.dailyCap} turns counted today.',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            meter('Today', today.clamp(0, earn.dailyCap), earn.dailyCap),
            if (setup != null) meter('Setup egg', setup.$1, setup.$2),
            if (today >= earn.dailyCap)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  "Today's turns are counted. More tomorrow.",
                  style: _ink(_muted),
                ),
              ),
          ],
        ),
      ),
    ];
  }

  // ── eggs waiting: one look per kind, with a count ───────────────────────────

  List<String> get _eggKinds => [
    for (final egg in zoo.eggs)
      if (!zoo.eggs.takeWhile((e) => e != egg).any((e) => e.kind == egg.kind))
        egg.kind,
  ];

  Widget _eggButton(String kind) {
    final eggs = zoo.eggs.where((e) => e.kind == kind).toList();
    return _action(
      'egg:$kind',
      'Hatch ${eggName(kind)} · ${eggs.length} waiting',
      () => widget.onHatch(eggs.first),
      tooltip: 'Open a ${eggName(kind)} (${eggs.length} waiting)',
    );
  }
}

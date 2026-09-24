import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import 'box_chrome.dart';
import 'search_result_text.dart';
import 'swarm_search_input.dart';
import 'swarm_switcher.dart' show SwarmSearchActionLabel, swarmSearchRowHeight;

/// One agent New Harness can create: a coding engine or a domain harness.
class AgentChoice {
  const AgentChoice({
    required this.id,
    required this.label,
    required this.mark,
    this.detail,
    this.creator,
    this.keywords,
    this.description,
  });

  /// `claude`, or `owner/name` for a harness.
  final String id;
  final String label;

  /// The line under the name: what it is, in the project's own words —
  /// "Advanced physics simulation".
  final String? detail;

  /// Who makes it — "Google DeepMind" — beside the name, quieter than it.
  final String? creator;

  /// More words the search matches but no row draws — the Store's shelf and
  /// the package's own domain, so "media" and "documents" both find Typst.
  final String? keywords;

  /// A sentence or two for the preview.
  final String? description;

  /// The agent's mark at [size].
  final Widget Function(double size) mark;
}

/// The Agent section of New Harness: one big search bar, at the top of the
/// form.
///
/// The catalog is past thirty agents, and a row of tiles fronted by a More
/// menu hid the harnesses the Store exists for. So the section is a search
/// bar, built like the New Tab search and Open Harness (owner, 2026-09-17:
/// "get rid of that line claude code codex etc and replace it with the
/// search bar… click on it shows the recent agents you use").
///
/// Closed, the box names the chosen agent and nothing else; the dialog's
/// "Agent." line above it says what it is for. Clicking it, or typing,
/// Return or an arrow key while it has focus, opens a panel in its place:
/// the search input, the agents you used most recently — or everything the
/// query names — and a preview of the highlighted one. The panel floats over
/// the sections under it, so the dialog never reflows; nothing in it leaves
/// the dialog.
class AgentPicker extends StatefulWidget {
  const AgentPicker({
    super.key,
    required this.value,
    required this.choices,
    required this.onChanged,
    this.recent,
    this.installed = const {},
    this.statusOf,
    this.focusNode,
    this.height = 64,
    this.width,
    this.terminalStyle = false,
    this.label = 'Agent',
  });

  final String value;
  final List<AgentChoice> choices;
  final ValueChanged<String> onChanged;

  /// Agents used lately, most recent first. Ids that are not in [choices]
  /// are skipped. Asked each time the list is built rather than passed as a
  /// list, so what the preference loaded after the dialog last rebuilt — the
  /// first New Harness after launch — is still in it.
  final List<String> Function()? recent;

  /// What the chosen machine has. Listed, with nothing typed, after [recent].
  final Set<String> installed;

  /// A line for the preview about [id] on the chosen machine — "Installed on
  /// M2" — or null when nothing is known.
  final String? Function(String id)? statusOf;

  /// The bar's focus, for a dialog that puts it there when it opens.
  final FocusNode? focusNode;

  /// The bar's height, and the search input's inside the open panel. New
  /// Harness gives it a tile's, so the bar sits in proportion with the rows
  /// of tiles under it.
  final double height;

  /// The width the section is laid out at. Passed in by the dialog, which has
  /// already measured it, rather than read from a LayoutBuilder here: a
  /// LayoutBuilder builds its children during layout, after the rest of the
  /// dialog, and Flutter orders Tab by when a focus node attached.
  final double? width;
  final bool terminalStyle;
  final String label;

  /// What the search input says before anything is typed.
  static const hint = 'Choose an agent for what you’d like to make';

  /// With nothing typed, the list holds this many agents at most.
  static const recentLength = 6;

  /// The engines that fill the list while there is nothing of your own on it.
  static const quickAgents = ['claude', 'codex', 'opencode'];

  /// The bar's and the panel's corner.
  static const radius = 24.0;

  @override
  State<AgentPicker> createState() => _AgentPickerState();
}

class _AgentPickerState extends State<AgentPicker> {
  String get _hint =>
      widget.label == 'Agent' ? AgentPicker.hint : 'Search harnesses';
  final _portal = OverlayPortalController();
  final _query = TextEditingController();
  final _inputFocus = FocusNode(debugLabel: 'Agent search input');
  final _ownBarFocus = FocusNode(debugLabel: 'Agent search');
  final _scroll = ScrollController();
  final _previewScroll = ScrollController();
  final _pointer = BoxPointerGate();
  bool _previewVisible = false;

  /// The search input and everything in the panel are one tap region. On a
  /// desktop, a mouse press outside a text field's region unfocuses it, and
  /// an unfocused input closes the panel — before the press on a row could
  /// become a click and choose it.
  final _tapGroup = Object();
  FocusNode get _barFocus => widget.focusNode ?? _ownBarFocus;

  int _cursor = 0;

  bool get _open => _portal.isShowing;
  String get _needle => _query.text.trim().toLowerCase();

  /// The type in the bar and the panel's input, grown with the bar.
  double get _fontSize => widget.terminalStyle
      ? 13
      : widget.height >= 88
      ? 20
      : 17;
  double get _radius => widget.terminalStyle ? 2 : AgentPicker.radius;

  @override
  void initState() {
    super.initState();
    _inputFocus.addListener(_inputFocusChanged);
    _barFocus.addListener(_barFocusChanged);
  }

  @override
  void didUpdateWidget(covariant AgentPicker oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.focusNode != widget.focusNode) {
      (oldWidget.focusNode ?? _ownBarFocus).removeListener(_barFocusChanged);
      _barFocus.addListener(_barFocusChanged);
    }
  }

  @override
  void dispose() {
    _inputFocus.removeListener(_inputFocusChanged);
    _barFocus.removeListener(_barFocusChanged);
    _query.dispose();
    _inputFocus.dispose();
    _ownBarFocus.dispose();
    _scroll.dispose();
    _previewScroll.dispose();
    super.dispose();
  }

  void _barFocusChanged() {
    if (mounted) setState(() {});
  }

  /// Tab away, or focus taken anywhere else: the panel closes.
  void _inputFocusChanged() {
    if (!_inputFocus.hasFocus && _open) _close(refocus: false);
  }

  AgentChoice? _choice(String id) =>
      widget.choices.where((choice) => choice.id == id).firstOrNull;

  /// With nothing typed: the choice, then what you used, then what the
  /// machine has, then the familiar engines to fill the list.
  List<AgentChoice> get _recent {
    final ids = [
      widget.value,
      ...?widget.recent?.call(),
      for (final choice in widget.choices)
        if (choice.id.contains('/') && widget.installed.contains(choice.id))
          choice.id,
      for (final choice in widget.choices)
        if (!choice.id.contains('/') && widget.installed.contains(choice.id))
          choice.id,
      ...AgentPicker.quickAgents,
    ];
    final seen = <String>{};
    return [
      for (final id in ids)
        if (seen.add(id)) ?_choice(id),
    ].take(AgentPicker.recentLength).toList();
  }

  /// How well [choice] answers [needle]: by name first, then by id, then by
  /// the words under the name. Negative when it does not.
  static int _rank(AgentChoice choice, String needle) {
    final label = choice.label.toLowerCase();
    if (label.startsWith(needle)) return 0;
    if (label.contains(needle)) return 1;
    if (choice.id.toLowerCase().contains(needle)) return 2;
    if (choice.creator?.toLowerCase().contains(needle) ?? false) return 3;
    if ((choice.detail?.toLowerCase().contains(needle) ?? false) ||
        (choice.keywords?.toLowerCase().contains(needle) ?? false)) {
      return 4;
    }
    return -1;
  }

  /// Everything the query names, best answer first. Among equals a harness
  /// comes before an engine: the engines differ from each other by name
  /// alone, and a query that reaches them by their category reaches them all.
  List<AgentChoice> get _matches {
    final needle = _needle;
    final ranked = <(int, int, AgentChoice)>[];
    for (final (index, choice) in widget.choices.indexed) {
      final rank = _rank(choice, needle);
      if (rank >= 0) ranked.add((rank, index, choice));
    }
    ranked.sort((a, b) {
      if (a.$1 != b.$1) return a.$1.compareTo(b.$1);
      final aHarness = a.$3.id.contains('/');
      final bHarness = b.$3.id.contains('/');
      if (aHarness != bHarness) return aHarness ? -1 : 1;
      return a.$2.compareTo(b.$2);
    });
    return [for (final row in ranked) row.$3];
  }

  List<AgentChoice> get _rows => _needle.isEmpty ? _recent : _matches;

  void _show({String initial = ''}) {
    _query.value = TextEditingValue(
      text: initial,
      selection: TextSelection.collapsed(offset: initial.length),
    );
    _cursor = 0;
    if (_scroll.hasClients) _scroll.jumpTo(0);
    _portal.show();
    setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _open) _inputFocus.requestFocus();
    });
  }

  void _close({bool refocus = true}) {
    if (!_open) return;
    _portal.hide();
    _query.clear();
    setState(() {});
    if (refocus) _barFocus.requestFocus();
  }

  void _choose(AgentChoice choice) {
    _close();
    widget.onChanged(choice.id);
  }

  void _move(int delta) {
    final count = _rows.length;
    if (count == 0) return;
    setState(() => _cursor = (_cursor + delta) % count);
    _reveal();
  }

  void _accept() {
    final rows = _rows;
    if (rows.isEmpty) return;
    _choose(rows[_cursor.clamp(0, rows.length - 1)]);
  }

  bool _composing() {
    final value = _query.value;
    return value.composing.isValid && !value.composing.isCollapsed;
  }

  /// Keeps the highlighted row in view after the keyboard moves it.
  void _reveal() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final rowHeight = _rowHeight(MediaQuery.textScalerOf(context));
      final top = 8 + _cursor * rowHeight;
      final bottom = top + rowHeight + 8;
      final position = _scroll.position;
      final offset = top - 8 < position.pixels
          ? top - 8
          : bottom > position.pixels + position.viewportDimension
          ? bottom - position.viewportDimension
          : position.pixels;
      final target = offset.clamp(0.0, position.maxScrollExtent);
      if (target != position.pixels) _scroll.jumpTo(target);
    });
  }

  double _rowHeight(TextScaler scaler) => widget.terminalStyle
      ? math.max(
          46,
          scaler.scale(grid.AppType.monoSize) * 1.35 +
              scaler.scale(grid.AppType.monoSize) * 1.35 +
              12,
        )
      : swarmSearchRowHeight(scaler, commands: false);

  /// The closed bar opens on the keys that start a search: Return, Space,
  /// an arrow, or the first letter of what you are looking for.
  KeyEventResult _barKeys(FocusNode _, KeyEvent event) {
    if (event is KeyUpEvent) return KeyEventResult.ignored;
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isMetaPressed ||
        keyboard.isControlPressed ||
        keyboard.isAltPressed) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter ||
        key == LogicalKeyboardKey.space ||
        key == LogicalKeyboardKey.arrowDown ||
        key == LogicalKeyboardKey.arrowUp) {
      _show();
      return KeyEventResult.handled;
    }
    final character = event.character;
    if (character != null &&
        character.length == 1 &&
        character.codeUnitAt(0) > 0x20 &&
        character.codeUnitAt(0) != 0x7f) {
      _show(initial: character);
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  /// The chosen agent's name: all the box says while it is closed. The
  /// section's line above it says what the box is for (owner, 2026-09-17:
  /// "in the search box, just the agent name").
  Widget _chosen(AgentChoice? choice) => KeyedSubtree(
    key: Key('new-agent-${widget.label.toLowerCase()}-choice'),
    child: Text(
      choice?.label ?? 'Choose an agent',
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: widget.terminalStyle
          ? boxMonoStyle()
          : grid.AppType.monoLabel(
              color: choice == null ? Colors.white60 : Colors.white,
            ),
    ),
  );

  Widget _bar(BuildContext context) {
    final choice = _choice(widget.value);
    final focused = _barFocus.hasFocus;
    return Focus(
      focusNode: _barFocus,
      onKeyEvent: _barKeys,
      child: Semantics(
        button: true,
        label: choice == null
            ? _hint
            : '${widget.label}: ${choice.label}. Search ${widget.label.toLowerCase()}s',
        excludeSemantics: true,
        child: Material(
          key: Key('new-agent-${widget.label.toLowerCase()}-field'),
          color: grid.AppPalette.swarmSearchSurface,
          surfaceTintColor: Colors.transparent,
          elevation: 2,
          shadowColor: Colors.black38,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(_radius),
            side: BorderSide(
              color: focused && !_open
                  ? grid.AppPalette.swarmAccent.withValues(alpha: .7)
                  : Colors.white.withValues(alpha: .10),
              width: focused && !_open ? 1.5 : 1,
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            canRequestFocus: false,
            mouseCursor: SystemMouseCursors.click,
            hoverColor: Colors.white.withValues(alpha: .03),
            onTap: () {
              _barFocus.requestFocus();
              _show();
            },
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: widget.height),
              child: Row(
                children: [
                  SizedBox(
                    width: widget.terminalStyle
                        ? 32
                        : _fontSize >= 20
                        ? 64
                        : 52,
                    child: widget.terminalStyle
                        ? Center(
                            child: Text(
                              '>',
                              style: boxMonoStyle(
                                color: grid.AppPalette.swarmAccent,
                              ),
                            ),
                          )
                        : Icon(
                            Icons.search,
                            size: _fontSize + 4,
                            color: Colors.white60,
                          ),
                  ),
                  Expanded(child: _chosen(choice)),
                  const Padding(
                    padding: EdgeInsets.only(left: 12, right: 22),
                    child: Icon(
                      Icons.keyboard_arrow_down,
                      size: 22,
                      color: Colors.white60,
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

  Widget _keys(BuildContext context, Widget child) {
    void run(VoidCallback action) {
      if (!_composing()) action();
    }

    if (KeymapTheme.of(context) != null) {
      return KeymapRegion(
        contextKind: KeymapContext.picker,
        composing: _composing,
        actions: {
          'picker.accept': () => run(_accept),
          'picker.add_here': () => run(_accept),
          'picker.next': () => run(() => _move(1)),
          'picker.previous': () => run(() => _move(-1)),
          'picker.cancel': () => run(_close),
          if (widget.terminalStyle)
            'picker.toggle_preview': () => run(_togglePreview),
          'picker.preview_page_down': () => run(() => _page(1)),
          'picker.preview_page_up': () => run(() => _page(-1)),
          // Tab is a picker command now (the box completes paths with it); a
          // matched key is consumed, so here it must still move the focus.
          'picker.complete': () =>
              run(() => FocusManager.instance.primaryFocus?.nextFocus()),
          'picker.complete_back': () =>
              run(() => FocusManager.instance.primaryFocus?.previousFocus()),
        },
        child: Actions(
          // The panel lives in an overlay, where EditableText's Escape would
          // reach no handler of its own; the keymap owns dismissal.
          actions: {
            DismissIntent: CallbackAction<DismissIntent>(onInvoke: (_) => null),
          },
          // The host gets first use of configured bindings. Any unbound
          // modified Enter still belongs to this picker, not to the form's
          // creation shortcut underneath it (including during composition).
          child: CallbackShortcuts(
            bindings: {
              for (final key in [
                LogicalKeyboardKey.enter,
                LogicalKeyboardKey.numpadEnter,
              ]) ...{
                SingleActivator(key, meta: true): () {},
                SingleActivator(key, control: true): () {},
              },
            },
            child: child,
          ),
        ),
      );
    }
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.enter): () => run(_accept),
        const SingleActivator(LogicalKeyboardKey.numpadEnter): () =>
            run(_accept),
        for (final key in [
          LogicalKeyboardKey.enter,
          LogicalKeyboardKey.numpadEnter,
        ]) ...{
          SingleActivator(key, meta: true): () => run(_accept),
          SingleActivator(key, control: true): () => run(_accept),
        },
        const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
            run(() => _move(1)),
        const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
            run(() => _move(-1)),
        const SingleActivator(LogicalKeyboardKey.keyN, control: true): () =>
            run(() => _move(1)),
        const SingleActivator(LogicalKeyboardKey.keyP, control: true): () =>
            run(() => _move(-1)),
        const SingleActivator(LogicalKeyboardKey.keyJ, control: true): () =>
            run(() => _move(1)),
        const SingleActivator(LogicalKeyboardKey.keyK, control: true): () =>
            run(() => _move(-1)),
        const SingleActivator(LogicalKeyboardKey.escape): () => run(_close),
        const SingleActivator(LogicalKeyboardKey.keyC, control: true): () =>
            run(_close),
        if (widget.terminalStyle)
          const SingleActivator(LogicalKeyboardKey.slash, control: true): () =>
              run(_togglePreview),
        const SingleActivator(LogicalKeyboardKey.pageDown): () =>
            run(() => _page(1)),
        const SingleActivator(LogicalKeyboardKey.pageUp): () =>
            run(() => _page(-1)),
      },
      child: child,
    );
  }

  void _togglePreview() => setState(() => _previewVisible = !_previewVisible);

  void _queryChanged(String _) {
    setState(() => _cursor = 0);
    if (_scroll.hasClients) _scroll.jumpTo(0);
  }

  void _page(int direction) {
    if (_previewScroll.hasClients) {
      final position = _previewScroll.position;
      _previewScroll.jumpTo(
        (position.pixels + direction * position.viewportDimension * .9).clamp(
          0.0,
          position.maxScrollExtent,
        ),
      );
    } else if (_scroll.hasClients) {
      final rows =
          (_scroll.position.viewportDimension /
                  _rowHeight(MediaQuery.textScalerOf(context)))
              .floor();
      _move(direction * math.max(1, rows));
    }
  }

  Widget _panel(BuildContext context, {required double width}) {
    final scaler = MediaQuery.textScalerOf(context);
    final rows = _rows;
    final cursor = rows.isEmpty ? 0 : _cursor.clamp(0, rows.length - 1);
    final rowHeight = _rowHeight(scaler);
    final empty = rows.isEmpty;
    final lines = empty ? 1 : rows.length;
    final listHeight =
        lines.clamp(widget.terminalStyle && !_previewVisible ? 1 : 4, 8) *
            rowHeight +
        16;
    final highlighted = empty ? null : rows[cursor];
    final showPreview =
        highlighted != null &&
        (widget.terminalStyle ? _previewVisible : width >= 760);
    final sideBySide = showPreview && width >= 760;
    final preview = showPreview
        ? _AgentPreview(
            key: ValueKey('new-agent-${widget.label.toLowerCase()}-preview'),
            choice: highlighted,
            status: widget.statusOf?.call(highlighted.id),
            current: highlighted.id == widget.value,
            controller: _previewScroll,
            terminalStyle: widget.terminalStyle,
          )
        : null;
    final results = ExcludeFocus(
      child: ListView.builder(
        key: ValueKey('new-agent-${widget.label.toLowerCase()}-list'),
        controller: _scroll,
        padding: const EdgeInsets.all(8),
        itemExtent: rowHeight,
        itemCount: lines,
        itemBuilder: (context, index) => empty
            ? Padding(
                key: Key(
                  'new-agent-${widget.label.toLowerCase()}-search-empty',
                ),
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    'No agents match “${_query.text.trim()}”.',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: grid.AppType.monoLabel(
                      fontWeight: FontWeight.w400,
                      color: Colors.white60,
                    ),
                  ),
                ),
              )
            : _row(rows[index], index, cursor, rowHeight, width),
      ),
    );
    return SizedBox(
      width: width,
      child: TextFieldTapRegion(
        groupId: _tapGroup,
        child: Material(
          key: Key('new-agent-${widget.label.toLowerCase()}-panel'),
          color: grid.AppPalette.swarmSearchSurface,
          surfaceTintColor: Colors.transparent,
          // Lifted off the dialog it covers, lightly: on the dialog's dark
          // field a deep shadow reads as a black outline around the panel.
          elevation: 4,
          shadowColor: Colors.black26,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(_radius),
            side: BorderSide(color: Colors.white.withValues(alpha: .10)),
          ),
          clipBehavior: Clip.antiAlias,
          child: DefaultTextStyle.merge(
            style: widget.terminalStyle ? boxMonoStyle() : const TextStyle(),
            child: _keys(
              context,
              Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Semantics(
                    label: 'Search ${widget.label.toLowerCase()}s',
                    child: ReadlineKeys(
                      controller: _query,
                      onChanged: _queryChanged,
                      child: SwarmSearchInput(
                        inputKey: Key(
                          'new-agent-${widget.label.toLowerCase()}-search',
                        ),
                        controller: _query,
                        focusNode: _inputFocus,
                        groupId: _tapGroup,
                        search: null,
                        onClose: _close,
                        onChanged: _queryChanged,
                        autofocus: false,
                        showClose: !widget.terminalStyle,
                        hintText: _hint,
                        rounded: !widget.terminalStyle,
                        prominent: !widget.terminalStyle,
                        prompt: widget.terminalStyle ? '>' : null,
                        height: widget.height,
                      ),
                    ),
                  ),
                  Flexible(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: SizedBox(
                        height: listHeight,
                        child: sideBySide
                            ? Row(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  Expanded(flex: 5, child: results),
                                  const SizedBox(width: 8),
                                  Expanded(flex: 5, child: preview!),
                                ],
                              )
                            : showPreview
                            ? Column(
                                children: [
                                  Expanded(flex: 11, child: results),
                                  Expanded(flex: 9, child: preview!),
                                ],
                              )
                            : results,
                      ),
                    ),
                  ),
                  if (widget.terminalStyle)
                    ExcludeFocus(
                      child: BoxHintStrip(
                        hints: [
                          BoxHint(
                            effectiveCommandHint(
                                  context,
                                  'picker.accept',
                                  contextKind: KeymapContext.picker,
                                ) ??
                                '',
                            'choose',
                            onTap: _accept,
                          ),
                          BoxHint(
                            effectiveCommandHint(
                                  context,
                                  'picker.toggle_preview',
                                  contextKind: KeymapContext.picker,
                                ) ??
                                '',
                            'preview',
                            onTap: _togglePreview,
                          ),
                          BoxHint(
                            effectiveCommandHint(
                                  context,
                                  'picker.cancel',
                                  contextKind: KeymapContext.picker,
                                ) ??
                                '',
                            'back',
                            onTap: _close,
                          ),
                        ],
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

  Widget _row(
    AgentChoice choice,
    int index,
    int cursor,
    double rowHeight,
    double panelWidth,
  ) {
    final scaler = MediaQuery.textScalerOf(context);
    final highlighted = index == cursor;
    final current = choice.id == widget.value;
    final needle = _needle;
    List<SearchFieldMatch> matches(String? text, {required bool title}) {
      if (needle.isEmpty || text == null) return const [];
      final field = text.toLowerCase();
      return field.contains(needle)
          ? [(field: field, term: needle, title: title)]
          : const [];
    }

    final compactAction =
        (panelWidth >= 760 ? panelWidth / 2 : panelWidth) <
        380 * scaler.scale(grid.AppType.monoSize) / grid.AppType.monoSize;
    return MouseRegion(
      onHover: (event) {
        if (_pointer.moved(event) && _cursor != index) {
          setState(() => _cursor = index);
        }
      },
      child: ListTile(
        key: ValueKey(
          'new-agent-${widget.label.toLowerCase()}-row-${choice.id}',
        ),
        minTileHeight: rowHeight,
        selected: highlighted,
        textColor: Colors.white,
        iconColor: Colors.white60,
        selectedColor: Colors.white,
        hoverColor: Colors.transparent,
        selectedTileColor: Colors.white.withValues(alpha: .055),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(widget.terminalStyle ? 0 : 12),
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12),
        leading: SizedBox(
          width: 24,
          child: Center(
            child: widget.terminalStyle
                ? Text(
                    highlighted ? '>' : ' ',
                    style: boxMonoStyle(color: grid.AppPalette.swarmAccent),
                  )
                : choice.mark(22),
          ),
        ),
        // "MuJoCo by Google DeepMind": the name first and bright, whose it is
        // after it and quiet.
        title: Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Flexible(
              child: SearchResultText(
                choice.label,
                matches: matches(choice.label, title: true),
                style: widget.terminalStyle
                    ? boxMonoStyle()
                    : grid.AppType.monoLabel(
                        fontWeight: FontWeight.w600,
                        color: Colors.white,
                      ),
              ),
            ),
            if (choice.creator case final creator?) ...[
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  'by $creator',
                  key: ValueKey(
                    'new-agent-${widget.label.toLowerCase()}-row-by-${choice.id}',
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: widget.terminalStyle
                      ? boxMonoStyle(color: kBoxFaint)
                      : grid.AppType.monoMeta(color: Colors.white54),
                ),
              ),
            ],
          ],
        ),
        subtitle: choice.detail == null
            ? null
            : SearchResultText(
                choice.detail!,
                matches: matches(choice.detail, title: false),
                style: widget.terminalStyle
                    ? boxMonoStyle(color: Colors.white60)
                    : grid.AppType.monoMeta(color: Colors.white60),
              ),
        trailing: widget.terminalStyle && highlighted
            ? Text('↵', style: boxMonoStyle(color: kBoxFaint))
            : highlighted
            ? ConstrainedBox(
                constraints: BoxConstraints(
                  maxWidth:
                      170 *
                      scaler.scale(grid.AppType.bodySize) /
                      grid.AppType.bodySize,
                ),
                child: TextButton(
                  key: ValueKey(
                    'new-agent-${widget.label.toLowerCase()}-row-action',
                  ),
                  onPressed: () => _choose(choice),
                  style: TextButton.styleFrom(foregroundColor: Colors.white),
                  child: SwarmSearchActionLabel(
                    current ? 'Keep agent' : 'Use agent',
                    compact: compactAction,
                  ),
                ),
              )
            : current
            ? const Icon(Icons.check, size: 16, color: Colors.white60)
            : null,
        onTap: () => _choose(choice),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return OverlayPortal.overlayChildLayoutBuilder(
      controller: _portal,
      overlayChildBuilder: (context, info) {
        // Read the current geometry during layout. A snapshot taken on open
        // leaves the panel outside the window after a resize or text scaling.
        final anchor = MatrixUtils.transformRect(
          info.childPaintTransform,
          Offset.zero & info.childSize,
        );
        final width = math.min(
          anchor.width,
          math.max(0.0, info.overlaySize.width - 16),
        );
        final left = math.max(
          8.0,
          math.min(anchor.left, info.overlaySize.width - width - 8),
        );
        final top = math.max(
          8.0,
          math.min(anchor.top, info.overlaySize.height - 180),
        );
        return Stack(
          children: [
            // A click anywhere the panel does not cover closes it, and lands on
            // nothing else: the sections under the panel are not the target.
            Positioned.fill(
              child: GestureDetector(
                key: Key('new-agent-${widget.label.toLowerCase()}-barrier'),
                behavior: HitTestBehavior.opaque,
                onTap: _close,
              ),
            ),
            Positioned(
              left: left,
              top: top,
              width: width,
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: math.max(0, info.overlaySize.height - top - 16),
                ),
                child: _panel(context, width: width),
              ),
            ),
          ],
        );
      },
      child: _bar(context),
    );
  }
}

/// What the highlighted row is, beside the list: the Open Harness preview's
/// shape, for an agent rather than a session.
class _AgentPreview extends StatelessWidget {
  const _AgentPreview({
    super.key,
    required this.choice,
    required this.status,
    required this.current,
    this.controller,
    this.terminalStyle = false,
  });

  final AgentChoice choice;
  final String? status;
  final bool current;
  final ScrollController? controller;
  final bool terminalStyle;

  static TextStyle get _muted =>
      grid.AppType.monoMeta(height: 1.5, color: Colors.white54);
  static TextStyle get _body => grid.AppType.monoLabel(
    fontWeight: FontWeight.w400,
    height: 1.6,
    color: Color(0xffe1e1e4),
  );

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final description = choice.description;
    final chips = [if (current) 'Chosen', ?status];
    return Semantics(
      container: true,
      label: 'Agent preview',
      child: SingleChildScrollView(
        controller: controller,
        padding: terminalStyle
            ? const EdgeInsets.all(12)
            : const EdgeInsets.fromLTRB(16, 20, 24, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                if (!terminalStyle) ...[
                  choice.mark(28),
                  const SizedBox(width: 12),
                ],
                Expanded(
                  child: Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(
                          text: choice.label,
                          style: terminalStyle
                              ? boxMonoStyle()
                              : grid.AppType.monoLabel(
                                  fontWeight: FontWeight.w600,
                                  color: Colors.white,
                                ),
                        ),
                        if (choice.creator case final creator?)
                          TextSpan(
                            text: '  by $creator',
                            style: terminalStyle
                                ? boxMonoStyle(color: kBoxFaint)
                                : grid.AppType.monoMeta(color: Colors.white54),
                          ),
                      ],
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            if (choice.detail case final detail?) ...[
              const SizedBox(height: 8),
              Text(
                detail,
                style: terminalStyle
                    ? boxMonoStyle(color: Colors.white70)
                    : grid.AppType.monoLabel(
                        fontWeight: FontWeight.w400,
                        height: 1.4,
                        color: Colors.white70,
                      ),
              ),
            ],
            if (chips.isNotEmpty) ...[
              const SizedBox(height: 12),
              if (terminalStyle)
                Text(chips.join(' · '), style: boxMonoStyle(color: kBoxFaint))
              else
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final chip in chips)
                      DecoratedBox(
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: .06),
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 4,
                          ),
                          child: Text(
                            chip,
                            style: grid.AppType.monoMeta(color: Colors.white70),
                          ),
                        ),
                      ),
                  ],
                ),
            ],
            if (description != null && description.trim().isNotEmpty) ...[
              SizedBox(height: terminalStyle ? 16 : 24),
              Text(
                'About',
                style: terminalStyle ? boxMonoStyle(color: kBoxFaint) : _muted,
              ),
              const SizedBox(height: 6),
              Text(
                description.trim(),
                style: terminalStyle ? boxMonoStyle() : _body,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/fuzzy_match.dart';
import '../shared/widgets/app_dialog.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart' show describeKeyBinding;
import '../state/app_state.dart';
import '../terminal/terminal_font_store.dart';
import 'box_chrome.dart';
import 'link_machine_dialog.dart';
import 'link_machine_screen.dart';

/// Commands run on the OTHER machine. Copying never executes them locally.
const String kLinkServerInstallCommand =
    'curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | bash';
const String kLinkServerLoginCommand = 'harness login';
const String kLinkServerStartCommand =
    'harness start && harness remote-password set';
final Uri kHarnessDownloadUrl = Uri.parse('https://www.autonomous.ai/harness');

Future<void> showLinkAnotherMachineDialog(
  BuildContext context,
  AppNotifier notifier, {
  AppKeymap? keymap,
}) {
  final activeKeymap = keymap ?? KeymapTheme.of(context, listen: false);
  return showAppDialog<void>(
    context: context,
    transitionDuration: Duration.zero,
    veilBlur: 0,
    veilTint: Colors.transparent,
    builder: (_) {
      final dialog = _LinkAnotherMachineDialog(notifier: notifier);
      return activeKeymap == null
          ? dialog
          : KeymapProvider(keymap: activeKeymap, child: dialog);
    },
  );
}

enum _Guide { desktop, server }

class _LinkEntry {
  const _LinkEntry(this.id, this.name, this.detail, {this.machine});
  final String id, name, detail;
  final MachineState? machine;
  bool get enabled => machine == null || machine!.needsLink;
}

class _LinkAnotherMachineDialog extends StatefulWidget {
  const _LinkAnotherMachineDialog({required this.notifier});
  final AppNotifier notifier;
  @override
  State<_LinkAnotherMachineDialog> createState() =>
      _LinkAnotherMachineDialogState();
}

class _LinkAnotherMachineDialogState extends State<_LinkAnotherMachineDialog> {
  AppNotifier get app => widget.notifier;
  final _query = TextEditingController();
  final _inputFocus = FocusNode(debugLabel: 'Find a machine to link');
  final _guideFocus = FocusNode(debugLabel: 'Machine setup first action');
  final _announcer = BoxAnnouncer();
  final _rowKeys = <String, GlobalKey>{};
  _Guide? _guide;
  String? _selectedId;
  String? _message;
  bool _error = false;
  bool _refreshing = false;
  bool _nested = false;
  int _copyRevision = 0;
  Timer? _messageTimer;

  bool get _composing =>
      _query.value.composing.isValid && !_query.value.composing.isCollapsed;
  bool get _mac => Theme.of(context).platform == TargetPlatform.macOS;

  String _hint(String command, String fallback) {
    final map = KeymapTheme.of(context);
    if (map == null) return fallback;
    final bindings = map
        .bindings(command, context: KeymapContext.picker)
        .toList();
    final preferred =
        bindings.where((binding) => binding.custom).firstOrNull ??
        (command == 'picker.refresh' && !_mac
            ? bindings
                  .where(
                    (binding) =>
                        binding.keys.length == 1 && binding.keys.first.control,
                  )
                  .firstOrNull
            : null) ??
        bindings.firstOrNull;
    return preferred == null ? 'click' : describeKeyBinding(preferred);
  }

  void _accept() {
    if (_nested || _composing) return;
    if (_guide == null && _inputFocus.hasFocus) {
      unawaited(_open(_selected));
    } else if (FocusManager.instance.primaryFocus?.context case final target?) {
      Actions.maybeInvoke(target, const ActivateIntent());
    }
  }

  Widget _keys(Widget child) {
    if (KeymapTheme.of(context) == null) return child;
    return KeymapRegion(
      contextKind: KeymapContext.picker,
      composing: () => _composing,
      actions: {
        'picker.accept': _accept,
        'picker.add_here': _accept,
        'picker.next': () => _guide == null && _inputFocus.hasFocus
            ? _move(1)
            : FocusManager.instance.primaryFocus?.nextFocus(),
        'picker.previous': () => _guide == null && _inputFocus.hasFocus
            ? _move(-1)
            : FocusManager.instance.primaryFocus?.previousFocus(),
        'picker.cancel': _back,
        'picker.refresh': () => unawaited(_refresh()),
        'picker.complete': () =>
            FocusManager.instance.primaryFocus?.nextFocus(),
        'picker.complete_back': () =>
            FocusManager.instance.primaryFocus?.previousFocus(),
      },
      // A deliberately unbound Escape must not dismiss via the route's
      // fallback shortcut. Configured cancel keys own this prompt.
      child: Actions(
        actions: {
          DismissIntent: CallbackAction<DismissIntent>(onInvoke: (_) => null),
        },
        child: child,
      ),
    );
  }

  List<MachineState> get _remotes =>
      app.machineStates.values.where((state) => !state.isLocalMachine).toList()
        ..sort((a, b) {
          if (a.needsLink != b.needsLink) return a.needsLink ? -1 : 1;
          return a.machine.displayName.toLowerCase().compareTo(
            b.machine.displayName.toLowerCase(),
          );
        });

  List<_LinkEntry> get _entries {
    final rows = [
      for (final state in _remotes)
        _LinkEntry(
          'machine:${state.machine.machineId}',
          state.machine.displayName,
          '${state.nodeOnline == false
                  ? 'offline'
                  : state.nodeOnline == true
                  ? 'online'
                  : 'checking'}'
              ' · ${state.needsLink ? 'enter remote password' : 'already linked'}',
          machine: state,
        ),
      const _LinkEntry(
        'desktop',
        'Set up a desktop',
        'macOS or Linux · install the app',
      ),
      const _LinkEntry(
        'server',
        'Set up a server over SSH',
        'install the CLI on the other machine',
      ),
      const _LinkEntry(
        'password',
        'This computer’s password',
        'let another machine connect here',
      ),
    ];
    final query = _query.text.trim().toLowerCase();
    if (query.isEmpty) return rows;
    final words = query.split(RegExp(r'\s+'));
    final ranked = <(int, int, _LinkEntry)>[];
    for (final (index, entry) in rows.indexed) {
      final text = '${entry.name} ${entry.detail}'.toLowerCase();
      var score = 0;
      var matches = true;
      for (final word in words) {
        final literal = text.indexOf(word);
        if (literal >= 0) {
          score += literal;
        } else {
          final spread = subsequenceSpread(text, word);
          if (spread == null) {
            matches = false;
            break;
          }
          score += 1000 + spread;
        }
      }
      if (matches) ranked.add((score, index, entry));
    }
    ranked.sort((a, b) {
      final score = a.$1.compareTo(b.$1);
      return score == 0 ? a.$2.compareTo(b.$2) : score;
    });
    return ranked.map((rank) => rank.$3).toList();
  }

  _LinkEntry? get _selected {
    final rows = _entries;
    return rows.where((row) => row.id == _selectedId).firstOrNull ??
        rows.firstOrNull;
  }

  @override
  void initState() {
    super.initState();
    _selectedId = _entries.where((entry) => entry.enabled).firstOrNull?.id;
    _focusInput();
  }

  @override
  void dispose() {
    _messageTimer?.cancel();
    _query.dispose();
    _inputFocus.dispose();
    _guideFocus.dispose();
    super.dispose();
  }

  void _focusInput() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && ModalRoute.of(context)?.isCurrent != false) {
        _inputFocus.requestFocus();
        _reveal();
      }
    });
  }

  void _reveal() {
    final row = _selected;
    if (row == null || _guide != null) return;
    final rowContext = _rowKeys[row.id]?.currentContext;
    if (rowContext != null) Scrollable.ensureVisible(rowContext, alignment: .5);
  }

  void _changed(String _) {
    setState(
      () => _selectedId =
          (_query.text.trim().isEmpty
                  ? _entries.where((entry) => entry.enabled)
                  : _entries)
              .firstOrNull
              ?.id,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _reveal();
    });
  }

  void _move(int step) {
    final rows = _entries;
    if (rows.isEmpty) return;
    final at = rows.indexWhere((row) => row.id == _selected?.id);
    final next = (at + step).clamp(0, rows.length - 1);
    setState(() => _selectedId = rows[next].id);
    _announcer.row(context, '${rows[next].name}, ${rows[next].detail}');
    _reveal();
  }

  void _say(String message, {bool error = false, bool transient = false}) {
    if (!mounted) return;
    _messageTimer?.cancel();
    setState(() {
      _message = message;
      _error = error;
    });
    _announcer.row(context, message);
    if (transient) {
      _messageTimer = Timer(const Duration(seconds: 3), () {
        if (mounted) setState(() => _message = null);
      });
    }
  }

  Future<void> _copy(String text, {bool command = true}) async {
    final revision = ++_copyRevision;
    try {
      await Clipboard.setData(ClipboardData(text: text));
      if (mounted && revision == _copyRevision) {
        _say(
          command
              ? 'Copied. Run on the other machine.'
              : 'Download link copied.',
          transient: true,
        );
      }
    } catch (_) {
      if (mounted && revision == _copyRevision) {
        _say(
          'Could not copy. Select the text to copy it, or try again.',
          error: true,
        );
      }
    }
  }

  Future<void> _refresh() async {
    if (_refreshing || app.machinesRefreshing) return;
    setState(() => _refreshing = true);
    try {
      await app.retryMachines();
      if (!mounted) return;
      final error = app.machineListError ?? app.lastError;
      if (error != null) {
        _say(error, error: true);
      } else {
        _say('Machine list refreshed.', transient: true);
      }
    } catch (_) {
      _say('Could not refresh machines. Try again.', error: true);
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  Future<void> _download() async {
    try {
      if (await launchUrl(
        kHarnessDownloadUrl,
        mode: LaunchMode.externalApplication,
      )) {
        return;
      }
    } catch (_) {
      // Keep recovery in the guide if the platform has no browser handler.
    }
    _say(
      'Could not open the browser. Copy the download link instead.',
      error: true,
    );
  }

  void _back() {
    if (_guide == null) {
      Navigator.of(context).pop();
    } else {
      setState(() => _guide = null);
      _focusInput();
    }
  }

  void _openGuide(_Guide guide) {
    setState(() => _guide = guide);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && ModalRoute.of(context)?.isCurrent != false) {
        _guideFocus.requestFocus();
      }
    });
  }

  Future<void> _open(_LinkEntry? entry) async {
    if (entry == null || !entry.enabled || _nested || _composing) return;
    setState(() => _selectedId = entry.id);
    if (entry.id == 'desktop' || entry.id == 'server') {
      _openGuide(entry.id == 'desktop' ? _Guide.desktop : _Guide.server);
      return;
    }
    setState(() => _nested = true);
    final previous = FocusManager.instance.primaryFocus;
    try {
      if (entry.machine case final state?) {
        final id = state.machine.machineId;
        if (app.stateOf(id)?.needsLink != true) return;
        await showLinkMachineScreenDialog(context, app, id);
        if (mounted && app.stateOf(id)?.needsLink == false) {
          _say('${state.machine.displayName} is linked.', transient: true);
        }
      } else {
        await showLinkMachineDialog(context, app);
      }
    } finally {
      if (mounted) setState(() => _nested = false);
      if (mounted && ModalRoute.of(context)?.isCurrent != false) {
        if (_guide == null) {
          _focusInput();
        } else if (previous?.context != null && previous!.canRequestFocus) {
          previous.requestFocus();
        } else {
          _guideFocus.requestFocus();
        }
      }
    }
  }

  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    if (_nested) return KeyEventResult.ignored;
    final keys = HardwareKeyboard.instance;
    final key = event.logicalKey;
    final plain =
        !keys.isControlPressed &&
        !keys.isMetaPressed &&
        !keys.isAltPressed &&
        !keys.isShiftPressed;
    final ctrl =
        keys.isControlPressed &&
        !keys.isMetaPressed &&
        !keys.isAltPressed &&
        !keys.isShiftPressed;
    final refresh =
        key == LogicalKeyboardKey.keyR &&
        (_mac
            ? keys.isMetaPressed && !keys.isControlPressed
            : keys.isControlPressed && !keys.isMetaPressed) &&
        !keys.isAltPressed &&
        !keys.isShiftPressed;
    final escape = plain && key == LogicalKeyboardKey.escape;
    final enter =
        plain &&
        (key == LogicalKeyboardKey.enter ||
            key == LogicalKeyboardKey.numpadEnter);
    final down =
        (plain && key == LogicalKeyboardKey.arrowDown) ||
        (ctrl &&
            (key == LogicalKeyboardKey.keyN || key == LogicalKeyboardKey.keyJ));
    final up =
        (plain && key == LogicalKeyboardKey.arrowUp) ||
        (ctrl &&
            (key == LogicalKeyboardKey.keyP || key == LogicalKeyboardKey.keyK));
    if (_composing && (escape || enter || up || down || refresh)) {
      return KeyEventResult.skipRemainingHandlers;
    }
    if (KeymapTheme.of(context, listen: false) != null) {
      // The host already had first use of configured keys. Don't turn an
      // unbound physical Enter into EditableText's native submit action.
      return enter && _inputFocus.hasFocus
          ? KeyEventResult.handled
          : KeyEventResult.ignored;
    }
    if (escape) {
      _back();
    } else if (refresh) {
      unawaited(_refresh());
    } else if (_guide == null && _inputFocus.hasFocus && (up || down)) {
      _move(down ? 1 : -1);
    } else if (_guide == null && _inputFocus.hasFocus && enter) {
      unawaited(_open(_selected));
    } else {
      return KeyEventResult.ignored;
    }
    return KeyEventResult.handled;
  }

  Widget _button(
    String label,
    VoidCallback action, {
    FocusNode? focus,
    Key? key,
  }) => TextButton(
    key: key,
    focusNode: focus,
    onPressed: action,
    style: TextButton.styleFrom(
      foregroundColor: Colors.white70,
      textStyle: boxMonoStyle(size: 12),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
      minimumSize: const Size(0, 28),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2)),
    ),
    child: Text(label),
  );

  Widget _machineRow(_LinkEntry entry, {bool picker = false}) {
    final selected = picker && entry.id == _selected?.id;
    return Semantics(
      selected: selected,
      button: entry.enabled,
      enabled: entry.enabled,
      child: InkWell(
        key: picker
            ? _rowKeys.putIfAbsent(entry.id, GlobalKey.new)
            : ValueKey('link-row-${entry.machine?.machine.machineId}'),
        canRequestFocus: !picker,
        onTap: entry.enabled ? () => unawaited(_open(entry)) : null,
        child: BoxRowHighlight(
          highlighted: selected,
          accent: Colors.white70,
          terminal: true,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 20,
                  child: Text(
                    selected ? '>' : ' ',
                    style: boxMonoStyle(color: Colors.white70),
                  ),
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        entry.name,
                        style: boxMonoStyle(
                          weight: selected ? FontWeight.w600 : null,
                        ),
                      ),
                      Text(
                        entry.detail,
                        style: boxMonoStyle(size: 11, color: kBoxFaint),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _guideBody() {
    final server = _guide == _Guide.server;
    final email = app.currentUser?.email ?? 'the same account as this computer';
    final remotes = _remotes.where((state) => state.needsLink).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'On the other ${server ? 'machine, over SSH' : 'computer'}:',
          style: boxMonoStyle(weight: FontWeight.w600),
        ),
        const SizedBox(height: 12),
        if (server) ...[
          _command(
            '1. Install the CLI (skip if installed)',
            kLinkServerInstallCommand,
            first: true,
          ),
          _command('2. Sign in as $email', kLinkServerLoginCommand),
          Text(
            'Open the printed sign-in link in a browser on any device.',
            style: boxMonoStyle(size: 11, color: kBoxFaint),
          ),
          _command(
            '3. Start Harness and set a remote password',
            kLinkServerStartCommand,
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: _button(
              'Copy all three commands',
              () => unawaited(
                _copy(
                  '$kLinkServerInstallCommand\n$kLinkServerLoginCommand\n$kLinkServerStartCommand',
                ),
              ),
              key: const Key('link-copy-all'),
            ),
          ),
        ] else ...[
          Text(
            '1. Install OpenHarness for macOS or Linux.',
            style: boxMonoStyle(size: 12),
          ),
          const SizedBox(height: 4),
          SelectableText(
            kHarnessDownloadUrl.toString(),
            style: boxMonoStyle(size: 12, color: Colors.white70),
          ),
          Wrap(
            spacing: 8,
            children: [
              _button(
                'Download OpenHarness',
                () => unawaited(_download()),
                focus: _guideFocus,
              ),
              _button(
                'Copy download link',
                () => unawaited(
                  _copy(kHarnessDownloadUrl.toString(), command: false),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text('2. Sign in as $email.', style: boxMonoStyle(size: 12)),
          const SizedBox(height: 10),
          Text(
            '3. Open commands → Link machine → This computer’s password.',
            style: boxMonoStyle(size: 12),
          ),
          const SizedBox(height: 4),
          Text(
            'Set a remote password there, then enter it here.',
            style: boxMonoStyle(size: 11, color: kBoxFaint),
          ),
        ],
        const SizedBox(height: 16),
        Text(
          remotes.isEmpty
              ? 'After sign-in, the machine appears here. Refresh to check now.'
              : 'Available to link',
          style: boxMonoStyle(size: 12, color: kBoxFaint),
        ),
        for (final state in remotes)
          _machineRow(
            _LinkEntry(
              'machine:${state.machine.machineId}',
              state.machine.displayName,
              'Enter remote password',
              machine: state,
            ),
          ),
      ],
    );
  }

  Widget _command(String title, String command, {bool first = false}) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 8, top: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(title, style: boxMonoStyle(size: 12)),
            const SizedBox(height: 4),
            SelectableText(
              command,
              style: boxMonoStyle(size: 12, color: Colors.white70),
            ),
            Align(
              alignment: Alignment.centerLeft,
              child: _button(
                'Copy command',
                () => unawaited(_copy(command)),
                focus: first ? _guideFocus : null,
                key: ValueKey('copy-$command'),
              ),
            ),
          ],
        ),
      );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([app, terminalFontStore]),
    builder: (context, _) {
      final rows = _entries;
      final selected = _selected;
      final message = _message ?? app.machineListError;
      return Offstage(
        offstage: _nested,
        child: Dialog(
          alignment: Alignment.topCenter,
          insetPadding: const EdgeInsets.fromLTRB(16, 56, 16, 18),
          elevation: 0,
          backgroundColor: Colors.transparent,
          child: _keys(
            Focus(
              onKeyEvent: _key,
              child: SizedBox(
                width: 760,
                child: TerminalBox(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: Text(
                                'Link another machine${_guide == null
                                    ? ''
                                    : _guide == _Guide.server
                                    ? ' / SSH'
                                    : ' / desktop'}',
                                style: boxMonoStyle(size: 12, color: kBoxFaint),
                              ),
                            ),
                            if (_guide == null)
                              Text(
                                '${rows.length}/${_remotes.length + 3}',
                                style: boxMonoStyle(size: 11, color: kBoxFaint),
                              ),
                          ],
                        ),
                      ),
                      if (_guide == null)
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          child: ReadlineKeys(
                            controller: _query,
                            onChanged: _changed,
                            child: TextField(
                              key: const Key('link-machine-search'),
                              controller: _query,
                              focusNode: _inputFocus,
                              autofocus: true,
                              style: boxMonoStyle(),
                              textAlignVertical: TextAlignVertical.center,
                              decoration: InputDecoration(
                                hintText: 'find a machine / desktop / SSH',
                                hintStyle: boxMonoStyle(color: kBoxFaint),
                                border: InputBorder.none,
                                enabledBorder: InputBorder.none,
                                focusedBorder: InputBorder.none,
                                filled: false,
                                isDense: true,
                                prefixIcon: Padding(
                                  padding: const EdgeInsets.only(right: 10),
                                  child: Center(
                                    widthFactor: 1,
                                    heightFactor: 1,
                                    child: Text(
                                      'machine >',
                                      style: boxMonoStyle(
                                        color: Colors.white70,
                                      ),
                                    ),
                                  ),
                                ),
                                prefixIconConstraints: const BoxConstraints(
                                  minHeight: 36,
                                ),
                                contentPadding: EdgeInsets.zero,
                              ),
                              onChanged: _changed,
                              onEditingComplete: () {},
                              onSubmitted: (_) => unawaited(_open(_selected)),
                            ),
                          ),
                        ),
                      Flexible(
                        child: SingleChildScrollView(
                          key: ValueKey(_guide),
                          padding: const EdgeInsets.fromLTRB(8, 6, 8, 10),
                          child: _guide != null
                              ? Padding(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 6,
                                  ),
                                  child: _guideBody(),
                                )
                              : Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.stretch,
                                  children: [
                                    if (rows.isEmpty)
                                      Padding(
                                        padding: const EdgeInsets.all(8),
                                        child: Text(
                                          'No matching machines. Clear the search to see setup options.',
                                          style: boxMonoStyle(
                                            size: 12,
                                            color: kBoxFaint,
                                          ),
                                        ),
                                      ),
                                    for (final entry in rows)
                                      _machineRow(entry, picker: true),
                                    if (selected != null && !selected.enabled)
                                      Padding(
                                        padding: const EdgeInsets.all(8),
                                        child: Text(
                                          'Already linked. Open its agents from New Tab or New Pane.',
                                          style: boxMonoStyle(
                                            size: 11,
                                            color: kBoxFaint,
                                          ),
                                        ),
                                      ),
                                  ],
                                ),
                        ),
                      ),
                      BoxHintStrip(
                        message: _refreshing || app.machinesRefreshing
                            ? 'Refreshing machines…'
                            : message,
                        isError:
                            !_refreshing &&
                            !app.machinesRefreshing &&
                            (_error ||
                                (_message == null &&
                                    app.machineListError != null)),
                        hints: [
                          if (_guide == null)
                            BoxHint(
                              '${_hint('picker.previous', '↑')}/${_hint('picker.next', '↓')}',
                              'select',
                            ),
                          if (_guide == null && selected?.enabled == true)
                            BoxHint(
                              _hint('picker.accept', 'enter'),
                              'open',
                              onTap: () => unawaited(_open(selected)),
                            ),
                          if (_guide != null)
                            BoxHint(
                              _hint('picker.complete', 'tab'),
                              'controls',
                            ),
                          BoxHint(
                            _hint('picker.refresh', _mac ? 'cmd-r' : 'ctrl-r'),
                            'refresh',
                            onTap: () => unawaited(_refresh()),
                          ),
                          BoxHint(
                            _hint('picker.cancel', 'esc'),
                            _guide == null ? 'close' : 'back',
                            onTap: _back,
                          ),
                        ],
                      ),
                    ],
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

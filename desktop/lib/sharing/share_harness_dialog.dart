import 'dart:async';
import 'dart:math' as math;

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/services.dart';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart';
import '../shortcuts/keymap_keyboard.dart';
import '../widgets/terminal_prompt.dart';
import '../widgets/desktop_chrome.dart';
import 'harness_comments.dart';
import '../state/app_state.dart';
import '../ws/ws_conn.dart';
import '../community/publish.dart';

typedef ShareAction = Future<Map<String, dynamic>> Function(
  String action,
  Map<String, dynamic> payload,
);

Future<void> showShareHarnessDialog(
  BuildContext context,
  AppNotifier app,
  String machineId,
  String agentId,
  String name,
) => showTerminalPrompt<void>(
  context,
  builder: (_) => ShareHarnessDialog(
    name: name,
    publish: () => publishHarness(app, machineId, agentId),
    manage: (action, payload) =>
        app.manageHarnessShares(machineId, agentId, action, payload),
  ),
);

class ShareHarnessDialog extends StatefulWidget {
  const ShareHarnessDialog({
    super.key,
    required this.name,
    required this.manage,
    this.publish,
  });
  final String name;
  final ShareAction manage;

  /// Hands the harness to the Hub, returning what the person does next there.
  final Future<String> Function()? publish;
  @override
  State<ShareHarnessDialog> createState() => _ShareHarnessDialogState();
}

enum _ShareRow { access, people, options, expiry, comments, stop, copy, retry }

class _ShareHarnessDialogState extends State<ShareHarnessDialog> {
  final _focus = FocusNode(debugLabel: 'share-form');
  final _emailFocus = FocusNode(debugLabel: 'share-emails');
  final _commentsFocus = FocusNode(debugLabel: 'share-comments');
  final _commentsKey = GlobalKey();
  final _formScroll = ScrollController();
  final _sideScroll = ScrollController();
  final _rowKeys = {for (final row in _ShareRow.values) row: GlobalKey()};
  final _choiceKeys = <int, GlobalKey>{};
  _ShareRow _row = _ShareRow.copy;
  bool _options = false, _picking = false, _hideChoices = false;
  int _choice = 0;

  final _emails = TextEditingController();
  List<Map<String, dynamic>> _shares = [];
  bool _loading = true, _busy = false;
  String? _error, _notice;
  int _days = 30;
  Map<String, dynamic>? _link;
  bool _collaboration = false, _manualCopy = false;
  Timer? _presence;
  int _revision = 0;
  bool _refreshing = false;
  @override
  void initState() {
    super.initState();
    // The dialog veil autofocuses its own Escape scope first, and only one
    // autofocus wins per scope — so the form asks for the keys itself.
    _focusPane();
    unawaited(_load());
    _presence = Timer.periodic(const Duration(seconds: 5), (_) {
      if (!_busy) unawaited(_load(quiet: true));
    });
  }

  @override
  void dispose() {
    _presence?.cancel();
    _emails.dispose();
    _focus.dispose();
    _emailFocus.dispose();
    _commentsFocus.dispose();
    _formScroll.dispose();
    _sideScroll.dispose();
    super.dispose();
  }

  String _message(Object error) =>
      error is WsRequestFailure && error.code == 'UNSUPPORTED'
      ? 'Update Harness on this machine to start sharing.'
      : error is WsRequestFailure && error.detail != null
      ? error.detail!
      : 'Could not reach this harness. Check the connection and try again.';
  void _accept(Map<String, dynamic> response) {
    final recipientId =
        _row == _ShareRow.people && _choice >= 2 && _choice - 2 < _shares.length
        ? _shares[_choice - 2]['id']
        : null;
    _collaboration = response['collaboration'] == true;
    _link = response['link'] is Map
        ? Map<String, dynamic>.from(response['link'] as Map)
        : null;
    _shares = [
      for (final row in response['shares'] as List? ?? const [])
        Map<String, dynamic>.from(row as Map),
    ];
    if (recipientId != null) {
      final index = _shares.indexWhere((share) => share['id'] == recipientId);
      _choice = index < 0 ? 0 : index + 2;
      if (_picking && index < 0) _focusPane();
    }
  }

  Future<void> _load({bool quiet = false}) async {
    if (_refreshing || _busy) return;
    _refreshing = true;
    final revision = _revision;
    try {
      final response = await widget.manage('list', const {});
      if (mounted && revision == _revision) {
        setState(() {
          _accept(response);
          _loading = false;
          if (!quiet) _error = null;
        });
      }
    } catch (error) {
      if (mounted && !quiet && revision == _revision) {
        setState(() {
          _loading = false;
          _error = _message(error);
        });
      }
    } finally {
      _refreshing = false;
    }
  }

  Future<void> _invite() async {
    if (_busy) return;
    final emails = _emails.text
        .split(RegExp(r'[,;\s]+'))
        .where((e) => e.isNotEmpty)
        .map((e) => e.toLowerCase())
        .toSet()
        .toList();
    if (emails.isEmpty ||
        emails.length > 20 ||
        emails.any((e) => !RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(e))) {
      setState(() {
        _error = 'Enter up to 20 valid email addresses, separated by commas.';
        _notice = null;
      });
      return;
    }
    setState(() {
      _revision++;
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final response = await widget.manage('invite', {
        'emails': emails,
        'days': _days,
      });
      if (mounted) {
        setState(() {
          _accept(response);
          _emails.clear();
          _notice = _shares.any((s) => s['error'] != null)
              ? 'Some invitations could not be shared. Check the details below.'
              : _shares.any((s) => s['pending'] == true)
              ? 'Invitations saved. They will appear when the connection returns.'
              : '${emails.length == 1 ? '1 person now has' : '${emails.length} people now have'} view-only access.';
        });
      }
    } catch (error) {
      if (mounted) setState(() => _error = _message(error));
    } finally {
      if (mounted) {
        setState(() => _busy = false);
        if (_picking && _row == _ShareRow.people) _focusPane();
      }
    }
  }

  Future<void> _remove(String id) async {
    if (_busy) return;
    setState(() {
      _revision++;
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final response = await widget.manage('remove', {'id': id});
      if (mounted) {
        setState(() {
          _accept(response);
          _notice = 'Access removed.';
        });
      }
    } catch (error) {
      if (mounted) setState(() => _error = _message(error));
    } finally {
      if (mounted) {
        setState(() => _busy = false);
        if (_picking && _row == _ShareRow.people) _focusPane();
      }
    }
  }

  Future<void> _linkAction(String visibility, {bool copy = false}) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _revision++;
      _error = null;
      _notice = null;
    });
    try {
      if (!copy || _link == null || _link?['visibility'] == 'off') {
        _accept(await widget.manage('link', {'visibility': visibility}));
      }
      if (copy && _link?['pending'] != true && _link?['error'] == null) {
        final url = _link?['url'] as String?;
        if (url == null) throw StateError('Link unavailable');
        await Clipboard.setData(ClipboardData(text: url));
        _manualCopy = false;
        if (mounted) setState(() => _notice = 'Link copied.');
      } else if (mounted) {
        setState(
          () => _notice =
              _link?['error'] as String? ??
              (_link?['pending'] == true
                  ? 'Saved. Waiting for the connection before the link is ready.'
                  : visibility == 'off'
                  ? 'Sharing stopped.'
                  : 'Access updated.'),
        );
      }
    } catch (error) {
      _manualCopy = copy && _link?['url'] != null;
      if (mounted) {
        setState(
          () => _error = copy && _link?['url'] != null
              ? 'Could not copy. Select the link below and copy it.'
              : _message(error),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  bool get _disabled => _busy || _loading;
  bool get _isPublic => _link?['visibility'] == 'public';
  bool get _linkActive => _link != null && _link?['visibility'] != 'off';
  bool get _composing =>
      _emails.value.composing.isValid && !_emails.value.composing.isCollapsed;
  bool get _hasChoices =>
      _row == _ShareRow.access ||
      _row == _ShareRow.people ||
      _row == _ShareRow.expiry ||
      _row == _ShareRow.comments;
  List<_ShareRow> get _rows => [
    if (_collaboration) _ShareRow.access,
    if (!_isPublic) _ShareRow.people,
    _ShareRow.options,
    if (_options) ...[
      if (!_isPublic) _ShareRow.expiry,
      if (_collaboration) _ShareRow.comments,
      if (_linkActive) _ShareRow.stop,
    ],
    _ShareRow.copy,
    if (_error != null) _ShareRow.retry,
  ];

  String _label(_ShareRow row) => switch (row) {
    _ShareRow.access => 'Access',
    _ShareRow.people => 'People',
    _ShareRow.options => 'Options',
    _ShareRow.expiry => 'Invite for',
    _ShareRow.comments => 'Comments',
    _ShareRow.stop => 'Stop sharing',
    _ShareRow.copy => _busy ? 'Saving…' : 'Copy link',
    _ShareRow.retry => 'Retry',
  };
  String? _value(_ShareRow row) => switch (row) {
    _ShareRow.access => _isPublic ? 'Public' : 'Private',
    _ShareRow.people =>
      _shares.isEmpty
          ? 'Only you'
          : '${_shares.length} ${_shares.length == 1 ? 'person' : 'people'}',
    _ShareRow.options => _options ? 'Hide' : 'Show',
    _ShareRow.expiry => '$_days days',
    _ShareRow.comments => 'Open discussion',
    _ => null,
  };
  bool _enabled(_ShareRow row) =>
      !_disabled && (row != _ShareRow.copy || _collaboration);

  void _select(_ShareRow row, {bool enter = false}) {
    if (!_enabled(row)) return;
    setState(() {
      _row = row;
      _picking = enter && _hasChoices;
      _hideChoices = false;
      _choice = switch (row) {
        _ShareRow.access => _isPublic ? 1 : 0,
        _ShareRow.expiry => const [7, 30, 90].indexOf(_days),
        _ => 0,
      };
    });
    _focusPane();
  }

  void _focusPane() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (_picking && _row == _ShareRow.people && _choice == 0) {
        _emailFocus.requestFocus();
      } else if (_picking && _row == _ShareRow.comments) {
        _commentsFocus.requestFocus();
      } else {
        _focus.requestFocus();
      }
      final target =
          (_picking ? _choiceKeys[_choice] : _rowKeys[_row])?.currentContext;
      if (target != null) Scrollable.ensureVisible(target, alignment: .5);
    });
  }

  void _backToForm({bool selectCopy = false}) {
    setState(() {
      _picking = false;
      _hideChoices = true;
      if (selectCopy) _row = _ShareRow.copy;
    });
    _focusPane();
  }

  void _cancel() {
    if (_picking || (_hasChoices && !_hideChoices)) {
      _backToForm();
    } else {
      Navigator.of(context).pop();
    }
  }

  void _switchPane() {
    if (_disabled || !_hasChoices) return;
    if (_picking) {
      _backToForm();
    } else {
      setState(() {
        _picking = true;
        _hideChoices = false;
      });
      _focusPane();
    }
  }

  void _step(int delta) {
    if (_disabled) return;
    if (_picking) {
      final count = switch (_row) {
        _ShareRow.access => 2,
        _ShareRow.expiry => 3,
        _ShareRow.people => _shares.length + 2,
        _ => 0,
      };
      if (count == 0) return;
      setState(() => _choice = (_choice + delta) % count);
      _focusPane();
    } else {
      final rows = _rows.where(_enabled).toList();
      if (rows.isNotEmpty) {
        _select(rows[(rows.indexOf(_row) + delta) % rows.length]);
      }
    }
  }

  Future<void> _chooseVisibility(int index) async {
    final visibility = index == 0 ? 'private' : 'public';
    if (_linkActive && _link?['visibility'] == visibility) {
      _backToForm(selectCopy: true);
      return;
    }
    await _linkAction(visibility);
    if (mounted && _error == null) _backToForm(selectCopy: true);
  }

  void _activate() {
    if (_disabled) return;
    if (!_picking) {
      if (!_enabled(_row)) return;
      switch (_row) {
        case _ShareRow.options:
          _toggleOptions();
        case _ShareRow.copy:
          unawaited(_linkAction('private', copy: true));
        case _ShareRow.stop:
          unawaited(_stopSharing());
        case _ShareRow.retry:
          unawaited(_load());
        default:
          _switchPane();
      }
    } else {
      switch (_row) {
        case _ShareRow.access:
          unawaited(_chooseVisibility(_choice));
        case _ShareRow.expiry:
          setState(() => _days = const [7, 30, 90][_choice]);
          _backToForm(selectCopy: true);
        case _ShareRow.people:
          if (_choice < 2) {
            if (_emails.text.trim().isNotEmpty) unawaited(_invite());
          } else if (_choice - 2 < _shares.length) {
            unawaited(_remove(_shares[_choice - 2]['id'] as String));
          }
        default:
          break;
      }
    }
  }

  Future<void> _stopSharing() async {
    await _linkAction('off');
    if (mounted && _error == null) _backToForm(selectCopy: true);
  }

  void _toggleOptions() {
    if (_disabled) return;
    setState(() {
      _options = !_options;
      if (!_rows.contains(_row)) {
        _row = _ShareRow.options;
        _picking = false;
        _hideChoices = true;
      }
    });
    _focusPane();
  }

  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    if (_composing) return KeyEventResult.skipRemainingHandlers;
    if (_picking && _row == _ShareRow.comments) return KeyEventResult.ignored;
    final stroke = keyStrokeForEvent(event);
    final map =
        KeymapTheme.of(context, listen: false)?.current ?? harnessDefaultKeymap;
    final command = stroke == null
        ? null
        : map.match(KeymapContext.picker, [stroke]).command;
    final action = _keyActions[command];
    // Left/right retain caret behavior while an email address is being edited.
    if (_emailFocus.hasFocus &&
        (event.logicalKey == LogicalKeyboardKey.arrowLeft ||
            event.logicalKey == LogicalKeyboardKey.arrowRight)) {
      return KeyEventResult.ignored;
    }
    if (action != null) {
      if (event is! KeyRepeatEvent ||
          command == 'picker.next' ||
          command == 'picker.previous') {
        action();
      }
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter) {
      return KeyEventResult.handled;
    }
    if (_emailFocus.hasFocus) return KeyEventResult.ignored;
    if (event.logicalKey == LogicalKeyboardKey.space &&
        _row == _ShareRow.options) {
      if (event is KeyDownEvent) _activate();
      return KeyEventResult.handled;
    }
    // Like Cmd-N, typing on People enters its editor with that first character.
    final character = event.character;
    if (_row == _ShareRow.people &&
        !_disabled &&
        !HardwareKeyboard.instance.isMetaPressed &&
        !HardwareKeyboard.instance.isControlPressed &&
        character != null &&
        character.isNotEmpty &&
        character.codeUnitAt(0) >= 32) {
      _emails.text += character;
      _emails.selection = TextSelection.collapsed(offset: _emails.text.length);
      setState(() {
        _picking = true;
        _hideChoices = false;
        _choice = 0;
      });
      _focusPane();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  Map<String, VoidCallback> get _keyActions => {
    'picker.accept': _activate,
    'picker.cancel': _cancel,
    'picker.next': () => _step(1),
    'picker.previous': () => _step(-1),
    'picker.complete': _switchPane,
    'picker.complete_back': _switchPane,
    'picker.control_next': () {
      if (!_picking) _switchPane();
    },
    'picker.control_previous': () {
      if (_picking) _backToForm();
    },
    'picker.more_options': _toggleOptions,
  };

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return DesktopChrome(
      child: DefaultTextStyle(
        style: DesktopChrome.text(size: 13),
        child: KeymapRegion(
          contextKind: KeymapContext.picker,
          composing: () => _composing,
          actions: _keyActions,
          child: Focus(
            focusNode: _focus,
            autofocus: true,
            onKeyEvent: _key,
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final formWidth = math.min(480.0, constraints.maxWidth);
                  final left = (constraints.maxWidth - formWidth) / 2;
                  final available =
                      constraints.maxWidth - left - formWidth - 16;
                  final beside = available >= 280;
                  final showChoices = _hasChoices && !_hideChoices;
                  final replaceForm = _picking && !beside;
                  // Opening a chooser leaves the form in place. Narrow windows
                  // show that same chooser in the form's frame instead.
                  return Stack(
                    children: [
                      Align(
                        alignment: Alignment.center,
                        child: SizedBox(
                          width: formWidth,
                          child: DesktopDialogSurface(
                            key: const ValueKey('share-form-surface'),
                            child: replaceForm
                                ? _sidePane(narrow: true)
                                : _formPane(),
                          ),
                        ),
                      ),
                      if (showChoices && beside)
                        Positioned(
                          left: left + formWidth + 16,
                          top: 0,
                          bottom: 0,
                          width: math.min(360.0, available),
                          child: Align(
                            alignment: Alignment.centerLeft,
                            child: DesktopDialogSurface(
                              key: const ValueKey('share-choices-surface'),
                              child: _sidePane(),
                            ),
                          ),
                        ),
                    ],
                  );
                },
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<String> get _messages => [
    if (_loading) 'Loading sharing…',
    if (!_loading && !_collaboration && _error == null)
      'Update Harness on this machine to share browser links and comments.',
    ?_error,
    ?_notice,
    if (_link?['error'] != null && _link?['error'] != _error)
      '${_link!['error']}',
    if (_manualCopy && _link?['url'] is String) _link!['url'] as String,
  ];

  /// These controls use the form's existing row/choice keyboard selection.
  /// Excluding their own focus keeps Tab switching panes and preserves the
  /// email editor's IME ownership; pointer and accessibility activation remain.
  Widget _plainRow({
    required String label,
    String? value,
    required bool selected,
    required bool enabled,
    required VoidCallback onTap,
    bool primary = false,
    bool destructive = false,
    bool? checked,
    IconData? icon,
    IconData? disclosure,
    Key? key,
    Key? rowKey,
  }) {
    final foreground = !enabled
        ? DesktopChrome.muted
        : primary
        ? Theme.of(context).colorScheme.onPrimary
        : destructive
        ? Theme.of(context).colorScheme.error
        : DesktopChrome.foreground;
    final content = Row(
      children: [
        if (checked != null || icon != null) ...[
          SizedBox(
            width: 18,
            child: checked == false
                ? null
                : Icon(checked == true ? AppIcons.check : icon, size: 18),
          ),
          const SizedBox(width: DesktopChrome.controlGap),
        ],
        Expanded(
          child: Text(label, style: DesktopChrome.control(color: foreground)),
        ),
        if (value != null) ...[
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              value,
              textAlign: TextAlign.end,
              style: DesktopChrome.control(color: DesktopChrome.muted),
            ),
          ),
        ],
        if (disclosure != null) ...[
          const SizedBox(width: DesktopChrome.controlGap),
          Icon(disclosure, size: 18, color: DesktopChrome.muted),
        ],
      ],
    );
    final style = ButtonStyle(
      minimumSize: const WidgetStatePropertyAll(Size(0, 36)),
      padding: const WidgetStatePropertyAll(
        EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      ),
      shape: WidgetStatePropertyAll(
        RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
        ),
      ),
      foregroundColor: WidgetStatePropertyAll(foreground),
      side: WidgetStateProperty.resolveWith(
        (states) => BorderSide(
          color: selected && enabled
              ? primary
                    ? Colors.white.withValues(alpha: .85)
                    : DesktopChrome.focusRing
              : DesktopChrome.rim,
          width: selected && enabled ? 2 : 1,
        ),
      ),
      backgroundColor: primary
          ? null
          : WidgetStateProperty.resolveWith((states) {
              if (selected && enabled) return DesktopChrome.selection;
              if (enabled && states.contains(WidgetState.hovered)) {
                return grid.AppGlass.rowHoverFill;
              }
              return DesktopChrome.field;
            }),
    );
    return Semantics(
      key: key,
      label: value == null ? label : '$label, $value',
      button: true,
      selected: selected,
      checked: checked,
      enabled: enabled,
      onTap: enabled ? onTap : null,
      excludeSemantics: true,
      child: KeyedSubtree(
        key: rowKey,
        child: ExcludeFocus(
          child: primary
              ? FilledButton(
                  onPressed: enabled ? onTap : null,
                  style: style,
                  child: content,
                )
              : TextButton(
                  onPressed: enabled ? onTap : null,
                  style: style,
                  child: content,
                ),
        ),
      ),
    );
  }

  Widget _formRow(_ShareRow row) => _plainRow(
    key: ValueKey('share-field-${row.name}'),
    rowKey: _rowKeys[row],
    label: _label(row),
    value: _value(row),
    selected: _row == row && !_picking,
    enabled: _enabled(row),
    primary: row == _ShareRow.copy,
    destructive: row == _ShareRow.stop,
    icon: row == _ShareRow.copy ? AppIcons.link2 : null,
    disclosure: switch (row) {
      _ShareRow.options => _options ? AppIcons.chevronUp : AppIcons.chevronDown,
      _ShareRow.access ||
      _ShareRow.people ||
      _ShareRow.expiry ||
      _ShareRow.comments => AppIcons.chevronRight,
      _ => null,
    },
    onTap: () {
      _select(row);
      _activate();
    },
  );

  Widget _formPane() => Padding(
    padding: const EdgeInsets.all(DesktopChrome.panelPadding),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Flexible(
          child: Scrollbar(
            controller: _formScroll,
            thumbVisibility: true,
            child: SingleChildScrollView(
              controller: _formScroll,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('Share harness', style: DesktopChrome.heading()),
                  const SizedBox(height: 8),
                  Text(
                    widget.name,
                    style: DesktopChrome.text(size: 14, medium: true),
                  ),
                  const SizedBox(height: DesktopChrome.groupGap),
                  for (final row in _rows)
                    if (row != _ShareRow.copy && row != _ShareRow.retry) ...[
                      if (row == _ShareRow.options) const SizedBox(height: 8),
                      _formRow(row),
                      const SizedBox(height: DesktopChrome.controlGap),
                    ],
                  if (!_picking) ..._messageWidgets(),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: DesktopChrome.groupGap),
        _formRow(_ShareRow.copy),
        if (widget.publish != null) ...[
          const SizedBox(height: DesktopChrome.controlGap),
          TextButton(
            onPressed: _busy
                ? null
                : () async {
                    setState(() {
                      _busy = true;
                      _error = null;
                    });
                    try {
                      final next = await widget.publish!();
                      if (mounted) setState(() => _notice = next);
                    } catch (error) {
                      if (mounted) {
                        setState(
                          () => _error = error is FormatException
                              ? error.message
                              : 'Could not prepare this harness. Open harness.autonomous.ai/hub/publish to choose its files.',
                        );
                      }
                    } finally {
                      if (mounted) setState(() => _busy = false);
                    }
                  },
            child: const Text('Publish to Hub'),
          ),
        ],
        if (_rows.contains(_ShareRow.retry)) ...[
          const SizedBox(height: DesktopChrome.controlGap),
          _formRow(_ShareRow.retry),
        ],
        const SizedBox(height: DesktopChrome.groupGap),
        Row(
          children: [
            Expanded(
              child: Text(
                'Keep your machine online.',
                style: DesktopChrome.metadata(),
              ),
            ),
            const SizedBox(width: 8),
            ExcludeFocus(
              child: TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('Close'),
              ),
            ),
          ],
        ),
      ],
    ),
  );

  List<Widget> _messageWidgets() => [
    for (final message in _messages) ...[
      const SizedBox(height: 12),
      Semantics(
        liveRegion: true,
        child: _manualCopy && message == _link?['url']
            ? SelectableText(message, style: grid.AppType.monoMeta())
            : Text(
                message,
                style: DesktopChrome.text(
                  size: 13,
                  color: message == _error || message == _link?['error']
                      ? Theme.of(context).colorScheme.error
                      : _link?['pending'] == true
                      ? grid.AppPalette.warn
                      : DesktopChrome.muted,
                ),
              ),
      ),
    ],
  ];

  Widget _sidePane({bool narrow = false}) {
    Widget choice(
      String label,
      int index,
      VoidCallback activate, {
      bool enabled = true,
      String? value,
      bool primary = false,
      bool destructive = false,
      bool? checked,
    }) => _plainRow(
      key: ValueKey('share-choice-$index'),
      rowKey: _choiceKeys.putIfAbsent(index, GlobalKey.new),
      label: label,
      value: value,
      selected: _picking && _choice == index,
      enabled: enabled && !_disabled,
      primary: primary,
      destructive: destructive,
      checked: checked,
      onTap: () {
        setState(() {
          _picking = true;
          _choice = index;
        });
        activate();
      },
    );
    Widget note(String text, {Color? color}) => Text(
      text,
      style: DesktopChrome.text(size: 13, color: color ?? DesktopChrome.muted),
    );
    final title = switch (_row) {
      _ShareRow.access => 'Link access',
      _ShareRow.people => 'People',
      _ShareRow.expiry => 'Invitation expiry',
      _ShareRow.comments => 'Comments',
      _ => 'Sharing options',
    };
    final backControl = TextButton.icon(
      key: narrow ? const ValueKey('share-back') : null,
      onPressed: _backToForm,
      icon: const Icon(AppIcons.arrowLeft, size: 16),
      label: const Text('Back'),
    );
    final back = _row == _ShareRow.comments && _picking
        ? backControl
        : ExcludeFocus(child: backControl);
    if (_row == _ShareRow.comments && _picking) {
      return TerminalPromptKeys(
        focusNode: _commentsFocus,
        cancel: _backToForm,
        child: SizedBox(
          height: 560,
          child: HarnessComments(
            key: _commentsKey,
            manage: widget.manage,
            headerAction: back,
            padding: const EdgeInsets.all(DesktopChrome.panelPadding),
          ),
        ),
      );
    }
    final fieldBorder = OutlineInputBorder(
      borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
      borderSide: BorderSide(color: DesktopChrome.rim),
    );
    return Padding(
      padding: const EdgeInsets.all(DesktopChrome.panelPadding),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(child: Text(title, style: DesktopChrome.heading())),
              back,
            ],
          ),
          const SizedBox(height: DesktopChrome.groupGap),
          Flexible(
            child: Scrollbar(
              controller: _sideScroll,
              thumbVisibility: true,
              child: SingleChildScrollView(
                controller: _sideScroll,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_row == _ShareRow.access) ...[
                      choice(
                        'Private',
                        0,
                        () => unawaited(_chooseVisibility(0)),
                        checked: !_isPublic,
                      ),
                      const SizedBox(height: 8),
                      note('Only invited emails can view and comment.'),
                      const SizedBox(height: DesktopChrome.groupGap),
                      choice(
                        'Public',
                        1,
                        () => unawaited(_chooseVisibility(1)),
                        checked: _isPublic,
                      ),
                      const SizedBox(height: 8),
                      note(
                        'Anyone with the link can view. Sign in to comment.',
                      ),
                      const SizedBox(height: DesktopChrome.groupGap),
                      note('Viewers cannot control your agent.'),
                    ],
                    if (_row == _ShareRow.expiry) ...[
                      for (var i = 0; i < 3; i++) ...[
                        choice('${const [7, 30, 90][i]} days', i, () {
                          setState(() => _days = const [7, 30, 90][i]);
                          _backToForm(selectCopy: true);
                        }, checked: _days == const [7, 30, 90][i]),
                        const SizedBox(height: DesktopChrome.controlGap),
                      ],
                      const SizedBox(height: 8),
                      note(
                        'Applies to new invitations. Your link stays active until you stop sharing.',
                      ),
                    ],
                    if (_row == _ShareRow.people) ...[
                      Text(
                        'Email addresses',
                        style: DesktopChrome.control(medium: true),
                      ),
                      const SizedBox(height: DesktopChrome.controlGap),
                      TextField(
                        key: _choiceKeys.putIfAbsent(0, GlobalKey.new),
                        controller: _emails,
                        focusNode: _emailFocus,
                        enabled: !_disabled,
                        keyboardType: TextInputType.emailAddress,
                        style: DesktopChrome.text(size: 14),
                        cursorColor: DesktopChrome.accent,
                        decoration: InputDecoration(
                          hintText: 'Add emails',
                          hintStyle: DesktopChrome.text(
                            size: 14,
                            color: DesktopChrome.muted,
                          ),
                          isDense: true,
                          filled: true,
                          fillColor: DesktopChrome.field,
                          border: fieldBorder,
                          enabledBorder: fieldBorder,
                          focusedBorder: fieldBorder.copyWith(
                            borderSide: BorderSide(
                              color: DesktopChrome.focusRing,
                              width: 2,
                            ),
                          ),
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 10,
                          ),
                        ),
                        onTap: () => setState(() {
                          _picking = true;
                          _choice = 0;
                        }),
                        onChanged: (_) => setState(() {}),
                        onSubmitted: (_) {
                          if (!_composing && !_disabled) unawaited(_invite());
                        },
                      ),
                      const SizedBox(height: DesktopChrome.controlGap),
                      choice(
                        'Add people',
                        1,
                        () => unawaited(_invite()),
                        enabled: _emails.text.trim().isNotEmpty,
                        primary: true,
                      ),
                      const SizedBox(height: 8),
                      note(
                        'Invited for $_days days. Copy and send them the link.',
                      ),
                      const SizedBox(height: DesktopChrome.groupGap),
                      if (_shares.isEmpty) note('No invited people yet.'),
                      for (final (index, share) in _shares.indexed) ...[
                        Text(
                          '${share['email']}',
                          style: DesktopChrome.text(size: 13, medium: true),
                        ),
                        const SizedBox(height: 4),
                        note(
                          _recipientStatus(share),
                          color: share['error'] != null
                              ? Theme.of(context).colorScheme.error
                              : share['pending'] == true ||
                                    share['expired'] == true
                              ? grid.AppPalette.warn
                              : DesktopChrome.muted,
                        ),
                        const SizedBox(height: 8),
                        choice(
                          'Remove ${share['email']}',
                          index + 2,
                          () => unawaited(_remove(share['id'] as String)),
                          destructive: true,
                        ),
                        const SizedBox(height: DesktopChrome.groupGap),
                      ],
                      note(
                        'Viewers can comment; they cannot control your agent.',
                      ),
                    ],
                    if (_row == _ShareRow.comments)
                      note('Open Comments to join the discussion.'),
                    if (_picking) ..._messageWidgets(),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _recipientStatus(Map<String, dynamic> share) {
    final expires = DateTime.tryParse(share['expiresAt'] as String? ?? '')
        ?.toLocal();
    return share['error'] as String? ??
        (share['pending'] == true
            ? 'Waiting for connection'
            : share['expired'] == true
            ? 'Expired · add again to renew'
            : (share['watching'] as num? ?? 0) > 0
            ? 'Watching now · Can view'
            : 'Can view${expires == null ? '' : ' · Until ${expires.month}/${expires.day}/${expires.year}'}');
  }
}

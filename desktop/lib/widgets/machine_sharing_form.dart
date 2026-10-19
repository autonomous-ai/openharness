import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../state/app_state.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'box_chrome.dart' show ReadlineKeys;
import 'desktop_chrome.dart';
import 'terminal_text_action.dart';

/// The most addresses one machine is shared with (CLI services/sharedMachines.ts `SHARE_EMAILS_MAX`).
const int machineShareEmailsMax = 100;

/// The backend's own rule for an address (zod's `email()`): one it would refuse is refused as it is
/// typed, by name, never as a failed save of the whole list.
final _emailPattern = RegExp(
  r"^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$",
);

/// One person in the list: an address the owner named, and whether they use it now. Everyone at the
/// domain is the switch above the list, never listed one by one.
typedef _Person = ({String email, bool usingIt});

/// Sharing one of the account's machines with other accounts
/// (docs/plans/2026-10-15-share-machine-plan.md), in the Machines picker's preview like Rename.
///
/// Every change applies as it is made — the domain switch, an address added, one removed (with an
/// Undo) — the way a sharing sheet does, so there is no list typed and then lost for want of a Save.
/// Done closes. The policy lives on the machine itself, so it is read from and written to that
/// machine (`shared_machines`).
class MachineSharingForm extends StatefulWidget {
  const MachineSharingForm({
    super.key,
    required this.app,
    required this.machineId,
    required this.onClose,
    required this.onFocusChanged,
    this.onSwitchPane,
  });
  final AppNotifier app;
  final String machineId;
  final ValueChanged<String?> onClose;
  final ValueChanged<bool> onFocusChanged;
  final VoidCallback? onSwitchPane;

  @override
  State<MachineSharingForm> createState() => MachineSharingFormState();
}

class MachineSharingFormState extends State<MachineSharingForm> {
  final _scope = FocusNode(debugLabel: 'Machine sharing');
  final _input = FocusNode(debugLabel: 'Share email');
  final _buttons = <String, FocusNode>{};
  final _value = TextEditingController();
  bool _loading = true, _busy = false;

  /// Why the sharing could not be read at all; the form offers Retry instead of its controls.
  String? _unavailable;

  /// What is wrong with what was typed, said under the field it was typed in ([_fieldIsError]: in
  /// error ink; otherwise a quiet note, "Already shared with …").
  String? _fieldError;
  bool _fieldIsError = true;

  /// Why the last change was refused. A change that went through says nothing: the list shows it.
  String? _status;

  /// Something changed while the form was open: Done leaves a summary in the machine's details.
  bool _changed = false;
  List<String> _emails = [];
  bool _sameDomain = false;
  String? _domain;
  List<Map<String, dynamic>> _members = const [];

  AppNotifier get app => widget.app;
  String get _name =>
      app.stateOf(widget.machineId)?.machine.displayName ?? 'this machine';
  bool get _composing =>
      _value.value.composing.isValid && !_value.value.composing.isCollapsed;

  @override
  void initState() {
    super.initState();
    _value.addListener(_typed);
    unawaited(_load());
  }

  @override
  void dispose() {
    _value.removeListener(_typed);
    _scope.dispose();
    _input.dispose();
    for (final node in _buttons.values) {
      node.dispose();
    }
    _value.dispose();
    super.dispose();
  }

  /// Typing clears an error the last change left, and the Share button follows the field.
  void _typed() {
    if (!mounted) return;
    setState(() {
      _fieldError = null;
    });
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _unavailable = null;
    });
    Map<String, dynamic> answer;
    try {
      answer = await app.machineSharing(widget.machineId);
    } catch (error) {
      answer = {
        'error': 'UNAVAILABLE',
        'message': 'Could not reach $_name. Check that it is online.',
      };
    }
    if (!mounted) return;
    setState(() {
      _loading = false;
      final error = answer['error'];
      if (error != null) {
        _unavailable = error == 'UNSUPPORTED'
            ? 'Update Harness on $_name to share it.'
            : answer['message'] as String? ??
                  'Could not read its sharing ($error).';
      } else {
        _show(answer);
      }
    });
    focus();
  }

  /// The sharing as the machine holds it now.
  void _show(Map<String, dynamic> answer) {
    _emails = [
      for (final email in answer['emails'] as List? ?? const [])
        if (email is String) email,
    ];
    _sameDomain = answer['sameDomain'] == true;
    _domain = answer['domain'] as String?;
    _members = [
      for (final member in answer['members'] as List? ?? const [])
        if (member is Map) Map<String, dynamic>.from(member),
    ];
  }

  /// Everyone in the list: the addresses named, in order. Whether each uses it now comes from the
  /// machine's members. Since 2026-10-16 a domain share is used like an email one, with no add step,
  /// so the members hold everyone at the domain: they are the switch, not rows.
  List<_Person> get _people {
    bool usingIt(String email) => _members.any(
      (m) => m['email'] == email && ((m['machines'] as num?) ?? 0) > 0,
    );
    return [
      for (final email in _emails) (email: email, usingIt: usingIt(email)),
    ];
  }

  void focus() {
    final target = _loading || _unavailable != null
        ? (_buttons['retry'] ?? _scope)
        : _input;
    if (target.context != null) {
      target.requestFocus();
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && target.context != null) target.requestFocus();
      });
    }
  }

  void _fieldSays(String message, {bool error = true}) {
    setState(() {
      _fieldError = message;
      _fieldIsError = error;
    });
  }

  /// Make the machine's sharing [emails] and [sameDomain], at once. While it is written nothing else
  /// can change; a refusal leaves the sharing as it was and says why.
  Future<bool> _apply(List<String> emails, bool sameDomain) async {
    if (_busy) return false;
    setState(() {
      _busy = true;
      _status = null;
    });
    Map<String, dynamic> answer;
    try {
      answer = await app.setMachineSharing(
        widget.machineId,
        emails,
        sameDomain: sameDomain,
      );
    } catch (error) {
      answer = {
        'error': 'UNAVAILABLE',
        'message': 'Could not reach $_name. Nothing changed.',
      };
    }
    if (!mounted) return false;
    final error = answer['error'];
    setState(() {
      _busy = false;
      if (error == null) {
        _show(answer);
      } else {
        _status =
            answer['message'] as String? ?? 'Could not share it ($error).';
      }
    });
    if (error != null) return false;
    _changed = true;
    return true;
  }

  /// Done: closes, and says where the sharing now stands when it changed here.
  void _done() {
    if (!_changed) return widget.onClose(null);
    final people = _emails.length;
    final parts = [
      if (people > 0) people == 1 ? '1 person' : '$people people',
      if (_sameDomain && _domain != null) 'everyone at $_domain',
    ];
    widget.onClose(
      parts.isEmpty ? 'Not shared.' : 'Shared with ${parts.join(' and ')}.',
    );
  }

  /// Every address typed in the field, shared at once.
  Future<void> _add() async {
    if (_busy || _loading || _composing) return;
    final typed = _value.text
        .split(RegExp(r'[\s,;]+'))
        .map((email) => email.trim().toLowerCase())
        .where((email) => email.isNotEmpty)
        .toList();
    if (typed.isEmpty) {
      _input.requestFocus();
      return;
    }
    final bad = typed
        .where((email) => !_emailPattern.hasMatch(email))
        .firstOrNull;
    if (bad != null) {
      _fieldSays('“$bad” is not an email address.');
      _input.requestFocus();
      return;
    }
    final fresh = typed.where((email) => !_emails.contains(email)).toSet();
    if (fresh.isEmpty) {
      _value.clear();
      _fieldSays(
        typed.length == 1
            ? 'Already shared with ${typed.single}.'
            : 'Already shared with them.',
        error: false,
      );
      return;
    }
    if (_emails.length + fresh.length > machineShareEmailsMax) {
      _fieldSays(
        'A machine can be shared with up to $machineShareEmailsMax people.',
      );
      return;
    }
    final added = await _apply([..._emails, ...fresh], _sameDomain);
    if (added) _value.clear();
    if (mounted) _input.requestFocus();
  }

  Future<void> _remove(String email) async {
    await _apply([..._emails]..remove(email), _sameDomain);
    if (mounted) focus();
  }

  Future<void> _toggleDomain() async {
    if (_domain == null) return;
    await _apply(_emails, !_sameDomain);
  }

  // ── keys ──────────────────────────────────────────────────────────────────────────────────────

  /// The editor's stops, in reading order: Back, the domain switch, (the field,) Share, each person's
  /// remove (or Back and Retry when the sharing could not be read).
  List<({String id, VoidCallback? run})> get _stops {
    if (_loading || _unavailable != null) {
      return [
        (id: 'back', run: _done),
        if (!_loading) (id: 'retry', run: () => unawaited(_load())),
      ];
    }
    return [
      (id: 'back', run: _done),
      if (_domain != null)
        (id: 'domain', run: _busy ? null : () => unawaited(_toggleDomain())),
      (
        id: 'add',
        run: _busy || _value.text.trim().isEmpty
            ? null
            : () => unawaited(_add()),
      ),
      for (final person in _people)
        (
          id: 'remove:${person.email}',
          run: _busy ? null : () => unawaited(_remove(person.email)),
        ),
    ];
  }

  FocusNode _node(String id) =>
      _buttons.putIfAbsent(id, () => FocusNode(debugLabel: id));

  List<FocusNode> get _nodes {
    final stops = _stops.where((stop) => stop.run != null).toList();
    final field = !_loading && _unavailable == null && !_busy;
    const beforeField = {'back', 'domain'};
    return [
      for (final stop in stops)
        if (beforeField.contains(stop.id)) _node(stop.id),
      if (field) _input,
      for (final stop in stops)
        if (!beforeField.contains(stop.id)) _node(stop.id),
    ];
  }

  void _move(bool forward) {
    if (_composing) return;
    final nodes = _nodes;
    if (nodes.isEmpty) return;
    final current = nodes.indexWhere((node) => node.hasFocus);
    final node =
        nodes[current < 0 ? 0 : (current + (forward ? 1 : -1)) % nodes.length];
    node.requestFocus();
    if (node.context case final context?) Scrollable.ensureVisible(context);
  }

  void _tab(bool forward) {
    if (_composing) return;
    final nodes = _nodes;
    final current = nodes.indexWhere((node) => node.hasFocus);
    final next = current + (forward ? 1 : -1);
    if (next >= 0 && next < nodes.length) {
      nodes[next].requestFocus();
    } else if (widget.onSwitchPane != null) {
      widget.onSwitchPane!();
    } else {
      _move(forward);
    }
  }

  void _accept() {
    if (_composing) return;
    if (_input.hasFocus) {
      unawaited(_add());
      return;
    }
    final stop = _stops
        .where((s) => _buttons[s.id]?.hasFocus == true)
        .firstOrNull;
    stop?.run?.call();
  }

  /// The picker's commands, while this editor holds the keys.
  bool handle(String command) {
    if (_composing) return true;
    switch (command) {
      case 'picker.cancel':
        _done();
      case 'picker.accept':
        _scope.hasFocus ? _accept() : focus();
      case 'picker.complete':
        _tab(true);
      case 'picker.complete_back':
        _tab(false);
      case 'picker.next' || 'picker.previous':
        if (!_scope.hasFocus) return false;
        _move(command == 'picker.next');
      default:
        return false;
    }
    return true;
  }

  Widget _keys(Widget child) {
    if (KeymapTheme.of(context) != null) {
      return KeymapRegion(
        contextKind: KeymapContext.picker,
        composing: () => _composing,
        actions: {
          'picker.accept': _accept,
          'picker.cancel': _done,
          'picker.complete': () => _tab(true),
          'picker.complete_back': () => _tab(false),
          'picker.next': () => _move(true),
          'picker.previous': () => _move(false),
        },
        child: child,
      );
    }
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.enter, includeRepeats: false):
            _accept,
        const SingleActivator(
          LogicalKeyboardKey.numpadEnter,
          includeRepeats: false,
        ): _accept,
        const SingleActivator(LogicalKeyboardKey.escape): _done,
        const SingleActivator(LogicalKeyboardKey.tab): () => _tab(true),
        const SingleActivator(LogicalKeyboardKey.tab, shift: true): () =>
            _tab(false),
        const SingleActivator(LogicalKeyboardKey.arrowDown): () => _move(true),
        const SingleActivator(LogicalKeyboardKey.arrowUp): () => _move(false),
      },
      child: child,
    );
  }

  // ── drawing ───────────────────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    grid.AppTheme.watch(context);
    final desktop = DesktopChrome.of(context);
    return _keys(
      Focus(
        focusNode: _scope,
        onFocusChange: widget.onFocusChanged,
        child: desktop ? _desktop(context) : _terminal(context),
      ),
    );
  }

  /// The person's mark: the first letter of their address, in a neutral disc.
  Widget _avatar(String email) => Container(
    width: 28,
    height: 28,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: grid.AppSurface.selectedFill,
      shape: BoxShape.circle,
      border: Border.all(color: DesktopChrome.rim),
    ),
    child: Text(
      email.isEmpty ? '?' : email.characters.first.toUpperCase(),
      style: DesktopChrome.control(medium: true),
    ),
  );

  Widget _spinner() => SizedBox(
    width: 12,
    height: 12,
    child: CircularProgressIndicator(
      strokeWidth: 1.5,
      color: DesktopChrome.muted,
    ),
  );

  Widget _desktop(BuildContext context) {
    final error = Theme.of(context).colorScheme.error;
    final people = _people;
    final fieldBorder = OutlineInputBorder(
      borderRadius: BorderRadius.circular(grid.AppDesktop.fieldRadius),
      borderSide: BorderSide(color: DesktopChrome.rim),
    );
    final inset = BoxDecoration(
      color: DesktopChrome.field,
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      border: Border.all(color: DesktopChrome.rim),
    );
    const gap = SizedBox(height: DesktopChrome.groupGap);
    const small = SizedBox(height: DesktopChrome.controlGap);
    final muted13 = DesktopChrome.text(size: 13, color: DesktopChrome.muted);

    // Back to the machine's details: the way out, beside what it leaves (Esc does the same). The
    // arrow's glyph sits on the column's edge, its 32-point target reaching past it.
    final heading = Transform.translate(
      offset: const Offset(-8, 0),
      child: Row(
        children: [
          AppIconButton(
            key: const ValueKey('machine-sharing:back'),
            icon: AppIcons.arrowLeft,
            tooltip: 'Back',
            color: DesktopChrome.foreground,
            focusNode: _node('back'),
            onPressed: _done,
          ),
          const SizedBox(width: 2),
          Expanded(
            child: Text(
              'Share $_name',
              style: DesktopChrome.heading(),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );

    // What sharing gives, said once and plainly: these people get the owner's own rights.
    final access = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Icon(
            AppIcons.shield,
            size: AppIcons.inlineSize,
            color: DesktopChrome.muted,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            'People you share it with get full access: they can run harnesses, open terminals and read files on it.',
            style: muted13,
          ),
        ),
      ],
    );

    Widget domainRow(String domain) => MergeSemantics(
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          key: const ValueKey('machine-sharing:domain-row'),
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          canRequestFocus: false,
          onTap: _busy ? null : () => unawaited(_toggleDomain()),
          child: Ink(
            decoration: inset,
            padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
            child: Row(
              children: [
                Icon(
                  AppIcons.globe,
                  size: AppIcons.inlineSize,
                  color: DesktopChrome.muted,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Everyone at $domain',
                        style: DesktopChrome.control(medium: true),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        _sameDomain
                            ? 'Anyone with an @$domain address can use it.'
                            : 'Let anyone with an @$domain address use it.',
                        style: DesktopChrome.metadata(),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Switch(
                  key: const ValueKey('machine-sharing:domain'),
                  focusNode: _node('domain'),
                  value: _sameDomain,
                  onChanged: _busy ? null : (_) => unawaited(_toggleDomain()),
                ),
              ],
            ),
          ),
        ),
      ),
    );

    final field = ReadlineKeys(
      controller: _value,
      enabled: !_busy,
      onChanged: (_) {},
      child: TextField(
        key: const ValueKey('machine-sharing-email'),
        controller: _value,
        focusNode: _input,
        readOnly: _busy,
        onTapOutside: (_) {},
        enableSuggestions: false,
        autocorrect: false,
        keyboardType: TextInputType.emailAddress,
        style: DesktopChrome.text(size: 13),
        cursorColor: DesktopChrome.accent,
        decoration: InputDecoration(
          hintText: 'Add people by email',
          hintStyle: muted13,
          prefixIcon: Icon(
            AppIcons.user,
            size: AppIcons.inlineSize,
            color: DesktopChrome.muted,
          ),
          prefixIconConstraints: const BoxConstraints(minWidth: 36),
          border: fieldBorder,
          enabledBorder: _fieldError == null || !_fieldIsError
              ? fieldBorder
              : fieldBorder.copyWith(borderSide: BorderSide(color: error)),
          disabledBorder: fieldBorder,
          focusedBorder: fieldBorder.copyWith(
            borderSide: BorderSide(
              color: _fieldError == null || !_fieldIsError
                  ? DesktopChrome.focusRing
                  : error,
              width: grid.AppDesktop.focusWidth,
            ),
          ),
          filled: true,
          fillColor: DesktopChrome.field,
          isDense: true,
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 10,
            vertical: 11,
          ),
        ),
        onEditingComplete: () {},
      ),
    );

    final addRow = Row(
      children: [
        Expanded(child: field),
        const SizedBox(width: DesktopChrome.controlGap),
        FilledButton(
          key: const ValueKey('machine-sharing:add'),
          focusNode: _node('add'),
          onPressed: !_busy && _value.text.trim().isNotEmpty
              ? () => unawaited(_add())
              : null,
          child: const Text('Share'),
        ),
      ],
    );

    Widget personRow(_Person person) => Padding(
      key: ValueKey('machine-sharing-person:${person.email}'),
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          _avatar(person.email),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  person.email,
                  style: DesktopChrome.control(medium: true),
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    // Colour is never the only signal: the words say it too.
                    if (person.usingIt) ...[
                      Container(
                        width: 6,
                        height: 6,
                        decoration: BoxDecoration(
                          color: grid.AppPalette.online,
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 6),
                    ],
                    Flexible(
                      child: Text(
                        person.usingIt
                            ? 'Using it'
                            : 'Invited · not using it yet',
                        style: DesktopChrome.metadata(),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          AppIconButton(
            key: ValueKey('machine-sharing:remove:${person.email}'),
            icon: AppIcons.close,
            tooltip: 'Stop sharing with ${person.email}',
            destructive: true,
            focusNode: _node('remove:${person.email}'),
            onPressed: _busy ? null : () => unawaited(_remove(person.email)),
          ),
        ],
      ),
    );

    // Only what needs saying: the change under way, or why it was refused.
    final status = Semantics(
      liveRegion: true,
      child: Row(
        children: [
          if (_busy) ...[
            _spinner(),
            const SizedBox(width: 8),
          ] else if (_status != null) ...[
            Icon(AppIcons.circleAlert, size: 14, color: error),
            const SizedBox(width: 8),
          ],
          Flexible(
            child: Text(
              _busy ? 'Saving…' : _status ?? '',
              style: DesktopChrome.text(
                size: 12,
                color: _busy ? DesktopChrome.muted : error,
              ),
            ),
          ),
        ],
      ),
    );

    // Said only when there is something to say: a change under way, a refusal, or Retry.
    final retry = !_loading && _unavailable != null;
    final actions = _busy || _status != null || retry
        ? Row(
            children: [
              Expanded(child: status),
              if (retry)
                TextButton(
                  key: const ValueKey('machine-sharing:retry'),
                  focusNode: _node('retry'),
                  onPressed: () => unawaited(_load()),
                  child: const Text('Retry'),
                ),
            ],
          )
        : null;

    final List<Widget> content;
    if (_loading) {
      content = [
        heading,
        small,
        Row(
          children: [
            _spinner(),
            const SizedBox(width: 8),
            Text('Reading who it is shared with…', style: muted13),
          ],
        ),
      ];
    } else if (_unavailable case final reason?) {
      content = [
        heading,
        small,
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Icon(
                AppIcons.circleAlert,
                size: AppIcons.inlineSize,
                color: error,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(child: Text(reason, style: DesktopChrome.text(size: 13))),
          ],
        ),
      ];
    } else {
      content = [
        heading,
        small,
        access,
        gap,
        if (_domain case final domain?) ...[domainRow(domain), gap],
        Text('People', style: DesktopChrome.control(medium: true)),
        small,
        addRow,
        if (_fieldError case final problem?)
          Padding(
            padding: const EdgeInsets.only(top: 6, left: 2),
            child: Semantics(
              liveRegion: true,
              child: Text(
                problem,
                key: const ValueKey('machine-sharing:field-error'),
                style: DesktopChrome.text(
                  size: 12,
                  color: _fieldIsError ? error : DesktopChrome.muted,
                ),
              ),
            ),
          ),
        if (people.isNotEmpty) ...[small, ...people.map(personRow)],
      ];
    }

    // The pane's whole width: the form is the pane while it is open.
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(18, 10, 18, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ...content,
          if (actions != null) ...[gap, actions],
        ],
      ),
    );
  }

  /// The terminal look: the same form and the same keys, in the terminal's own type.
  Widget _terminal(BuildContext context) {
    final cell = terminalCellSizeOf(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final gap = SizedBox(height: cell.height);
    Widget line(String text, {Color? color}) => Text(
      text,
      style: terminalContentStyle(color: color ?? theme.foreground),
    );
    Widget action(String id, String label, VoidCallback? run) =>
        TerminalTextAction(
          key: ValueKey('machine-sharing:$id'),
          label: label,
          padding: EdgeInsets.zero,
          focusNode: _node(id),
          onPressed: run,
        );
    final people = _people;
    return SingleChildScrollView(
      padding: EdgeInsets.symmetric(
        horizontal: cell.width * 2,
        vertical: cell.height,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              action('back', '←', _done),
              SizedBox(width: cell.width),
              line('Share $_name'),
            ],
          ),
          gap,
          if (_loading)
            line('Reading who it is shared with…', color: theme.muted)
          else if (_unavailable case final reason?) ...[
            line(reason, color: theme.yellow),
            gap,
            action('retry', 'Retry', () => unawaited(_load())),
          ] else ...[
            line(
              'People you share it with get full access: harnesses, terminals and files.',
              color: theme.muted,
            ),
            gap,
            if (_domain case final domain?) ...[
              action(
                'domain',
                '[${_sameDomain ? 'x' : ' '}] Everyone at $domain',
                _busy ? null : () => unawaited(_toggleDomain()),
              ),
              gap,
            ],
            Row(
              children: [
                SizedBox(
                  width: cell.width * 8,
                  child: Text(
                    'email >',
                    style: terminalContentStyle(color: theme.muted),
                  ),
                ),
                Expanded(
                  child: ReadlineKeys(
                    controller: _value,
                    enabled: !_busy,
                    onChanged: (_) {},
                    child: TextField(
                      key: const ValueKey('machine-sharing-email'),
                      controller: _value,
                      focusNode: _input,
                      readOnly: _busy,
                      onTapOutside: (_) {},
                      enableSuggestions: false,
                      autocorrect: false,
                      style: terminalContentStyle(color: theme.foreground),
                      cursorColor: theme.foreground,
                      decoration: const InputDecoration(
                        border: InputBorder.none,
                        isDense: true,
                        isCollapsed: true,
                        contentPadding: EdgeInsets.zero,
                      ),
                      onEditingComplete: () {},
                    ),
                  ),
                ),
              ],
            ),
            gap,
            for (final person in people)
              Row(
                children: [
                  Expanded(
                    child: line(
                      '${person.email}  ${person.usingIt ? 'using it' : 'invited'}',
                    ),
                  ),
                  action(
                    'remove:${person.email}',
                    'Remove',
                    _busy ? null : () => unawaited(_remove(person.email)),
                  ),
                ],
              ),
          ],
          if (_fieldError case final problem?)
            line(problem, color: _fieldIsError ? theme.yellow : theme.muted),
          gap,
          if (_busy)
            line('Saving…', color: theme.muted)
          else if (_status case final status?)
            line(status, color: theme.yellow),
        ],
      ),
    );
  }
}

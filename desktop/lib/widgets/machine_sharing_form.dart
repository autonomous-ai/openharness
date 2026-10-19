import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/desktop_window.dart';
import '../core/guest_folders.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_select_field.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../state/app_state.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'box_chrome.dart' show ReadlineKeys;
import 'desktop_chrome.dart';
import 'remote_folder_picker.dart';
import 'terminal_text_action.dart';

/// The most addresses one machine is shared with (CLI services/sharedMachines.ts `SHARE_EMAILS_MAX`).
const int machineShareEmailsMax = 100;

/// The most folders guests may use there (CLI services/sharedMachines.ts `SHARED_FOLDERS_MAX`).
const int machineSharedFoldersMax = 20;

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
    this.onModalChanged,
    this.chooseFolder,
  });
  final AppNotifier app;
  final String machineId;
  final ValueChanged<String?> onClose;
  final ValueChanged<bool> onFocusChanged;
  final VoidCallback? onSwitchPane;

  /// Told when a dialog of the form's opens over the workspace (true) and closes (false): a picker
  /// that hosts the form steps aside meanwhile instead of closing, which would drop the folder picked.
  final ValueChanged<bool>? onModalChanged;

  /// Picks a folder on the machine being shared, or null when cancelled. Defaults to the macOS
  /// folder panel on this computer and the folder browser on any other (a panel there would browse
  /// this Mac and hand back a path that is not on that machine); tests pass their own.
  final Future<String?> Function(BuildContext context)? chooseFolder;

  @override
  State<MachineSharingForm> createState() => MachineSharingFormState();
}

class MachineSharingFormState extends State<MachineSharingForm> {
  final _scope = FocusNode(debugLabel: 'Machine sharing');
  final _input = FocusNode(debugLabel: 'Share email');
  final _folderInput = FocusNode(debugLabel: 'Share folder');
  final _buttons = <String, FocusNode>{};
  final _value = TextEditingController();
  final _folderValue = TextEditingController();
  bool _loading = true, _busy = false;

  /// Why the sharing could not be read at all; the form offers Retry instead of its controls.
  String? _unavailable;

  /// What is wrong with what was typed, said under the field it was typed in ([_fieldIsError]: in
  /// error ink; otherwise a quiet note, "… already has access").
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

  /// Whether guests can start harnesses there (`ready`), or what turning it on takes (`missing`,
  /// `outdated`, `not-authorized`); null from a CLI that predates guests.
  String? _guestAccess;

  /// Waiting on the admin prompt on that computer, which the first share shows.
  bool _approving = false;

  /// The owner's folders guests may work in there, read only or editable.
  List<GuestFolder> _folders = const [];

  /// What is wrong with the folder typed, said under its field.
  String? _folderError;

  /// A folder picker is open: a second press waits for it.
  bool _choosing = false;

  AppNotifier get app => widget.app;

  /// Whether it is shared with anyone now.
  bool get _sharing => _emails.isNotEmpty || _sameDomain;

  /// What a guest gets, and, until it is on, what sharing will ask of the owner.
  String get _guestNote => _approving
      ? 'Enter your password on $_name to finish setting up.'
      : 'People you invite get their own private space here and use your Claude and '
            'ChatGPT plans. They can’t see your files or harnesses.'
            // Shared already, the notice under this says it (_guestsOffNote).
            '${_guestAccess == null || _guestAccess == 'ready' || _sharing ? '' : ' You’ll enter your password once to set this up.'}';

  /// Why guests cannot use it yet, beside the button that fixes it.
  String get _guestsOffNote => _guestAccess == 'outdated'
      ? 'People you added can’t use it since the update.'
      : 'People you added can’t use it yet.';
  String get _name =>
      app.stateOf(widget.machineId)?.machine.displayName ?? 'this machine';
  bool get _composing =>
      _value.value.composing.isValid && !_value.value.composing.isCollapsed;

  @override
  void initState() {
    super.initState();
    _value.addListener(_typed);
    _folderValue.addListener(_typed);
    unawaited(_load());
  }

  @override
  void dispose() {
    _value.removeListener(_typed);
    _folderValue.removeListener(_typed);
    _scope.dispose();
    _input.dispose();
    _folderInput.dispose();
    _folderValue.dispose();
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
      _folderError = null;
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
        'message': 'Can’t reach $_name. Make sure it’s on and online.',
      };
    }
    if (!mounted) return;
    setState(() {
      _loading = false;
      final error = answer['error'];
      if (error != null) {
        _unavailable = error == 'UNSUPPORTED'
            ? 'Update Harness on $_name to share it.'
            : answer['message'] as String? ?? 'Couldn’t load sharing ($error).';
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
    _guestAccess = answer['guestAccess'] as String? ?? _guestAccess;
    _folders = GuestFolders.fromJson(answer).folders;
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
  ///
  /// The first share turns guest access on first: each guest's harnesses run as their own account
  /// there, which takes one admin prompt on that computer (docs/plans/2026-10-19-guest-machine-sharing-plan.md).
  Future<bool> _apply(List<String> emails, bool sameDomain) async {
    if (_busy) return false;
    setState(() {
      _busy = true;
      _status = null;
    });
    final sharing = emails.isNotEmpty || sameDomain;
    if (sharing && _guestsOff && !await _enableGuests()) return false;
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
        'message': 'Can’t reach $_name. Nothing changed.',
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
            answer['message'] as String? ??
            'Couldn’t save the change ($error).';
      }
    });
    if (error != null) return false;
    _changed = true;
    return true;
  }

  /// Guest access is off there: the helper is missing, or older than this CLI's (an update), or no longer
  /// allowed. Null (a CLI from before guests) is not off.
  bool get _guestsOff => _guestAccess != null && _guestAccess != 'ready';

  /// Turn guest access on there, behind its admin prompt; false, with the reason said, when it was not.
  /// Called with the form busy, or busies it while it waits.
  Future<bool> _enableGuests() async {
    setState(() {
      _busy = true;
      _status = null;
      _approving = true;
    });
    Map<String, dynamic> enabled;
    try {
      enabled = await app.enableMachineGuests(widget.machineId);
    } catch (error) {
      enabled = {
        'error': 'UNAVAILABLE',
        'message': 'Can’t reach $_name. Nothing changed.',
      };
    }
    if (!mounted) return false;
    final refused = enabled['error'];
    setState(() {
      _approving = false;
      if (refused != null) {
        _busy = false;
        _status =
            enabled['message'] as String? ??
            'Couldn’t turn on sharing ($refused).';
      } else {
        _guestAccess = enabled['guestAccess'] as String? ?? 'ready';
      }
    });
    return refused == null;
  }

  /// Turn on, on its own: shared already, but guests cannot start harnesses until it is on again.
  Future<void> _turnGuestsOn() async {
    if (_busy) return;
    if (await _enableGuests() && mounted) setState(() => _busy = false);
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
      _fieldSays('“$bad” isn’t a valid email address.');
      _input.requestFocus();
      return;
    }
    final fresh = typed.where((email) => !_emails.contains(email)).toSet();
    if (fresh.isEmpty) {
      _value.clear();
      _fieldSays(
        typed.length == 1
            ? '${typed.single} already has access.'
            : 'They already have access.',
        error: false,
      );
      return;
    }
    if (_emails.length + fresh.length > machineShareEmailsMax) {
      _fieldSays('You can invite up to $machineShareEmailsMax people.');
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

  /// Make the folders guests may use [folders], at once; a refusal (a folder that is not the owner's,
  /// or not there) leaves them as they were and says why.
  Future<bool> _applyFolders(List<GuestFolder> folders) async {
    if (_busy) return false;
    setState(() {
      _busy = true;
      _status = null;
    });
    Map<String, dynamic> answer;
    try {
      answer = await app.setMachineGuestFolders(widget.machineId, folders);
    } catch (error) {
      answer = {
        'error': 'UNAVAILABLE',
        'message': 'Can’t reach $_name. Nothing changed.',
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
            answer['message'] as String? ??
            'Couldn’t share the folder ($error).';
      }
    });
    if (error != null) return false;
    _changed = true;
    return true;
  }

  /// A folder picked on that machine, shared as one typed would be.
  Future<void> _chooseFolder() async {
    if (_busy || _loading || _choosing) return;
    setState(() => _choosing = true);
    String? picked;
    try {
      picked = await (widget.chooseFolder ?? _pickFolder)(context);
    } finally {
      if (mounted) setState(() => _choosing = false);
    }
    if (!mounted) return;
    if (picked == null || picked.trim().isEmpty) {
      _focusFolders();
      return;
    }
    await _addFolder(picked.trim());
  }

  Future<String?> _pickFolder(BuildContext context) {
    final typed = _folderValue.text.trim();
    final start = typed.startsWith('/') ? typed : null;
    return app.stateOf(widget.machineId)?.isLocalMachine == true
        ? whileNativePicker(
            () => getDirectoryPath(
              initialDirectory: start,
              confirmButtonText: 'Share',
            ),
          )
        : _modal(
            () => showRemoteFolderPicker(
              context,
              notifier: app,
              machineId: widget.machineId,
              initialPath: start,
              desktop: true,
            ),
          );
  }

  Future<T> _modal<T>(Future<T> Function() dialog) async {
    widget.onModalChanged?.call(true);
    try {
      return await dialog();
    } finally {
      widget.onModalChanged?.call(false);
    }
  }

  /// The folder typed (or [chosen]), shared read only: a guest's harness may read it, and the
  /// switch lets it edit. Nothing typed opens the picker.
  Future<void> _addFolder([String? chosen]) async {
    if (_busy || _loading) return;
    final typed = chosen ?? _folderValue.text.trim();
    if (typed.isEmpty) {
      await _chooseFolder();
      return;
    }
    final path = typed.length > 1 && typed.endsWith('/')
        ? typed.substring(0, typed.length - 1)
        : typed;
    String? problem;
    if (!path.startsWith('/')) {
      problem =
          'Enter the folder’s full path on $_name, like /Users/you/project.';
    } else if (_folders.any((folder) => folder.path == path)) {
      problem = '${_folderName(path)} is already shared.';
    } else if (_folders.length >= machineSharedFoldersMax) {
      problem = 'You can share up to $machineSharedFoldersMax folders.';
    }
    if (problem != null) {
      setState(() => _folderError = problem);
      _focusFolders();
      return;
    }
    final added = await _applyFolders([
      ..._folders,
      GuestFolder(path: path, write: false),
    ]);
    if (added && chosen == null) _folderValue.clear();
    if (mounted) _focusFolders();
  }

  /// Back to where folders are added: Add Folder on the desktop, the path field in the terminal look.
  void _focusFolders() {
    if (!mounted) return;
    (DesktopChrome.of(context) ? _node('folder-choose') : _folderInput)
        .requestFocus();
  }

  Future<void> _toggleFolderWrite(String path) => _applyFolders([
    for (final folder in _folders)
      folder.path == path
          ? GuestFolder(path: path, write: !folder.write)
          : folder,
  ]);

  Future<void> _removeFolder(String path) async {
    await _applyFolders([
      for (final folder in _folders)
        if (folder.path != path) folder,
    ]);
    if (mounted) focus();
  }

  // ── keys ──────────────────────────────────────────────────────────────────────────────────────

  /// The editor's stops, in reading order: Back, the domain switch, (the field,) Share, each person's
  /// remove (or Back and Retry when the sharing could not be read).
  List<({String id, VoidCallback? run})> get _stops {
    final desktop = DesktopChrome.of(context);
    if (_loading || _unavailable != null) {
      return [
        (id: 'back', run: _done),
        if (!_loading) (id: 'retry', run: () => unawaited(_load())),
      ];
    }
    return [
      (id: 'back', run: _done),
      if (_guestsOff && _sharing)
        (id: 'guests-on', run: _busy ? null : () => unawaited(_turnGuestsOn())),
      if (_domain != null)
        (id: 'domain', run: _busy ? null : () => unawaited(_toggleDomain())),
      // Invite and Add Folder are buttons on the desktop only; the terminal look takes Enter in its
      // fields instead, and a stop with nothing drawn would hold the focus nowhere.
      if (desktop)
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
      if (desktop)
        (
          id: 'folder-choose',
          run: _busy || _choosing ? null : () => unawaited(_chooseFolder()),
        ),
      for (final folder in _folders) ...[
        (
          id: 'folder-write:${folder.path}',
          run: _busy ? null : () => unawaited(_toggleFolderWrite(folder.path)),
        ),
        (
          id: 'folder-remove:${folder.path}',
          run: _busy ? null : () => unawaited(_removeFolder(folder.path)),
        ),
      ],
    ];
  }

  FocusNode _node(String id) =>
      _buttons.putIfAbsent(id, () => FocusNode(debugLabel: id));

  List<FocusNode> get _nodes {
    final stops = _stops.where((stop) => stop.run != null).toList();
    final field = !_loading && _unavailable == null && !_busy;
    // The desktop adds folders with Add Folder; only the terminal look has a path field.
    final pathField = field && !DesktopChrome.of(context);
    const beforeField = {'back', 'guests-on', 'domain'};
    bool folders(String id) => id.startsWith('folder-');
    return [
      for (final stop in stops)
        if (beforeField.contains(stop.id)) _node(stop.id),
      if (field) _input,
      for (final stop in stops)
        if (!beforeField.contains(stop.id) && !folders(stop.id)) _node(stop.id),
      if (pathField) _folderInput,
      for (final stop in stops)
        if (folders(stop.id)) _node(stop.id),
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
    if (_folderInput.hasFocus) {
      unawaited(_addFolder());
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

  /// A row's mark in a neutral disc: a person's first letter, or a symbol for the domain and folders.
  Widget _disc({String? letter, IconData? icon}) => Container(
    width: 28,
    height: 28,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: grid.AppSurface.selectedFill,
      shape: BoxShape.circle,
      border: Border.all(color: DesktopChrome.rim),
    ),
    child: icon != null
        ? Icon(icon, size: 14, color: DesktopChrome.muted)
        : Text(
            letter == null || letter.isEmpty
                ? '?'
                : letter.characters.first.toUpperCase(),
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

    // What sharing gives, said once and plainly: guests get a space of their own, never the owner's.
    final access = Text(_guestNote, style: muted13);

    // Shared, but guests cannot start anything until guest access is on: said once, beside the fix.
    final guestsOff = Container(
      key: const ValueKey('machine-sharing:guests-off'),
      decoration: inset,
      padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
      child: Row(
        children: [
          Icon(
            AppIcons.circleAlert,
            size: AppIcons.inlineSize,
            color: DesktopChrome.muted,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(_guestsOffNote, style: DesktopChrome.text(size: 13)),
          ),
          const SizedBox(width: DesktopChrome.controlGap),
          FilledButton(
            key: const ValueKey('machine-sharing:guests-on'),
            focusNode: _node('guests-on'),
            onPressed: _busy ? null : () => unawaited(_turnGuestsOn()),
            child: const Text('Turn On Sharing'),
          ),
        ],
      ),
    );

    Widget section(String title, {String? detail}) => Padding(
      padding: const EdgeInsets.only(bottom: DesktopChrome.controlGap),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: DesktopChrome.control(medium: true)),
          if (detail != null) ...[
            const SizedBox(height: 4),
            Text(detail, style: muted13),
          ],
        ],
      ),
    );

    // One list anatomy for people, the domain and folders: a mark, the name, a line of context,
    // then the controls at the right edge.
    Widget listRow({
      required Key key,
      required Widget mark,
      required String title,
      required Widget subtitle,
      required List<Widget> trailing,
      String? tooltip,
    }) {
      Widget name = Text(
        title,
        style: DesktopChrome.control(medium: true),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      );
      if (tooltip != null) name = Tooltip(message: tooltip, child: name);
      return Padding(
        key: key,
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            mark,
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [name, const SizedBox(height: 2), subtitle],
              ),
            ),
            const SizedBox(width: 8),
            ...trailing,
          ],
        ),
      );
    }

    Widget quiet(String text) => Text(
      text,
      style: DesktopChrome.metadata(),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );

    Widget domainRow(String domain) => MergeSemantics(
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          key: const ValueKey('machine-sharing:domain-row'),
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          canRequestFocus: false,
          onTap: _busy ? null : () => unawaited(_toggleDomain()),
          child: listRow(
            key: const ValueKey('machine-sharing-domain'),
            mark: _disc(icon: AppIcons.globe),
            title: 'Everyone at $domain',
            subtitle: quiet(
              _sameDomain
                  ? 'Anyone with an @$domain email can use it.'
                  : 'Let anyone with an @$domain email use it.',
            ),
            trailing: [
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
          hintText: 'Email address',
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
          child: const Text('Invite'),
        ),
      ],
    );

    // Adding a folder is choosing one: the macOS panel here, the folder browser on another machine.
    // Both still take a typed path (⇧⌘G in the panel, the path field in the browser).
    final addFolder = OutlinedButton.icon(
      key: const ValueKey('machine-sharing:folder-choose'),
      focusNode: _node('folder-choose'),
      onPressed: !_busy && !_choosing ? () => unawaited(_chooseFolder()) : null,
      icon: const Icon(AppIcons.plus, size: AppIcons.inlineSize),
      label: const Text('Add Folder…'),
    );

    // How much a guest may do in a folder, the way a Mac's File Sharing says it.
    Widget accessMenu(GuestFolder folder) => AppSelectField<bool>(
      key: ValueKey('machine-sharing:folder-write:${folder.path}'),
      focusNode: _node('folder-write:${folder.path}'),
      value: folder.write,
      width: 112,
      menuWidth: 232,
      menuAlignedToEnd: true,
      semanticLabel: 'Access to ${_folderName(folder.path)}',
      options: const [
        SelectOption(
          value: false,
          label: 'Can view',
          detail: 'Open and read files',
        ),
        SelectOption(
          value: true,
          label: 'Can edit',
          detail: 'Also change, add and delete files',
        ),
      ],
      onChanged: (write) {
        if (_busy || write == folder.write) return;
        unawaited(_toggleFolderWrite(folder.path));
      },
    );

    Widget folderRow(GuestFolder folder) => listRow(
      key: ValueKey('machine-sharing-folder:${folder.path}'),
      mark: _disc(icon: AppIcons.folder),
      title: _folderName(folder.path),
      tooltip: folder.path,
      subtitle: quiet(_folderParent(folder.path)),
      trailing: [
        accessMenu(folder),
        const SizedBox(width: 4),
        AppIconButton(
          key: ValueKey('machine-sharing:folder-remove:${folder.path}'),
          icon: AppIcons.close,
          tooltip: 'Stop sharing ${_folderName(folder.path)}',
          destructive: true,
          focusNode: _node('folder-remove:${folder.path}'),
          onPressed: _busy ? null : () => unawaited(_removeFolder(folder.path)),
        ),
      ],
    );

    Widget personRow(_Person person) => listRow(
      key: ValueKey('machine-sharing-person:${person.email}'),
      mark: _disc(letter: person.email),
      title: person.email,
      subtitle: Row(
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
          Flexible(child: quiet(person.usingIt ? 'Joined' : 'Invited')),
        ],
      ),
      trailing: [
        AppIconButton(
          key: ValueKey('machine-sharing:remove:${person.email}'),
          icon: AppIcons.close,
          tooltip: 'Remove ${person.email}',
          destructive: true,
          focusNode: _node('remove:${person.email}'),
          onPressed: _busy ? null : () => unawaited(_remove(person.email)),
        ),
      ],
    );

    Widget problem(String text, Key key, {bool isError = true}) => Padding(
      padding: const EdgeInsets.only(top: 6, left: 2),
      child: Semantics(
        liveRegion: true,
        child: Text(
          text,
          key: key,
          style: DesktopChrome.text(
            size: 12,
            color: isError ? error : DesktopChrome.muted,
          ),
        ),
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
            Text('Loading…', style: muted13),
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
        if (_guestsOff && _sharing) ...[gap, guestsOff],
        gap,
        section('People'),
        addRow,
        if (_fieldError case final said?)
          problem(
            said,
            const ValueKey('machine-sharing:field-error'),
            isError: _fieldIsError,
          ),
        if (people.isNotEmpty || _domain != null) small,
        ...people.map(personRow),
        if (_domain case final domain?) domainRow(domain),
        gap,
        section(
          'Folders',
          detail: 'People you share with see everything inside, even passwords and keys.',
        ),
        ..._folders.map(folderRow),
        if (_folders.isNotEmpty) small,
        Align(alignment: AlignmentDirectional.centerStart, child: addFolder),
        if (_folderError case final said?)
          problem(said, const ValueKey('machine-sharing:folder-error')),
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
            line('Loading…', color: theme.muted)
          else if (_unavailable case final reason?) ...[
            line(reason, color: theme.yellow),
            gap,
            action('retry', 'Retry', () => unawaited(_load())),
          ] else ...[
            line(_guestNote, color: theme.muted),
            if (_guestsOff && _sharing)
              action(
                'guests-on',
                'Turn on sharing',
                _busy ? null : () => unawaited(_turnGuestsOn()),
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
                      '${person.email}  ${person.usingIt ? 'joined' : 'invited'}',
                    ),
                  ),
                  action(
                    'remove:${person.email}',
                    'Remove',
                    _busy ? null : () => unawaited(_remove(person.email)),
                  ),
                ],
              ),
            gap,
            line(
              'Folders they can open. They see everything inside, including passwords or keys.',
              color: theme.muted,
            ),
            Row(
              children: [
                SizedBox(
                  width: cell.width * 8,
                  child: Text(
                    'folder >',
                    style: terminalContentStyle(color: theme.muted),
                  ),
                ),
                Expanded(
                  child: ReadlineKeys(
                    controller: _folderValue,
                    enabled: !_busy,
                    onChanged: (_) {},
                    child: TextField(
                      key: const ValueKey('machine-sharing-folder'),
                      controller: _folderValue,
                      focusNode: _folderInput,
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
            for (final folder in _folders)
              Row(
                children: [
                  Expanded(child: line(folder.path)),
                  action(
                    'folder-write:${folder.path}',
                    '[${folder.write ? 'x' : ' '}] can edit',
                    _busy
                        ? null
                        : () => unawaited(_toggleFolderWrite(folder.path)),
                  ),
                  SizedBox(width: cell.width),
                  action(
                    'folder-remove:${folder.path}',
                    'Remove',
                    _busy ? null : () => unawaited(_removeFolder(folder.path)),
                  ),
                ],
              ),
            if (_folderError case final problem?)
              line(problem, color: theme.yellow),
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

/// A folder's own name: what a person recognises it by.
String _folderName(String path) {
  final parts = path.split('/').where((part) => part.isNotEmpty);
  return parts.isEmpty ? '/' : parts.last;
}

/// Where it is: the folder that holds it.
String _folderParent(String path) {
  final cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.substring(0, cut);
}

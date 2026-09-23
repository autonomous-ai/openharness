import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;

import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';

/// Browses the selected machine through fs_list_dir. The native folder chooser
/// would return a path on this computer instead of the agent's machine.
Future<String?> showRemoteFolderPicker(
  BuildContext context, {
  required AppNotifier notifier,
  required String machineId,
  String? initialPath,
}) => showAppDialog<String>(
  context: context,
  builder: (context) => _RemoteFolderPickerDialog(
    notifier: notifier,
    machineId: machineId,
    initialPath: initialPath,
  ),
);

/// What a thumb gets: the path field and the two buttons under it, one height.
///
/// 44 rather than the 48 Material puts under a touch target, because this is a
/// sheet of rows with a field at the top of it, not a toolbar: at 50 the button
/// read as the heaviest thing on the screen and the sheet as a form built
/// around it. The whole row of controls still clears iOS's own 44 floor.
const double _touchControlHeight = 44;

class _RemoteFolderPickerDialog extends StatefulWidget {
  const _RemoteFolderPickerDialog({
    required this.notifier,
    required this.machineId,
    this.initialPath,
  });

  final AppNotifier notifier;
  final String machineId;
  final String? initialPath;

  @override
  State<_RemoteFolderPickerDialog> createState() =>
      _RemoteFolderPickerDialogState();
}

class _RemoteFolderPickerDialogState extends State<_RemoteFolderPickerDialog> {
  final _location = TextEditingController();
  final _locationFocus = FocusNode(debugLabel: 'Remote folder path');
  final _foldersFocus = FocusNode(debugLabel: 'Remote folders');
  final _scroll = ScrollController();
  String? _path, _requestedPath, _error;
  List<String> _entries = [];
  bool _loading = true, _truncated = false;
  int _request = 0, _edit = 0, _selected = -1;
  double _rowHeight = 36;

  bool get _canSelect =>
      !_loading &&
      _error == null &&
      _path != null &&
      _location.text.trim() == _path;

  // The remote machine may use different path separators than this desktop.
  p.Context get _paths => p.Context(
    style:
        (_path?.startsWith(r'\\') ?? false) ||
            RegExp(r'^[A-Za-z]:[/\\]').hasMatch(_path ?? '')
        ? p.Style.windows
        : p.Style.posix,
  );

  String? get _parentPath {
    if (_path == null) return null;
    final parent = _paths.dirname(_path!);
    return parent == _path ? null : parent;
  }

  @override
  void initState() {
    super.initState();
    _load(widget.initialPath);
    // ⚠️ **The SECOND way this field took the keyboard, and the one that
    // survived turning `autofocus` off.** A dialog's first frame has no focus
    // to give, so this asked for it a frame later — which on a phone is a
    // keyboard over the folder list a moment after it is read, and it went on
    // happening with `autofocus: false` because it is not the same mechanism.
    // Both are gated on the same fact now; see the field's `autofocus` for
    // what the fact is.
    //
    // `defaultTargetPlatform`, not `Theme.of(context).platform`, because there
    // is no context to read a theme from here.
    if (defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS) {
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _locationFocus.requestFocus();
    });
  }

  @override
  void dispose() {
    // ⚠️ **Here, not only on Cancel, because Cancel is not the only way out.**
    // The barrier behind this dialog dismisses it too, and so does Back — both
    // take the sheet away and neither passes through a button of ours, so the
    // keyboard was left standing over a screen with no field in it. Dispose is
    // the one place every exit meets.
    //
    // Told to the platform rather than dropped as focus: see [_hideKeyboard]
    // for why the two are not the same thing.
    unawaited(SystemChannels.textInput.invokeMethod<void>('TextInput.hide'));
    _location.dispose();
    _locationFocus.dispose();
    _foldersFocus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load(String? path, {String? highlight}) async {
    if (_loading && _request > 0 && path == _requestedPath) return;
    final request = ++_request;
    final edit = _edit;
    setState(() {
      _loading = true;
      _error = null;
      _requestedPath = path;
      if (_location.text != (path ?? '')) {
        _location.text = path ?? '';
        _location.selection = TextSelection.collapsed(
          offset: _location.text.length,
        );
      }
    });
    Map<String, dynamic> result;
    try {
      result = await widget.notifier.listRemoteFolder(widget.machineId, path);
    } catch (_) {
      result = {'error': 'UNREACHABLE'};
    }
    if (!mounted || request != _request) return;
    final resolved = result['path'];
    final error = result['error'];
    if (error != null || resolved is! String || resolved.isEmpty) {
      setState(() {
        _loading = false;
        _error = edit != _edit
            ? null
            : error is String
            ? error
            : 'UNAVAILABLE';
      });
      return;
    }
    setState(() {
      _loading = false;
      _path = resolved;
      _entries = [
        for (final entry in result['entries'] as List? ?? const [])
          if (entry is Map &&
              entry['isDir'] != false &&
              entry['name'] is String &&
              (entry['name'] as String).isNotEmpty)
            entry['name'] as String,
      ];
      _truncated = result['truncated'] == true;
      _selected = _entries.isEmpty
          ? -1
          : math.max(0, _entries.indexOf(highlight ?? ''));
      // A reply may canonicalize a path, but must not replace a newer draft or
      // disturb a selection/caret when the field already contains that path.
      if (edit == _edit && _location.text != resolved) {
        _location.value = TextEditingValue(
          text: resolved,
          selection: TextSelection(
            baseOffset: 0,
            extentOffset: resolved.length,
          ),
        );
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && request == _request) _revealSelection();
    });
  }

  void _openPath() {
    final path = _location.text.trim();
    if (path.isEmpty || (_loading && path == _requestedPath)) return;
    _load(path);
  }

  void _up() {
    if (_loading) return;
    final parent = _parentPath;
    if (parent != null) _load(parent, highlight: _paths.basename(_path!));
  }

  void _select() {
    if (_canSelect) Navigator.of(context).pop(_path);
  }

  void _openSelected() {
    if (!_loading && _selected >= 0 && _selected < _entries.length) {
      _load(_paths.join(_path!, _entries[_selected]));
    }
  }

  void _revealSelection() {
    if (!_scroll.hasClients || _selected < 0) return;
    final top = _selected * _rowHeight;
    final bottom = top + _rowHeight;
    final position = _scroll.position;
    final target = top < position.pixels
        ? top
        : bottom > position.pixels + position.viewportDimension
        ? bottom - position.viewportDimension
        : position.pixels;
    _scroll.jumpTo(target.clamp(0.0, position.maxScrollExtent));
  }

  /// Puts the software keyboard away.
  ///
  /// ⚠️ **Dropping focus is not enough, and the screenshot of it failing is why
  /// this exists.** `unfocus()` alone left the field drawn unfocused — its label
  /// grey — with the keyboard still standing over the folder list: the dialog's
  /// focus scope takes the focus back, the engine is never told the input
  /// connection is finished, and iOS keeps the keyboard for whatever it thinks
  /// is still editing. Telling the platform outright is what actually closes
  /// it; the unfocus stays so the field also STOPS looking like it is being
  /// typed into.
  void _hideKeyboard() {
    _locationFocus.unfocus();
    FocusManager.instance.primaryFocus?.unfocus();
    unawaited(SystemChannels.textInput.invokeMethod<void>('TextInput.hide'));
  }

  KeyEventResult _folderKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isControlPressed ||
        keyboard.isMetaPressed ||
        keyboard.isAltPressed ||
        keyboard.isShiftPressed) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.arrowLeft) {
      _up();
    } else if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter ||
        key == LogicalKeyboardKey.arrowRight) {
      _openSelected();
    } else if (key == LogicalKeyboardKey.arrowDown ||
        key == LogicalKeyboardKey.arrowUp ||
        key == LogicalKeyboardKey.home ||
        key == LogicalKeyboardKey.end) {
      if (!_loading && _entries.isNotEmpty) {
        setState(() {
          _selected = switch (key) {
            LogicalKeyboardKey.home => 0,
            LogicalKeyboardKey.end => _entries.length - 1,
            LogicalKeyboardKey.arrowUp => (_selected - 1).clamp(
              0,
              _entries.length - 1,
            ),
            _ => (_selected + 1).clamp(0, _entries.length - 1),
          };
        });
        _revealSelection();
      }
    } else {
      return KeyEventResult.ignored;
    }
    return KeyEventResult.handled;
  }

  String _errorMessage(String code) => switch (code) {
    'FORBIDDEN' =>
      'Choose a folder inside your home directory on this machine.',
    'PERMISSION_DENIED' => 'You don’t have permission to open this folder.',
    'NOT_A_DIRECTORY' => 'That path is not a folder.',
    'NOT_FOUND' =>
      'This folder could not be found. Check the path and try again.',
    'INVALID_PATH' => 'Enter a full folder path on this machine.',
    'UNREACHABLE' =>
      'Couldn’t reach this machine. Check its connection and retry.',
    _ => 'Couldn’t open this folder. Try again.',
  };

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final scale = MediaQuery.textScalerOf(context);
    _rowHeight = math.max(36, scale.scale(14) * 1.35 + 16);
    final listHeight =
        (MediaQuery.sizeOf(context).height - 320 - scale.scale(50)).clamp(
          120.0,
          280.0,
        );
    final machine = widget.notifier
        .stateOf(widget.machineId)
        ?.machine
        .displayName;
    final mac = Theme.of(context).platform == TargetPlatform.macOS;
    // A platform with a software keyboard: the one where raising it costs the
    // list this sheet exists to show. See the field's `autofocus`.
    final touch =
        Theme.of(context).platform == TargetPlatform.android ||
        Theme.of(context).platform == TargetPlatform.iOS;
    // ⚠️ **On a phone the buttons take the FIELD's height, by forcing both to
    // one number.** They are the two things a thumb aims at in this sheet, and
    // the buttons were sized for a mouse — a desktop control height, a third
    // shorter than the box above them. Matching by eye would drift the moment
    // either side's padding changed; [_touchControlHeight] is given to the
    // field's decoration and to the buttons alike, so they are equal by
    // construction. A desktop keeps its compact controls.
    final actionStyle = ButtonStyle(
      minimumSize: WidgetStatePropertyAll(
        Size(
          0,
          touch
              ? _touchControlHeight
              : math.max(
                  grid.AppControl.heightScaled,
                  scale.scale(grid.AppControl.fontSize) * 1.25 + 16,
                ),
        ),
      ),
    );
    return IconButtonTheme(
      data: IconButtonThemeData(
        style: ButtonStyle(
          minimumSize: const WidgetStatePropertyAll(Size(32, 32)),
          padding: const WidgetStatePropertyAll(EdgeInsets.all(6)),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(grid.AppControl.radius),
            ),
          ),
          overlayColor: WidgetStatePropertyAll(grid.AppSurface.hoverFill),
          foregroundColor: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.disabled)
                ? AppColors.muted
                : states.contains(WidgetState.hovered) ||
                      states.contains(WidgetState.focused)
                ? AppColors.text
                : AppColors.textSoft,
          ),
        ),
      ),
      child: CallbackShortcuts(
        bindings: {
          SingleActivator(
            LogicalKeyboardKey.enter,
            meta: mac,
            control: !mac,
            includeRepeats: false,
          ): _select,
          const SingleActivator(LogicalKeyboardKey.arrowUp, alt: true): _up,
        },
        child: AlertDialog(
          title: const Text('Choose a folder'),
          scrollable: true,
          content: SizedBox(
            width: 520,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'On ${machine ?? 'the remote machine'}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 12),
                Focus(
                  onKeyEvent: (node, event) {
                    if (event is KeyDownEvent &&
                        event.logicalKey == LogicalKeyboardKey.arrowDown &&
                        !HardwareKeyboard.instance.isAltPressed &&
                        !HardwareKeyboard.instance.isControlPressed &&
                        !HardwareKeyboard.instance.isMetaPressed &&
                        !HardwareKeyboard.instance.isShiftPressed &&
                        _location.value.composing.isCollapsed &&
                        !_loading &&
                        _entries.isNotEmpty) {
                      _foldersFocus.requestFocus();
                      _revealSelection();
                      return KeyEventResult.handled;
                    }
                    return KeyEventResult.ignored;
                  },
                  child: TextField(
                    key: const Key('remote-folder-path'),
                    controller: _location,
                    focusNode: _locationFocus,
                    // ⚠️ **Not on a phone, and that is not a style choice.**
                    // This field is the way in for somebody who knows the path
                    // already; everybody else came to BROWSE, and the list they
                    // came for is what the keyboard covers. On a desktop the
                    // field costs nothing — there is no keyboard to raise and
                    // the list is still there — so the focus stays where it
                    // was useful.
                    autofocus: !touch,
                    // Tapping the sheet anywhere but the field puts the
                    // keyboard away, rather than leaving it up over the folders
                    // with nothing typing into it.
                    onTapOutside: (_) => _hideKeyboard(),
                    style: grid.kFieldTextStyle,
                    decoration: InputDecoration(
                      // See [actionStyle] — the buttons below take this same
                      // height.
                      constraints: touch
                          ? const BoxConstraints.tightFor(
                              height: _touchControlHeight,
                            )
                          : null,
                      isDense: touch,
                      labelText: 'Folder path',
                      hintText: 'Enter a full folder path…',
                      suffixIcon: IconButton(
                        tooltip: 'Open path',
                        onPressed:
                            _location.text.trim().isEmpty ||
                                (_loading &&
                                    _location.text.trim() == _requestedPath)
                            ? null
                            : _openPath,
                        icon: const Icon(Icons.arrow_forward, size: 18),
                      ),
                    ),
                    onChanged: (_) => setState(() {
                      _edit++;
                      _error = null;
                    }),
                    onEditingComplete: () {},
                    onSubmitted: (_) => _openPath(),
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        _path != null && _location.text.trim() != _path
                            ? 'Showing $_path'
                            : 'Folders',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.labelMedium,
                      ),
                    ),
                    IconButton(
                      key: const Key('remote-folder-home'),
                      tooltip: 'Home folder on this machine',
                      onPressed: () => _load(null),
                      icon: const Icon(Icons.home_outlined, size: 18),
                    ),
                    IconButton(
                      tooltip: mac
                          ? 'Up one folder (⌥↑)'
                          : 'Up one folder (Alt+↑)',
                      onPressed: _loading || _parentPath == null ? null : _up,
                      icon: const Icon(Icons.arrow_upward, size: 18),
                    ),
                  ],
                ),
                Focus(
                  focusNode: _foldersFocus,
                  onKeyEvent: _folderKey,
                  onFocusChange: (_) => setState(() {}),
                  child: Container(
                    key: const Key('remote-folder-list'),
                    height: listHeight,
                    decoration: BoxDecoration(
                      color: AppColors.background,
                      border: Border.all(
                        color: _foldersFocus.hasFocus
                            ? AppColors.accent
                            : AppColors.border,
                      ),
                      borderRadius: BorderRadius.circular(
                        grid.AppCard.insetRadius,
                      ),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: _loading
                        ? const _FolderRowsSkeleton()
                        : _entries.isEmpty
                        ? Center(
                            child: Padding(
                              padding: const EdgeInsets.all(16),
                              child: Text(
                                _path == null
                                    ? 'Enter a path or open your home folder.'
                                    : 'No subfolders here.',
                                textAlign: TextAlign.center,
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                            ),
                          )
                        : ListView.builder(
                            // ⚠️ Zero, not the default. A ListView left to choose pads itself with
                            // the screen's safe-area insets — on a phone the status bar above and
                            // the gesture bar below — even inside this boxed dialog, where neither
                            // is anywhere near it. A home folder with one subfolder then drew that
                            // row halfway down an empty box.
                            padding: EdgeInsets.zero,
                            controller: _scroll,
                            itemExtent: _rowHeight,
                            itemCount: _entries.length,
                            itemBuilder: (context, index) => Semantics(
                              selected: index == _selected,
                              child: Material(
                                color:
                                    index == _selected && _foldersFocus.hasFocus
                                    ? AppColors.selected
                                    : Colors.transparent,
                                child: InkWell(
                                  canRequestFocus: false,
                                  onTap: () {
                                    _foldersFocus.requestFocus();
                                    setState(() => _selected = index);
                                    _openSelected();
                                  },
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 12,
                                    ),
                                    child: Row(
                                      children: [
                                        Icon(
                                          Icons.folder_outlined,
                                          size: 18,
                                          color: AppColors.mutedStrong,
                                        ),
                                        const SizedBox(width: 10),
                                        Expanded(
                                          child: Text(
                                            _entries[index],
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                        ),
                                        Icon(
                                          Icons.chevron_right,
                                          size: 16,
                                          color: AppColors.mutedStrong,
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 8),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Semantics(
                          liveRegion: true,
                          child: Text(
                            _errorMessage(_error!),
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(color: AppColors.danger),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      TextButton(
                        onPressed: () => _load(_requestedPath),
                        child: const Text('Retry'),
                      ),
                    ],
                  ),
                ] else if (_truncated && !_loading) ...[
                  const SizedBox(height: 8),
                  Text(
                    'More folders are available. Enter their full path to open them.',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              style: actionStyle,
              // The keyboard goes with the sheet. Popped while the field still
              // holds focus, it stayed up over whatever the sheet was covering
              // — and the screen behind had no field for it to be typing into.
              onPressed: () {
                _hideKeyboard();
                Navigator.of(context).pop();
              },
              child: const Text('Cancel'),
            ),
            Tooltip(
              message: mac
                  ? 'Select this folder (⌘↩)'
                  : 'Select this folder (Ctrl+Enter)',
              child: FilledButton(
                style: actionStyle,
                onPressed: _canSelect ? _select : null,
                child: const Text('Select this folder'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _FolderRowsSkeleton extends StatelessWidget {
  const _FolderRowsSkeleton();

  @override
  Widget build(BuildContext context) => SkeletonList(
    rows: 5,
    semanticsLabel: 'Loading folders',
    itemBuilder: (context, i) => Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      child: Row(
        children: [
          const Skeleton(width: 18, height: 18, radius: 3),
          const SizedBox(width: 10),
          Expanded(
            child: SkeletonText(
              style: Theme.of(context).textTheme.bodyMedium!,
              widthFactor: const [0.42, 0.28, 0.56, 0.34, 0.48][i],
            ),
          ),
        ],
      ),
    ),
  );
}

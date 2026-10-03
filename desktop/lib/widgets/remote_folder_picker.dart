import 'dart:async';
import 'dart:math' as math;

import '../terminal/terminal_text.dart';

import '../shared/widgets/labeled_field.dart';

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;

import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import 'desktop_chrome.dart';

/// Browses the selected machine through fs_list_dir. The native folder chooser
/// would return a path on this computer instead of the agent's machine.
Future<String?> showRemoteFolderPicker(
  BuildContext context, {
  required AppNotifier notifier,
  required String machineId,
  String? initialPath,
  bool terminal = false,
  bool desktop = false,
}) => showAppDialog<String>(
  context: context,
  builder: (context) => ListenableBuilder(
    listenable: terminalFontStore,
    builder: (context, _) {
      final theme = Theme.of(context);
      return Theme(
        data: terminal && !desktop
            ? theme.copyWith(
                textTheme: theme.textTheme.apply(
                  fontSizeFactor:
                      terminalFontStore.size / grid.AppType.monoSize,
                ),
              )
            : theme,
        child: _RemoteFolderPickerDialog(
          notifier: notifier,
          machineId: machineId,
          initialPath: initialPath,
          terminal: terminal,
          desktop: desktop,
        ),
      );
    },
  ),
);

class _RemoteFolderPickerDialog extends StatefulWidget {
  const _RemoteFolderPickerDialog({
    required this.notifier,
    required this.machineId,
    this.initialPath,
    this.terminal = false,
    this.desktop = false,
  });

  final AppNotifier notifier;
  final String machineId;
  final String? initialPath;
  final bool terminal, desktop;

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
  bool get _blocking => _loading && (_path == null || _requestedPath != _path);
  int _request = 0, _edit = 0, _selected = -1;
  double _rowHeight = 36;

  bool get _canSelect =>
      !_blocking &&
      _error == null &&
      _path != null &&
      _location.text.trim() == _path;

  bool get _composing => !_location.value.composing.isCollapsed;

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
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _locationFocus.requestFocus();
    });
  }

  @override
  void dispose() {
    _location.dispose();
    _locationFocus.dispose();
    _foldersFocus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load(
    String? path, {
    String? highlight,
    bool refreshing = false,
  }) async {
    if (_loading && _request > 0 && path == _requestedPath) return;
    final request = ++_request;
    final edit = _edit;
    setState(() {
      _loading = true;
      _error = null;
      _requestedPath = path;
      if (!refreshing && _location.text != (path ?? '')) {
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
    final keep = refreshing && _selected >= 0 && _selected < _entries.length
        ? _entries[_selected]
        : highlight;
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
          : math.max(0, _entries.indexOf(keep ?? ''));
      // A reply may canonicalize a path, but must not replace a newer draft or
      // disturb a selection/caret when the field already contains that path.
      if (!refreshing && edit == _edit && _location.text != resolved) {
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

  void _refresh() {
    if (_loading || _composing) return;
    final highlighted = _selected >= 0 && _selected < _entries.length
        ? _entries[_selected]
        : null;
    unawaited(_load(_path, highlight: highlighted, refreshing: true));
  }

  void _retry() {
    unawaited(_load(_requestedPath));
    _locationFocus.requestFocus();
  }

  void _openPath() {
    final path = _location.text.trim();
    if (_composing || path.isEmpty || (_loading && path == _requestedPath)) {
      return;
    }
    _load(path);
  }

  void _up() {
    if (_blocking || _composing) return;
    final parent = _parentPath;
    if (parent != null) _load(parent, highlight: _paths.basename(_path!));
  }

  void _select() {
    if (_canSelect && !_composing) Navigator.of(context).pop(_path);
  }

  void _editLocation() {
    if (_composing) return;
    _locationFocus.requestFocus();
    _location.selection = TextSelection(
      baseOffset: 0,
      extentOffset: _location.text.length,
    );
  }

  void _openSelected() {
    if (!_blocking && _selected >= 0 && _selected < _entries.length) {
      _load(_paths.join(_path!, _entries[_selected]));
    }
  }

  void _openEntry(int index) {
    _foldersFocus.requestFocus();
    setState(() => _selected = index);
    _openSelected();
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
      if (event is KeyDownEvent) _openSelected();
    } else if (key == LogicalKeyboardKey.arrowDown ||
        key == LogicalKeyboardKey.arrowUp ||
        key == LogicalKeyboardKey.home ||
        key == LogicalKeyboardKey.end ||
        key == LogicalKeyboardKey.pageDown ||
        key == LogicalKeyboardKey.pageUp) {
      if (!_blocking && _entries.isNotEmpty) {
        final page = _scroll.hasClients
            ? math.max(
                1,
                (_scroll.position.viewportDimension / _rowHeight).floor(),
              )
            : 1;
        setState(() {
          _selected = switch (key) {
            LogicalKeyboardKey.home => 0,
            LogicalKeyboardKey.end => _entries.length - 1,
            LogicalKeyboardKey.pageDown => (_selected + page).clamp(
              0,
              _entries.length - 1,
            ),
            LogicalKeyboardKey.pageUp => (_selected - page).clamp(
              0,
              _entries.length - 1,
            ),
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

  Widget _pathField() => Focus(
    onKeyEvent: (node, event) {
      if (_composing) {
        return KeyEventResult.skipRemainingHandlers;
      }
      if (event is KeyDownEvent &&
          event.logicalKey == LogicalKeyboardKey.arrowDown &&
          !HardwareKeyboard.instance.isAltPressed &&
          !HardwareKeyboard.instance.isControlPressed &&
          !HardwareKeyboard.instance.isMetaPressed &&
          !HardwareKeyboard.instance.isShiftPressed &&
          _location.value.composing.isCollapsed &&
          !_blocking &&
          _entries.isNotEmpty) {
        _foldersFocus.requestFocus();
        _revealSelection();
        return KeyEventResult.handled;
      }
      return KeyEventResult.ignored;
    },
    child: Semantics(
      label: widget.desktop ? 'Folder path' : null,
      child: TextField(
        key: const Key('remote-folder-path'),
        controller: _location,
        focusNode: _locationFocus,
        autofocus: true,
        autocorrect: false,
        enableSuggestions: false,
        // A path: typed and pasted, so set to be copied exactly.
        style: widget.terminal && !widget.desktop
            ? terminalTextStyle(color: grid.AppPalette.textPrimary)
            : grid.AppType.mono(color: grid.AppPalette.textPrimary),
        decoration: InputDecoration(
          hintText: 'Enter a full folder path…',
          isDense: widget.desktop,
          filled: widget.desktop ? true : null,
          fillColor: widget.desktop ? DesktopChrome.field : null,
          border: widget.desktop
              ? OutlineInputBorder(
                  borderRadius: BorderRadius.circular(
                    grid.AppDesktop.fieldRadius,
                  ),
                  borderSide: BorderSide(color: DesktopChrome.rim),
                )
              : null,
          enabledBorder: widget.desktop
              ? OutlineInputBorder(
                  borderRadius: BorderRadius.circular(
                    grid.AppDesktop.fieldRadius,
                  ),
                  borderSide: BorderSide(color: DesktopChrome.rim),
                )
              : null,
          focusedBorder: widget.desktop
              ? OutlineInputBorder(
                  borderRadius: BorderRadius.circular(
                    grid.AppDesktop.fieldRadius,
                  ),
                  borderSide: BorderSide(
                    color: DesktopChrome.focusRing,
                    width: grid.AppDesktop.focusWidth,
                  ),
                )
              : null,
          suffixIcon: IconButton(
            tooltip: 'Open path',
            onPressed:
                _location.text.trim().isEmpty ||
                    (_loading && _location.text.trim() == _requestedPath)
                ? null
                : _openPath,
            icon: const Icon(AppIcons.arrowRight, size: 18),
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
  );

  Widget _folderList(double listHeight) => Focus(
    focusNode: _foldersFocus,
    onKeyEvent: _folderKey,
    onFocusChange: (_) => setState(() {}),
    child: Container(
      key: const Key('remote-folder-list'),
      height: listHeight,
      decoration: BoxDecoration(
        color: widget.desktop ? DesktopChrome.field : AppColors.background,
        border: Border.all(
          color: _foldersFocus.hasFocus
              ? widget.desktop
                    ? DesktopChrome.focusRing
                    : AppColors.accent
              : widget.desktop
              ? DesktopChrome.rim
              : AppColors.border,
          width: _foldersFocus.hasFocus && widget.desktop ? 2 : 1,
        ),
        borderRadius: BorderRadius.circular(grid.AppCard.insetRadius),
      ),
      clipBehavior: Clip.antiAlias,
      child: _blocking
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
                  style: widget.desktop
                      ? DesktopChrome.text(size: 13, color: DesktopChrome.muted)
                      : Theme.of(context).textTheme.bodySmall,
                ),
              ),
            )
          : ListView.builder(
              controller: _scroll,
              itemExtent: _rowHeight,
              itemCount: _entries.length,
              itemBuilder: (context, index) => Semantics(
                button: true,
                label: _entries[index],
                hint: 'Open folder',
                selected: index == _selected,
                excludeSemantics: true,
                onTap: () => _openEntry(index),
                child: Material(
                  color: index == _selected && _foldersFocus.hasFocus
                      ? widget.desktop
                            ? DesktopChrome.selection
                            : AppColors.selected
                      : Colors.transparent,
                  child: InkWell(
                    splashFactory: widget.desktop
                        ? NoSplash.splashFactory
                        : null,
                    canRequestFocus: false,
                    onTap: () => _openEntry(index),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Row(
                        children: [
                          Icon(
                            AppIcons.folder,
                            size: 18,
                            color: widget.desktop
                                ? DesktopChrome.accent
                                : AppColors.mutedStrong,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              _entries[index],
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: widget.desktop
                                  ? DesktopChrome.text()
                                  : null,
                            ),
                          ),
                          Icon(
                            AppIcons.chevronRight,
                            size: 16,
                            color: widget.desktop
                                ? DesktopChrome.muted
                                : AppColors.mutedStrong,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
    ),
  );

  Widget _desktopDialog(BuildContext context, String? machine, bool mac) {
    final scale = MediaQuery.textScalerOf(context);
    final listHeight =
        (MediaQuery.sizeOf(context).height - 290 - scale.scale(60)).clamp(
          140.0,
          290.0,
        );
    return DesktopChrome(
      child: Dialog(
        key: const ValueKey('desktop-remote-folder-dialog'),
        backgroundColor: Colors.transparent,
        elevation: 0,
        insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 620, maxHeight: 620),
          child: DesktopDialogSurface(
            child: Semantics(
              scopesRoute: true,
              namesRoute: true,
              explicitChildNodes: true,
              label: 'Choose a folder',
              child: FocusTraversalGroup(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    DesktopDialogHeader(
                      title: 'Choose a folder',
                      detail: 'On ${machine ?? 'the remote machine'}',
                    ),
                    Divider(height: 1, color: DesktopChrome.rim),
                    Flexible(
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.all(
                          grid.AppDesktop.panelPadding,
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            ExcludeSemantics(
                              child: Text(
                                'Folder path',
                                style: DesktopChrome.text(
                                  size: 12,
                                  color: DesktopChrome.muted,
                                ),
                              ),
                            ),
                            const SizedBox(height: 6),
                            _pathField(),
                            const SizedBox(height: 12),
                            Wrap(
                              spacing: 8,
                              runSpacing: 8,
                              children: [
                                DesktopPill(
                                  key: const Key('remote-folder-up'),
                                  label: 'Up',
                                  semanticLabel: 'Up one folder',
                                  icon: AppIcons.arrowUp,
                                  compact: true,
                                  tooltip: mac
                                      ? 'Up one folder (⌘↑ or ⌥↑)'
                                      : 'Up one folder (Alt+↑)',
                                  onPressed: _blocking || _parentPath == null
                                      ? null
                                      : _up,
                                ),
                                DesktopPill(
                                  key: const Key('remote-folder-home'),
                                  label: 'Home',
                                  icon: AppIcons.house,
                                  compact: true,
                                  tooltip: 'Home folder on this machine',
                                  onPressed: () => _load(null),
                                ),
                                DesktopPill(
                                  key: const Key('remote-folder-refresh'),
                                  label: 'Refresh',
                                  icon: AppIcons.refreshCw,
                                  compact: true,
                                  tooltip: mac
                                      ? 'Refresh folders (⌘R)'
                                      : 'Refresh folders (Ctrl+R)',
                                  onPressed: _loading ? null : _refresh,
                                ),
                              ],
                            ),
                            const SizedBox(height: 12),
                            if (_path != null &&
                                _location.text.trim() != _path) ...[
                              Text(
                                'Showing $_path',
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: DesktopChrome.text(
                                  size: 12,
                                  color: DesktopChrome.muted,
                                ),
                              ),
                              const SizedBox(height: 8),
                            ],
                            if (_error != null) ...[
                              Semantics(
                                liveRegion: true,
                                child: Text(
                                  _errorMessage(_error!),
                                  style: DesktopChrome.text(
                                    size: 13,
                                    color: Theme.of(context).colorScheme.error,
                                  ),
                                ),
                              ),
                              const SizedBox(height: 8),
                              Align(
                                alignment: Alignment.centerLeft,
                                child: DesktopPill(
                                  label: 'Retry',
                                  icon: AppIcons.refreshCw,
                                  onPressed: _retry,
                                ),
                              ),
                              const SizedBox(height: 12),
                            ],
                            _folderList(listHeight),
                            if (_error == null && _truncated && !_loading) ...[
                              const SizedBox(height: 12),
                              Text(
                                'More folders are available. Enter their full path to open them.',
                                style: DesktopChrome.text(
                                  size: 12,
                                  color: DesktopChrome.muted,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                    Divider(height: 1, color: DesktopChrome.rim),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
                      child: Wrap(
                        alignment: WrapAlignment.end,
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          OutlinedButton(
                            onPressed: () => Navigator.of(context).pop(),
                            child: const Text('Cancel'),
                          ),
                          FilledButton(
                            key: const Key('remote-folder-select'),
                            onPressed: _canSelect ? _select : null,
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const Flexible(
                                  child: Text('Select this folder'),
                                ),
                                const SizedBox(width: 12),
                                Text(
                                  mac ? '⌘↵' : 'Ctrl↵',
                                  style: grid.AppType.monoMeta(),
                                ),
                              ],
                            ),
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
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final scale = MediaQuery.textScalerOf(context);
    _rowHeight = math.max(
      36,
      scale.scale(
                widget.terminal && !widget.desktop
                    ? terminalFontStore.size
                    : grid.AppType.bodySize,
              ) *
              1.35 +
          16,
    );
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
    final actionStyle = ButtonStyle(
      minimumSize: WidgetStatePropertyAll(
        Size(
          0,
          math.max(
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
          SingleActivator(LogicalKeyboardKey.keyR, meta: mac, control: !mac):
              _refresh,
          if (widget.desktop) ...{
            SingleActivator(LogicalKeyboardKey.keyL, meta: mac, control: !mac):
                _editLocation,
            const SingleActivator(
              LogicalKeyboardKey.keyG,
              meta: true,
              shift: true,
            ): _editLocation,
            const SingleActivator(LogicalKeyboardKey.arrowUp, meta: true): _up,
          },
        },
        child: widget.desktop
            ? _desktopDialog(context, machine, mac)
            : AlertDialog(
                title: const Text('Choose a folder'),
                scrollable: true,
                // Material's 20 here left MORE air between the title and the
                // machine line below it (16) than between that line and the next
                // section (12), so the one line that belongs to the title floated
                // between the two blocks instead of sitting under it. 10 groups it
                // with its title and the section below starts a clear 16 later.
                contentPadding: const EdgeInsets.fromLTRB(24, 10, 24, 24),
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
                      const SizedBox(height: 16),
                      if (widget.terminal)
                        Text('Folder path', style: terminalTextStyle())
                      else
                        const FieldLabel('Folder path'),
                      // The label was flush against its field, while the Folders
                      // header gets ~8 from the icon buttons beside it centring.
                      const SizedBox(height: 6),
                      _pathField(),
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
                            icon: const Icon(AppIcons.house, size: 18),
                          ),
                          IconButton(
                            tooltip: 'Refresh folders',
                            onPressed: _loading ? null : _refresh,
                            icon: const Icon(AppIcons.refreshCw, size: 18),
                          ),
                          IconButton(
                            tooltip: mac
                                ? 'Up one folder (⌥↑)'
                                : 'Up one folder (Alt+↑)',
                            onPressed: _blocking || _parentPath == null
                                ? null
                                : _up,
                            icon: const Icon(AppIcons.arrowUp, size: 18),
                          ),
                        ],
                      ),
                      _folderList(listHeight),
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
                                      ?.copyWith(
                                        color: Theme.of(context)
                                            .colorScheme
                                            .error,
                                      ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            TextButton(
                              onPressed: _retry,
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
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Cancel'),
                  ),
                  FilledButton(
                    style: actionStyle,
                    onPressed: _canSelect ? _select : null,
                    child: const Text('Select this folder'),
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

import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:window_manager/window_manager.dart';

import '../core/test_run.dart';
import '../screens/swarm_menu_bus.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import 'engine_identity.dart';

/// Runs one app-menu action — the same strings the macOS application menu
/// reports over `harness/app_menu`, handled once in
/// `_RootShellState.runAppMenuAction`.
typedef AppMenuActionHandler = Future<void> Function(String action);

/// The app's commands as an in-window menu bar.
///
/// On macOS the commands live in the native menu bar: the application menu's
/// own rows and View's font rows are installed in MainFlutterWindow.swift,
/// and File, Edit's Find rows, View's workspace rows and History are built by
/// SwarmTitlebar.swift from the `harness/swarm_tabs` payloads. Linux has no native menu bar to hand any of
/// that to, so this draws the same menus in the window instead: the state
/// comes off [SwarmMenuBus] (what Swift would have received), the rows
/// dispatch back through the same handler the macOS channel delivers to, and
/// the application-menu commands fire the same action strings through
/// [onAction].
///
/// The tab strip and the title-bar buttons are not here: on Linux Flutter
/// draws those itself, as it does anywhere AppKit is not drawing them. Two
/// standard menus are deliberately not mirrored row for row: Edit lacks
/// AppKit's Cut/Copy/Paste roles (the terminal owns those keys; only the rows
/// that reach Dart are drawn), and Window carries the two rows this app can
/// act on itself. Each row shows the shortcut the keymap gives its action,
/// which is where macOS takes its key equivalents from too. Off Linux this renders nothing; [visible] exists so a widget
/// test can force the bar on without caring which OS the host is. Widget
/// tests at large keep the bar off by default: it is window chrome — on macOS
/// it costs the layout nothing at all — and pane-geometry assertions should
/// not depend on whether the Linux build is drawing it.
class LinuxMenuBar extends StatefulWidget {
  const LinuxMenuBar({
    super.key,
    required this.onAction,
    this.state,
    this.visible,
  });

  final AppMenuActionHandler onAction;

  /// The swarm-menu state to draw; defaults to the shared bus's. A test seams
  /// its own in rather than touching the singleton.
  final SwarmMenuState? state;

  /// Force the bar on or off; defaults to following the host platform.
  final bool? visible;

  @override
  State<LinuxMenuBar> createState() => _LinuxMenuBarState();
}

class _LinuxMenuBarState extends State<LinuxMenuBar> {
  final _controllers = <String, MenuController>{};

  MenuController? _openMenu;

  SwarmMenuState get _state => widget.state ?? swarmMenuBus.state;

  @override
  void initState() {
    super.initState();
    _state.addListener(_changed);
  }

  @override
  void dispose() {
    _state.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  /// The bar's panels size to the window, not to [AppControl.menuMaxHeight] —
  /// a History menu a row or two over the token drew a scrollbar for entries
  /// the screen had every room to draw. The panels open downward from a strip
  /// at the top, so the room they have is the window minus the strip itself
  /// and a margin for the screen edge; past that a menu really does scroll.
  MenuStyle get _panelStyle {
    final height = MediaQuery.sizeOf(context).height;
    return grid.AppMenu.style(maxHeight: height - 30 - 24);
  }

  @override
  Widget build(BuildContext context) {
    final visible = widget.visible ?? (Platform.isLinux && !kUnderTest);
    if (!visible) return const SizedBox.shrink();
    grid.AppTheme.watch(context);
    return Container(
      height: 30,
      decoration: BoxDecoration(
        color: grid.AppPalette.panelBg,
        border: Border(bottom: BorderSide(color: grid.AppGlass.hair)),
      ),
      // The full set of menus outgrows a narrow window; a menubar that
      // scrolls beats one that clips its last menus into nothing.
      child: ScrollConfiguration(
        behavior: ScrollConfiguration.of(context).copyWith(scrollbars: false),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 6),
          child: Row(
            children: [
              _menu('Harness', _buildHarnessMenu()),
              _menu('File', _buildFileMenu()),
              _menu('Edit', _buildEditMenu()),
              _menu('View', _buildViewMenu(), onOpen: _readFullScreen),
              _menu('History', _buildHistoryMenu()),
              _menu('Window', _buildWindowMenu()),
              _menu('Help', _buildHelpMenu()),
            ],
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // The menus. Row for row the macOS bar: the application menu's additions
  // (MainFlutterWindow.swift), File and History (SwarmTitlebar.swift), and the
  // stock menus' rows that reach Dart.
  // ---------------------------------------------------------------------------

  List<Widget> _buildHarnessMenu() {
    return [
      _appRow(
        key: 'menu-bar-about',
        icon: LucideIcons.info300,
        label: 'About Harness',
        action: 'showAbout',
      ),
      const AppMenuDivider(),
      _swarmRow(
        key: 'menu-bar-customize',
        icon: LucideIcons.palette300,
        label: 'Customize Harness',
        action: 'customize',
      ),
      _swarmRow(
        key: 'menu-bar-settings',
        icon: LucideIcons.settings300,
        label: 'Settings…',
        action: 'settings',
      ),
      const AppMenuDivider(),
      _appRow(
        key: 'menu-bar-shortcuts',
        icon: LucideIcons.keyboard300,
        label: 'Keyboard Shortcuts…',
        action: 'showShortcuts',
      ),
      _appRow(
        key: 'menu-bar-check-for-updates',
        icon: LucideIcons.refreshCw300,
        label: 'Check for Updates…',
        action: 'checkForUpdates',
      ),
      _appRow(
        key: 'menu-bar-flash-firmware',
        icon: LucideIcons.zap300,
        label: 'Flash Firmware…',
        action: 'flashFirmware',
      ),
      const AppMenuDivider(),
      // The Quit row the Mac's application menu carries. It goes through
      // window_manager so the app's exit lifecycle — the pane-arrangement
      // flush in didRequestAppExit — runs on the way out.
      _plainRow(
        key: 'menu-bar-quit',
        label: 'Quit Harness',
        onTap: () => windowManager.close(),
      ),
    ];
  }

  /// SwarmTitlebar.swift's File menu, in its three groups: the harness, the
  /// tab, the pane. New Terminal stays off it there too; its shortcut is the
  /// way in.
  List<Widget> _buildFileMenu() {
    final state = _state;
    return [
      _swarmRow(
        key: 'menu-bar-new-harness',
        icon: LucideIcons.plus300,
        label: 'New Harness',
        action: 'newAgent',
      ),
      _swarmRow(
        key: 'menu-bar-open-harness',
        icon: LucideIcons.folderOpen300,
        label: 'Open Harness',
        action: 'addAgent',
      ),
      _swarmRow(
        key: 'menu-bar-clone-agent',
        icon: LucideIcons.copyPlus300,
        label: 'Clone Harness',
        action: 'cloneAgent',
      ),
      _swarmRow(
        key: 'menu-bar-restart-agent',
        icon: LucideIcons.rotateCw300,
        label: 'Restart Harness',
        action: 'restartAgent',
        enabled: _paneAction('restartAgent'),
      ),
      _swarmRow(
        key: 'menu-bar-share-agent',
        icon: LucideIcons.share300,
        label: 'Share Harness',
        action: 'shareAgent',
        enabled: _paneAction('shareAgent'),
      ),
      const AppMenuDivider(),
      _swarmRow(
        key: 'menu-bar-new-tab',
        icon: LucideIcons.squarePlus300,
        label: 'New Tab',
        action: 'new',
      ),
      _swarmRow(
        key: 'menu-bar-rename-tab',
        icon: LucideIcons.pencil300,
        label: 'Rename Tab',
        action: 'renameActive',
      ),
      _swarmRow(
        key: 'menu-bar-close-tab',
        icon: LucideIcons.x300,
        label: 'Close Tab',
        action: 'closeActive',
      ),
      const AppMenuDivider(),
      _swarmRow(
        key: 'menu-bar-split-right',
        icon: LucideIcons.panelRight300,
        label: 'Split Right',
        action: 'splitRight',
        enabled: state.enabled && state.canFind,
      ),
      _swarmRow(
        key: 'menu-bar-split-down',
        icon: LucideIcons.panelBottom300,
        label: 'Split Down',
        action: 'splitDown',
        enabled: state.enabled && state.canFind,
      ),
      _swarmRow(
        key: 'menu-bar-zoom-pane',
        icon: LucideIcons.focus300,
        label: 'Zoom Pane',
        action: 'zoomPane',
        enabled: state.enabled && state.canFind,
      ),
      _swarmRow(
        key: 'menu-bar-move-pane',
        icon: LucideIcons.arrowRightLeft300,
        label: 'Move Pane to Tab',
        action: 'movePaneToTab',
        enabled: state.enabled && state.canFind,
      ),
      _swarmRow(
        key: 'menu-bar-close-pane',
        icon: LucideIcons.x300,
        label: 'Close Pane',
        action: 'closePane',
        enabled: state.enabled && state.canClosePane,
      ),
    ];
  }

  /// AppKit's Edit menu carries the text-editing roles a terminal owns, so
  /// only the rows that reach Dart are drawn here: the terminal's Find rows,
  /// then Search Commands, last as on macOS.
  List<Widget> _buildEditMenu() {
    final state = _state;
    return [
      _swarmRow(
        key: 'menu-bar-find-terminal',
        label: 'Find in Terminal…',
        action: 'findTerminal',
        enabled: state.enabled && state.canFind,
      ),
      _swarmRow(
        key: 'menu-bar-find-next',
        label: 'Find Next',
        action: 'findNext',
        enabled: state.enabled && state.canFind,
      ),
      _swarmRow(
        key: 'menu-bar-find-previous',
        label: 'Find Previous',
        action: 'findPrevious',
        enabled: state.enabled && state.canFind,
      ),
      const AppMenuDivider(),
      _swarmRow(
        key: 'menu-bar-commands',
        icon: LucideIcons.command300,
        label: 'Search Commands…',
        action: 'commands',
      ),
    ];
  }

  /// MainFlutterWindow.swift's rows before Full Screen, SwarmTitlebar.swift's
  /// after it.
  List<Widget> _buildViewMenu() {
    return [
      _appRow(
        key: 'menu-bar-layout',
        icon: LucideIcons.layoutGrid300,
        label: 'Layout…',
        action: 'showLayout',
      ),
      const AppMenuDivider(),
      _appRow(
        key: 'menu-bar-reset-font-size',
        icon: LucideIcons.type300,
        label: 'Default Font Size',
        action: 'resetTerminalFontSize',
      ),
      _appRow(
        key: 'menu-bar-bigger-font',
        icon: LucideIcons.aArrowUp300,
        label: 'Bigger',
        action: 'increaseTerminalFontSize',
      ),
      _appRow(
        key: 'menu-bar-smaller-font',
        icon: LucideIcons.aArrowDown300,
        label: 'Smaller',
        action: 'decreaseTerminalFontSize',
      ),
      const AppMenuDivider(),
      // AppKit's stock Full Screen row, reached through window_manager, and
      // named for what it will do the way AppKit names it.
      _plainRow(
        key: 'menu-bar-full-screen',
        label: _fullScreen ? 'Exit Full Screen' : 'Enter Full Screen',
        onTap: () async {
          await windowManager.setFullScreen(
            !await windowManager.isFullScreen(),
          );
        },
      ),
      const AppMenuDivider(),
      _swarmRow(
        key: 'menu-bar-sessions',
        icon: LucideIcons.terminal300,
        label: 'Harnesses',
        action: 'sessions',
      ),
      _swarmRow(
        key: 'menu-bar-notifications',
        icon: LucideIcons.bell300,
        label: 'Harnesses Needing Input…',
        action: 'notifications',
      ),
      _swarmRow(
        key: 'menu-bar-machines',
        icon: LucideIcons.server300,
        label: 'Machines',
        action: 'machineList',
      ),
      _swarmRow(
        key: 'menu-bar-models',
        icon: LucideIcons.cpu300,
        label: 'Models',
        action: 'models',
      ),
      _swarmRow(
        key: 'menu-bar-machine-monitor',
        icon: LucideIcons.activity300,
        label: 'Machine Monitor',
        action: 'manageMachines',
      ),
      const AppMenuDivider(),
      _swarmRow(
        key: 'menu-bar-toggle-viewer',
        label: 'Toggle Viewer',
        action: 'toggleViewer',
        enabled: _paneAction('toggleViewer'),
      ),
      _swarmRow(
        key: 'menu-bar-toggle-composer',
        label: 'Toggle Message Composer',
        action: 'toggleComposer',
        enabled: _paneAction('toggleComposer'),
      ),
    ];
  }

  /// validateMenuItem's rule for the per-pane rows: the app takes actions,
  /// and the focused pane can take this one.
  bool _paneAction(String action) =>
      _state.enabled && _state.paneActions[action] == true;

  bool _fullScreen = false;

  Future<void> _readFullScreen() async {
    if (kUnderTest && widget.visible != null) return;
    final full = await windowManager.isFullScreen();
    if (mounted && full != _fullScreen) setState(() => _fullScreen = full);
  }

  List<Widget> _buildHistoryMenu() {
    final state = _state;
    final closed = state.closedHistory.take(10).toList();
    final visited = state.history.take(15).toList();
    return [
      _swarmRow(
        key: 'menu-bar-history-back',
        label: 'Back',
        action: 'historyBack',
        enabled: state.enabled && state.canGoBack,
      ),
      _swarmRow(
        key: 'menu-bar-history-forward',
        label: 'Forward',
        action: 'historyForward',
        enabled: state.enabled && state.canGoForward,
      ),
      // No default chord here: ⌘⇧T is New Terminal now. The same row, the
      // same missing shortcut, as the native menu.
      _swarmRow(
        key: 'menu-bar-reopen-last',
        label: 'Reopen Closed Tab or Pane',
        action: 'reopen',
        enabled: state.enabled && state.canReopen,
      ),
      const AppMenuDivider(),
      _header('Recently Closed'),
      for (final entry in closed)
        _swarmRow(
          key: 'menu-bar-closed-${entry.id}',
          label: _entryTitle(entry),
          note: entry.machineName.isEmpty ? null : entry.machineName,
          leading: _engineLeading(entry.engine, entry.iconAsset),
          action: 'reopenHistory',
          args: {'id': entry.id},
          enabled: state.enabled && entry.canReopen,
        ),
      if (closed.isEmpty) _label('No Recently Closed Tabs or Panes'),
      const AppMenuDivider(),
      _header('Recently Visited'),
      for (final entry in visited)
        _swarmRow(
          key: 'menu-bar-visited-${entry.id}',
          label: _entryTitle(entry),
          note: entry.machineName.isEmpty ? null : entry.machineName,
          leading: _engineLeading(entry.engine, entry.iconAsset),
          action: 'historyDestination',
          args: {'id': entry.id},
          enabled: state.enabled,
          selected: entry.current,
        ),
      if (visited.isEmpty) _label('No Recent Visits'),
      const AppMenuDivider(),
      _swarmRow(
        key: 'menu-bar-show-history',
        label: 'Show Full History',
        action: 'showHistory',
      ),
    ];
  }

  /// The two window rows this app can act on itself. The Mac's Window menu is
  /// AppKit's own; the same two belong to window_manager here.
  List<Widget> _buildWindowMenu() {
    return [
      _plainRow(
        key: 'menu-bar-minimize',
        label: 'Minimize',
        onTap: () => windowManager.minimize(),
      ),
      _plainRow(
        key: 'menu-bar-zoom',
        label: 'Zoom',
        onTap: () async {
          if (await windowManager.isMaximized()) {
            await windowManager.unmaximize();
          } else {
            await windowManager.maximize();
          }
        },
      ),
    ];
  }

  List<Widget> _buildHelpMenu() {
    return [
      // Quick Start is a keymap command on macOS too: the Help row sends it
      // over the swarm channel as `keymapCommand`.
      _swarmRow(
        key: 'menu-bar-quick-start',
        icon: LucideIcons.rocket300,
        label: 'Quick Start',
        action: 'keymapCommand',
        args: const {'command': 'keyboard.quick_start'},
        hintAction: 'keyboard.quick_start',
      ),
      _appRow(
        key: 'menu-bar-keyboard-practice',
        icon: LucideIcons.keyboard300,
        label: 'Keyboard Practice',
        action: 'keyboardPractice',
      ),
      const AppMenuDivider(),
      _appRow(
        key: 'menu-bar-export-logs',
        icon: LucideIcons.fileDown300,
        label: 'Export Logs…',
        action: 'exportLogs',
      ),
    ];
  }

  // ---------------------------------------------------------------------------
  // Rows and panels.
  // ---------------------------------------------------------------------------

  /// A row that dispatches into the swarm bus — the same contract a native
  /// menu on macOS delivers with. [swarm] false sends an app-menu action to
  /// [LinuxMenuBar.onAction] instead (View's layout row lives on the other
  /// channel, as it does on the Mac).
  Widget _swarmRow({
    required String key,
    required String label,
    required String action,
    Map<String, Object?>? args,
    IconData? icon,
    String? note,
    Widget? leading,
    bool? enabled,
    bool selected = false,
    bool danger = false,
    bool swarm = true,
    String? hintAction,
  }) {
    // Every action row takes `actionsEnabled` from the state, the way the
    // native menu's validateMenuItem does; a row that passes its own flag
    // means BOTH must hold.
    if (!(enabled ?? _state.enabled)) return _label(label, note: note);
    return AppMenuItem(
      key: Key(key),
      icon: icon,
      label: label,
      note: note,
      leading: leading,
      trailing: _hint(hintAction ?? action),
      selected: selected,
      danger: danger,
      onPressed: () {
        _closeAll();
        if (swarm) {
          swarmMenuBus.receive(MethodCall(action, args));
        } else {
          widget.onAction(action);
        }
      },
    );
  }

  /// A row on the app-menu bus — the commands MainFlutterWindow.swift installs
  /// into the application menu on macOS.
  Widget _appRow({
    required String key,
    required String label,
    required String action,
    IconData? icon,
  }) {
    return AppMenuItem(
      key: Key(key),
      icon: icon,
      label: label,
      trailing: _hint(action),
      onPressed: () {
        _closeAll();
        widget.onAction(action);
      },
    );
  }

  Widget _plainRow({
    required String key,
    required String label,
    required VoidCallback onTap,
  }) {
    return AppMenuItem(
      key: Key(key),
      label: label,
      onPressed: () {
        _closeAll();
        onTap();
      },
    );
  }

  Widget _menu(String label, List<Widget> children, {VoidCallback? onOpen}) {
    final controller = _controllers.putIfAbsent(label, MenuController.new);
    final isOpen = identical(_openMenu, controller);
    return MenuAnchor(
      controller: controller,
      style: _panelStyle,
      onOpen: () {
        setState(() => _openMenu = controller);
        onOpen?.call();
      },
      onClose: () {
        if (identical(_openMenu, controller)) {
          setState(() => _openMenu = null);
        }
      },
      menuChildren: children,
      child: TextButton(
        key: Key('menu-bar-${label.toLowerCase()}'),
        onPressed: () {
          // Read at press time, not from the build's capture: the button does
          // not rebuild between a menu closing and the click that reopens it.
          final wasOpen = controller.isOpen;
          _closeAll();
          if (!wasOpen) controller.open();
        },
        style: TextButton.styleFrom(
          foregroundColor: isOpen
              ? grid.AppPalette.textPrimary
              : grid.AppPalette.textSecondary,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          minimumSize: const Size(0, 28),
          shape: const RoundedRectangleBorder(),
          textStyle: const TextStyle(
            fontSize: 12.5,
            fontWeight: FontWeight.w500,
          ),
        ),
        child: Text(label),
      ),
    );
  }

  /// The keymap's chord for [action], set quietly at the row's end where a
  /// native menu draws its key equivalent.
  Widget? _hint(String action) {
    final hint = _state.hints[action];
    if (hint == null) return null;
    return Text(
      hint,
      style: grid.AppType.monoLabel(color: grid.AppPalette.textFaint),
    );
  }

  void _closeAll() {
    for (final controller in _controllers.values) {
      if (controller.isOpen) controller.close();
    }
  }

  Widget? _engineLeading(String? engine, String? iconAsset) {
    final asset =
        iconAsset ?? (engine == null ? null : engineIdentity(engine).asset);
    if (asset == null) return null;
    return Image.asset(
      asset,
      width: 16,
      height: 16,
      errorBuilder: (context, error, stackTrace) => const SizedBox.shrink(),
    );
  }

  /// Swift trims a long tab title to head…tail at 76 characters; the same
  /// shape keeps a wide History menu from pushing the panel wide.
  String _entryTitle(SwarmMenuEntry entry) {
    final title = entry.title;
    if (title.length <= 76) return title;
    return '${title.substring(0, 48)}…${title.substring(title.length - 24)}';
  }

  // A section heading — the small quiet line AppKit's section headers draw.
  Widget _header(String text) =>
      _MenuLabelRow(text, color: grid.AppPalette.textFaint, fontSize: 11.5);

  // A disabled row: an empty state, a provider with no reading behind it, a
  // command the current pane cannot take.
  Widget _label(String text, {String? note, bool faint = false}) =>
      _MenuLabelRow(text, note: note, faint: faint);
}

/// A non-interactive menu row, matched to [AppMenuItem]'s metrics so a
/// disabled row sits where an enabled one would.
class _MenuLabelRow extends StatelessWidget {
  const _MenuLabelRow(
    this.label, {
    this.note,
    this.faint = false,
    this.color,
    this.fontSize,
  });

  final String label;
  final String? note;
  final bool faint;
  final Color? color;
  final double? fontSize;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final metrics = AppMenuRowMetrics.compact;
    final ink = faint
        ? grid.AppPalette.textFaint
        : grid.AppPalette.textSecondary;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      child: Padding(
        padding: metrics.padding,
        child: Row(
          children: [
            SizedBox(width: metrics.iconSize + 9),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: color ?? ink,
                  fontFamily: grid.AppFont.sans,
                  fontFamilyFallback: grid.AppFont.sansFallback,
                  fontSize: fontSize ?? metrics.fontSize,
                  height: 1.2,
                  fontWeight: grid.AppFont.medium,
                ),
              ),
            ),
            if (note != null) ...[
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  note!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: grid.AppPalette.textFaint,
                    fontFamily: grid.AppFont.sans,
                    fontFamilyFallback: grid.AppFont.sansFallback,
                    fontSize: metrics.noteSize,
                    height: 1.2,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

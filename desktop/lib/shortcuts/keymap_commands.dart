import '../logging/debug_surface.dart';
import 'app_shortcuts.dart';
import 'keymap.dart';
import 'keymap_keyboard.dart';

/// Stable identities connect search to workspace actions. The same catalog
/// supplies the file-remapping foundation; native runtime wiring is separate.
class HarnessCommand {
  const HarnessCommand(
    this.id,
    this.label,
    this.group, {
    this.extraKeys = const [],
    this.keywords = const [],
    this.action,
    this.nativeAction,
    this.context = KeymapContext.workspace,
    this.repeatable = false,
    this.hidden = false,
  });
  final String id, label;
  final ShortcutGroup group;
  final List<String> extraKeys;
  final List<String> keywords;

  /// Workspace defaults come from the live shortcut table. A command cannot
  /// quietly propose different keys from the ones the user already uses.
  List<String> get keys =>
      action == null ? extraKeys : _workspaceKeys[action] ?? const [];
  final ShortcutAction? action;
  final String? nativeAction;
  final KeymapContext context;
  final bool repeatable;

  /// Review commands still use the shared keymap, but stay out of normal help.
  final bool hidden;
}

final _workspaceKeys = _readWorkspaceKeys();
Map<ShortcutAction, List<String>> _readWorkspaceKeys() {
  final result = <ShortcutAction, List<String>>{};
  for (final shortcut in appShortcuts()) {
    final keys = keyStrokeFor(
      shortcut.activator.trigger,
      command: shortcut.activator.meta,
      control: shortcut.activator.control,
      alt: shortcut.activator.alt,
      shift: shortcut.activator.shift,
    )!.toString();
    (result[shortcut.action] ??= []).add(keys);
  }
  return result;
}

final harnessCommands = <HarnessCommand>[
  const HarnessCommand(
    'navigation.command_bar',
    'Ask Harness',
    ShortcutGroup.actions,
    extraKeys: ['cmd+shift+j'],
  ),
  const HarnessCommand(
    'navigation.commands',
    'Search commands',
    ShortcutGroup.actions,
    extraKeys: ['cmd+p'],
    nativeAction: 'commands',
  ),
  const HarnessCommand(
    'swarm.new',
    'New Tab',
    ShortcutGroup.navigate,
    action: ShortcutAction.newSwarm,
    nativeAction: 'new',
  ),
  const HarnessCommand(
    'swarm.close',
    'Close Tab',
    ShortcutGroup.navigate,
    action: ShortcutAction.closeSwarm,
    nativeAction: 'closeActive',
  ),
  // The live table binds no chord to it any more (⌘⇧T is New Terminal), so
  // `keys` comes back empty: a palette and menu command a person may give a
  // key of their own in keybindings.jsonc.
  const HarnessCommand(
    'swarm.reopen',
    'Reopen closed tab or pane',
    ShortcutGroup.navigate,
    action: ShortcutAction.reopenClosedSwarm,
    nativeAction: 'reopen',
  ),
  const HarnessCommand(
    'swarm.next',
    'Next Tab',
    ShortcutGroup.navigate,
    action: ShortcutAction.nextSwarm,
    nativeAction: 'next',
    repeatable: true,
  ),
  const HarnessCommand(
    'swarm.previous',
    'Previous Tab',
    ShortcutGroup.navigate,
    action: ShortcutAction.previousSwarm,
    nativeAction: 'previous',
    repeatable: true,
  ),
  const HarnessCommand(
    'swarm.rename',
    'Rename Tab',
    ShortcutGroup.actions,
    action: ShortcutAction.renameSwarm,
    nativeAction: 'renameActive',
  ),
  const HarnessCommand(
    'navigation.back',
    'Go back',
    ShortcutGroup.navigate,
    action: ShortcutAction.previousAgent,
    nativeAction: 'historyBack',
    repeatable: true,
  ),
  const HarnessCommand(
    'navigation.forward',
    'Go forward',
    ShortcutGroup.navigate,
    action: ShortcutAction.nextAgent,
    nativeAction: 'historyForward',
    repeatable: true,
  ),
  const HarnessCommand(
    'navigation.history',
    'Show full history',
    ShortcutGroup.navigate,
    action: ShortcutAction.showHistory,
    nativeAction: 'showHistory',
  ),
  const HarnessCommand(
    'navigation.needs_input',
    'Show harnesses needing input',
    ShortcutGroup.navigate,
    action: ShortcutAction.showAttention,
    nativeAction: 'notifications',
  ),
  for (var i = 1; i <= 9; i++)
    HarnessCommand(
      'swarm.select_$i',
      'Select tab $i',
      ShortcutGroup.navigate,
      extraKeys: ['cmd+$i'],
    ),
  for (var i = 1; i <= 9; i++)
    HarnessCommand('pane.focus_$i', 'Focus pane $i', ShortcutGroup.panes),
  const HarnessCommand(
    'pane.focus_left',
    'Focus the pane to the left',
    ShortcutGroup.panes,
    action: ShortcutAction.focusPaneLeft,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.focus_right',
    'Focus the pane to the right',
    ShortcutGroup.panes,
    action: ShortcutAction.focusPaneRight,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.focus_above',
    'Focus the pane above',
    ShortcutGroup.panes,
    action: ShortcutAction.focusPaneAbove,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.focus_below',
    'Focus the pane below',
    ShortcutGroup.panes,
    action: ShortcutAction.focusPaneBelow,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.move_left',
    'Move the pane left',
    ShortcutGroup.panes,
    action: ShortcutAction.movePaneLeft,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.move_right',
    'Move the pane right',
    ShortcutGroup.panes,
    action: ShortcutAction.movePaneRight,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.move_up',
    'Move the pane up',
    ShortcutGroup.panes,
    action: ShortcutAction.movePaneUp,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.move_down',
    'Move the pane down',
    ShortcutGroup.panes,
    action: ShortcutAction.movePaneDown,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.move_to_tab',
    'Move the pane to another tab',
    ShortcutGroup.panes,
    action: ShortcutAction.movePaneToTab,
    nativeAction: 'movePaneToTab',
    keywords: ['send', 'tab', 'another'],
  ),
  const HarnessCommand(
    'pane.zoom',
    'Zoom or restore the focused pane',
    ShortcutGroup.panes,
    action: ShortcutAction.zoomPane,
    nativeAction: 'zoomPane',
  ),
  const HarnessCommand(
    'pane.close',
    'Close the focused pane',
    ShortcutGroup.panes,
    action: ShortcutAction.closePane,
    nativeAction: 'closePane',
  ),
  const HarnessCommand(
    'pane.last',
    'Return to the last pane',
    ShortcutGroup.panes,
    action: ShortcutAction.lastPane,
  ),
  const HarnessCommand(
    'pane.pin',
    'Pin or unpin the focused pane',
    ShortcutGroup.panes,
    action: ShortcutAction.pinPane,
    nativeAction: 'pinPane',
  ),
  const HarnessCommand(
    'pane.layout',
    'Choose a layout',
    ShortcutGroup.panes,
    action: ShortcutAction.showLayout,
    nativeAction: 'layout',
  ),
  const HarnessCommand('pane.resize', 'Resize panes', ShortcutGroup.panes),
  const HarnessCommand(
    'pane.split_right',
    'Split right…',
    ShortcutGroup.panes,
    extraKeys: ['cmd+r'],
    nativeAction: 'splitRight',
  ),
  const HarnessCommand(
    'pane.split_down',
    'Split down…',
    ShortcutGroup.panes,
    extraKeys: ['cmd+d'],
    nativeAction: 'splitDown',
  ),
  const HarnessCommand(
    'pane.reset_sizes',
    'Reset pane sizes',
    ShortcutGroup.panes,
  ),
  const HarnessCommand(
    'terminal.find',
    'Find in the focused terminal',
    ShortcutGroup.navigate,
    action: ShortcutAction.findTerminal,
    nativeAction: 'findTerminal',
  ),
  const HarnessCommand(
    'terminal.find_next',
    'Next terminal match',
    ShortcutGroup.navigate,
    action: ShortcutAction.findNext,
    nativeAction: 'findNext',
    repeatable: true,
  ),
  const HarnessCommand(
    'terminal.find_previous',
    'Previous terminal match',
    ShortcutGroup.navigate,
    action: ShortcutAction.findPrevious,
    nativeAction: 'findPrevious',
    repeatable: true,
  ),
  const HarnessCommand(
    'agent.open',
    'Open Harness',
    ShortcutGroup.actions,
    action: ShortcutAction.addAgent,
    nativeAction: 'addAgent',
    keywords: ['resume', 'existing', 'pane'],
  ),
  const HarnessCommand('agent.add', 'New Pane', ShortcutGroup.actions),
  const HarnessCommand(
    'agent.new',
    'New Harness',
    ShortcutGroup.actions,
    action: ShortcutAction.newAgent,
    nativeAction: 'newAgent',
  ),
  const HarnessCommand('agent.rename', 'Rename Harness', ShortcutGroup.actions),
  const HarnessCommand('agent.stop', 'Stop Harness', ShortcutGroup.actions),
  const HarnessCommand('agent.fork', 'Fork Harness', ShortcutGroup.actions),
  const HarnessCommand(
    'agent.clone',
    'Clone Harness',
    ShortcutGroup.actions,
    action: ShortcutAction.cloneAgent,
    nativeAction: 'cloneAgent',
    keywords: ['duplicate', 'another', 'fresh'],
  ),
  const HarnessCommand(
    'agent.restart',
    'Restart Harness',
    ShortcutGroup.actions,
    action: ShortcutAction.restartAgent,
    nativeAction: 'restartAgent',
    keywords: ['again', 'relaunch', 'resume'],
  ),
  const HarnessCommand(
    'terminal.new',
    'New Terminal',
    ShortcutGroup.actions,
    action: ShortcutAction.newTerminal,
    nativeAction: 'newTerminal',
  ),
  // The id is a user's keybinding and does not move; the label is the app's name.
  const HarnessCommand(
    'machines.manage',
    'Open Machine Monitor',
    ShortcutGroup.actions,
    nativeAction: 'manageMachines',
  ),
  const HarnessCommand(
    'machines.list',
    'Open Machines',
    ShortcutGroup.actions,
    nativeAction: 'machineList',
    extraKeys: ['cmd+m'],
  ),
  const HarnessCommand(
    'machine.link',
    'Connect another machine',
    ShortcutGroup.actions,
    nativeAction: 'linkMachine',
  ),
  const HarnessCommand(
    'project.add',
    'Add project',
    ShortcutGroup.actions,
    nativeAction: 'addProject',
  ),
  const HarnessCommand(
    'machines.refresh',
    'Refresh machines and agents',
    ShortcutGroup.actions,
    action: ShortcutAction.reload,
    nativeAction: 'reload',
  ),
  const HarnessCommand(
    'task.route',
    'Boss mode: route a task',
    ShortcutGroup.actions,
    action: ShortcutAction.routeTask,
  ),
  const HarnessCommand(
    'project.orchestrate',
    'Create with the orchestrator',
    ShortcutGroup.actions,
    action: ShortcutAction.orchestrate,
  ),
  const HarnessCommand(
    'app.customize',
    'Customize Harness',
    ShortcutGroup.actions,
    nativeAction: 'customize',
  ),
  const HarnessCommand(
    'app.store',
    'Harness Store',
    ShortcutGroup.actions,
    extraKeys: ['cmd+s'],
    keywords: ['install', 'browse harnesses', 'packages', 'extensions'],
    nativeAction: 'store',
  ),
  const HarnessCommand(
    'app.settings',
    'Open Settings',
    ShortcutGroup.actions,
    action: ShortcutAction.showSettings,
    nativeAction: 'settings',
  ),
  const HarnessCommand(
    'keyboard.help',
    'Keyboard shortcuts',
    ShortcutGroup.actions,
    action: ShortcutAction.showShortcuts,
    nativeAction: 'showShortcuts',
  ),
  const HarnessCommand(
    'keyboard.open_config',
    'Open keyboard config',
    ShortcutGroup.actions,
    nativeAction: 'openKeymap',
  ),
  const HarnessCommand(
    'keyboard.quick_start',
    'Quick start',
    ShortcutGroup.actions,
    keywords: ['onboarding', 'learn', 'guide', 'getting started'],
    nativeAction: 'quickStart',
  ),
  const HarnessCommand(
    'keyboard.practice',
    'Keyboard practice',
    ShortcutGroup.actions,
    keywords: ['tutorial', 'learn', 'shortcuts', 'training', 'keys'],
    nativeAction: 'keyboardPractice',
  ),
  const HarnessCommand(
    'keyboard.pause_guide',
    'Pause quick start',
    ShortcutGroup.actions,
    keywords: ['hide guide', 'dismiss tutorial'],
  ),
  if (kDebugSurfaceEnabled)
    const HarnessCommand(
      'app.debug',
      'Open the debug log',
      ShortcutGroup.actions,
      action: ShortcutAction.showDebug,
    ),
  if (kDebugSurfaceEnabled)
    const HarnessCommand(
      'app.onboarding_review',
      'Review onboarding',
      ShortcutGroup.actions,
      extraKeys: ['cmd+alt+shift+o'],
      hidden: true,
    ),
  const HarnessCommand(
    'picker.next',
    'Next result',
    ShortcutGroup.navigate,
    extraKeys: ['down', 'ctrl+n', 'ctrl+j'],
    context: KeymapContext.picker,
    repeatable: true,
  ),
  const HarnessCommand(
    'picker.previous',
    'Previous result',
    ShortcutGroup.navigate,
    extraKeys: ['up', 'ctrl+p', 'ctrl+k'],
    context: KeymapContext.picker,
    repeatable: true,
  ),
  const HarnessCommand(
    'picker.preview_page_up',
    'Page up in the preview or results',
    ShortcutGroup.navigate,
    extraKeys: ['pageup'],
    context: KeymapContext.picker,
    repeatable: true,
  ),
  const HarnessCommand(
    'picker.preview_page_down',
    'Page down in the preview or results',
    ShortcutGroup.navigate,
    extraKeys: ['pagedown'],
    context: KeymapContext.picker,
    repeatable: true,
  ),
  const HarnessCommand(
    'picker.accept',
    'Open the selected result',
    ShortcutGroup.navigate,
    extraKeys: ['enter', 'ctrl+m'],
    context: KeymapContext.picker,
  ),
  // Starts New Harness from any field, without walking down to its button.
  const HarnessCommand(
    'picker.start',
    'Start the new harness from any field',
    ShortcutGroup.actions,
    extraKeys: ['shift+enter'],
    context: KeymapContext.picker,
  ),
  const HarnessCommand(
    'picker.refresh',
    'Refresh the machine list',
    ShortcutGroup.actions,
    extraKeys: ['cmd+r', 'ctrl+r'],
    context: KeymapContext.picker,
  ),
  const HarnessCommand(
    'picker.add_here',
    'Add the selected agent',
    ShortcutGroup.actions,
    extraKeys: ['cmd+enter'],
    context: KeymapContext.picker,
  ),
  // The box's own keys. They were hardcoded activators: absent from ⌘/ and the
  // config template, and impossible to move — the one corner where "every key
  // can be remapped" was not true.
  const HarnessCommand(
    'picker.complete',
    'Complete the path, or go to the next field',
    ShortcutGroup.navigate,
    // ⌃I is Tab to a terminal, as ⌃M is Return and ⌃[ is Escape.
    extraKeys: ['tab', 'ctrl+i'],
    context: KeymapContext.picker,
    repeatable: true,
  ),
  const HarnessCommand(
    'picker.complete_back',
    'The previous candidate, or the previous field',
    ShortcutGroup.navigate,
    extraKeys: ['shift+tab'],
    context: KeymapContext.picker,
    repeatable: true,
  ),
  const HarnessCommand(
    'picker.more_options',
    'Open the full New Harness form',
    ShortcutGroup.navigate,
    extraKeys: ['cmd+period'],
    context: KeymapContext.picker,
  ),
  // Launch and Project use arrows/Enter. Keep stable command identities for
  // explicit user bindings without reserving plain letters in these prompts.
  for (final (name, key, label) in [
    ('agent', null, 'Choose the new agent'),
    ('project', null, 'Choose the new agent’s project'),
    ('task', null, 'Edit the new agent’s first task'),
    ('options', null, 'Edit the new agent’s advanced options'),
    // Project is a text filter. Keep these command identities available for
    // explicit user remaps, without taking ordinary letters from the editor.
    ('project_new', null, 'Name a new project'),
    ('project_existing', null, 'Open an existing project'),
    ('project_repository', null, 'Clone a GitHub repository'),
    ('project_machine', null, 'Choose the new agent’s machine'),
    ('project_browse', 'ctrl+o', 'Browse folders on the selected machine'),
  ])
    HarnessCommand(
      'creation.$name',
      label,
      ShortcutGroup.actions,
      extraKeys: [?key],
      context:
          const {
            'project_new',
            'project_existing',
            'project_repository',
          }.contains(name)
          ? KeymapContext.project
          : KeymapContext.picker,
    ),
  for (var recent = 1; recent <= 9; recent++)
    HarnessCommand(
      'creation.project_recent_$recent',
      'Use recent project $recent',
      ShortcutGroup.actions,
      context: KeymapContext.project,
    ),
  const HarnessCommand(
    'picker.toggle_preview',
    'Show or hide the result preview',
    ShortcutGroup.navigate,
    extraKeys: ['ctrl+slash'],
    context: KeymapContext.picker,
  ),
  for (var row = 1; row <= 9; row++)
    HarnessCommand(
      'picker.pick_$row',
      'Take row $row',
      ShortcutGroup.navigate,
      extraKeys: ['alt+$row'],
      context: KeymapContext.picker,
    ),
  const HarnessCommand(
    'picker.cancel',
    'Close search',
    ShortcutGroup.navigate,
    extraKeys: ['escape', 'ctrl+c', 'ctrl+g', 'ctrl+bracketleft'],
    context: KeymapContext.picker,
  ),
];

final harnessCommandById = {
  for (final command in harnessCommands) command.id: command,
};
final harnessDefaultBindings = [
  for (final command in harnessCommands)
    for (final keys in command.keys)
      KeyBinding(
        keys: keys.split(' ').map(KeyStroke.parse),
        command: command.id,
        context: command.context,
      ),
];
final harnessDefaultKeymap = ResolvedKeymap(
  harnessDefaultBindings,
  const KeymapConfig.empty(),
);

List<String> describeKeyStrokeKeys(KeyStroke stroke) => [
  if (stroke.control) '⌃',
  if (stroke.alt) '⌥',
  if (stroke.shift) '⇧',
  if (stroke.command) '⌘',
  const {
        'left': '←',
        'right': '→',
        'up': '↑',
        'down': '↓',
        'pageup': 'Page Up',
        'pagedown': 'Page Down',
        'enter': '↵',
        'escape': 'Esc',
        'tab': '⇥',
        'space': 'Space',
        'comma': ',',
        'period': '.',
        'slash': '/',
        'backslash': r'\',
        'semicolon': ';',
        'quote': "'",
        'backquote': '`',
        'bracketleft': '[',
        'bracketright': ']',
        'minus': '-',
        'equal': '=',
        'backspace': '⌫',
        'delete': '⌦',
      }[stroke.key] ??
      stroke.key.toUpperCase(),
];
String describeKeyStroke(KeyStroke stroke) =>
    describeKeyStrokeKeys(stroke).join();
String describeKeyBinding(KeyBinding binding) =>
    binding.keys.map(describeKeyStroke).join(' ');

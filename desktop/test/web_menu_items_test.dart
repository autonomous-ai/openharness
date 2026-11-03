import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/web/shell/web_menu_items.dart';

List<String> _commands(List<List<WebMenuItem>> menu) => [
  for (final group in menu)
    for (final item in group) item.command,
];

void main() {
  test('every web menu row names a registered workspace command', () {
    final registered = {for (final command in harnessCommands) command.id};
    for (final group in kWebMenuGroups) {
      for (final item in group) {
        expect(registered, contains(item.command), reason: item.label);
      }
    }
  });

  test('a phone gets Store; a wide window has its own Store button', () {
    final phone = _commands(runnableWebMenu((_) => true, compact: true));
    final wide = _commands(runnableWebMenu((_) => true, compact: false));
    expect(phone, contains('app.store'));
    expect(wide, isNot(contains('app.store')));
  });

  test('the + menu is New tab, New Swarm, Split pane, History', () {
    expect(_commands(runnableWebMenu((_) => true, compact: false)), [
      'swarm.new',
      'super_tab.new',
      'pane.split_right',
      'navigation.history',
    ]);
  });

  test('what moved to the bar or the avatar, and keyboard tours, stay out', () {
    final all = _commands(runnableWebMenu((_) => true, compact: true));
    for (final elsewhere in [
      'machines.list',
      'models.list',
      'navigation.commands',
      'app.settings',
      'app.customize',
      'app.add_phone',
      'agent.new',
      'harnesses.list',
      'navigation.needs_input',
      // Share is the Experimental setting's to show, never the menu's.
      'agent.share',
      'pane.split_down',
      'pane.close',
      'keyboard.help',
      'keyboard.quick_start',
    ]) {
      expect(all, isNot(contains(elsewhere)), reason: elsewhere);
    }
  });

  test('More keeps zoom, move, layouts and reopen reachable', () {
    final more = [
      for (final item in runnableWebMore((_) => true, panes: 2)) item.command,
    ];
    final registered = {for (final command in harnessCommands) command.id};
    expect(registered, containsAll(more));
    expect(
      more,
      containsAll([
        'pane.zoom',
        'pane.move_left',
        'pane.move_right',
        'pane.move_up',
        'pane.move_down',
        'pane.move_to_tab',
        'pane.layout',
        'swarm.reopen',
      ]),
    );
  });

  test('one pane has nothing to zoom or move; nothing runnable, no More', () {
    final one = [
      for (final item in runnableWebMore((_) => true, panes: 1)) item.command,
    ];
    expect(one, ['pane.move_to_tab', 'pane.layout', 'swarm.reopen']);
    expect(runnableWebMore((_) => false, panes: 2), isEmpty);
  });

  test('rows that cannot run, and groups left empty, are not drawn', () {
    final menu = runnableWebMenu(
      (command) => !command.startsWith('swarm.') && command != 'super_tab.new',
      compact: false,
    );
    expect(menu, hasLength(kWebMenuGroups.length - 1));
    expect(runnableWebMenu((_) => false, compact: false), isEmpty);
  });
}

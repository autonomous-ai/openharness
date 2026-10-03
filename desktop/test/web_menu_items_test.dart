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

  test('a phone gets Store, a wide window gets Add phone', () {
    final phone = _commands(runnableWebMenu((_) => true, compact: true));
    final wide = _commands(runnableWebMenu((_) => true, compact: false));
    expect(phone, contains('app.store'));
    expect(phone, isNot(contains('app.add_phone')));
    expect(wide, contains('app.add_phone'));
    expect(wide, isNot(contains('app.store')));
  });

  test('controls the bar already has, and keyboard tours, stay out', () {
    final all = _commands(runnableWebMenu((_) => true, compact: true));
    for (final elsewhere in [
      'agent.new',
      'swarm.new',
      'harnesses.list',
      'navigation.needs_input',
      'pane.split_down',
      'pane.close',
      'pane.zoom',
      'pane.layout',
      'keyboard.help',
      'keyboard.quick_start',
    ]) {
      expect(all, isNot(contains(elsewhere)), reason: elsewhere);
    }
  });

  test('sharing and one split, to the right, have a row', () {
    final all = _commands(runnableWebMenu((_) => true, compact: true));
    expect(all, containsAll(['agent.share', 'pane.split_right']));
  });

  test('rows that cannot run, and groups left empty, are not drawn', () {
    final menu = runnableWebMenu(
      (command) => !command.startsWith('pane.') && command != 'agent.share',
      compact: false,
    );
    expect(menu, hasLength(kWebMenuGroups.length - 1));
    expect(runnableWebMenu((_) => false, compact: false), isEmpty);
  });
}

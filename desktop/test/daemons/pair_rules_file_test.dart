// pair.jsonc: where harnessd reads the pair's rules (cli/src/pair/rules.ts
// pairConfigPath), and the file the window writes when there is none, which
// must mean exactly what no file means: the model off, no rules.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/daemons/pair_rules_file.dart';

/// JSON with `//` comments and trailing commas, read the way rules.ts does.
Object? _jsonc(String text) {
  final lines = [
    for (final line in const LineSplitter().convert(text))
      line.replaceFirst(RegExp(r'^\s*//.*$'), ''),
  ].join('\n');
  return jsonDecode(lines.replaceAll(RegExp(r',(\s*[}\]])'), r'$1'));
}

void main() {
  test('the path follows XDG_CONFIG_HOME when it is absolute', () {
    expect(
      pairRulesPath(environment: {'HOME': '/Users/pat'}),
      '/Users/pat/.config/harness/pair.jsonc',
    );
    expect(
      pairRulesPath(
        environment: {'HOME': '/Users/pat', 'XDG_CONFIG_HOME': '/cfg'},
      ),
      '/cfg/harness/pair.jsonc',
    );
    expect(
      pairRulesPath(
        environment: {'HOME': '/Users/pat', 'XDG_CONFIG_HOME': 'relative'},
      ),
      '/Users/pat/.config/harness/pair.jsonc',
    );
  });

  test('the template is no rules, no model and no learning, explained', () {
    expect(_jsonc(pairRulesTemplate), {
      'model': false,
      'learn': {'borrow': false, 'export': [], 'agentsMd': []},
      'rules': [],
    });
    expect(pairRulesTemplate, contains('act within rules'));
    expect(pairConfigTurnsOn(pairRulesTemplate), isEmpty);
  });

  test('stripJsonc reads comments and trailing commas as rules.ts does', () {
    expect(
      jsonDecode(
        stripJsonc(
          '{ // a comment\n "a": "http://x // not a comment", /* b */ '
          '"b": [1, 2,], "c": "q\\"//",\n}',
        ),
      ),
      {'a': 'http://x // not a comment', 'b': [1, 2], 'c': 'q"//'},
    );
  });

  test('a rules confirmation lists every rule, the model and each learning '
      'opt-in', () {
    const file = '''// mine
{
  "model": true,
  "learn": { "borrow": true, "export": ["claude", "nope"], "agentsMd": ["~/code/api"] },
  "rules": [
    { "name": "tests in api", "harness": "api*", "question": "npm test", "choice": "Yes", },
    { "question": "^Approve", "choice": "1. Yes", "engine": "codex", "project": "~/code/web" },
  ],
}''';
    // The gate's own detail: `pair.jsonc (<summary>):` and then the file.
    final lines = pairConfigTurnsOn(
      'pair.jsonc (2 rules, model on, learn borrow + export claude + '
      'AGENTS.md in 1 project):\n$file',
    );
    expect(lines, [
      'rule "tests in api": answers "Yes" to /npm test/ (harness api*)',
      'rule "rule 2": answers "1. Yes" to /^Approve/ (codex, in ~/code/web)',
      'model: one small model call per new question, on your engine',
      'learn.borrow: what Hermes, Claude Code and Codex learned on their own '
          'become lesson candidates',
      'learn.export: approved skills also written to ~/.claude/skills',
      'learn.agentsMd: notes may go into AGENTS.md in ~/code/api',
    ]);
    expect(pairConfigTurnsOn('pair.jsonc (0 rules):\n{ not json'), isEmpty);
  });

  test('a missing file is written once; an existing one is never touched', () async {
    final dir = await Directory.systemTemp.createTemp('pair-rules');
    addTearDown(() => dir.delete(recursive: true));
    final env = {'HOME': '/nowhere', 'XDG_CONFIG_HOME': dir.path};
    final file = await ensurePairRules(environment: env);
    expect(file.path, '${dir.path}/harness/pair.jsonc');
    expect(await file.readAsString(), pairRulesTemplate);
    await file.writeAsString('{"rules": [], "model": true}');
    await ensurePairRules(environment: env);
    expect(await file.readAsString(), '{"rules": [], "model": true}');
  });
}

/// `pair.jsonc`: the person's rules for their paired daemon (`daemons/BRAIN.md`,
/// "Autonomy and rules"; `cli/src/pair/rules.ts`). harnessd reads it, on every
/// machine, at `$XDG_CONFIG_HOME/harness/pair.jsonc` (an absolute
/// `XDG_CONFIG_HOME`), else `~/.config/harness/pair.jsonc`, and re-reads it
/// when it changes. The window only opens it for editing, writing a commented
/// file with no rules first when there is none: no rules is what a missing
/// file already means, so creating it changes nothing.
library;

import 'dart:convert';
import 'dart:io';

/// Where harnessd reads the rules on this computer.
String pairRulesPath({Map<String, String>? environment}) {
  final env = environment ?? Platform.environment;
  final xdg = env['XDG_CONFIG_HOME'];
  final base = xdg != null && xdg.startsWith('/')
      ? xdg
      : '${env['HOME'] ?? ''}/.config';
  return '$base/harness/pair.jsonc';
}

/// A file that means exactly what no file means: the model off, no rules.
const pairRulesTemplate = '''// Your paired daemon's rules (daemons/BRAIN.md, "Autonomy and rules").
// harnessd reads this on every machine and re-reads it when it changes.
{
  // true lets the daemon ask one small model for better status-line words.
  "model": false,

  // Learning, every part off by default: borrow what Hermes, Claude Code
  // and Codex learned on their own as lesson candidates; export approved
  // skills to ~/.agents/skills and ~/.claude/skills ("agents", "claude");
  // the projects whose notes may go into their AGENTS.md.
  "learn": { "borrow": false, "export": [], "agentsMd": [] },

  // Answers to give without asking, used only while the dial is
  // "act within rules". The first rule that matches wins. A rule never
  // answers a push, delete, force-push, deploy or merge prompt, never picks
  // an option that answers for more than this once, and approves only what
  // a key could (reads, tests, builds, linters, formatters, in-project
  // edits). Everything a rule does is journaled and reported afterwards.
  "rules": [
    // {
    //   "name": "tests in api",
    //   "harness": "api*",
    //   "project": "~/code/api",
    //   "question": "npm (run )?test",
    //   "choice": "Yes"
    // }
  ]
}
''';

/// The rules file, written from [pairRulesTemplate] when it does not exist
/// yet (never over one that does).
Future<File> ensurePairRules({Map<String, String>? environment}) async {
  final file = File(pairRulesPath(environment: environment));
  if (!await file.exists()) {
    await file.parent.create(recursive: true);
    await file.writeAsString(pairRulesTemplate, flush: true);
  }
  return file;
}

/// [text] as JSON: comments and trailing commas taken out, as harnessd reads
/// pair.jsonc (`cli/src/pair/rules.ts` `parseJsonc`).
String stripJsonc(String text) {
  final out = StringBuffer();
  var inString = false;
  for (var i = 0; i < text.length; i++) {
    final c = text[i];
    if (inString) {
      out.write(c);
      if (c == '\\' && i + 1 < text.length) {
        out.write(text[++i]);
      } else if (c == '"') {
        inString = false;
      }
      continue;
    }
    if (c == '"') {
      inString = true;
      out.write(c);
      continue;
    }
    if (c == '/' && i + 1 < text.length && text[i + 1] == '/') {
      while (i < text.length && text[i] != '\n') {
        i++;
      }
      out.write('\n');
      continue;
    }
    if (c == '/' && i + 1 < text.length && text[i + 1] == '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] == '*' && text[i + 1] == '/')) {
        i++;
      }
      i++;
      continue;
    }
    if (c == ',') {
      var j = i + 1;
      while (j < text.length && text[j].trim().isEmpty) {
        j++;
      }
      if (j < text.length && (text[j] == '}' || text[j] == ']')) continue;
    }
    out.write(c);
  }
  return out.toString();
}

/// What a pair.jsonc waiting for the person's yes turns on, one line each:
/// every rule, the model, and each learning opt-in (`learn.borrow`,
/// `learn.export`, `learn.agentsMd`). [detail] is the confirmation's own
/// (`pair.jsonc (<summary>):` and then the file); a file that does not read
/// lists nothing, and the confirmation still shows it whole.
List<String> pairConfigTurnsOn(String detail) {
  final newline = detail.indexOf('\n');
  final text = detail.startsWith('pair.jsonc') && newline >= 0
      ? detail.substring(newline + 1)
      : detail;
  Object? value;
  try {
    value = jsonDecode(stripJsonc(text));
  } catch (_) {
    return const [];
  }
  if (value is! Map) return const [];
  String str(Object? v) => v is String ? v.trim() : '';
  final lines = <String>[];
  final rules = value['rules'] is List ? value['rules'] as List : const [];
  for (final (i, raw) in rules.indexed) {
    if (raw is! Map) continue;
    final name = str(raw['name']).isEmpty ? 'rule ${i + 1}' : str(raw['name']);
    final where = [
      if (str(raw['harness']).isNotEmpty) 'harness ${str(raw['harness'])}',
      if (str(raw['engine']).isNotEmpty) str(raw['engine']),
      if (str(raw['project']).isNotEmpty) 'in ${str(raw['project'])}',
    ];
    lines.add(
      'rule "$name": answers "${str(raw['choice'])}" to '
      '/${str(raw['question'])}/${where.isEmpty ? '' : ' (${where.join(', ')})'}',
    );
  }
  if (value['model'] == true) {
    lines.add('model: one small model call per new question, on your engine');
  }
  final learn = value['learn'] is Map ? value['learn'] as Map : const {};
  if (learn['borrow'] == true) {
    lines.add(
      'learn.borrow: what Hermes, Claude Code and Codex learned on their '
      'own become lesson candidates',
    );
  }
  final export = [
    for (final d in learn['export'] is List ? learn['export'] as List : [])
      if (d == 'agents' || d == 'claude') d as String,
  ];
  if (export.isNotEmpty) {
    lines.add(
      'learn.export: approved skills also written to '
      '${export.map((d) => '~/.$d/skills').join(' and ')}',
    );
  }
  final agentsMd = [
    for (final f in learn['agentsMd'] is List ? learn['agentsMd'] as List : [])
      if (f is String && f.trim().isNotEmpty) f.trim(),
  ];
  if (agentsMd.isNotEmpty) {
    lines.add('learn.agentsMd: notes may go into AGENTS.md in ${agentsMd.join(', ')}');
  }
  return lines;
}

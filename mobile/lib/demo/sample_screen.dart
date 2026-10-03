/// What a sample harness has on screen, and how each CLI draws it.
///
/// A harness's screen is two parts, the way Claude Code and Codex both lay theirs out: the
/// TRANSCRIPT, which only ever grows and scrolls up into history, and the LIVE REGION under it —
/// the prompt box, the spinner while working, a permission dialog while asking — which is redrawn
/// in place every time it changes. [SampleLook] turns both into lines for one pane width.
library;

import 'sample_text.dart';

/// One item of a transcript.
sealed class SampleEntry {
  const SampleEntry();
}

/// What the person asked, echoed the way the CLI echoes it.
class UserEntry extends SampleEntry {
  const UserEntry(this.text);
  final String text;
}

/// The agent talking. `code` in backticks is drawn as code.
class SayEntry extends SampleEntry {
  const SayEntry(this.text);
  final String text;
}

enum ToolOutcome { ok, failed, declined }

/// A tool call and what it printed — `⏺ Bash(npm test)` / `  ⎿  12 passed`.
class ToolEntry extends SampleEntry {
  const ToolEntry(
    this.tool,
    this.arg, [
    this.out = const [],
    this.outcome = ToolOutcome.ok,
  ]);
  final String tool;
  final String arg;
  final List<String> out;
  final ToolOutcome outcome;
}

/// One line of a diff: its number in the file, `-`, `+` or a space, and the code.
class DiffLine {
  const DiffLine(this.number, this.sign, this.code);
  final int number;
  final String sign;
  final String code;
}

/// An edit to a file, with the lines it changed.
class DiffEntry extends SampleEntry {
  const DiffEntry(this.file, this.lines);
  final String file;
  final List<DiffLine> lines;

  int get added => lines.where((line) => line.sign == '+').length;
  int get removed => lines.where((line) => line.sign == '-').length;
}

class Todo {
  const Todo(this.text, {this.done = false});
  final String text;
  final bool done;
}

/// The agent's plan, as its todo tool prints it.
class TodoEntry extends SampleEntry {
  const TodoEntry(this.items);
  final List<Todo> items;
}

/// What the CLI prints as it starts.
class BannerEntry extends SampleEntry {
  const BannerEntry(this.cwd);
  final String cwd;
}

/// A line the CLI adds about the turn itself — an interrupt, a restart.
class NoteEntry extends SampleEntry {
  const NoteEntry(this.text);
  final String text;
}

/// A permission question: the command, what it is for, and the answers on offer.
class SampleAsk {
  const SampleAsk({
    required this.title,
    required this.command,
    required this.purpose,
    required this.options,
  });

  /// `Bash command`.
  final String title;
  final String command;
  final String purpose;

  /// The rows, in order — `1.` is the first.
  final List<String> options;

  /// The dialog's own line, drawn in the pane.
  String get question => 'Do you want to proceed?';

  /// What the daemon announces for it (`permissionTitle` in the CLI's askQuestion.ts): the header
  /// and the command, `Approve Bash command: psql -f …`. It is what Find quotes under a harness that
  /// needs you — the pane's stock "Do you want to proceed?" said nothing about what.
  String get announced => 'Approve $title: $command';
}

enum LiveMode { idle, working, asking }

/// The live region's state: what is typed, what the spinner says, what is being asked.
class LiveState {
  LiveMode mode = LiveMode.idle;
  String input = '';

  /// The spinner's word, `Thinking`.
  String verb = 'Thinking';

  /// Spinner ticks since the turn started — the frame and the seconds both come from it.
  int ticks = 0;
  int tokens = 0;
  SampleAsk? ask;
  int selected = 0;
}

/// How often the spinner moves.
const sampleSpinnerTick = Duration(milliseconds: 700);

/// One CLI's way of drawing things.
abstract class SampleLook {
  const SampleLook();

  /// The engine id this look is — `claude` or `codex`.
  String get engine;

  List<String> entry(SampleEntry entry, int width);
  List<String> live(LiveState state, int width);

  /// The transcript as lines: each entry, then the blank line both CLIs leave after one.
  List<String> transcript(Iterable<SampleEntry> entries, int width) => [
    for (final item in entries) ...[...entry(item, width), ''],
  ];

  static SampleLook of(String engine) =>
      engine == 'codex' ? const CodexLook() : const ClaudeLook();
}

/// `code` in backticks, as its own style.
List<Span> _inline(String text, {String style = '', String code = '38;5;153'}) {
  final spans = <Span>[];
  final parts = text.split('`');
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].isEmpty) continue;
    spans.add(Span(parts[i], i.isOdd ? code : style));
  }
  return spans;
}

String _seconds(LiveState state) =>
    '${(state.ticks * sampleSpinnerTick.inMilliseconds / 1000).floor()}s';

String _tokens(int tokens) =>
    tokens < 1000 ? '$tokens' : '${(tokens / 1000).toStringAsFixed(1)}k';

/// A box drawn to [width]: the border dim, the rows as given.
List<String> _box(List<List<Span>> rows, int width, {String border = Sgr.dim}) {
  final inner = width - 4;
  return [
    SampleText.ansi([Span('╭${'─' * (width - 2)}╮', border)]),
    for (final row in rows)
      SampleText.ansi([
        Span('│', border),
        const Span(' '),
        ...SampleText.pad(row, inner),
        const Span(' '),
        Span('│', border),
      ]),
    SampleText.ansi([Span('╰${'─' * (width - 2)}╯', border)]),
  ];
}

/// The prompt's text laid into rows [room] wide, with the caret after it — at most [maxRows], the
/// last ones, as a prompt box scrolls its own text.
List<List<Span>> _promptRows(
  String input,
  int room, {
  required String placeholder,
  int maxRows = 4,
}) {
  const caret = Span(' ', '7');
  if (input.isEmpty) {
    return [
      [caret, Span(SampleText.clip(placeholder, room - 1), Sgr.dim)],
    ];
  }
  final runes = input.runes.toList();
  final rows = <List<Span>>[];
  for (var at = 0; at < runes.length; at += room) {
    final end = at + room < runes.length ? at + room : runes.length;
    rows.add([Span(String.fromCharCodes(runes.sublist(at, end)))]);
  }
  final last = rows.last;
  final lastWidth = SampleText.widthOf(last);
  if (lastWidth < room) {
    rows[rows.length - 1] = [...last, caret];
  } else {
    rows.add([caret]);
  }
  return rows.length <= maxRows ? rows : rows.sublist(rows.length - maxRows);
}

/// Claude Code, as its terminal UI draws.
class ClaudeLook extends SampleLook {
  const ClaudeLook();

  @override
  String get engine => 'claude';

  static const _glyphs = ['·', '✢', '✳', '✶', '✻', '✽'];

  @override
  List<String> entry(SampleEntry entry, int width) => switch (entry) {
    UserEntry(:final text) => SampleText.wrap(
      [Span(text, Sgr.gray)],
      width,
      first: const [Span('> ', Sgr.gray)],
      rest: const [Span('  ')],
    ),
    SayEntry(:final text) => SampleText.wrap(
      _inline(text),
      width,
      first: const [Span('⏺', '97'), Span(' ')],
      rest: const [Span('  ')],
    ),
    ToolEntry() => _tool(entry, width),
    DiffEntry() => _diff(entry, width),
    TodoEntry(:final items) => [
      SampleText.ansi(const [
        Span('⏺', Sgr.green),
        Span(' '),
        Span('Update Todos', Sgr.bold),
      ]),
      for (var i = 0; i < items.length; i++)
        ...SampleText.wrap(
          [
            Span(
              '${items[i].done ? '☒' : '☐'} ${items[i].text}',
              items[i].done ? '2;9' : '',
            ),
          ],
          width,
          first: [Span(i == 0 ? '  ⎿  ' : '     ', Sgr.dim)],
          rest: const [Span('       ')],
        ),
    ],
    BannerEntry(:final cwd) => _box(
      [
        const [
          Span('✻', Sgr.claude),
          Span(' Welcome to '),
          Span('Claude Code', Sgr.bold),
          Span('!'),
        ],
        const [],
        const [
          Span('  /help for help, /status for your current setup', Sgr.dim),
        ],
        const [],
        [Span('  cwd: $cwd', Sgr.dim)],
      ],
      width < 52 ? width : 52,
      border: Sgr.claude,
    ),
    NoteEntry(:final text) => SampleText.wrap(
      [Span(text, Sgr.red)],
      width,
      first: const [Span('  ⎿  ', Sgr.dim)],
      rest: const [Span('     ')],
    ),
  };

  List<String> _tool(ToolEntry tool, int width) {
    final mark = switch (tool.outcome) {
      ToolOutcome.ok => Sgr.green,
      ToolOutcome.failed || ToolOutcome.declined => Sgr.red,
    };
    return [
      ...SampleText.wrap(
        [Span(tool.tool, Sgr.bold), Span('(${tool.arg})')],
        width,
        first: [Span('⏺', mark), const Span(' ')],
        rest: const [Span('  ')],
      ),
      for (var i = 0; i < tool.out.length; i++)
        ...SampleText.wrap(
          [
            Span(
              tool.out[i],
              tool.outcome == ToolOutcome.declined ? Sgr.red : '',
            ),
          ],
          width,
          first: [Span(i == 0 ? '  ⎿  ' : '     ', Sgr.dim)],
          rest: const [Span('     ')],
        ),
    ];
  }

  List<String> _diff(DiffEntry diff, int width) {
    String plural(int n, String word) => '$n $word${n == 1 ? '' : 's'}';
    return [
      ...SampleText.wrap(
        [const Span('Update', Sgr.bold), Span('(${diff.file})')],
        width,
        first: const [Span('⏺', Sgr.green), Span(' ')],
        rest: const [Span('  ')],
      ),
      ...SampleText.wrap(
        [
          Span(
            'Updated ${diff.file} with ${plural(diff.added, 'addition')} and '
            '${plural(diff.removed, 'removal')}',
          ),
        ],
        width,
        first: const [Span('  ⎿  ', Sgr.dim)],
        rest: const [Span('     ')],
      ),
      for (final line in diff.lines)
        ...SampleText.wrap(
          [
            Span('${line.sign} ${line.code}', switch (line.sign) {
              '-' => Sgr.removed,
              '+' => Sgr.added,
              _ => '',
            }),
          ],
          width,
          first: [
            const Span('   '),
            Span(line.number.toString().padLeft(3), Sgr.dim),
            const Span(' '),
          ],
          rest: const [Span('         ')],
        ),
    ];
  }

  @override
  List<String> live(LiveState state, int width) {
    if (state.mode == LiveMode.asking && state.ask != null) {
      return _dialog(state.ask!, state.selected, width);
    }
    final box = _box([
      for (final (i, row) in _promptRows(
        state.input,
        width - 6,
        // Claude Code's own kind of nudge, and true of any project: not one project's file name
        // on every harness.
        placeholder: 'Try "test"',
      ).indexed)
        [Span(i == 0 ? '> ' : '  '), ...row],
    ], width);
    final status = SampleText.ansi(
      SampleText.clipSpans(const [
        Span('  ⏵⏵ accept edits on', Sgr.magenta),
        Span(' (shift+tab to cycle)', Sgr.dim),
      ], width),
    );
    if (state.mode != LiveMode.working) return [...box, status];
    final glyph = _glyphs[state.ticks % _glyphs.length];
    final spinner = SampleText.ansi(
      SampleText.clipSpans([
        Span('$glyph ${state.verb}…', Sgr.claude),
        Span(
          ' (${_seconds(state)} · ↓ ${_tokens(state.tokens)} tokens · esc to interrupt)',
          Sgr.dim,
        ),
      ], width),
    );
    return [spinner, '', ...box, status];
  }

  /// The permission dialog, as Claude Code draws it over its prompt box.
  List<String> _dialog(SampleAsk ask, int selected, int width) => [
    SampleText.ansi([Span('─' * width, Sgr.dim)]),
    SampleText.ansi([const Span(' '), Span(ask.title, Sgr.bold)]),
    '',
    ...SampleText.wrap(
      [Span(ask.command)],
      width,
      first: const [Span('   ')],
      rest: const [Span('   ')],
    ),
    ...SampleText.wrap(
      [Span(ask.purpose, Sgr.dim)],
      width,
      first: const [Span('   ')],
      rest: const [Span('   ')],
    ),
    '',
    SampleText.ansi([Span(' ${ask.question}')]),
    for (var i = 0; i < ask.options.length; i++)
      ...SampleText.wrap(
        [Span(ask.options[i], i == selected ? Sgr.cyan : '')],
        width,
        first: [
          Span(
            i == selected ? ' ❯ ${i + 1}. ' : '   ${i + 1}. ',
            i == selected ? Sgr.cyan : '',
          ),
        ],
        rest: const [Span('      ')],
      ),
    '',
    SampleText.ansi([const Span(' Esc to cancel · Enter to confirm', Sgr.dim)]),
  ];
}

/// Codex, as its terminal UI draws.
class CodexLook extends SampleLook {
  const CodexLook();

  @override
  String get engine => 'codex';

  @override
  List<String> entry(SampleEntry entry, int width) => switch (entry) {
    UserEntry(:final text) => SampleText.wrap(
      [Span(text)],
      width,
      first: const [Span('›', Sgr.bold), Span(' ')],
      rest: const [Span('  ')],
    ),
    SayEntry(:final text) => SampleText.wrap(
      _inline(text, code: Sgr.cyan),
      width,
      first: const [Span('• ')],
      rest: const [Span('  ')],
    ),
    ToolEntry() => _tool(entry, width),
    DiffEntry() => _diff(entry, width),
    TodoEntry(:final items) => [
      SampleText.ansi(const [Span('• '), Span('Updated Plan', Sgr.bold)]),
      for (var i = 0; i < items.length; i++)
        ...SampleText.wrap(
          [
            Span(
              '${items[i].done ? '✔' : '□'} ${items[i].text}',
              items[i].done ? '2;9' : '',
            ),
          ],
          width,
          first: [Span(i == 0 ? '  └ ' : '    ', Sgr.dim)],
          rest: const [Span('      ')],
        ),
    ],
    BannerEntry(:final cwd) => _box([
      const [
        Span('>_ ', Sgr.dim),
        Span('OpenAI Codex', Sgr.bold),
        Span(' (v0.46.0)', Sgr.dim),
      ],
      const [],
      const [Span('model:     ', Sgr.dim), Span('gpt-5-codex high')],
      [const Span('directory: ', Sgr.dim), Span(cwd)],
    ], width < 48 ? width : 48),
    NoteEntry(:final text) => SampleText.wrap(
      [Span(text)],
      width,
      first: const [Span('■', Sgr.red), Span(' ')],
      rest: const [Span('  ')],
    ),
  };

  List<String> _tool(ToolEntry tool, int width) {
    final (title, lines) = switch (tool.tool) {
      'Bash' => ('Ran', <String>[]),
      'Read' => ('Explored', ['Read ${tool.arg}']),
      'Grep' || 'Search' => ('Explored', ['Search ${tool.arg}']),
      _ => (tool.tool, <String>[]),
    };
    final out = [...lines, ...tool.out];
    final mark = tool.outcome == ToolOutcome.ok ? '' : Sgr.red;
    return [
      ...SampleText.wrap(
        [Span(title, Sgr.bold), if (tool.tool == 'Bash') Span(' ${tool.arg}')],
        width,
        first: [Span('•', mark), const Span(' ')],
        rest: const [Span('    ')],
      ),
      for (var i = 0; i < out.length; i++)
        ...SampleText.wrap(
          [Span(out[i], Sgr.dim)],
          width,
          first: [Span(i == 0 ? '  └ ' : '    ', Sgr.dim)],
          rest: const [Span('    ')],
        ),
    ];
  }

  List<String> _diff(DiffEntry diff, int width) => [
    ...SampleText.wrap(
      [
        const Span('Edited', Sgr.bold),
        Span(' ${diff.file} '),
        const Span('('),
        Span('+${diff.added}', Sgr.green),
        const Span(' '),
        Span('-${diff.removed}', Sgr.red),
        const Span(')'),
      ],
      width,
      first: const [Span('• ')],
      rest: const [Span('    ')],
    ),
    for (final line in diff.lines)
      ...SampleText.wrap(
        [
          Span('${line.sign}${line.code}', switch (line.sign) {
            '-' => Sgr.red,
            '+' => Sgr.green,
            _ => Sgr.dim,
          }),
        ],
        width,
        first: [
          const Span('  '),
          Span(line.number.toString().padLeft(3), Sgr.dim),
          const Span(' '),
        ],
        rest: const [Span('       ')],
      ),
  ];

  @override
  List<String> live(LiveState state, int width) {
    if (state.mode == LiveMode.asking && state.ask != null) {
      return _approval(state.ask!, state.selected, width);
    }
    final rows = _promptRows(
      state.input,
      width - 2,
      placeholder: 'Ask Codex to do anything',
    );
    final composer = [
      for (final (i, row) in rows.indexed)
        SampleText.ansi([Span(i == 0 ? '› ' : '  ', Sgr.bold), ...row]),
    ];
    final footer = SampleText.ansi(
      SampleText.clipSpans(const [
        Span('  92% context left · ? for shortcuts', Sgr.dim),
      ], width),
    );
    if (state.mode != LiveMode.working) return [...composer, '', footer];
    final working = SampleText.ansi(
      SampleText.clipSpans([
        const Span('• '),
        const Span('Working', Sgr.bold),
        Span(' (${_seconds(state)} • esc to interrupt)', Sgr.dim),
      ], width),
    );
    return [working, '', ...composer, '', footer];
  }

  List<String> _approval(SampleAsk ask, int selected, int width) => [
    SampleText.ansi([
      const Span('  Would you like to run the following command?', Sgr.bold),
    ]),
    '',
    ...SampleText.wrap(
      [Span(ask.command)],
      width,
      first: const [Span('  \$ ', Sgr.dim)],
      rest: const [Span('    ')],
    ),
    '',
    for (var i = 0; i < ask.options.length; i++)
      ...SampleText.wrap(
        [Span(ask.options[i], i == selected ? Sgr.cyan : '')],
        width,
        first: [
          Span(
            i == selected ? '› ${i + 1}. ' : '  ${i + 1}. ',
            i == selected ? Sgr.cyan : '',
          ),
        ],
        rest: const [Span('     ')],
      ),
    '',
    SampleText.ansi([
      const Span('  Press enter to confirm or esc to cancel', Sgr.dim),
    ]),
  ];
}

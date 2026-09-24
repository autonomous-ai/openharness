/// Read an open question dialog straight off the terminal's own buffer.
///
/// ⚠️ **Why this exists at all.** The daemon already watches the pane and
/// shapes the question — but it publishes it on `commander_question`, which
/// goes out over `sendCommander` (`webEligible: false`) and `sendLocal`
/// (loopback only). A phone attached over the relay is in neither audience, so
/// that frame never arrives here. Until `commander_question` is carried over an
/// encrypted up-type, the buffer this app already holds is the only source it
/// has.
///
/// ⚠️ **This does NOT feed `blockedAgents`.** The amber ring on a tile, and the
/// Needs input picker, still read the daemon's frames — an agent this window is
/// not looking at has no buffer here to read, and letting a pane-derived
/// question drive that shared state would make a ring that only exists while
/// its agent happens to be on screen. What this feeds is the keyboard on the
/// page whose buffer it read, and nothing else.
///
/// Ported from the daemon's `parseQuestionPane` (cli/src/lib/askQuestion.ts).
/// Kept deliberately narrow: Claude Code and Codex only. Every other engine
/// returns null and keeps exactly the behaviour it has today.
library;

import 'package:xterm/xterm.dart';

import 'key_chord.dart';

/// Which CLI painted the dialog — the two this parser is verified against.
///
/// The engine matters for more than the frame: Codex highlights on a digit and
/// commits on Enter, while Claude's digit both selects and submits. [QuestionPaneView.enterSubmits]
/// carries that difference out.
enum QuestionEngine { claude, codex }

/// Map the engine id the app already carries onto the two this parser knows.
///
/// ⚠️ Unknown ids return null on purpose — `commandcode` and the rest paint
/// dialogs this parser has never been checked against, and guessing at one
/// would put a pad over a screen it cannot actually drive.
QuestionEngine? questionEngineOf(String? engineId) => switch (engineId) {
  'claude' => QuestionEngine.claude,
  'codex' => QuestionEngine.codex,
  _ => null,
};

/// One selectable row of the dialog.
class QuestionPaneRow {
  const QuestionPaneRow({
    required this.number,
    required this.label,
    required this.checked,
  });

  /// The digit to press.
  final String number;

  final String label;

  /// `[✔]` rather than `[ ]` — only ever set on a multi-select.
  final bool checked;
}

/// A dialog found on the pane.
class QuestionPaneView {
  const QuestionPaneView({
    required this.question,
    required this.rows,
    required this.multi,
    required this.enterSubmits,
    required this.partial,
  });

  /// Empty when [partial] — the dialog is open but its question has scrolled
  /// out of the buffer.
  final String question;

  final List<QuestionPaneRow> rows;

  /// Rows render as `[ ]` / `[✔]`: a digit toggles rather than answers.
  final bool multi;

  /// The footer says a digit only highlights and Enter commits — Codex's
  /// `request_user_input`. False where one digit selects and submits: every
  /// Claude dialog, and Codex's async question (see [_asyncFooter]).
  final bool enterSubmits;

  /// The dialog is on screen but its top — the question and its first rows — is
  /// above the buffer. Enough to know a dialog is STILL OPEN, and not enough to
  /// show as a question.
  ///
  /// ⚠️ Measured by the daemon on Codex: it anchors its footer and lets a short
  /// pane cut the top off. A caller must treat this as "keep whatever is
  /// showing", never as "no dialog".
  final bool partial;

  /// A question worth putting a pad over: open, and with its text in hand.
  bool get answerable => !partial && question.isNotEmpty && rows.isNotEmpty;

  /// Changes whenever the dialog does — used to tell a redraw of the SAME
  /// question from a new one.
  String get fingerprint =>
      '$question|${rows.map((r) => '${r.number}.${r.label}').join('|')}';
}

/// Rows that exist in every dialog but can never BE an answer.
final RegExp _chatRow = RegExp(
  r'^chat about (this|these)$',
  caseSensitive: false,
);

/// The free-text row. It opens an editor instead of choosing, so it must never
/// be offered as a selectable label. Claude writes "Type something.", Codex
/// "Type something..." — one trailing dot or three.
final RegExp _typeRow = RegExp(
  r'^(type something\.{0,3}|type your own( answer)?|other \(type your (own|answer)\))$',
  caseSensitive: false,
);

/// The bottom of a live dialog. Each CLI words its own.
///
/// `enter to submit answer` is Codex's `request_user_input`; the rest are
/// Claude's. Missing one means the dialog is never seen at all.
final RegExp _footer = RegExp(
  r'enter to (select|confirm|submit)|enter\s+(submit|confirm|toggle)',
  caseSensitive: false,
);

/// Codex's footer, which also says a digit alone does not commit.
final RegExp _enterSubmitsFooter = RegExp(
  r'enter to submit answer',
  caseSensitive: false,
);

/// The footer of a Codex ASYNC question once it has been opened out of the
/// queue (`request_user_input_async`, see [parseQueuedQuestions]):
/// `enter submit   ctrl+] skip   ⌥+↓ main prompt`.
///
/// ⚠️ **Not the synchronous dialog, and it does not behave like one.**
/// Measured on Codex 0.156.1: a digit here selects AND submits — `2` answered
/// "Green" on the spot — where the synchronous dialog's digit only moves the
/// highlight. And the UI appends a free-text `Other` row of its own (the tool
/// tells the model never to include one), which is an editor, not an answer.
///
/// Matched on the words, not the keys: `skip` and `main prompt` are what the
/// hints do, and the keys in front of them are the person's to remap.
final RegExp _asyncFooter = RegExp(
  r'enter\s+submit\b.*\b(skip|main prompt)\b',
  caseSensitive: false,
);

/// The free-text row an async question's UI adds under the model's options.
final RegExp _asyncOtherRow = RegExp(
  r'^other( \(write an answer\))?$',
  caseSensitive: false,
);

/// `❯ 1. Label` — with the caret optional and any checkbox peeled off.
final RegExp _row = RegExp(r'^\s*[❯›>]?\s*(\d+)\.\s+(.+?)\s*$');

final RegExp _checkbox = RegExp(r'^\[([^\]])\]\s*(.*)$');

/// A row drawn as a checkbox, which makes the whole dialog multi-select.
final RegExp _checkboxRow = RegExp(r'^\s*[❯›>]?\s*\d+\.\s+\[');

/// The tab bar above a multi-question dialog, a rule, or a checkbox chip —
/// whichever comes first walking up is the top of this frame.
final RegExp _frameTop = RegExp(r'[←→]');
final RegExp _chipTop = RegExp(r'^[☐☒✔✓]');
final RegExp _ruleTop = RegExp(r'^[─━-]{6,}$');

/// Codex draws an option's description on the SAME line as its label, padded
/// into a second column (`1. Red    Creates a bold, high-contrast`). Claude
/// puts it on the line below, where it is not a row at all and is skipped.
///
/// ⚠️ **Two spaces, not three.** Codex pads to a column, so a label as long as
/// its column leaves only the single gap the padding guarantees — measured on
/// `__fixtures__/question-codex.txt`, where `2. Green  Creates a fresh…` has
/// exactly two and a three-space rule left the description glued to the label.
/// A real label never holds a double space: the dialog collapses its own
/// whitespace before it paints.
final RegExp _codexDescription = RegExp(r'^(.+?)\s{2,}\S');

/// Codex's own chrome, drawn directly above a question with no blank line to
/// separate it: the prompt caret, an event bullet, the status line under the
/// composer, or an async question's `1 of 2` counter. Each marks the top of the
/// dialog's frame.
///
/// ⚠️ Without this the wrap walk had nothing to stop it — Codex paints no rule
/// and no tab bar — and it swallowed the whole transcript into the question.
final RegExp _codexChrome = RegExp(
  r'^\s*[›•❯>]|^\s*(Question \d+/\d+|\d+ of \d+\s*$|Working \(|Ask Codex)',
);

/// Lines that may sit under a live dialog's footer without meaning the engine
/// has moved on: a second footer line, a bare prompt caret, or a rule.
///
/// ⚠️ **The footer WRAPS, and its tail is not a hint word to be listed.** On
/// a 47-column phone pane `Enter to select · ↑/↓ to navigate · Esc to cancel`
/// breaks after `Esc to`, leaving a line that is just `cancel` — and a rule
/// built from the words this parser happened to have seen rejected it, decided
/// the dialog was stale, and hid the pad over a live question. Measured on pane
/// %11 while the dialog was open.
///
/// So the test is SHAPE, not vocabulary: the continuation of a wrapped footer
/// is a short scrap of prose with no sentence-ending punctuation. Engine output
/// under a dead dialog is a real line — long, or punctuated, or marked with the
/// glyph its CLI prefixes results with. [_footerTailWords] is what keeps this
/// from swallowing one.
final RegExp _trailingChrome = RegExp(
  r'^(option \d+/\d+|[\u276f\u203a>]\s*|[\u2502\u251c\u2514\u2500\u2014\-_\s]+)$',
  caseSensitive: false,
);

/// A line that reads as the tail of a footer the pane wrapped.
///
/// ⚠️ **Not a length test.** The first version of this allowed a short,
/// unpunctuated scrap — enough for `cancel`, and nothing else. Then a pane
/// wrapped `Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in
/// Vim · Esc to cancel` onto a second line that was 37 characters and six
/// words, the test rejected it, and the pad vanished the moment the caret
/// reached the last row. Measured on pane %12.
///
/// A footer says what keys do, so its continuation carries the same marks the
/// footer itself does: the `·` it separates hints with, or a `key to verb`
/// phrase such as `Esc to cancel`. Engine output under a dead dialog has
/// neither.
bool _looksLikeFooterTail(String line) {
  // Its own output glyph rules a line out whatever else it holds — every CLI
  // prefixes results with one, and no wrapped footer starts with one.
  if (_outputGlyph.hasMatch(line)) return false;
  if (RegExp(r'[.!?\u3002]$').hasMatch(line)) return false;
  if (_footerHint.hasMatch(line)) return true;
  // A footer can wrap onto a single orphan word — `… · Esc to` breaks and leaves
  // just `cancel`, which carries no hint of its own. One bare word is not a
  // line of output either, so it is allowed through on its shape alone.
  return !line.contains(' ') && line.length <= 16;
}

/// The glyphs a CLI prefixes its own output with.
final RegExp _outputGlyph = RegExp(
  r'^[\u23fa\u2022\u2713\u2717\u203a\u276f>\u2731\u250c\u2514#\[]',
);

/// What a footer's continuation looks like: a `·` separator, or a phrase
/// naming a key and what it does.
///
/// ⚠️ **Every modifier a footer writes, glyphs included, and outside the word
/// boundaries.** Codex's async question wraps its footer on a phone pane and,
/// on its last question, the second line is `⌥+↓ prev question` alone — no
/// `shift+`, no `ctrl+`, nothing this used to know. That line read as output
/// under a dead dialog, the dialog was dropped, and the keyboard never came up
/// for it. Measured on Codex 0.156.1, question 2 of 2. The modifiers sit before
/// the `\b` group because a `\b` cannot follow `+` into `↓` or `]`: neither
/// side is a word character.
final RegExp _footerHint = RegExp(
  r'\u00b7|[⌥⌃⇧]\s*\+|\b(?:ctrl|shift|alt|option|opt|meta)\s*\+|\b(to (select|cancel|confirm|submit|toggle|navigate|edit|add|interrupt|view|expand)|esc|enter|tab|\u2191/\u2193|\u2190/\u2192)\b',
  caseSensitive: false,
);

/// The review step's own anchor, in place of the footer it does not paint.
final RegExp _reviewPrompt = RegExp(
  r'ready to submit your answers',
  caseSensitive: false,
);

/// The row that makes a review a review.
final RegExp _submitRow = RegExp(r'^submit answers$', caseSensitive: false);

/// How far under its prompt a review's rows may run.
const int _maxReviewScan = 10;

/// How far above the footer a dialog's rows may run before this stops looking.
const int _maxRowScan = 40;

/// How far above the rows the question may sit.
const int _maxQuestionScan = 12;

/// How many lines a wrapped question may span.
///
/// ⚠️ A real wrapped question is two or three lines on a 47-column phone
/// pane. More than this is the walk having escaped a frame whose top it could
/// not recognise, and the tail alone beats a question with the transcript in
/// it.
const int _maxWrapLines = 4;

/// Read the current dialog off [terminal]'s buffer, or null if there is none.
///
/// ⚠️ **Anchored to the LAST footer, not the first.** The buffer holds
/// scrollback — old dialogs, old plan text — and the live dialog is always the
/// lowest one. Reading upward from the bottom is what keeps an answered
/// question in the scrollback from being shown as an open one.
QuestionPaneView? readQuestionPane(Terminal terminal, QuestionEngine engine) {
  final lines = questionPaneLines(terminal);
  if (lines.isEmpty) return null;
  return parseQuestionLines(lines, engine);
}

/// The buffer as plain text, oldest line first — what every parser here reads.
///
/// Public so one read of the buffer can serve both [parseQuestionLines] and
/// [parseQueuedQuestions] rather than each copying it out again.
///
/// ⚠️ **Reads the buffer, not the viewport.** Someone scrolled up to read
/// history is still being asked the question, and a pad that vanished when they
/// scrolled would be a pad that leaves exactly when it is being read about.
List<String> questionPaneLines(Terminal terminal) {
  final buffer = terminal.buffer;
  final lines = buffer.lines;
  final total = lines.length;
  if (total == 0) return const [];
  // The dialog is at the bottom; everything far above it is scrollback that
  // only slows the walk down.
  final from = total - _bufferScan < 0 ? 0 : total - _bufferScan;
  final out = <String>[];
  for (var i = from; i < total; i++) {
    out.add(lines[i].toString().replaceAll('\u00a0', ' ').trimRight());
  }
  return out;
}

/// How much of the buffer to read back.
///
/// ⚠️ The daemon captures 60 lines and the phone negotiates a 50-line pty, so
/// 80 covers a dialog that begins above the fold with room to spare, without
/// walking scrollback that cannot hold the live dialog anyway.
const int _bufferScan = 80;

/// The parser proper, over lines already stripped of styling.
///
/// Separated from [readQuestionPane] so the shape can be reasoned about against
/// a captured pane without a live terminal.
QuestionPaneView? parseQuestionLines(
  List<String> lines,
  QuestionEngine engine,
) {
  // ⚠️ **The review screen paints no footer**, so it has to be found first or
  // not at all. After the last question the dialog becomes "Ready to submit
  // your answers?" over `1. Submit answers` / `2. Cancel` — still open, still
  // waiting, still driven by the same arrows and Enter. Anchoring only on a
  // footer made the pad vanish the moment the caret reached Submit, which is
  // exactly when it is still needed. Measured on pane %8.
  final review = _parseReview(lines);
  if (review != null) return review;

  final footer = lines.lastIndexWhere((l) => _footer.hasMatch(l));
  if (footer < 0) return null;
  // ⚠️ **A footer is not proof the dialog is still open.** The daemon captures
  // the live pane, where an answered dialog is simply gone. This reads a
  // BUFFER, which keeps it in scrollback forever — and anchoring on the last
  // footer alone showed the pad again over a question answered minutes ago,
  // with its options still tappable. Measured against a real pane with the
  // answer and two more turns appended below it.
  //
  // What separates the two is what sits UNDER the footer: a live dialog is the
  // last thing on screen, so only blanks and its own trailing chrome may follow
  // it. One line of ordinary output down there means the engine has moved on.
  if (!_isLastThingOnScreen(lines, footer)) return null;

  final rows = <QuestionPaneRow>[];
  var checkbox = false;
  var start = -1;
  for (var i = footer - 1; i >= 0 && footer - i <= _maxRowScan; i--) {
    final row = _parseRow(lines[i], engine);
    if (row == null) continue;
    rows.insert(0, row);
    if (_checkboxRow.hasMatch(lines[i])) checkbox = true;
    if (row.number == '1') {
      start = i;
      break;
    }
  }

  final asyncQuestion =
      engine == QuestionEngine.codex && _asyncFooter.hasMatch(lines[footer]);
  final enterSubmits =
      !asyncQuestion && _enterSubmitsFooter.hasMatch(lines[footer]);
  // The UI's own free-text row, always last — see [_asyncFooter]. Dropped here
  // rather than folded into [_typeRow]: a Claude dialog's option CAN be called
  // "Other", and there it is an answer.
  if (asyncQuestion &&
      rows.isNotEmpty &&
      _asyncOtherRow.hasMatch(rows.last.label)) {
    rows.removeLast();
  }
  // Rows in view but no "1." above them: the dialog's top is out of the buffer.
  // Only Codex does this, and only its footer proves the dialog is still there.
  if (rows.isNotEmpty && start < 0 && (enterSubmits || asyncQuestion)) {
    return QuestionPaneView(
      question: '',
      rows: rows,
      multi: checkbox,
      enterSubmits: enterSubmits,
      partial: true,
    );
  }
  if (start < 0 || rows.isEmpty) return null;

  // The question is the nearest real text line above the rows.
  //
  // ⚠️ **Stop at the frame's top, never walk past it.** Mid-repaint the
  // question line can be blank for one read, and walking on would pick up the
  // PREVIOUS question still in scrollback and pair a stale title with live
  // options. An empty result just means "look again".
  var question = '';
  var questionAt = -1;
  for (var i = start - 1; i >= 0 && start - i <= _maxQuestionScan; i--) {
    final line = lines[i].trim();
    if (line.isEmpty) continue;
    if (_frameTop.hasMatch(line) ||
        _chipTop.hasMatch(line) ||
        _ruleTop.hasMatch(line)) {
      break;
    }
    question = line;
    questionAt = i;
    break;
  }

  // ⚠️ **The question can be WRAPPED, and the daemon does not stitch it.** A
  // 47-column pane broke "…và dài bao lâu?" across two lines and the daemon
  // announced the question as "lâu?" — see `[question] … asking the user ·
  // "lâu?"` in harness.log. The line above is part of the question when it is
  // prose rather than another row or the frame's top.
  if (question.isNotEmpty) {
    question = _stitchWrapped(lines, questionAt, question);
  }

  final answerable = rows
      .where((r) => !_chatRow.hasMatch(r.label) && !_typeRow.hasMatch(r.label))
      .toList(growable: false);
  if (answerable.isEmpty) return null;

  return QuestionPaneView(
    question: question,
    rows: answerable,
    multi: checkbox,
    enterSubmits: enterSubmits,
    partial: false,
  );
}

/// Walk up from the question's last line, gathering the lines it wrapped onto.
///
/// [tailAt] is the index [tail] was read from — NOT `start - 1`. The question
/// search skips blank lines, so the two are different whenever a dialog puts a
/// gap between its question and its first row, and walking from the wrong one
/// appended the tail to itself ("…bao lâu? lâu?" on a live 47-column pane).
///
/// ⚠️ **Bounded by [_maxWrapLines], and that bound is load-bearing.** A dialog
/// whose frame has no rule or tab bar above the question — Codex draws none —
/// has nothing to stop this walk, and it ran to the top of the buffer and
/// returned the entire screen as the question, transcript and all. Real wrapped
/// questions are two or three lines; anything longer is the walk having escaped
/// its frame, and the tail alone is the better answer.
String _stitchWrapped(List<String> lines, int tailAt, String tail) {
  if (tailAt <= 0) return tail;
  final parts = <String>[tail];
  for (var i = tailAt - 1; i >= 0 && tailAt - i <= _maxWrapLines; i--) {
    final line = lines[i].trim();
    // A blank line is the top of the question's own block in every dialog that
    // leaves one.
    if (line.isEmpty) break;
    if (_frameTop.hasMatch(line) ||
        _chipTop.hasMatch(line) ||
        _ruleTop.hasMatch(line)) {
      break;
    }
    // Another numbered row above means the question never wrapped — what is up
    // there belongs to a different frame.
    if (_row.hasMatch(line)) break;
    // Codex paints its own chrome directly above the question with no blank
    // line between: a prompt caret, a bullet, or its status/model line. Each is
    // the top of the frame as surely as a rule would be.
    if (_codexChrome.hasMatch(line)) break;
    parts.insert(0, line);
  }
  return parts.join(' ');
}

/// The review step, which closes a multi-question dialog.
///
/// It has no footer of its own — `Ready to submit your answers?` and its two
/// rows are the whole frame — so it is anchored on that line instead, and only
/// when it is the last thing on screen.
///
/// Returned as an ordinary question: the pad drives it exactly as it drives any
/// other, and calling it something else would only make the caller ask why.
QuestionPaneView? _parseReview(List<String> lines) {
  final at = lines.lastIndexWhere((l) => _reviewPrompt.hasMatch(l));
  if (at < 0) return null;
  final rows = <QuestionPaneRow>[];
  var sawSubmit = false;
  for (var i = at + 1; i < lines.length && i - at <= _maxReviewScan; i++) {
    final line = lines[i].trim();
    if (line.isEmpty) continue;
    final row = _parseRow(lines[i], QuestionEngine.claude);
    if (row == null) {
      // Anything else under the prompt means this review has been answered and
      // what follows is the engine's output.
      if (_trailingChrome.hasMatch(line) || _looksLikeFooterTail(line)) {
        continue;
      }
      return null;
    }
    rows.add(row);
    if (_submitRow.hasMatch(row.label)) sawSubmit = true;
  }
  // Both halves matter: the prompt alone appears in scrollback too, and it is
  // the Submit row still being drawn under it that says this one is live.
  if (!sawSubmit || rows.isEmpty) return null;
  return QuestionPaneView(
    question: lines[at].trim(),
    rows: rows,
    multi: false,
    enterSubmits: false,
    partial: false,
  );
}

/// Is the dialog ending at [footer] the last thing drawn on the pane?
///
/// Everything below it must be blank or the dialog's own trailing chrome.
/// Codex draws TWO footer lines (`option 1/4 | tab to add notes` above
/// `enter to submit answer | esc to interrupt`) and an empty prompt line can
/// follow either CLI, so a handful of recognised lines are allowed through —
/// but anything the engine printed afterwards is not.
bool _isLastThingOnScreen(List<String> lines, int footer) {
  for (var i = footer + 1; i < lines.length; i++) {
    final line = lines[i].trim();
    if (line.isEmpty) continue;
    if (_footer.hasMatch(line)) continue;
    if (_trailingChrome.hasMatch(line)) continue;
    // The footer itself, wrapped. Not limited to the line directly under it:
    // `Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim ·
    // Esc to cancel` takes three lines on a 47-column pane, and each carries
    // the marks _looksLikeFooterTail reads.
    if (_looksLikeFooterTail(line)) continue;
    return false;
  }
  return true;
}

QuestionPaneRow? _parseRow(String line, QuestionEngine engine) {
  final m = _row.firstMatch(line);
  if (m == null) return null;
  final raw = m.group(2)!;
  final box = _checkbox.firstMatch(raw);
  var label = (box != null ? box.group(2)! : raw).trim();
  // Codex pads a description into a second column on the row itself; Claude
  // never does, so this only ever runs where it was measured.
  if (engine == QuestionEngine.codex) {
    final split = _codexDescription.firstMatch(label);
    if (split != null) label = split.group(1)!.trim();
  }
  if (label.isEmpty) return null;
  return QuestionPaneRow(
    number: m.group(1)!,
    label: label,
    checked: box != null && box.group(1)!.trim().isNotEmpty,
  );
}

/// Codex's async questions, waiting in its queue rather than open on screen.
///
/// ```
/// • Queued follow-up inputs
///   ? 1 question
///     shift+← to answer
///
/// › Ask Codex to do anything
/// ```
///
/// ⚠️ **Why a dialog parser cannot see this.** `request_user_input_async` asks
/// and lets the agent carry on working: nothing is open, nothing has a footer
/// or rows, and the composer stays live under it. The question only becomes a
/// dialog once [answerKey] is pressed — and on a phone that key is one the
/// keyboard does not have.
class QueuedQuestions {
  const QueuedQuestions({required this.count, required this.answerKey});

  /// How many are waiting — `? 2 questions`.
  final int count;

  /// The key the hint says opens the first of them, as Codex names it — see
  /// [KeyChord] for why it is read rather than assumed.
  final KeyChord answerKey;

  @override
  bool operator ==(Object other) =>
      other is QueuedQuestions &&
      other.count == count &&
      other.answerKey == answerKey;

  @override
  int get hashCode => Object.hash(count, answerKey);
}

/// `? 1 question` — the count line. Its wording varies with the count and, per
/// the strings Codex 0.156.1 carries, may say `unanswered`.
final RegExp _queuedCount = RegExp(
  r'^\s*\?\s+(\d+)\s+(?:unanswered\s+)?questions?\s*$',
  caseSensitive: false,
);

/// `shift+← to answer` — and `shift + ← to answer`, which is how the same hint
/// was captured from another install: the key's spacing is not fixed.
final RegExp _queuedHint = RegExp(
  r'^\s*(\S(?:.*\S)?)\s+to answer\s*$',
  caseSensitive: false,
);

/// Codex's composer line — `› Ask Codex to do anything`, or `›` over a draft.
final RegExp _composer = RegExp(r'^\s*\u203a(\s|$)');

/// How far above its hint the count line may sit. They are adjacent in every
/// capture; one line of slack covers a repaint caught mid-way.
const int _maxQueuedCountGap = 2;

/// How far under the hint Codex's composer must be.
///
/// ⚠️ **The composer is what says the queue is live.** The block is part of
/// Codex's bottom pane, always drawn right above the composer; one read with
/// the hint and no composer under it is scrollback, or a Codex that has exited,
/// and a button pressing a key into either would type into whatever is there
/// now. The slack is for queued follow-up messages, which the same block can
/// list under the question.
const int _maxQueuedComposerScan = 10;

/// Read Codex's queued async questions off the buffer, or null if none wait.
///
/// ⚠️ **Codex only, and only its live bottom pane.** Anchored to the LAST hint
/// in the buffer, for the reason [readQuestionPane] anchors to the last
/// footer, and only when Codex's composer is still drawn under it.
QueuedQuestions? parseQueuedQuestions(List<String> lines) {
  // ⚠️ **Every candidate from the bottom up, not just the last one.** A hint's
  // shape — words, then `to answer` — is also the shape of a sentence, and the
  // lowest such line can be the person's own draft in the composer. Each is
  // checked in turn, and the first that is a real hint wins.
  for (var at = lines.length - 1; at >= 0; at--) {
    final match = _queuedHint.firstMatch(lines[at]);
    if (match == null) continue;
    final found = _queuedAt(lines, at, match.group(1)!);
    if (found != null) return found;
  }
  return null;
}

/// The queue whose hint is on line [hintAt], naming [keyText] — or null when
/// that line is not one.
QueuedQuestions? _queuedAt(List<String> lines, int hintAt, String keyText) {
  var count = 0;
  for (var i = hintAt - 1; i >= 0 && hintAt - i <= _maxQueuedCountGap; i--) {
    final match = _queuedCount.firstMatch(lines[i]);
    if (match != null) {
      count = int.parse(match.group(1)!);
      break;
    }
    // Only blanks may stand between the two; anything else means this hint
    // belongs to something other than a question count.
    if (lines[i].trim().isNotEmpty) return null;
  }
  if (count <= 0) return null;

  var live = false;
  for (
    var i = hintAt + 1;
    i < lines.length && i - hintAt <= _maxQueuedComposerScan;
    i++
  ) {
    if (_composer.hasMatch(lines[i])) {
      live = true;
      break;
    }
    // A dialog under the hint means the question has already been opened.
    if (_footer.hasMatch(lines[i])) return null;
  }
  if (!live) return null;

  final key = KeyChord.parse(keyText);
  // A key this cannot press is no key at all — see [KeyChord].
  if (key == null) return null;
  return QueuedQuestions(count: count, answerKey: key);
}

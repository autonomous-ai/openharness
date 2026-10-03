/// Local UI boundary for controls that operate on the rendered terminal but
/// do not travel to the remote tmux pane.
enum TerminalFindAction { open, next, previous }

/// Optional capability: small device gestures can select local output without
/// turning them into arrow keys or mouse reports in the running program.
abstract interface class TerminalPassageViewport {
  Map<String, dynamic> selectPassage(Map<String, dynamic> command);
}

/// Spoken lookup shares the local terminal index; scans may yield to rendering.
abstract interface class TerminalPassageSearchViewport {
  Future<Map<String, dynamic>> searchPassage(Map<String, dynamic> command);
}

/// One local reading position. Restoring consumes it, even if the original
/// buffer has gone away. It never reopens a stream or sends terminal input.
abstract interface class TerminalReadingBookmark {
  bool restore();
  void dispose();
}

abstract interface class TerminalReadingViewport {
  TerminalReadingBookmark? bookmarkReading();
}

/// Show the end of local scrollback without sending keys or mouse input to the
/// running program. Full-screen applications own their scrolling and refuse.
abstract interface class TerminalLatestViewport {
  bool showLatestReading();
}

abstract interface class TerminalViewport {
  /// One report from the hardware dial.
  ///
  /// [phase] is 0 (down), 1 (move), or 2 (up). [dy] is the movement in glass
  /// pixels and [velocity] is glass pixels per second at release.
  void scroll(int phase, int dy, int velocity);

  /// Opens or steps through local terminal output without sending a key.
  void find(TerminalFindAction action);

  /// Claims an already mounted editor before navigation's next rendered frame.
  /// False means the destination has no ready input view yet.
  bool focusInput();
}

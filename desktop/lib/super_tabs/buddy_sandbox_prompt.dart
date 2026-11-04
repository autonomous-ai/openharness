import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';

import '../core/harness_cli_runner.dart';
import '../widgets/desktop_chrome.dart';

/// `harness buddy-sandbox` (cli/src/lib/windows/buddySandboxCommand.ts): what a
/// person on Windows agrees to so their Buddy reads past its own folder.
abstract class BuddySandboxInstaller {
  Future<bool> ready();

  /// Returns null when installed, or the sentence saying why it is not.
  Future<String?> install(void Function(String line) progress);
}

class CliBuddySandboxInstaller implements BuddySandboxInstaller {
  CliBuddySandboxInstaller({HarnessCliRunner? runner})
    : _runner = runner ?? HarnessCliRunner();
  final HarnessCliRunner _runner;

  @override
  Future<bool> ready() async {
    final result = await _runner.run(['buddy-sandbox', 'status']);
    return result.exitCode == 0 && '${result.stdout}'.trim() == 'ready';
  }

  @override
  Future<String?> install(void Function(String line) progress) async {
    final Process process;
    try {
      process = await _runner.start(['buddy-sandbox', 'install']);
    } on ProcessException catch (error) {
      return 'Harness could not start this: ${error.message}';
    }
    unawaited(process.stdin.close());
    final lines = process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(progress);
    final failure = process.stderr.transform(utf8.decoder).join();
    final code = await process.exitCode;
    await lines.cancel();
    if (code == 0) return null;
    final said = (await failure).trim();
    return said.isEmpty ? 'This did not finish.' : said;
  }
}

/// Windows, on the Buddy's own computer: the one question that lets it read
/// the person's files. They say yes once, Windows asks once, and the Buddy
/// starts again in the same chat. Saying nothing leaves it in its folder, as
/// the line says: nothing breaks, and the question is back next time.
class BuddySandboxPrompt extends StatefulWidget {
  const BuddySandboxPrompt({
    super.key,
    required this.installer,
    required this.restart,
  });
  final BuddySandboxInstaller installer;

  /// Starts the Buddy again, in the same chat, so it picks up its new reach.
  final Future<void> Function() restart;

  @override
  State<BuddySandboxPrompt> createState() => _BuddySandboxPromptState();
}

class _BuddySandboxPromptState extends State<BuddySandboxPrompt> {
  /// Not now holds for as long as the app runs, across every Buddy bar.
  static bool _notNow = false;

  bool _show = false, _busy = false;
  String? _progress, _error;

  @override
  void initState() {
    super.initState();
    if (!_notNow) unawaited(_check());
  }

  Future<void> _check() async {
    final bool ready;
    try {
      ready = await widget.installer.ready();
    } catch (_) {
      // A CLI that cannot answer has nothing to offer here yet.
      return;
    }
    if (mounted && !ready) setState(() => _show = true);
  }

  Future<void> _allow() async {
    setState(() {
      _busy = true;
      _error = null;
      _progress = 'Windows will ask you once. Choose Yes.';
    });
    final failure = await widget.installer.install((line) {
      if (mounted) setState(() => _progress = line);
    });
    if (!mounted) return;
    if (failure != null) {
      setState(() {
        _busy = false;
        _error = failure;
      });
      return;
    }
    await widget.restart();
    if (mounted) setState(() => _show = false);
  }

  @override
  Widget build(BuildContext context) {
    if (!_show) return const SizedBox.shrink();
    final text = _error ?? _progress ?? kBuddySandboxQuestion;
    return Row(
      key: const ValueKey('buddy-sandbox-prompt'),
      children: [
        Expanded(child: Text(text, style: DesktopChrome.control())),
        if (!_busy) ...[
          TextButton(
            key: const ValueKey('buddy-sandbox-not-now'),
            onPressed: () {
              _notNow = true;
              setState(() => _show = false);
            },
            child: const Text('Not now'),
          ),
          TextButton(
            key: const ValueKey('buddy-sandbox-allow'),
            onPressed: _allow,
            child: Text(_error == null ? 'Allow' : 'Try again'),
          ),
        ],
      ],
    );
  }
}

const kBuddySandboxQuestion =
    'Let your Buddy read your files? It can’t change anything or see your '
    'passwords. Until then it reads only its own folder.';

/// For tests: each starts from a question nobody has answered.
@visibleForTesting
void resetBuddySandboxPromptForTest() =>
    _BuddySandboxPromptState._notNow = false;

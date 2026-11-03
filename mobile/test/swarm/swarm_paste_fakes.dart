import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_paste.dart';

/// The phone's clipboard as a message box's Paste sees it, for one test: a
/// picture ([image], none when null) beside [text]. With [hold] set, a read
/// of the picture waits until [release].
class FakeSwarmClipboard {
  FakeSwarmClipboard({this.image, this.text});

  Uint8List? image;
  String? text;
  bool hold = false;

  /// How many times the picture was read (a read is what asks iOS's "Allow
  /// Paste").
  int reads = 0;
  final _held = <Completer<Uint8List?>>[];

  /// Answers the reads waiting, with what [image] is now.
  void release() {
    for (final read in _held) {
      read.complete(image);
    }
    _held.clear();
  }

  /// Puts this clipboard in place of the phone's until the test ends.
  void install(WidgetTester tester) {
    final hasImage = swarmClipboardHasImage;
    final readImage = readSwarmClipboardImage;
    swarmClipboardHasImage = () async => image != null;
    readSwarmClipboardImage = () {
      reads++;
      if (!hold) return Future.value(image);
      final read = Completer<Uint8List?>();
      _held.add(read);
      return read.future;
    };
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      switch (call.method) {
        case 'Clipboard.hasStrings':
          return {'value': text != null && text!.isNotEmpty};
        case 'Clipboard.getData':
          return text == null ? null : {'text': text};
      }
      return null;
    });
    addTearDown(() {
      swarmClipboardHasImage = hasImage;
      readSwarmClipboardImage = readImage;
      messenger.setMockMethodCallHandler(SystemChannels.platform, null);
    });
  }
}

/// A few bytes that stand for a PNG: nothing here decodes them.
Uint8List pngBytes([int size = 64]) => Uint8List(size)..[0] = 0x89;

/// Long-presses [field] and lets its menu ask the clipboard and open.
Future<void> openFieldMenu(WidgetTester tester, Finder field) async {
  await tester.longPress(field);
  await tester.pumpAndSettle();
}

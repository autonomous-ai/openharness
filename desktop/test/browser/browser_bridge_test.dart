import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/browser/browser_bridge.dart';
import 'package:harness/browser/browser_stream.dart';
import 'package:harness/terminal/terminal_binary.dart';

import '../support/fake_browser_view.dart';

const _id = '0f8fad5b-d9cb-469f-a165-70867728950e';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeBrowserView view;
  late List<(String, Map<String, dynamic>)> frames;
  late List<TerminalBinaryFrame> binary;
  late BrowserStream stream;
  late BrowserBridge bridge;

  setUp(() {
    view = FakeBrowserView();
    frames = [];
    binary = [];
    stream = BrowserStream(
      machineId: 'm',
      agentId: 'a1',
      send: (type, payload) async {
        frames.add((type, Map.of(payload)));
        return true;
      },
      sendBinary: (frame) async {
        binary.add(frame);
        return true;
      },
    );
    bridge = BrowserBridge(view, stream, mac: true);
  });

  /// The page loads, the machine opens the stream, and the bridge is running.
  Future<void> start() async {
    final started = bridge.start();
    view.say({'t': 'ready'});
    await Future<void>.delayed(Duration.zero);
    stream.handleFrame('agent_browser_open_result', {
      'requestId': frames.single.$2['requestId'],
      'streamId': _id,
    });
    await started;
  }

  test('the page is configured and opened once it is ready and the stream '
      'is open', () async {
    final started = bridge.start();
    await Future<void>.delayed(Duration.zero);
    // Nothing is opened before the page can take it.
    expect(frames, isEmpty);
    view.say({'t': 'ready'});
    await Future<void>.delayed(Duration.zero);
    expect(view.posted, [
      {'t': 'config', 'mac': true},
    ]);
    stream.handleFrame('agent_browser_open_result', {
      'requestId': frames.single.$2['requestId'],
      'streamId': _id,
    });
    await started;
    expect(view.posted.last, {'t': 'open'});
  });

  test(
    'page data reaches stream.write and stream bytes reach the page',
    () async {
      await start();
      stream.handleBinary(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.browser,
          streamId: _id,
          seq: 0,
          bytes: Uint8List.fromList([1, 2, 255]),
          compressed: false,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(view.posted.last, {
        't': 'data',
        'b64': base64Encode([1, 2, 255]),
      });
      view.say({
        't': 'data',
        'b64': base64Encode([4, 5]),
      });
      view.say({'t': 'consumed', 'bytes': browserAckStepBytes});
      await Future<void>.delayed(Duration.zero);
      expect(binary.single.bytes, [4, 5]);
      expect(frames.last.$1, 'agent_browser_ack');
      expect(frames.last.$2, {'streamId': _id, 'bytes': browserAckStepBytes});
    },
  );

  test(
    "{t:'state', connected:false} from the page closes the stream",
    () async {
      await start();
      view.say({'t': 'state', 'connected': true});
      view.say({'t': 'state', 'connected': false});
      expect(await stream.closed, 'closed');
      expect(frames.last.$1, 'agent_browser_close');
    },
  );

  test('a close from the machine reaches the page', () async {
    await start();
    stream.handleFrame('agent_browser_close', {
      'streamId': _id,
      'reason': 'rate',
    });
    await Future<void>.delayed(Duration.zero);
    expect(view.posted.last, {'t': 'closed', 'reason': 'rate'});
  });

  test('Paste posts the clipboard\'s text', () async {
    await start();
    bridge.paste('Xin chào 👋');
    expect(view.posted.last, {'t': 'paste', 'text': 'Xin chào 👋'});
  });

  test('window posts the size to the page', () async {
    await start();
    bridge.window(1280, 720);
    expect(view.posted.last, {'t': 'window', 'width': 1280, 'height': 720});
  });

  test('copy from the page reaches the clipboard', () async {
    final copied = <Object?>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') copied.add(call.arguments);
          return null;
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null),
    );
    await start();
    view.say({'t': 'copy', 'text': 'Xin chào'});
    await Future<void>.delayed(Duration.zero);
    expect(copied, [
      {'text': 'Xin chào'},
    ]);
  });

  test('close ends the stream and stops listening to the page', () async {
    await start();
    await bridge.close();
    expect(await stream.closed, 'closed');
    view.say({
      't': 'data',
      'b64': base64Encode([1]),
    });
    await Future<void>.delayed(Duration.zero);
    expect(binary, isEmpty);
  });
}

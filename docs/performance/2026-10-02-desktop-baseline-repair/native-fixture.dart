import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';
import '../test/boot_flow_widget_test.dart' as boot;
import '../test/machines_manager_test.dart' as tools;
import '../test/desktop_dialog_interaction_test.dart' as dialogs;
import '../test/swarm_screen_test.dart' show terminal;
import '../test/swarm_state_test.dart' show createApp;
void main() {
  if (!kUnderTest) throw StateError('Memory-only native fixture requires FLUTTER_TEST=1');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized().framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
  setUpAll(() async {
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1280,800));
    await windowManager.setAlwaysOnTop(true);
  });
  setUp(() async {await windowManager.show();await windowManager.focus();});
  tearDownAll(() => windowManager.setAlwaysOnTop(false));
  group('boot',boot.main);
  group('tools',tools.main);
  group('dialogs',() => dialogs.main(nativeSmoke:true));
  testWidgets('native narrow headers retain title and close at large text', (tester) async {
    final app=createApp();
    final session=terminal('a0',[]);
    session.agentName='Review the release notes';
    app.machineStates['m']!.agents=[const Agent(id:'a0',name:'Review the release notes',engine:'codex',terminalAvailable:true)];
    final capture=GlobalKey();
    for(final width in [240.0,280.0,420.0]) {
      for(final status in [TerminalSessionStatus.controlling,TerminalSessionStatus.opening,TerminalSessionStatus.takenOver,TerminalSessionStatus.closed]) {
        session.status=status;
        await tester.pumpWidget(MaterialApp(home:MediaQuery(data:const MediaQueryData(textScaler:TextScaler.linear(1.7)),child:Align(alignment:Alignment.topLeft,child:RepaintBoundary(key:capture,child:SizedBox(width:width,height:360,child:TerminalPanel(notifier:app,session:session,focused:false,compactHeader:true,onClose:(){},onDelete:(){},onToggleComposer:(){})))))));
        await tester.pump(const Duration(milliseconds:40));
        expect(tester.getSize(find.byKey(const ValueKey('terminal-pane-title'))).width,greaterThan(40));
        expect(find.byTooltip('Close Pane').hitTestable(),findsOneWidget);
        expect(tester.takeException(),isNull);
        final boundary=capture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image=await boundary.toImage();
        final bytes=await image.toByteData(format:ui.ImageByteFormat.png);
        await File('${Platform.environment['BASELINE_NATIVE_OUTPUT']}/header-${width.toInt()}-${status.name}.png').writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      }
    }
    await tester.pumpWidget(const SizedBox());session.dispose();app.dispose();
  },timeout:const Timeout(Duration(seconds:90)));
}

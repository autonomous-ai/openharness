// viewerPaneName: what a harness's viewer pane is called when the daemon did not say.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/models.dart';
import 'package:harness/widgets/pane_grid.dart';

void main() {
  const catalog = [
    DshEntry(
      id: 'autonomous/blender',
      name: 'Blender',
      engine: 'claude',
      viewer: true,
      viewerUse: 'autonomous/model-viewer',
    ),
    DshEntry(
      id: 'autonomous/model-viewer',
      name: ' 3D Viewer ',
      engine: '',
      kind: 'viewer',
    ),
    DshEntry(
      id: 'autonomous/marp',
      name: 'Marp',
      engine: 'claude',
      viewer: true,
    ),
    DshEntry(
      id: 'autonomous/odd',
      name: 'Odd',
      engine: 'claude',
      viewer: true,
      viewerUse: 'autonomous/blank-viewer',
    ),
    DshEntry(id: 'autonomous/blank-viewer', name: '  ', engine: '', kind: 'viewer'),
  ];
  Agent agent({String? dsh, String? dshName, String? viewerName}) => Agent(
    id: 'a1',
    name: 'Blender harness 9-17 15:30',
    dsh: dsh,
    dshName: dshName,
    viewerName: viewerName,
  );

  test('the daemon’s name wins', () {
    expect(
      viewerPaneName(
        agent(dsh: 'autonomous/blender', viewerName: 'Custom Viewer'),
        catalog,
      ),
      'Custom Viewer',
    );
  });

  test('from an older daemon: the shared viewer’s name from the catalog, else the harness’s and Viewer', () {
    expect(
      viewerPaneName(
        agent(dsh: 'autonomous/blender', dshName: 'Blender'),
        catalog,
      ),
      '3D Viewer',
    );
    expect(
      viewerPaneName(agent(dsh: 'autonomous/marp', dshName: 'Marp'), catalog),
      'Marp Viewer',
    );
    expect(
      viewerPaneName(agent(dsh: 'autonomous/marp'), catalog),
      'Marp Viewer',
    );
    expect(
      viewerPaneName(agent(dsh: 'autonomous/odd', dshName: 'Odd'), catalog),
      'Odd Viewer',
    );
    expect(
      viewerPaneName(agent(dsh: 'someone/unknown', dshName: '  '), catalog),
      'Viewer',
    );
    expect(viewerPaneName(agent(dsh: 'someone/unknown'), const []), 'Viewer');
    expect(viewerPaneName(null, catalog), 'Viewer');
  });
}

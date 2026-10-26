/// One state the web UX fixture can open, by its `?scenario=` name.
library;

import '../../../test/support/web_ux_app.dart';

class WebUxScenario {
  const WebUxScenario(this.seed);

  /// The app in the state this scenario reviews. Dialogs and panels are
  /// opened by clicking, in `tool/web_ux/flows/`.
  final WebUxApp Function() seed;
}

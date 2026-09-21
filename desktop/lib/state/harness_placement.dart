/// A requested destination, not an allocated tab or pane. Resolving it waits
/// until an existing harness is chosen or a new harness is successfully made.
enum HarnessPlacement {
  currentTab,
  newTab;

  String get title => this == newTab ? 'New Tab' : 'New Pane';
  String get action => this == newTab ? 'Open in new tab' : 'Add to this tab';
  String get createAction =>
      this == newTab ? 'Create in new tab' : 'Create in this tab';
}

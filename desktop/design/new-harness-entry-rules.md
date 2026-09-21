# New Harness entry rules

All workspace entry points use the command dock. Start submits the values in
the reviewed draft. Merely opening or cancelling it never starts a harness or
allocates a tab.

| Entry | Initial values | Destination after a successful start |
| --- | --- | --- |
| Cmd-T → New Harness | Focused pane's agent, machine, and project | New tab |
| Cmd-P → New Harness | Same defaults as Cmd-T | Current tab |
| Cmd-N or the New Harness command | Focused pane's defaults; retain a task and destination already chosen in search | Current tab unless its source requests a new tab |
| Explicit pane split | Focused pane's defaults | Requested split in that tab |
| Store New Harness, or a product's Open action in the pane or native Models menu | Explicit product and machine; suggested project named for that product | New tab |
| Store Resume Harness | Existing harness and its machine; choose from a menu when several match | Focus its existing tab or reopen a view of the same harness |
| Store Try this prompt | Same as Open, with the example as the editable task | New tab |
| First empty workspace | Installed/preferred agent, local machine, suggested project | New tab |

The Store and orchestration tabs cannot host a terminal pane. Generic creation
from either uses a new tab. Command-bar requests keep the workspace context and
apply any agent or machine explicitly named by the request.

While the harness picker is open, Cmd-T and Cmd-P change only the destination.
They preserve the query, text selection, highlighted result, and project or
machine filter. Repeating either shortcut refocuses the same input. The heading,
Enter action, and available capacity update together. Cancelling still leaves
the workspace unchanged.

## Draft ownership

- Workspace drafts belong to their original machine, focused source harness,
  and project context. A different focused harness does not inherit their edits.
- Cmd-T and Cmd-P can resume the same workspace draft. The shortcut just used
  controls placement; a saved draft cannot redirect it to an old destination.
- Store drafts belong to the explicitly requested product and machine. Opening
  Blender cannot restore Workshop's agent, task, or generated project name.
- Escape preserves edits. Reopening the same source without a new task resumes
  its compatible draft. Store Open still wins if the agent or machine was
  changed inside that saved draft.
- A newly typed search task or Store example starts from that entry's defaults.
  Repeating the same request while its draft is already open keeps its edits.
- A request awaiting confirmation is an exception: restore its exact values and
  receipt. A new task must not silently turn an uncertain start into a duplicate.
  An in-flight or uncertain draft cannot be replaced while it is open.
- Closing the dock does not discard unresolved receipts. Advanced options and
  return-to-dock preserve the same draft ownership and placement.

## Project names

Suggested projects display the existing `<agent>-YYYY-MM-DD-HH-MM` naming
convention. Untouched suggestions follow agent changes; a user's edited name
does not. The suggestion is frozen while reviewed. Project → New Project
prefills and selects the name so it can be replaced.

Each machine retains its own project choice. A folder on one machine is never
silently reused on another. Generated folders use exclusive reservation and
advance to seconds/a suffix only on a confirmed collision. Explicit names are
never silently renamed, and existing files are never overwritten.

## Regression coverage

- `test/new_harness_entry_rules_test.dart`: product changes with an open or
  dismissed dock, Open/Try, edited names, machine changes, explicit agent
  precedence, search isolation, exact launch payloads, pending receipts, source
  pane changes, and Cmd-T/Cmd-P draft recovery and placement. Repeated/switched
  shortcuts retain typed tasks, text selection, existing results, and project
  scope; starting then uses the displayed destination.
- `test/harness_placement_test.dart`, `test/box_flows_test.dart`,
  `test/harness_store_entry_test.dart`: pinned creation, keyboard routing,
  cancellation, pending starts, tab allocation, source context, and capacity
  and existing-pane actions after changing a picker's destination.
- `test/models_menu_test.dart`: the native Models menu uses the product dock
  on its explicitly chosen machine; an uninstalled product opens its Store page.
- `test/generated_project_launch_test.dart` and
  `test/new_harness_project_context_test.dart`: generated versus edited names,
  collisions, delayed replies, and machine-specific project choices.
- `integration_test/native_workspace_e2e_test.dart`: native onboarding,
  Cmd-T/Cmd-P creation, edited defaults, Store product switching for Open/Try,
  the Models menu, and terminal input immediately after starting without a
  mouse click. Creation journeys also switch and repeat shortcuts while a task
  is already typed into the picker.

Native fixtures use fake transport and injected Flutter keys. They do not start
live harnesses or establish physical AppKit/IME behavior.

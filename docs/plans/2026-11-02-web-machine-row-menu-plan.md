# Web: a ⋯ on machine rows, and a browser check of their right-click

**Goal:** a machine's Swarm menu opens on the web without depending on a right-click, and a real browser proves what
the right-click does on a release build.

**What the browser showed:** the deployed v1.3.88 bundle holds #2518's guard, and a release build of that code opens the
Swarm menu on a right-click on a collapsed machine. What fails there: a right-click on an expanded machine's readings,
outside the guarded top line, and a second right-click while the Swarm menu is open. Both bring up the browser's menu.
Reading the code found agent rows and Machines panel rows open menus of their own with no guard.

## Steps (test first)

1. Widget tests: ⋯ shows on pointing, opens the same menu with Desktop's permissions, is reached by Tab; the menu key
   opens it on the row; no ⋯ on a computer. Then `_MachineMore` on the row, in a browser only.
2. Widget tests: the browser menu stays off while the Swarm menu is open, and comes back on closing or when the screen
   goes with the menu up. Then a hold in `_menu`, released in `finally` and in `dispose`.
3. Widget tests: agent rows and Machines panel rows switch the browser menu off, and keep it off with their menu open.
   Then `BrowserMenuOff` and a hold on both.
3a. Widget test: a right-click on an expanded machine's readings opens the menu. Then the guard around that block.
4. Browser check: `desktop/scripts/web-machine-menu-check.mjs` drives a release build of
   `test/web/release/machine_row_app.dart` in a real browser, on v1.3.88's code (red) and on this branch (green).

# Try a native starter

Three small projects let you try the new interactions directly from this source checkout.
Use Node 22 or newer and the native assets from an existing Harness installation. Run these
commands from the repository root, one at a time:

```sh
node store/tools/try-hands-on.mjs mujoco
node store/tools/try-hands-on.mjs strudel
node store/tools/try-hands-on.mjs circuitjs
```

Each command prints a local URL and the project folder. Open the URL in a browser.

| Starter | Your first experiment | What you can keep |
| --- | --- | --- |
| MuJoCo | Open **What if**, choose **Lunar gravity**, then click **Farthest apart** to inspect the two pendulum poses at their largest measured difference. | A self-contained experiment JSON and measured-path CSV, reproducible with the harness's native Python tool. |
| Strudel | Click **Play**, then **Record take**. Mute a voice, add a marker, finish the recording and **Keep take**. Headphones help you hear your changes. | The actual stereo WAV, source, mix changes and markers under `out/takes/`. |
| CircuitJS | Open **Scope Lab**, capture the named nodes, then change the resistor in `circuit.txt` and capture again. Compare the voltage traces and move the two cursors. | Native circuit sources, real solver samples, plot and notes under `.harness/circuit-captures/`. |

The projects contain an original pendulum, synth composition and RC circuit. You can edit their
source while the preview is open or give the printed project path to your agent. The
[field guide](hands-on.md) has eight longer invitations, native recordings and follow-up prompts.

## Keep working in the same project

Choose a durable project folder with `--workspace`. Existing starter files are retained:

```sh
node store/tools/try-hands-on.mjs circuitjs --workspace ~/Projects/my-circuit-lab
```

Press Ctrl-C to stop the preview server. Close its browser tab when you finish, especially if
music is playing. Your source and kept work remain in the printed project folder; rerun the same
command to resume. MuJoCo's download buttons save files through your browser.

Without `--workspace`, the launcher creates a project in the system temporary directory. Copy it
somewhere durable if you want to keep working on it; the system may eventually clear temporary files.

## Native assets

The launcher uses the dependencies pinned by this checkout. It looks first in each source
package and then in `~/.harness/dsh/autonomous`. To use a different existing package cache:

```sh
node store/tools/try-hands-on.mjs mujoco --runtime-root /path/to/harness/packages
```

MuJoCo needs the MuJoCo Viewer package's Node dependencies; Strudel needs its installed REPL;
CircuitJS needs its upstream `war` build. A missing or incompatible dependency produces a setup
message before creating the project. The launcher copies this branch's viewer into a temporary
runtime, links the native assets and removes that runtime when the server stops. It does not
download packages or update your installed harnesses. Each starter uses its native engine;
these previews do not start an agent chat.

Strudel's REPL may request optional sample indexes when it opens. The included composition uses
local synthesizers and was also verified with external requests blocked.

Run `node store/tools/try-hands-on.mjs --help` for the options.

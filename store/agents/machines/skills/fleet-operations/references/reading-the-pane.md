# Reading the pane

The map beside you is drawn from exactly the observation `status` returns, so anything on it can be
talked about without another read. It has three views.

**Fleet.** Every machine, with this computer in the middle. Each machine is a ring of ticks: one
tick per harness, grouped into an arc per project. A long, breathing tick is a harness that is still
open; a short faint one is closed. The number inside the ring is how many are open. A dashed empty
ring means the machine could not be read — not that it is idle. The lines are this computer's links:
solid to a machine it can reach, dotted amber to one still waiting to be linked.

**Projects.** Every project with a harness open, and the machines it is open on, as threads. This is
the view that answers "where is this work happening" and "what is this machine carrying that nothing
else is". It shows the busiest projects first when there are more than fit.

**Activity.** Each mark is one harness, stacked at the time it was created, over 24 hours, 7 days or
30 days. It answers "when did all this start" and "which machine has been picking up work". It does
not claim anything about how long a harness ran — that is not in the data.

The right rail is the inspector: the fleet's totals with nothing selected, one machine's detail when
a machine is picked, one project's when a project is. Its "Ask the agent" block is a phrase the
person can copy into the terminal; treat a pasted one as an ordinary request.

The pane takes exactly one input — a remote password, on the row of a machine waiting to be linked.
Everything else is read-only and changes through you.

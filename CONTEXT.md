# Harness

Harness runs and supervises coding agents across desktop, mobile, CLI and devices. This glossary fixes the words used across those apps.

## Language

### Appearance

**Background**:
The image or fill shown behind the panes of a running harness tab, seen through them. Blank shows nothing.
_Avoid_: Wallpaper, start background, behind harnesses

**Built-in background**:
A background that ships with Harness, including the default Blank.
_Avoid_: Default background, preset

**Custom background**:
The single background the user supplies from their own image; Harness keeps its own copy, so the original file can move or disappear.
_Avoid_: Custom wallpaper, user image, uploaded background

**Dim**:
How much a custom background is darkened so the panes in front of it stay readable.
_Avoid_: Overlay, opacity, brightness

**Fit**:
How a custom background is sized to the tab: fill, fit, center or tile.
_Avoid_: Scale mode, crop

**Pane opacity**:
How solid a harness tab's panes are over a non-Blank **Background**; lower lets more of it through.
_Avoid_: Transparency, terminal opacity, Dim (which darkens the background itself)

### Sign-in

**Harness-issued sign-in**:
A sign-in Harness grants itself when a device that is already signed in approves a new one by QR, rather than one made through the Autonomous account service. Each belongs either to a computer or to a phone.
_Avoid_: Harness session, hna token

**Computer sign-in**:
A sign-in held by a computer: it may run agents, connect as a machine, and be traded for a Grid session.
_Avoid_: Machine session

**Phone sign-in**:
A Harness-issued sign-in held by a phone: it may watch and drive agents, but it cannot sign another device in or be traded for a Grid session.
_Avoid_: Viewer, viewer session (a **Viewer** is a surface for inspecting work)

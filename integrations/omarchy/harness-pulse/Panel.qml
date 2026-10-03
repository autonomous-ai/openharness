import QtQuick
import QtQuick.Controls
import QtQuick.Shapes
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "pi.harness-pulse"
  ipcTarget: "harness-pulse"
  // The shared Panel IPC gives `open`, `close` and `toggle` on harness-pulse for the fleet popup.
  manageIpc: true

  // The bar (Omarchy's or menubar-overload) draws tooltips itself and only for a target whose
  // tooltipHovered is true; a tooltip drawn inside the widget is clipped to the bar's height.
  property bool tooltipHovered: false
  function hoverTip(text) { tooltipHovered = true; if (bar && bar.showTooltip) bar.showTooltip(root, text) }
  function unhoverTip() { tooltipHovered = false; if (bar && bar.hideTooltip) bar.hideTooltip(root) }

  readonly property int refreshIntervalSec: {
    var v = Number(setting("refreshIntervalSec", 1))
    return isFinite(v) ? Math.max(1, Math.min(30, Math.round(v))) : 1
  }
  readonly property int maxAgents: {
    var v = Number(setting("maxAgents", 8))
    return isFinite(v) ? Math.max(1, Math.min(24, Math.round(v))) : 8
  }
  readonly property bool reducedMotion: setting("reducedMotion", false) === true
  readonly property string workingColor: String(setting("workingColor", "Accent"))
  readonly property bool showMachine: setting("showMachine", true) !== false
  readonly property string focusWindowClass: String(setting("focusWindowClass", "com.autonomous.harness"))
  // The face shown inside a ring that waits on you. "Auto": avatarPath when set, else ~/.face, else
  // initials. "Initials": always initials. "None": plain ring. Nothing personal ships in the plugin.
  readonly property string avatarMode: String(setting("avatar", "Auto") || "Auto")
  readonly property string avatarSetting: String(setting("avatarPath", "") || "")
  readonly property string homeDir: Quickshell.env("HOME") || ""
  function expandHome(p) { return p.indexOf("~/") === 0 ? root.homeDir + p.substring(1) : p }
  // The candidate picture is probed once here, so a missing ~/.face costs one warning, not one per ring.
  readonly property string avatarPath: avatarProbe.status === Image.Ready ? avatarCandidate : ""
  Image { id: avatarProbe; visible: false; asynchronous: true; sourceSize.width: 64; sourceSize.height: 64; source: root.avatarCandidate !== "" ? "file://" + root.avatarCandidate : "" }
  readonly property string avatarCandidate: avatarMode !== "Auto" ? ""
    : (avatarSetting !== "" ? expandHome(avatarSetting) : (homeDir !== "" ? homeDir + "/.face" : ""))
  readonly property string avatarInitials: {
    if (avatarMode === "None") return ""
    var s = String(setting("avatarInitials", "") || "").trim()
    if (s === "") s = String(Quickshell.env("USER") || "").substring(0, 1)
    return s.substring(0, 2).toUpperCase()
  }
  // Logo for the popup's idle and connecting states: Omarchy (read from the system at runtime,
  // never bundled), Harness (a drawn hexagon mark), Custom (logoPath) or None.
  readonly property string logoMode: String(setting("logo", "Harness") || "Harness")
  readonly property string logoPath: expandHome(String(setting("logoPath", "") || ""))
  readonly property int ringSize: {
    var v = Number(setting("ringSize", 18))
    return isFinite(v) ? Math.max(12, Math.min(28, Math.round(v))) : 18
  }

  property var agents: []
  property var alerts: []
  property var subs: []
  property string subsPick: ""
  property string lastStop: ""
  property string hostname: ""
  property string lastError: ""
  property bool daemonUp: false
  property var theme: ({})
  property int nowMs: Date.now()
  // agentId -> last state, for the fleet view activity ticker.
  property var lastStates: null

  readonly property string helperPath: {
    var p = Qt.resolvedUrl("pulse-feed").toString()
    return p.indexOf("file://") === 0 ? p.substring(7) : p
  }

  // The bar row never grows: a fixed slot per ring up to maxAgents, plus a status glyph.
  readonly property int slotWidth: ringSize + 6
  // "Summary" (default): one ring for the most urgent agent plus a count. "Rings": one ring per agent.
  readonly property bool summaryBar: String(setting("barMode", "Summary")) !== "Rings"
  readonly property int needsYou: agents.filter(function (a) { return a.state === "waiting" || a.state === "permission" }).length
  readonly property int workingCount: agents.filter(function (a) { return a.state === "working" }).length
  readonly property string countText: needsYou > 0 ? String(needsYou) : String(agents.length)
  readonly property int countWidth: summaryBar && agents.length > 0 ? countText.length * Math.max(7, ringSize * 0.5) + 6 : 0
  // One short line: bar tooltips render inside the bar's window, so a second line is clipped.
  readonly property string fleetSummary: {
    if (!daemonUp) return "Harness daemon not running"
    if (agents.length === 0) return "Harness: no agents"
    var parts = [agents.length + " agent" + (agents.length === 1 ? "" : "s")]
    if (needsYou > 0) parts.push(needsYou + " waiting on you")
    if (workingCount > 0) parts.push(workingCount + " working")
    return "Harness · " + parts.join(" · ")
  }

  implicitWidth: statusGlyph.width + 4 + (collisionBadge.visible ? collisionBadge.width + 4 : 0) + (summaryBar ? slotWidth + countWidth : Math.max(1, Math.min(maxAgents, agents.length)) * slotWidth)
  implicitHeight: ringSize + 4

  // Theme palette (yellow/red/green) for the state colours; shell Color.* for the rest.
  FileView {
    id: themeFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"
    watchChanges: true
    preload: false
    onLoaded: root.theme = Model.parseThemeColors(text())
    onFileChanged: reload()
  }
  Component.onCompleted: themeFile.reload()

  // The clock only ticks while a tooltip or the popup could show it.
  Timer { interval: 1000; running: true; repeat: true; onTriggered: root.nowMs = Date.now() }

  // pulse-feed polls the daemon and prints one JSON line per poll; exit 3 means daemon down.
  Process {
    id: feed
    command: ["python3", root.helperPath, "--interval", String(root.refreshIntervalSec)]
    running: true
    stdout: SplitParser {
      onRead: function (line) {
        var r = Model.parseFeedLine(line)
        if (!r.ok) { root.lastError = r.error; root.daemonUp = false; return }
        root.lastError = ""
        root.daemonUp = true
        root.hostname = r.hostname
        root.agents = Model.sortAgents(r.agents)
        root.alerts = r.alerts || []
        root.subs = r.subs || []
        root.subsPick = r.pick || ""
        var d = Model.diffStates(root.lastStates, root.agents, Date.now())
        root.lastStates = d.map
        if (d.events.length > 0) fleetView.pushEvents(d.events)
      }
    }
    onExited: function (code) {
      root.daemonUp = false
      // A minute without the daemon: the last roster is stale, so drop it rather than show ghosts.
      if (code === 3) { root.agents = []; root.alerts = []; root.lastStates = null }
      if (code === 3) root.lastError = "Harness daemon not running"
      else if (code !== 0) root.lastError = "pulse-feed exited " + code
      restart.start()
    }
  }
  Timer { id: restart; interval: 5000; repeat: false; onTriggered: feed.running = true }

  // Hyprland with a Lua config (0.56+, Omarchy 4) reads `hyprctl dispatch X` as `hl.dispatch(X)` and
  // refuses the classic `focuswindow class:...` form; older Hyprland knows only that form. Try the Lua
  // dispatcher first and fall back, so the same widget focuses the window on either.
  Process {
    id: focus
    command: ["sh", "-c",
      "hyprctl dispatch \"hl.dsp.focus({ window = 'class:^($1)$' })\" 2>/dev/null | grep -qx ok || hyprctl dispatch focuswindow \"class:^($1)$\"",
      "focus", root.focusWindowClass]
    running: false
  }

  Row {
    id: row
    anchors.verticalCenter: parent.verticalCenter
    spacing: 0

    // Status glyph: the daemon itself. Non-colour, one character.
    Text {
      id: statusGlyph
      anchors.verticalCenter: parent.verticalCenter
      text: root.daemonUp ? "⬡" : "⬢"   // hexagon outline vs filled
      color: root.daemonUp ? Color.foreground : Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.35)
      font.pixelSize: root.ringSize * 0.7
      Behavior on color { ColorAnimation { duration: root.reducedMotion ? 0 : 220 } }

      // Hold-to-stop: press and hold the hexagon for two seconds to cancel every agent turn on this
      // machine. A red ring drains around the hexagon while held; release early and nothing happens.
      property real hold: 0
      NumberAnimation on hold {
        id: holdAnim
        running: false
        from: 0; to: 1; duration: 2000
        onFinished: { if (statusGlyph.hold >= 1) { stopAll.running = true; statusGlyph.hold = 0 } }
      }
      // Shape, not Canvas: a Canvas repainted per frame flickers on the bar.
      Shape {
        id: holdArc
        anchors.centerIn: parent
        width: root.ringSize + 4; height: root.ringSize + 4
        visible: statusGlyph.hold > 0
        preferredRendererType: Shape.CurveRenderer
        ShapePath {
          strokeWidth: 2
          capStyle: ShapePath.RoundCap
          fillColor: "transparent"
          strokeColor: (root.theme && root.theme.red) ? root.theme.red : Color.urgent
          PathAngleArc { centerX: holdArc.width / 2; centerY: holdArc.height / 2; radiusX: holdArc.width / 2 - 1.5; radiusY: radiusX; startAngle: -90; sweepAngle: (1 - statusGlyph.hold) * 360 }
        }
      }
      MouseArea {
        anchors.fill: parent
        enabled: root.daemonUp
        hoverEnabled: true
        acceptedButtons: Qt.LeftButton | Qt.RightButton
        property double pressedAt: 0
        // A quick click opens the fleet popup; only a 2 s hold stops agents. Right-click also opens it.
        onPressed: function (mouse) {
          if (mouse.button === Qt.RightButton) return
          pressedAt = Date.now(); statusGlyph.hold = 0; holdAnim.restart()
        }
        onReleased: function (mouse) {
          holdAnim.stop(); statusGlyph.hold = 0
          if (mouse.button === Qt.RightButton || Date.now() - pressedAt < 400) root.toggle()
        }
        onCanceled: { holdAnim.stop(); statusGlyph.hold = 0 }
        onEntered: root.hoverTip(root.lastStop !== "" ? root.lastStop : "Click: fleet · Hold 2 s: stop all")
        onExited: root.unhoverTip()
      }
    }
    Process {
      id: stopAll
      command: ["python3", root.helperPath, "--stop-all"]
      running: false
      stdout: SplitParser {
        onRead: function (line) {
          try { var d = JSON.parse(line); root.lastStop = d.cancelled ? "Stopped " + d.cancelled.length + " agent(s)" : "Stop failed: " + (d.error || "unknown") }
          catch (e) { root.lastStop = "Stop failed" }
        }
      }
    }
    Item { width: 4; height: 1 }

    // Collision badge: two agents on one file, folder or branch in the last hour. Only present when
    // there is something to say, so the bar stays quiet otherwise (it takes a fixed slot only
    // while visible, and the ring row shifts by one glyph, never by a layout reflow).
    Text {
      id: collisionBadge
      anchors.verticalCenter: parent.verticalCenter
      visible: root.alerts.length > 0
      text: "△" + (root.alerts.length > 1 ? String(root.alerts.length) : "")
      color: (root.theme && root.theme.red) ? root.theme.red : Color.urgent
      font.pixelSize: root.ringSize * 0.7
      font.bold: true
      opacity: 1.0
      SequentialAnimation on opacity {
        running: collisionBadge.visible && !root.reducedMotion
        loops: Animation.Infinite
        NumberAnimation { from: 1.0; to: 0.45; duration: 900; easing.type: Easing.InOutSine }
        NumberAnimation { from: 0.45; to: 1.0; duration: 900; easing.type: Easing.InOutSine }
      }
      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        onEntered: root.hoverTip((function () {
            var lines = []
            for (var i = 0; i < root.alerts.length && i < 6; i++) lines.push(root.alerts[i].kind + ": " + root.alerts[i].detail)
            return lines.slice(0, 1).join("").slice(0, 60)
          })())
        onExited: root.unhoverTip()
      }
    }
    Item { width: collisionBadge.visible ? 4 : 0; height: 1 }

    Repeater {
      model: root.summaryBar ? (root.agents.length > 0 ? 1 : 0) : Math.min(root.maxAgents, root.agents.length)
      delegate: Item {
        required property int index
        readonly property var agent: root.agents[index] || ({})
        width: root.slotWidth + (root.summaryBar ? root.countWidth : 0)
        height: root.ringSize + 4

        Text {
          id: countLabel
          visible: root.summaryBar
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          text: root.countText
          color: root.needsYou > 0 ? agentRing.stateColor : Color.foreground
          opacity: root.needsYou > 0 ? 1 : 0.6
          font.pixelSize: Math.max(10, root.ringSize - 6)
          font.bold: root.needsYou > 0
        }

        // A soft dot travels along the row toward a ring that waits on you (leads the eye on wide bars).
        Rectangle {
          id: pulseDot
          width: 4; height: 4; radius: 2
          y: parent.height / 2 - 2
          color: agentRing.stateColor
          opacity: 0
          visible: !root.reducedMotion && (agent.state === "waiting" || agent.state === "permission")
          SequentialAnimation on x {
            running: pulseDot.visible
            loops: Animation.Infinite
            PropertyAction { target: pulseDot; property: "opacity"; value: 0.0 }
            NumberAnimation { from: -root.slotWidth * 2; to: root.slotWidth / 2 - 2; duration: 900; easing.type: Easing.InOutQuad }
            PropertyAction { target: pulseDot; property: "opacity"; value: 0.0 }
            PauseAnimation { duration: 1500 }
          }
          SequentialAnimation on opacity {
            running: pulseDot.visible
            loops: Animation.Infinite
            NumberAnimation { from: 0; to: 0.85; duration: 300 }
            NumberAnimation { from: 0.85; to: 0; duration: 600 }
            PauseAnimation { duration: 1500 }
          }
        }

        AgentRing {
          id: agentRing
          anchors.verticalCenter: parent.verticalCenter
          x: (root.slotWidth - width) / 2
          size: root.ringSize
          agent: parent.agent
          reducedMotion: root.reducedMotion
          theme: root.theme
          avatarPath: root.avatarPath
          avatarInitials: root.avatarInitials
          workingColor: root.workingColor
        }

        MouseArea {
          anchors.fill: parent
          hoverEnabled: true
          acceptedButtons: Qt.LeftButton | Qt.RightButton
          // Left and right: the fleet popup (the Harness app is optional; Orca users never open it).
          onClicked: root.toggle()
          onEntered: root.hoverTip(root.summaryBar ? root.fleetSummary : (agent.name || "agent") + " · " + (agent.label || agent.state) + (agent.since ? " " + Model.ago(agent.since, root.nowMs) : ""))
          onExited: root.unhoverTip()
        }
      }
    }
  }

  MouseArea {
    anchors.fill: parent
    enabled: root.agents.length === 0
    hoverEnabled: true
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    onClicked: root.toggle()
    onEntered: root.hoverTip(root.fleetSummary)
    onExited: root.unhoverTip()
  }

  // ---- Fleet popup: right-click the widget (or `toggle` over IPC). ----
  KeyboardPanel {
    id: popup
    anchorItem: row
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: popup.fittedContentWidth(480)
    contentHeight: popup.fittedContentHeight(fleetView.implicitHeight, 620)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function (direction) { root.switchPanel(direction) }

      FleetView {
        id: fleetView
        anchors.fill: parent
        agents: root.agents
        alerts: root.alerts
        subs: root.subs
        subsPick: root.subsPick
        hostname: root.hostname
        daemonUp: root.daemonUp
        active: root.opened
        reducedMotion: root.reducedMotion
        workingColor: root.workingColor
        theme: root.theme
        logoMode: root.logoMode
        logoPath: root.logoPath
        lastStop: root.lastStop
        nowMs: root.nowMs
        onStopAllRequested: stopAll.running = true
      }
    }
  }
}

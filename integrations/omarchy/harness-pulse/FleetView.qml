pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Shapes
import QtQuick.Effects
import qs.Commons
import "Model.js" as Model

// The popup: a live fleet view. Fixed size; nothing in here scrolls except the bounded activity
// ticker, which scrolls in place. Every animation answers a question:
//   orbit turning         something on that machine is working (stops when nothing is)
//   hub glow and tether   something on that machine needs you
//   spend gauges sweeping how much of each agent's cap is used (redrawn from zero on open)
//   triangle pulsing      two agents touched the same file, folder or branch inside the hour
//   ticker slide-in       what just changed, newest on top
//   hexagon charging      how far through the 2 s hold-to-stop you are
// All motion stops while the popup is closed, and reducedMotion freezes it (values still show).
Item {
  id: fleet

  property var agents: []
  property var alerts: []
  property var subs: []
  property string subsPick: ""
  property string hostname: ""
  property bool daemonUp: false
  property bool active: false
  property bool reducedMotion: false
  property string workingColor: "Accent"
  property var theme: ({})
  property string lastStop: ""
  property string logoMode: "Harness"   // Omarchy, Harness, Custom or None
  property string logoPath: ""
  property int nowMs: Date.now()
  signal stopAllRequested()

  readonly property bool motion: active && !reducedMotion
  readonly property color accent: Color.accent
  readonly property color fg: Color.foreground
  readonly property color urgent: theme.yellow ? theme.yellow : Color.urgent
  readonly property color danger: theme.red ? theme.red : Color.urgent
  readonly property color okay: theme.green ? theme.green : Color.accent
  readonly property color faint: Qt.rgba(fg.r, fg.g, fg.b, 0.14)
  readonly property color muted: Qt.rgba(fg.r, fg.g, fg.b, 0.55)
  readonly property var groups: Model.groupByMachine(agents, hostname).slice(0, 3)
  readonly property var counts: Model.stateCounts(agents)

  function colorFor(state) {
    switch (state) {
      case "working": return accent
      case "waiting": return urgent
      case "permission": return danger
      case "failed": return danger
      case "done": return okay
      case "offline": return Qt.rgba(fg.r, fg.g, fg.b, 0.28)
      default: return muted
    }
  }
  function hexPoints(cx, cy, r) {
    var pts = []
    for (var i = 0; i <= 6; i++) {
      var a = Math.PI / 180 * (60 * i - 90)
      pts.push(Qt.point(cx + r * Math.cos(a), cy + r * Math.sin(a)))
    }
    return pts
  }

  // Spend gauges redraw from zero each time the popup opens, so the quantity is drawn, not stamped.
  property bool revealed: false
  onActiveChanged: {
    revealed = false
    if (active) revealTimer.restart()
  }
  Timer { id: revealTimer; interval: 60; onTriggered: fleet.revealed = true }

  implicitWidth: 480
  implicitHeight: column.implicitHeight

  // Faint scanlines on the orbit field only (idle texture, never over text), 8 percent.
  Column {
    id: column
    width: parent.width
    spacing: 10

    // ---------------- Header: title, daemon, state chips, collision badge ----------------
    Item {
      width: parent.width
      height: 26
      Row {
        anchors.verticalCenter: parent.verticalCenter
        spacing: 8
        Text {
          text: fleet.daemonUp ? "⬡" : "⬢"
          color: fleet.daemonUp ? fleet.accent : fleet.muted
          font.pixelSize: 18
          anchors.verticalCenter: parent.verticalCenter
        }
        Column {
          anchors.verticalCenter: parent.verticalCenter
          Text { text: "HARNESS FLEET"; color: fleet.fg; font.pixelSize: 11; font.bold: true; font.letterSpacing: 2 }
          Text {
            text: fleet.daemonUp ? (fleet.agents.length + " agents on " + fleet.groups.length + " machine" + (fleet.groups.length === 1 ? "" : "s")) : "daemon not running"
            color: fleet.muted; font.pixelSize: 10
          }
        }
      }
      Row {
        anchors.right: badge.left
        anchors.rightMargin: 10
        anchors.verticalCenter: parent.verticalCenter
        spacing: 6
        Repeater {
          model: ["permission", "waiting", "failed", "working", "done"]
          delegate: Rectangle {
            id: chip
            required property string modelData
            readonly property int n: fleet.counts[chip.modelData] || 0
            height: 18
            width: chipText.implicitWidth + 12
            radius: 9
            color: chip.n > 0 ? Qt.rgba(fleet.colorFor(chip.modelData).r, fleet.colorFor(chip.modelData).g, fleet.colorFor(chip.modelData).b, 0.16) : "transparent"
            border.width: 1
            border.color: chip.n > 0 ? fleet.colorFor(chip.modelData) : fleet.faint
            Text {
              id: chipText
              anchors.centerIn: parent
              text: Model.glyphFor(chip.modelData) + " " + chip.n
              color: chip.n > 0 ? fleet.colorFor(chip.modelData) : fleet.muted
              font.pixelSize: 10
              font.bold: chip.n > 0
            }
          }
        }
      }
      // Collision badge: a red triangle that pulses while an alert is live. Its slot is always
      // reserved so the header never shifts; with no alert it is a faint outline.
      Item {
        id: badge
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        width: 26; height: 24
        readonly property bool live: fleet.alerts.length > 0
        Shape {
          id: tri
          anchors.fill: parent
          preferredRendererType: Shape.CurveRenderer
          transformOrigin: Item.Center
          ShapePath {
            strokeWidth: 1.6
            joinStyle: ShapePath.RoundJoin
            strokeColor: badge.live ? fleet.danger : fleet.faint
            fillColor: badge.live ? Qt.rgba(fleet.danger.r, fleet.danger.g, fleet.danger.b, 0.25) : "transparent"
            PathPolyline { path: [Qt.point(13, 2), Qt.point(24.5, 22), Qt.point(1.5, 22), Qt.point(13, 2)] }
          }
        }
        Rectangle {
          id: triGlow
          anchors.centerIn: parent
          width: 30; height: 30; radius: 15
          color: "transparent"
          border.width: 2
          border.color: fleet.danger
          opacity: 0
          visible: badge.live && fleet.motion
        }
        SequentialAnimation {
          running: badge.live && fleet.motion
          loops: Animation.Infinite
          ParallelAnimation {
            ScaleAnimator { target: tri; from: 1.0; to: 1.15; duration: 240; easing.type: Easing.OutQuad }
            ScaleAnimator { target: triGlow; from: 0.6; to: 1.4; duration: 700; easing.type: Easing.OutCubic }
            OpacityAnimator { target: triGlow; from: 0.9; to: 0; duration: 700; easing.type: Easing.OutCubic }
          }
          ScaleAnimator { target: tri; from: 1.15; to: 1.0; duration: 300; easing.type: Easing.InOutQuad }
          PauseAnimation { duration: 600 }
          onRunningChanged: if (!running) tri.scale = 1
        }
        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          y: 9
          text: badge.live ? String(fleet.alerts.length) : "△"
          visible: badge.live
          color: fleet.fg
          font.pixelSize: 10
          font.bold: true
        }
      }
    }

    // ---------------- Orbit field: one hub per machine, agents in orbit ----------------
    Rectangle {
      id: field
      width: parent.width
      height: 176
      radius: 10
      color: Qt.rgba(fleet.fg.r, fleet.fg.g, fleet.fg.b, 0.03)
      border.width: 1
      border.color: fleet.faint
      clip: true

      // Scanlines: 8 percent, static, never over text (the machine label sits below the lines' tile).
      Column {
        anchors.fill: parent
        opacity: 0.08
        spacing: 3
        Repeater {
          model: Math.floor(field.height / 3)
          delegate: Rectangle { width: field.width; height: 1; color: fleet.accent }
        }
      }

      // Idle / connecting: the chosen logo and one line of status. While the daemon is down the logo
      // breathes (still trying); with the daemon up and no agents it holds still (nothing to do).
      Column {
        anchors.centerIn: parent
        spacing: 10
        visible: fleet.groups.length === 0
        Item {
          id: logoBox
          anchors.horizontalCenter: parent.horizontalCenter
          // A wordmark gets a wide box, the hexagon a square one; the column height stays the same.
          width: imageOk ? 200 : 64; height: 64
          visible: fleet.logoMode !== "None"
          readonly property string imagePath: fleet.logoMode === "Omarchy" ? "/usr/share/omarchy/logo.svg"
            : fleet.logoMode === "Custom" ? fleet.logoPath : ""
          readonly property bool imageOk: logoImage.status === Image.Ready
          opacity: 0.85
          SequentialAnimation on opacity {
            running: fleet.motion && !fleet.daemonUp && logoBox.visible
            loops: Animation.Infinite
            NumberAnimation { from: 0.85; to: 0.3; duration: 1200; easing.type: Easing.InOutSine }
            NumberAnimation { from: 0.3; to: 0.85; duration: 1200; easing.type: Easing.InOutSine }
            onRunningChanged: if (!running) logoBox.opacity = 0.85
          }
          Image {
            id: logoImage
            anchors.fill: parent
            source: logoBox.imagePath !== "" ? "file://" + logoBox.imagePath : ""
            sourceSize.width: 400; sourceSize.height: 128
            fillMode: Image.PreserveAspectFit
            asynchronous: true
            visible: false
          }
          MultiEffect {
            anchors.fill: parent
            source: logoImage
            visible: logoBox.imageOk
            // Tint to the theme so the Omarchy mark follows the palette like everything else.
            brightness: fleet.logoMode === "Omarchy" ? 1.0 : 0.0
            colorization: fleet.logoMode === "Omarchy" ? 1.0 : 0.0
            colorizationColor: fleet.accent
          }
          // Harness mark (and the fallback when an image logo cannot be read): a drawn hexagon.
          Shape {
            anchors.fill: parent
            visible: !logoBox.imageOk
            preferredRendererType: Shape.CurveRenderer
            ShapePath {
              strokeWidth: 2.5
              joinStyle: ShapePath.RoundJoin
              strokeColor: fleet.accent
              fillColor: "transparent"
              PathPolyline { path: fleet.hexPoints(logoBox.width / 2, 32, 28) }
            }
            ShapePath {
              strokeWidth: 1.2
              joinStyle: ShapePath.RoundJoin
              strokeColor: Qt.rgba(fleet.accent.r, fleet.accent.g, fleet.accent.b, 0.5)
              fillColor: Qt.rgba(fleet.accent.r, fleet.accent.g, fleet.accent.b, 0.12)
              PathPolyline { path: fleet.hexPoints(logoBox.width / 2, 32, 16) }
            }
          }
        }
        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          text: fleet.daemonUp ? "No agents. Nothing is moving, so nothing animates." : "Connecting to the Harness daemon..."
          color: fleet.muted
          font.pixelSize: 11
        }
      }

      Row {
        anchors.centerIn: parent
        spacing: 4
        Repeater {
          model: fleet.groups
          delegate: Item {
            id: tile
            required property var modelData
            readonly property var group: modelData
            readonly property int n: Math.min(8, group.agents.length)
            width: Math.min(156, (field.width - 16) / Math.max(1, fleet.groups.length))
            height: field.height
            readonly property real cx: width / 2
            readonly property real cy: 78
            readonly property real orbitR: 56

            // Orbit angle. Turns only while something on this machine works (one turn per 24 s).
            property real angle: 0
            NumberAnimation on angle {
              running: fleet.motion && tile.group.working
              loops: Animation.Infinite
              from: 0; to: 360; duration: 24000
            }

            // Orbit track, dashed.
            Shape {
              anchors.fill: parent
              preferredRendererType: Shape.CurveRenderer
              ShapePath {
                strokeWidth: 1
                strokeColor: tile.group.working ? Qt.rgba(fleet.accent.r, fleet.accent.g, fleet.accent.b, 0.35) : fleet.faint
                fillColor: "transparent"
                strokeStyle: ShapePath.DashLine
                dashPattern: [2, 4]
                PathAngleArc { centerX: tile.cx; centerY: tile.cy; radiusX: tile.orbitR; radiusY: tile.orbitR; startAngle: 0; sweepAngle: 360 }
              }
            }

            // Tethers from the hub to every agent that needs a person: they breathe with the hub.
            Repeater {
              model: tile.n
              delegate: Shape {
                id: tether
                required property int index
                readonly property var a: tile.group.agents[index]
                readonly property real rad: Math.PI / 180 * (tile.angle + index * 360 / tile.n - 90)
                anchors.fill: parent
                visible: a && (a.state === "waiting" || a.state === "permission" || a.state === "failed")
                opacity: hubGlow.opacity * 0.9 + 0.25
                preferredRendererType: Shape.CurveRenderer
                ShapePath {
                  strokeWidth: 1.2
                  strokeColor: fleet.colorFor(tether.a ? tether.a.state : "idle")
                  fillColor: "transparent"
                  startX: tile.cx; startY: tile.cy
                  PathLine { x: tile.cx + (tile.orbitR - 10) * Math.cos(tether.rad); y: tile.cy + (tile.orbitR - 10) * Math.sin(tether.rad) }
                }
              }
            }

            // Hub: a hexagon for the machine. Glows (urgency) when anything on it needs you.
            Rectangle {
              id: hubGlow
              x: tile.cx - 30; y: tile.cy - 30
              width: 60; height: 60; radius: 30
              color: Qt.rgba(fleet.urgent.r, fleet.urgent.g, fleet.urgent.b, 0.22)
              visible: tile.group.needsYou
              opacity: 0.5
              SequentialAnimation on opacity {
                running: fleet.motion && tile.group.needsYou
                loops: Animation.Infinite
                NumberAnimation { from: 0.25; to: 0.9; duration: 900; easing.type: Easing.InOutSine }
                NumberAnimation { from: 0.9; to: 0.25; duration: 900; easing.type: Easing.InOutSine }
              }
              layer.enabled: visible
              layer.effect: MultiEffect { blurEnabled: true; blur: 0.8; blurMax: 24 }
            }
            Shape {
              anchors.fill: parent
              preferredRendererType: Shape.CurveRenderer
              ShapePath {
                strokeWidth: 1.8
                joinStyle: ShapePath.RoundJoin
                strokeColor: tile.group.needsYou ? fleet.urgent : fleet.accent
                fillColor: Qt.rgba(Color.background.r, Color.background.g, Color.background.b, 0.9)
                PathPolyline { path: fleet.hexPoints(tile.cx, tile.cy, 24) }
              }
            }
            Text {
              x: tile.cx - width / 2; y: tile.cy - height / 2
              width: 44
              horizontalAlignment: Text.AlignHCenter
              elide: Text.ElideMiddle
              text: tile.group.machine
              color: fleet.fg
              font.pixelSize: tile.group.machine.length > 7 ? 8 : 10
              font.bold: tile.group.machine === fleet.hostname
            }

            // Agent nodes: the same ring as the bar, upright, riding the orbit.
            Repeater {
              model: tile.n
              delegate: AgentRing {
                required property int index
                readonly property real rad: Math.PI / 180 * (tile.angle + index * 360 / tile.n - 90)
                size: 20
                x: tile.cx + tile.orbitR * Math.cos(rad) - width / 2
                y: tile.cy + tile.orbitR * Math.sin(rad) - height / 2
                agent: tile.group.agents[index] || ({})
                reducedMotion: !fleet.motion
                showGlyph: !fleet.motion
                theme: fleet.theme
                workingColor: fleet.workingColor
              }
            }

            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              anchors.bottom: parent.bottom
              anchors.bottomMargin: 4
              text: tile.group.agents.length + " agent" + (tile.group.agents.length === 1 ? "" : "s")
              color: fleet.muted
              font.pixelSize: 10
            }
          }
        }
      }
    }

    // ---------------- Subscriptions: weekly use per plan, banked below (harness subs) ----------------
    Item {
      width: parent.width
      height: 82
      Text {
        id: spendLabel
        text: "THIS WEEK"
        color: fleet.muted
        font.pixelSize: 9; font.bold: true; font.letterSpacing: 2
      }
      Text {
        anchors.left: spendLabel.right; anchors.leftMargin: 8
        visible: gaugeRow.count === 0
        text: "no subscriptions detected"
        color: fleet.muted
        font.pixelSize: 10
      }
      Row {
        y: 14
        spacing: 6
        Repeater {
          id: gaugeRow
          model: fleet.subs.slice(0, 8)
          delegate: Item {
            id: gauge
            required property var modelData
            readonly property real f: Math.max(0, Number(modelData.used) || 0)
            readonly property real banked: Number(modelData.banked) || 0
            // Over pace (negative banked) is the warning, not raw use: 60 percent used on day six is fine.
            readonly property color tone: f >= 1 ? fleet.danger : banked < -0.1 ? fleet.danger : banked < 0 ? fleet.urgent : fleet.accent
            width: 64; height: 68
            property real shown: fleet.revealed ? Math.min(1, f) : 0
            Behavior on shown { NumberAnimation { duration: fleet.motion ? 900 : 0; easing.type: Easing.OutCubic } }
            Shape {
              id: gaugeShape
              width: 40; height: 40
              anchors.horizontalCenter: parent.horizontalCenter
              preferredRendererType: Shape.CurveRenderer
              ShapePath {
                strokeWidth: 4; capStyle: ShapePath.RoundCap; fillColor: "transparent"
                strokeColor: fleet.faint
                PathAngleArc { centerX: 20; centerY: 20; radiusX: 17; radiusY: 17; startAngle: 135; sweepAngle: 270 }
              }
              ShapePath {
                strokeWidth: 4; capStyle: ShapePath.RoundCap; fillColor: "transparent"
                strokeColor: gauge.tone
                PathAngleArc { centerX: 20; centerY: 20; radiusX: 17; radiusY: 17; startAngle: 135; sweepAngle: Math.max(0.1, 270 * gauge.shown) }
              }
            }
            // At or over the cap the gauge pulses once per second (the brake is on).
            Rectangle {
              anchors.centerIn: gaugeShape
              width: 40; height: 40; radius: 20
              color: "transparent"; border.width: 2; border.color: fleet.danger
              visible: gauge.f >= 1
              opacity: 0.2
              SequentialAnimation on opacity {
                running: fleet.motion && gauge.f >= 1
                loops: Animation.Infinite
                NumberAnimation { from: 0.9; to: 0.0; duration: 1000; easing.type: Easing.OutCubic }
              }
            }
            Text {
              anchors.centerIn: gaugeShape
              text: Math.round(gauge.f * 100) + "%"
              color: gauge.tone
              font.pixelSize: 9; font.bold: true
            }
            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              anchors.bottom: parent.bottom
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              elide: Text.ElideRight
              text: (fleet.subsPick === gauge.modelData.id ? "▸ " : "") + gauge.modelData.name
              color: fleet.subsPick === gauge.modelData.id ? fleet.accent : fleet.muted
              font.pixelSize: 9
            }
            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              y: 40
              text: (gauge.banked >= 0 ? "+" : "") + Math.round(gauge.banked * 100) + "% banked"
              color: gauge.banked >= 0 ? fleet.okay : gauge.tone
              font.pixelSize: 8
            }
          }
        }
      }
    }

    // ---------------- Collisions: fixed two lines, always reserved ----------------
    Column {
      width: parent.width
      height: 30
      Repeater {
        model: 2
        delegate: Text {
          required property int index
          readonly property var alert: fleet.alerts[index]
          width: parent.width
          elide: Text.ElideRight
          text: alert ? "△ " + alert.kind + ": " + alert.detail : (index === 0 ? "no collisions in the last hour" : "")
          color: alert ? fleet.danger : fleet.muted
          font.pixelSize: 10
          font.family: "monospace"
        }
      }
    }

    // ---------------- Activity ticker: bounded, scrolls in place ----------------
    Rectangle {
      width: parent.width
      height: 96
      radius: 8
      color: Qt.rgba(fleet.fg.r, fleet.fg.g, fleet.fg.b, 0.03)
      border.width: 1
      border.color: fleet.faint
      ListView {
        id: ticker
        anchors.fill: parent
        anchors.margins: 6
        clip: true
        spacing: 1
        model: tickerModel
        boundsBehavior: Flickable.StopAtBounds
        add: Transition {
          enabled: fleet.motion
          NumberAnimation { property: "x"; from: -24; to: 0; duration: 260; easing.type: Easing.OutCubic }
          NumberAnimation { property: "opacity"; from: 0; to: 1; duration: 260 }
        }
        displaced: Transition {
          enabled: fleet.motion
          NumberAnimation { property: "y"; duration: 200; easing.type: Easing.OutCubic }
        }
        delegate: Row {
          required property string t
          required property string glyph
          required property string st
          required property string who
          required property string what
          required property int index
          spacing: 6
          height: 16
          opacity: index === 0 ? 1.0 : 0.8
          Text { text: parent.t; color: fleet.muted; font.pixelSize: 10; font.family: "monospace" }
          Text { text: parent.glyph; color: fleet.colorFor(parent.st); font.pixelSize: 11; font.bold: true; width: 12 }
          Text { text: parent.who; color: fleet.fg; font.pixelSize: 10; font.bold: true }
          Text { text: parent.what; color: fleet.muted; font.pixelSize: 10; width: 300; elide: Text.ElideRight }
        }
        Text {
          anchors.centerIn: parent
          visible: ticker.count === 0
          text: "activity shows here as agents change state"
          color: fleet.muted
          font.pixelSize: 10
        }
      }
    }

    // ---------------- Hold-to-stop hexagon ----------------
    Item {
      width: parent.width
      height: 56

      Item {
        id: stopHex
        width: 52; height: 52
        property real hold: 0
        readonly property real c: 26
        readonly property real r: 23
        readonly property bool charging: stopMouse.pressed && fleet.daemonUp

        NumberAnimation on hold {
          id: charge
          running: false
          from: 0; to: 1; duration: 2000
          onFinished: if (stopHex.hold >= 1) { fleet.stopAllRequested(); drain.restart() }
        }
        NumberAnimation on hold { id: drain; running: false; to: 0; duration: fleet.reducedMotion ? 0 : 240; easing.type: Easing.OutCubic }

        // Charge core: the inner hexagon grows with the hold.
        Shape {
          anchors.fill: parent
          preferredRendererType: Shape.CurveRenderer
          scale: stopHex.hold
          visible: stopHex.hold > 0.01
          ShapePath {
            strokeWidth: 0
            strokeColor: "transparent"
            fillColor: Qt.rgba(fleet.danger.r, fleet.danger.g, fleet.danger.b, 0.25 + 0.5 * stopHex.hold)
            PathPolyline { path: fleet.hexPoints(stopHex.c, stopHex.c, stopHex.r - 3) }
          }
        }
        // Six edges, dim at rest; each lights as the hold passes its sixth.
        Repeater {
          model: 6
          delegate: Shape {
            id: edge
            required property int index
            readonly property var p: fleet.hexPoints(stopHex.c, stopHex.c, stopHex.r)
            readonly property bool lit: stopHex.hold * 6 > index
            anchors.fill: parent
            preferredRendererType: Shape.CurveRenderer
            ShapePath {
              strokeWidth: edge.lit ? 3 : 1.6
              capStyle: ShapePath.RoundCap
              strokeColor: edge.lit ? fleet.danger : Qt.rgba(fleet.danger.r, fleet.danger.g, fleet.danger.b, fleet.daemonUp ? 0.55 : 0.2)
              fillColor: "transparent"
              startX: edge.p[edge.index].x; startY: edge.p[edge.index].y
              PathLine { x: edge.p[edge.index + 1].x; y: edge.p[edge.index + 1].y }
            }
          }
        }
        // Crackle: a dashed hexagon spinning around the charge while held.
        Shape {
          id: crackle
          anchors.fill: parent
          visible: stopHex.charging && !fleet.reducedMotion
          preferredRendererType: Shape.CurveRenderer
          RotationAnimator on rotation { running: crackle.visible; loops: Animation.Infinite; from: 0; to: 360; duration: 900 }
          ShapePath {
            strokeWidth: 1
            strokeColor: Qt.lighter(fleet.danger, 1.4)
            fillColor: "transparent"
            strokeStyle: ShapePath.DashLine
            dashPattern: [1, 5]
            PathPolyline { path: fleet.hexPoints(stopHex.c, stopHex.c, stopHex.r + 2) }
          }
        }
        Text {
          anchors.centerIn: parent
          text: "■"
          color: stopHex.hold > 0.5 ? fleet.fg : fleet.danger
          font.pixelSize: 14
        }
        MouseArea {
          id: stopMouse
          anchors.fill: parent
          enabled: fleet.daemonUp
          onPressed: { drain.stop(); charge.from = stopHex.hold; charge.duration = Math.max(1, 2000 * (1 - stopHex.hold)); charge.restart() }
          onReleased: { if (charge.running) { charge.stop(); drain.restart() } }
          onCanceled: { charge.stop(); drain.restart() }
        }
      }
      Column {
        anchors.left: stopHex.right
        anchors.leftMargin: 12
        anchors.verticalCenter: parent.verticalCenter
        spacing: 2
        Text {
          text: stopHex.charging ? "STOPPING IN " + (2 * (1 - stopHex.hold)).toFixed(1) + " S, RELEASE TO CANCEL" : "HOLD 2 S TO STOP EVERY AGENT"
          color: stopHex.charging ? fleet.danger : fleet.fg
          font.pixelSize: 10; font.bold: true; font.letterSpacing: 1
        }
        Text {
          text: fleet.lastStop !== "" ? fleet.lastStop : "on " + (fleet.hostname || "this machine") + ", cancels every running turn"
          color: fleet.muted
          font.pixelSize: 10
        }
      }
    }
  }

  ListModel { id: tickerModel }
  // Bounded ticker: newest on top, at most 40 rows kept.
  function pushEvents(list) {
    for (var i = 0; i < list.length; i++) {
      var e = list[i]
      tickerModel.insert(0, { t: Model.clock(e.at), glyph: e.glyph, st: e.state, who: e.name + (e.machine ? "@" + e.machine : ""), what: e.text })
    }
    while (tickerModel.count > 40) tickerModel.remove(tickerModel.count - 1)
  }
}

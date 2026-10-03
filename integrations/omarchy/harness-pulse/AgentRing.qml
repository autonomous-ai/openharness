import QtQuick
import QtQuick.Shapes
import QtQuick.Effects
import qs.Commons

// One agent, one ring. Fixed footprint (rings animate in place, never the row).
//
// Every motion is a state, so a glance reads it without the tooltip:
//   working     comet with a fading trail circles clockwise (the agent is moving)
//   waiting     yellow halo breathes out from the ring (it wants you, not urgently)
//   permission  red strobe burst plus a chromatic glitch, repeating (it is blocked on you)
//   failed      one strobe and glitch burst on entry, then a steady thin red ring with a
//               small glitch tick every 6 s (still broken, not shouting)
//   done        the core fills with a burst and a shockwave ring, then holds still
//   offline     dim dashed ring, no motion
//   idle        the ring shrinks to a dot, no motion
// Animators run on the render thread; nothing repaints per frame on the GUI thread and nothing
// runs in idle, offline or a settled done ring.
Item {
  id: ring

  property var agent: ({})
  property int size: 18
  property bool reducedMotion: false
  property var theme: ({})
  property bool showGlyph: reducedMotion
  // A picture of the person the agent is waiting on, shown inside the ring only while the agent
  // waits or needs permission. If the picture is missing or unreadable, avatarInitials shows
  // instead; both empty means a plain ring.
  property string avatarPath: ""
  property string avatarInitials: ""
  /** Working ring colour: "Accent" (theme accent), "Cyan" or "Green". */
  property string workingColor: "Accent"

  readonly property string state: agent && agent.state ? agent.state : "idle"
  // Spend as a fraction of the per-agent cap, or -1 when no cap is set: drawn as the outer arc.
  readonly property real spendFraction: agent && agent.spend && agent.spend.fraction !== null && agent.spend.fraction !== undefined ? Number(agent.spend.fraction) : -1
  readonly property bool hasSpend: spendFraction >= 0
  readonly property bool waitingOnPerson: state === "waiting" || state === "permission"
  readonly property bool avatarReady: avatarPath !== "" && avatar.status === Image.Ready
  readonly property bool showAvatar: waitingOnPerson && (avatarReady || avatarInitials !== "")
  readonly property bool motion: !reducedMotion
  readonly property color accent: Color.accent
  readonly property color urgent: theme.yellow ? theme.yellow : Color.urgent
  readonly property color danger: theme.red ? theme.red : Color.urgent
  readonly property color okay: theme.green ? theme.green : Color.accent
  readonly property color glitchA: theme.cyan ? theme.cyan : accent
  readonly property color glitchB: theme.magenta ? theme.magenta : danger
  readonly property color dim: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.28)

  readonly property color stateColor: {
    switch (state) {
      case "working": return workingColor === "Cyan" ? "#22d3ee" : workingColor === "Green" ? okay : accent
      case "waiting": return urgent
      case "permission": return danger
      case "failed": return danger
      case "done": return okay
      case "offline": return dim
      default: return Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.55)
    }
  }

  readonly property real lineWidth: state === "failed" ? 1.5 : 2.2
  // The outer edge belongs to the spend arc when a cap is set; the state ring sits one line in.
  readonly property real ringDiameter: size - (hasSpend ? 4.4 : 1.0)

  // Idle shrinks to a dot; waiting and permission breathe. Scale only, never width.
  property real breath: 1.0
  readonly property real coreScale: state === "idle" ? 0.42 : breath
  property real fill: state === "done" ? 1.0 : 0.0
  property real flash: 1.0

  width: size
  height: size

  Behavior on fill { NumberAnimation { duration: ring.motion ? 420 : 0; easing.type: Easing.OutBack } }

  SequentialAnimation on breath {
    running: ring.motion && ring.waitingOnPerson
    loops: Animation.Infinite
    NumberAnimation { from: 1.0; to: 1.08; duration: 600; easing.type: Easing.InOutSine }
    NumberAnimation { from: 1.08; to: 1.0; duration: 600; easing.type: Easing.InOutSine }
    onRunningChanged: if (!running) ring.breath = 1.0
  }

  onStateChanged: {
    if (!motion) return
    if (state === "failed") failBurst.restart()
    else if (state === "done") doneBurst.restart()
  }

  // ---- Waiting / permission halo: a soft disc that breathes outward behind the ring. ----
  Rectangle {
    id: halo
    anchors.centerIn: parent
    width: ring.size; height: ring.size; radius: width / 2
    color: Qt.rgba(ring.stateColor.r, ring.stateColor.g, ring.stateColor.b, 0.35)
    visible: ring.motion && ring.waitingOnPerson
    opacity: 0
    scale: 1
    SequentialAnimation {
      running: halo.visible
      loops: Animation.Infinite
      ParallelAnimation {
        ScaleAnimator { target: halo; from: 0.7; to: 1.3; duration: 1200; easing.type: Easing.OutSine }
        OpacityAnimator { target: halo; from: 0.8; to: 0.0; duration: 1200; easing.type: Easing.OutSine }
      }
      PauseAnimation { duration: ring.state === "permission" ? 200 : 600 }
    }
  }

  // ---- Strobe: a hard red flash disc (permission repeats it, failed fires it once). ----
  Rectangle {
    id: strobe
    anchors.centerIn: parent
    width: ring.size; height: ring.size; radius: width / 2
    color: ring.danger
    opacity: 0
    visible: ring.motion && (ring.state === "permission" || ring.state === "failed")
  }

  // ---- Chromatic glitch ghosts: two offset copies of the ring in cyan and magenta. ----
  Rectangle {
    id: ghostA
    anchors.centerIn: parent
    transform: Translate { id: ghostAShift; x: 0 }
    width: ring.ringDiameter; height: width; radius: width / 2
    color: "transparent"
    border.width: ring.lineWidth
    border.color: ring.glitchA
    opacity: 0
    visible: strobe.visible
  }
  Rectangle {
    id: ghostB
    anchors.centerIn: parent
    transform: Translate { id: ghostBShift; x: 0 }
    width: ring.ringDiameter; height: width; radius: width / 2
    color: "transparent"
    border.width: ring.lineWidth
    border.color: ring.glitchB
    opacity: 0
    visible: strobe.visible
  }

  // One chromatic glitch: ghosts split left and right, the core jitters, all snap back (90 ms).
  SequentialAnimation {
    id: glitch
    PropertyAction { target: ghostA; property: "opacity"; value: 0.85 }
    PropertyAction { target: ghostB; property: "opacity"; value: 0.85 }
    PropertyAction { target: ghostAShift; property: "x"; value: -1.5 }
    PropertyAction { target: ghostBShift; property: "x"; value: 1.5 }
    PropertyAction { target: coreShift; property: "x"; value: 1 }
    PauseAnimation { duration: 50 }
    PropertyAction { target: ghostAShift; property: "x"; value: 1 }
    PropertyAction { target: ghostBShift; property: "x"; value: -1 }
    PropertyAction { target: coreShift; property: "x"; value: -1 }
    PauseAnimation { duration: 40 }
    PropertyAction { target: coreShift; property: "x"; value: 0 }
    PropertyAction { target: ghostA; property: "opacity"; value: 0 }
    PropertyAction { target: ghostB; property: "opacity"; value: 0 }
  }

  // Permission: three strobes and a glitch, every 1.6 s, until someone answers.
  SequentialAnimation {
    running: ring.motion && ring.state === "permission"
    loops: Animation.Infinite
    OpacityAnimator { target: strobe; from: 0; to: 0.9; duration: 50 }
    OpacityAnimator { target: strobe; from: 0.9; to: 0; duration: 90 }
    OpacityAnimator { target: strobe; from: 0; to: 0.9; duration: 50 }
    OpacityAnimator { target: strobe; from: 0.9; to: 0; duration: 90 }
    OpacityAnimator { target: strobe; from: 0; to: 0.9; duration: 50 }
    OpacityAnimator { target: strobe; from: 0.9; to: 0; duration: 90 }
    ScriptAction { script: glitch.restart() }
    PauseAnimation { duration: 1180 }
  }

  // Failed: two flashes and a glitch on entry, then only a glitch tick every 6 s.
  SequentialAnimation {
    id: failBurst
    OpacityAnimator { target: strobe; from: 0; to: 0.9; duration: 50 }
    OpacityAnimator { target: strobe; from: 0.9; to: 0; duration: 90 }
    PauseAnimation { duration: 80 }
    OpacityAnimator { target: strobe; from: 0; to: 0.9; duration: 50 }
    OpacityAnimator { target: strobe; from: 0.9; to: 0; duration: 90 }
    ScriptAction { script: glitch.restart() }
  }
  SequentialAnimation {
    running: ring.motion && ring.state === "failed"
    loops: Animation.Infinite
    PauseAnimation { duration: 6000 }
    ScriptAction { script: glitch.restart() }
  }

  // ---- Done: shockwave ring expands once as the core fills. ----
  Rectangle {
    id: shockwave
    anchors.centerIn: parent
    width: ring.size; height: ring.size; radius: width / 2
    color: "transparent"
    border.width: 1.5
    border.color: ring.okay
    opacity: 0
    visible: ring.motion
  }
  ParallelAnimation {
    id: doneBurst
    ScaleAnimator { target: shockwave; from: 0.5; to: 1.35; duration: 520; easing.type: Easing.OutCubic }
    OpacityAnimator { target: shockwave; from: 1.0; to: 0.0; duration: 520; easing.type: Easing.OutCubic }
  }

  // ---- Spend arc: the outer edge, 0 to 100 percent of the cap. Amber at 80, red at the cap. ----
  Shape {
    id: spendShape
    anchors.fill: parent
    visible: ring.hasSpend
    preferredRendererType: Shape.CurveRenderer
    property real sweep: Math.min(1, Math.max(0, ring.spendFraction)) * 360
    Behavior on sweep { NumberAnimation { duration: ring.motion ? 700 : 0; easing.type: Easing.OutCubic } }
    ShapePath {
      strokeWidth: 1.2
      strokeColor: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.12)
      fillColor: "transparent"
      PathAngleArc { centerX: ring.size / 2; centerY: ring.size / 2; radiusX: ring.size / 2 - 0.7; radiusY: radiusX; startAngle: 0; sweepAngle: 360 }
    }
    ShapePath {
      strokeWidth: 1.2
      capStyle: ShapePath.RoundCap
      fillColor: "transparent"
      strokeColor: ring.spendFraction >= 1 ? ring.danger : ring.spendFraction >= 0.8 ? ring.urgent : Qt.rgba(ring.accent.r, ring.accent.g, ring.accent.b, 0.85)
      PathAngleArc { centerX: ring.size / 2; centerY: ring.size / 2; radiusX: ring.size / 2 - 0.7; radiusY: radiusX; startAngle: -90; sweepAngle: spendShape.sweep }
    }
  }

  // ---- The state ring itself. ----
  Item {
    id: core
    anchors.centerIn: parent
    transform: Translate { id: coreShift; x: 0 }
    width: ring.ringDiameter
    height: ring.ringDiameter
    scale: ring.coreScale
    opacity: ring.flash
    Behavior on scale { enabled: ring.motion && !ring.waitingOnPerson; NumberAnimation { duration: 260; easing.type: Easing.OutCubic } }

    // Base ring. Working dims it so the comet reads; offline dashes it.
    Rectangle {
      anchors.fill: parent
      radius: width / 2
      color: "transparent"
      visible: ring.state !== "offline"
      border.width: ring.lineWidth
      border.color: ring.state === "working"
        ? Qt.rgba(ring.stateColor.r, ring.stateColor.g, ring.stateColor.b, ring.motion ? 0.22 : 1.0)
        : ring.stateColor
      Behavior on border.color { ColorAnimation { duration: ring.motion ? 220 : 0 } }
    }
    Shape {
      anchors.fill: parent
      visible: ring.state === "offline"
      preferredRendererType: Shape.CurveRenderer
      ShapePath {
        strokeWidth: 1.2
        strokeColor: ring.dim
        fillColor: "transparent"
        strokeStyle: ShapePath.DashLine
        dashPattern: [1.5, 2]
        PathAngleArc { centerX: core.width / 2; centerY: core.height / 2; radiusX: core.width / 2 - 0.6; radiusY: radiusX; startAngle: 0; sweepAngle: 360 }
      }
    }

    // Working: a comet head with a fading trail, rotating on the render thread.
    Item {
      id: comet
      anchors.fill: parent
      visible: ring.motion && ring.state === "working"
      RotationAnimator on rotation {
        running: comet.visible
        loops: Animation.Infinite
        from: 0; to: 360; duration: 1800
      }
      Shape {
        anchors.fill: parent
        preferredRendererType: Shape.CurveRenderer
        id: cometShape
        readonly property real cr: comet.width / 2 - ring.lineWidth / 2
        ShapePath {
          strokeWidth: ring.lineWidth; fillColor: "transparent"; capStyle: ShapePath.FlatCap
          strokeColor: Qt.rgba(ring.accent.r, ring.accent.g, ring.accent.b, 0.12)
          PathAngleArc { centerX: comet.width / 2; centerY: comet.height / 2; radiusX: cometShape.cr; radiusY: cometShape.cr; startAngle: -210; sweepAngle: 40 }
        }
        ShapePath {
          strokeWidth: ring.lineWidth; fillColor: "transparent"; capStyle: ShapePath.FlatCap
          strokeColor: Qt.rgba(ring.accent.r, ring.accent.g, ring.accent.b, 0.3)
          PathAngleArc { centerX: comet.width / 2; centerY: comet.height / 2; radiusX: cometShape.cr; radiusY: cometShape.cr; startAngle: -170; sweepAngle: 30 }
        }
        ShapePath {
          strokeWidth: ring.lineWidth; fillColor: "transparent"; capStyle: ShapePath.FlatCap
          strokeColor: Qt.rgba(ring.accent.r, ring.accent.g, ring.accent.b, 0.6)
          PathAngleArc { centerX: comet.width / 2; centerY: comet.height / 2; radiusX: cometShape.cr; radiusY: cometShape.cr; startAngle: -140; sweepAngle: 25 }
        }
        ShapePath {
          strokeWidth: ring.lineWidth; fillColor: "transparent"; capStyle: ShapePath.RoundCap
          strokeColor: ring.accent
          PathAngleArc { centerX: comet.width / 2; centerY: comet.height / 2; radiusX: cometShape.cr; radiusY: cometShape.cr; startAngle: -115; sweepAngle: 25 }
        }
      }
      // Bright head at 12 o'clock with a glow, so the leading edge is unmistakable.
      Rectangle {
        width: ring.lineWidth + 1.6; height: width; radius: width / 2
        x: comet.width / 2 - width / 2
        y: ring.lineWidth / 2 - height / 2
        color: Qt.lighter(ring.accent, 1.5)
        layer.enabled: true
        layer.effect: MultiEffect { shadowEnabled: true; shadowColor: ring.accent; shadowBlur: 0.6; shadowHorizontalOffset: 0; shadowVerticalOffset: 0 }
      }
    }
    // Reduced motion working: a static half arc so the state still reads.
    Shape {
      anchors.fill: parent
      visible: !ring.motion && ring.state === "working"
      preferredRendererType: Shape.CurveRenderer
      ShapePath {
        strokeWidth: ring.lineWidth; fillColor: "transparent"
        strokeColor: ring.accent
        PathAngleArc { centerX: core.width / 2; centerY: core.height / 2; radiusX: core.width / 2 - ring.lineWidth / 2; radiusY: radiusX; startAngle: -90; sweepAngle: 180 }
      }
    }

    // Done: the core fills to a solid dot.
    Rectangle {
      anchors.centerIn: parent
      width: parent.width; height: parent.height; radius: width / 2
      color: ring.okay
      scale: ring.fill
      visible: ring.fill > 0.01
    }
  }

  // The face of the person being waited on, round-masked inside the ring. Fades in and out; the
  // ring itself is unchanged so the footprint never moves.
  Item {
    id: avatarHolder
    anchors.centerIn: parent
    width: ring.size - 6
    height: ring.size - 6
    visible: opacity > 0
    opacity: ring.showAvatar ? 1.0 : 0.0
    scale: ring.breath
    Behavior on opacity { NumberAnimation { duration: ring.reducedMotion ? 0 : 220 } }
    Image {
      id: avatar
      anchors.fill: parent
      source: ring.avatarPath !== "" ? "file://" + ring.avatarPath : ""
      fillMode: Image.PreserveAspectCrop
      asynchronous: true
      cache: true
      visible: false
    }
    Rectangle {
      id: avatarMask
      anchors.fill: parent
      radius: width / 2
      color: "white"
      visible: false
      layer.enabled: true
    }
    MultiEffect {
      anchors.fill: parent
      visible: ring.avatarReady
      source: avatar
      maskEnabled: true
      maskSource: avatarMask
    }
    // Fallback: initials on a disc in the state colour.
    Rectangle {
      anchors.fill: parent
      radius: width / 2
      visible: !ring.avatarReady
      color: Qt.rgba(ring.stateColor.r, ring.stateColor.g, ring.stateColor.b, 0.85)
      Text {
        anchors.centerIn: parent
        text: ring.avatarInitials
        color: Color.background
        font.pixelSize: Math.max(6, parent.height * (ring.avatarInitials.length > 1 ? 0.48 : 0.62))
        font.bold: true
      }
    }
  }

  Text {
    anchors.centerIn: parent
    visible: ring.showGlyph && !ring.showAvatar
    text: ring.agent && ring.agent.glyph ? ring.agent.glyph : ""
    color: ring.state === "done" ? Color.background : ring.stateColor
    font.pixelSize: Math.max(8, ring.size * 0.55)
    font.bold: true
  }
}

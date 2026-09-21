import React from "react";
import {
  AbsoluteFill,
  Audio,
  Composition,
  interpolate,
  registerRoot,
  staticFile,
  useCurrentFrame,
} from "remotion";

const FPS = 24;
const DURATION = 18;
const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};
const Afterglow: React.FC<{ title: string; subtitle: string }> = ({
  title,
  subtitle,
}) => {
  const f = useCurrentFrame();
  const t = f / FPS;
  const phase = Math.min(3, Math.floor(t / 4.5));
  const local = t % 4.5;
  const entrance = interpolate(local, [0, 0.9], [0, 1], clamp);
  const fade = interpolate(local, [3.9, 4.5], [1, 0], clamp);
  const cut = Math.min(entrance, fade);
  const rotation = t * 4;
  const labels = [
    "A STUDY IN LIGHT",
    "FIND THE QUIET",
    "FOLLOW THE LIGHT",
    "MAKE SOMETHING MOVE",
  ];
  return (
    <AbsoluteFill
      style={{
        background: "#11130f",
        color: "#fff7e6",
        fontFamily: "Helvetica, Arial, sans-serif",
        overflow: "hidden",
      }}
    >
      <Audio src={staticFile("afterglow.wav")} volume={0.38} />
      <svg
        viewBox="0 0 1280 720"
        style={{ width: "100%", height: "100%", position: "absolute" }}
      >
        <defs>
          <radialGradient id="sun">
            <stop stopColor="#fff8d5" />
            <stop offset=".48" stopColor="#ffc87a" />
            <stop offset=".82" stopColor="#d47b48" />
            <stop offset="1" stopColor="#723e29" />
          </radialGradient>
          <radialGradient id="sky">
            <stop stopColor={phase === 2 ? "#224e48" : "#84573d"} />
            <stop offset="1" stopColor="#111711" />
          </radialGradient>
          <linearGradient id="land" x2="0" y2="1">
            <stop stopColor="#292f25" />
            <stop offset="1" stopColor="#101810" />
          </linearGradient>
          <filter id="soft">
            <feGaussianBlur stdDeviation="38" />
          </filter>
          <filter id="grain">
            <feTurbulence
              type="fractalNoise"
              baseFrequency=".78"
              numOctaves="2"
              stitchTiles="stitch"
            />
            <feColorMatrix type="saturate" values="0" />
          </filter>
        </defs>
        <rect width="1280" height="720" fill="url(#sky)" />
        <circle
          cx={phase === 1 ? 960 : 845}
          cy={260 + Math.sin(t / 4) * 24}
          r={phase === 2 ? 180 : 142}
          fill="#df995e"
          opacity=".25"
          filter="url(#soft)"
        />
        <g
          transform={`translate(${phase === 1 ? 960 : 845},${270 + Math.sin(t / 4) * 24}) rotate(${rotation})`}
        >
          <circle r={phase === 2 ? 166 : 132} fill="url(#sun)" />
          {phase === 2 &&
            Array.from({ length: 11 }, (_, i) => (
              <ellipse
                key={i}
                rx={205 + i * 12}
                ry={64 + i * 5}
                fill="none"
                stroke="#f1c68b"
                strokeOpacity={0.08 + i * 0.015}
                strokeWidth="1.2"
                transform={`rotate(${-26 + Math.sin(t / 3) * 5})`}
              />
            ))}
        </g>
        <path
          d={`M0 ${470 + Math.sin(t / 5) * 8} Q260 350 480 485 T1000 480 T1420 460 V720 H0Z`}
          fill="#3d4734"
        />
        <path
          d="M-50 600 Q180 424 500 565 T1350 540 V750 H-50Z"
          fill="#252f25"
        />
        <path
          d={`M-80 750 Q300 ${440 + Math.cos(t / 6) * 12} 690 630 T1370 600 V750Z`}
          fill="url(#land)"
        />
        {Array.from({ length: 24 }, (_, i) => (
          <path
            key={i}
            d={`M${-160 + i * 65} 760 Q${170 + i * 44} ${530 + i * 2} ${1360 + i * 35} ${582 + i * 5}`}
            fill="none"
            stroke="#c9c99b"
            strokeOpacity=".085"
            strokeWidth="1"
          />
        ))}
        <rect
          width="1280"
          height="720"
          filter="url(#grain)"
          opacity=".035"
          style={{ mixBlendMode: "screen" }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 58,
          borderTop: "1px solid #f4e4c944",
          borderBottom: "1px solid #f4e4c933",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "22px 0",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 13,
            letterSpacing: 3,
          }}
        >
          <span>OPENMONTAGE / STUDY 001</span>
          <span>18 SECONDS OF POSSIBILITY</span>
        </div>
        <div
          style={{
            opacity: cut,
            transform: `translateY(${(1 - entrance) * 24}px)`,
            marginBottom: phase === 3 ? 65 : 15,
          }}
        >
          <div
            style={{
              fontSize: 13,
              letterSpacing: 5,
              marginBottom: 18,
              color: "#f1ce9b",
            }}
          >
            {labels[phase]}
          </div>
          <div
            style={{
              fontFamily: "Georgia, Times New Roman, serif",
              fontSize: phase === 3 ? 92 : 112,
              letterSpacing: -6,
              lineHeight: 1.08,
              maxWidth: 740,
            }}
          >
            {phase === 0
              ? title
              : phase === 1
                ? "A little\nroom to dream."
                : phase === 2
                  ? "Ideas have\nan orbit."
                  : title}
          </div>
          <div
            style={{
              fontSize: 20,
              marginTop: 22,
              color: "#ede4d0",
              letterSpacing: 0.2,
            }}
          >
            {phase === 3
              ? subtitle
              : phase === 0
                ? "A small film. An open beginning."
                : phase === 1
                  ? "Shape the story. Give it space."
                  : "Let the next frame surprise you."}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 12,
            letterSpacing: 2,
            color: "#d6d1b5",
          }}
        >
          <span>AN EDITABLE MOTION STUDY</span>
          <span>0{phase + 1} / 04</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

registerRoot(() => (
  <Composition
    id="Afterglow"
    component={Afterglow}
    durationInFrames={FPS * DURATION}
    fps={FPS}
    width={1280}
    height={720}
    defaultProps={{
      title: "Afterglow",
      subtitle: "Your next film starts here.",
    }}
  />
));

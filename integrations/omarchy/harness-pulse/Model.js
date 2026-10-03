.pragma library

// Attention states the daemon emits. Anything unknown renders as idle.
var STATES = ["working", "waiting", "permission", "failed", "done", "idle", "offline"];

// Glyphs are the non-colour channel (accessibility, reducedMotion).
var GLYPHS = {
  working: "◐",     // half circle
  waiting: "?",
  permission: "!",
  failed: "✗",      // ballot x
  done: "●",        // filled circle
  idle: "○",        // ring
  offline: "·"      // middle dot
};

function normaliseState(s) {
  return STATES.indexOf(s) >= 0 ? s : "idle";
}

function glyphFor(state) {
  return GLYPHS[normaliseState(state)] || GLYPHS.idle;
}

// Parse one JSON line from pulse-feed. Returns {ok, agents, hostname, error}.
function parseFeedLine(line) {
  try {
    var d = JSON.parse(line);
    if (!d || typeof d !== "object") return { ok: false, agents: [], error: "bad payload" };
    if (d.error) return { ok: false, agents: [], error: String(d.error) };
    var agents = Array.isArray(d.agents) ? d.agents : [];
    var alerts = Array.isArray(d.alerts) ? d.alerts : [];
    return {
      ok: true,
      hostname: d.hostname || "",
      // Weekly subscription use from the daemon (harness subs): used and banked are fractions.
      subs: d.subscriptions && Array.isArray(d.subscriptions.subs) ? d.subscriptions.subs.map(function (x) {
        return { id: String(x.id || ""), name: String(x.name || x.id || ""), used: Number(x.used) || 0,
                 banked: Number(x.bankedSigned) || 0, tone: String(x.tone || ""), resetsInMs: Number(x.resetsInMs) || 0 };
      }) : [],
      pick: d.subscriptions ? String(d.subscriptions.pick || "") : "",
      // Collision alerts from the daemon: two agents on one file, folder or branch inside the hour.
      alerts: alerts.map(function (x) {
        return { kind: String(x.kind || ""), detail: String(x.detail || ""), at: Number(x.at) || 0 };
      }),
      agents: agents.map(function (a) {
        return {
          agentId: String(a.agentId || ""),
          name: String(a.name || a.agentId || "agent"),
          engine: String(a.engine || ""),
          machine: String(a.machine || d.hostname || ""),
          state: normaliseState(a.state),
          since: Number(a.since) || 0,
          detail: String(a.detail || ""),
          label: String(a.label || a.state || ""),
          glyph: a.glyph ? String(a.glyph) : glyphFor(a.state),
          lane: a.lane ? String(a.lane) : "",
          spend: a.spend && typeof a.spend === "object"
            ? { usd: Number(a.spend.usd) || 0, tokens: Number(a.spend.tokens) || 0,
                fraction: (a.spend.fraction === null || a.spend.fraction === undefined) ? null : Number(a.spend.fraction) }
            : null
        };
      })
    };
  } catch (e) {
    return { ok: false, agents: [], error: "parse: " + e };
  }
}

// Rank: what needs a person first. Permission and waiting float left.
var RANK = { permission: 0, waiting: 1, failed: 2, done: 3, working: 4, idle: 5, offline: 6 };

function sortAgents(agents) {
  return agents.slice().sort(function (a, b) {
    var r = RANK[a.state] - RANK[b.state];
    if (r !== 0) return r;
    return a.since - b.since;
  });
}

// Six-digit hex colours from colors.toml, keyed by name (blue, yellow, red...).
function parseThemeColors(text) {
  var out = {};
  var re = /^\s*([A-Za-z0-9_]+)\s*=\s*"?#?([0-9a-fA-F]{6})"?/gm;
  var m;
  while ((m = re.exec(text)) !== null) out[m[1].toLowerCase()] = "#" + m[2];
  return out;
}

function ago(sinceMs, nowMs) {
  if (!sinceMs) return "";
  var s = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  return Math.round(s / 3600) + "h";
}

// Fleet view: agents grouped by machine, this host first, then by name. Each group carries
// whether anything on it needs a person, so the hub can glow.
function groupByMachine(agents, hostname) {
  var groups = {};
  var order = [];
  for (var i = 0; i < agents.length; i++) {
    var m = agents[i].machine || hostname || "local";
    if (!groups[m]) { groups[m] = { machine: m, agents: [], needsYou: false, working: false, spendUsd: 0 }; order.push(m); }
    var g = groups[m];
    g.agents.push(agents[i]);
    if (agents[i].state === "waiting" || agents[i].state === "permission" || agents[i].state === "failed") g.needsYou = true;
    if (agents[i].state === "working") g.working = true;
    if (agents[i].spend && agents[i].spend.usd) g.spendUsd += agents[i].spend.usd;
  }
  order.sort(function (a, b) {
    if (a === hostname) return -1;
    if (b === hostname) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return order.map(function (m) { return groups[m]; });
}

// Count per state, for the header chips.
function stateCounts(agents) {
  var out = { working: 0, waiting: 0, permission: 0, failed: 0, done: 0, idle: 0, offline: 0 };
  for (var i = 0; i < agents.length; i++) out[agents[i].state] = (out[agents[i].state] || 0) + 1;
  return out;
}

// Activity ticker: compare the previous {agentId: state} map with the new agents and return one
// event per change. First sight of an agent is an event too ("joined"). Returns {events, map}.
function diffStates(prevMap, agents, nowMs) {
  var map = {};
  var events = [];
  for (var i = 0; i < agents.length; i++) {
    var a = agents[i];
    var key = a.agentId || (a.machine + "/" + a.name);
    map[key] = a.state;
    var before = prevMap ? prevMap[key] : undefined;
    if (before === a.state) continue;
    events.push({
      at: nowMs,
      name: a.name,
      machine: a.machine,
      state: a.state,
      glyph: glyphFor(a.state),
      text: before === undefined ? "joined, " + (a.label || a.state) : before + " > " + (a.label || a.state)
    });
  }
  if (prevMap) {
    for (var k in prevMap) {
      if (map[k] === undefined) events.push({ at: nowMs, name: k.split("/").pop(), machine: "", state: "offline", glyph: glyphFor("offline"), text: "left the fleet" });
    }
  }
  return { events: events, map: map };
}

function clock(ms) {
  var d = new Date(ms);
  function two(n) { return n < 10 ? "0" + n : "" + n; }
  return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
}

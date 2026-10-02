// Read-only resource accounting for owned app/daemon/tmux roots and descendants.
// Includes kernel-accounted exited children, so short-lived ps/git helpers count.
import Foundation
import Darwin

func fail(_ text: String) -> Never {
  FileHandle.standardError.write(Data((text + "\n").utf8))
  exit(1)
}
let args = CommandLine.arguments
guard args.count == 5, let duration = Int(args[2]), (5...1800).contains(duration) else {
  fail("Usage: process_forest_usage PID[,PID...] SECONDS(5–1800) LABEL NEW_OUTPUT.json")
}
let roots = args[1].split(separator: ",").compactMap { Int32($0) }
guard !roots.isEmpty, roots.count == args[1].split(separator: ",").count,
      roots.allSatisfy({ $0 > 1 }), Set(roots).count == roots.count else {
  fail("Expected distinct, valid owned root PIDs")
}
guard !FileManager.default.fileExists(atPath: args[4]) else { fail("Output already exists") }

var timebase = mach_timebase_info_data_t()
guard mach_timebase_info(&timebase) == KERN_SUCCESS, timebase.denom > 0 else { fail("No Mach timebase") }
let began = ProcessInfo.processInfo.systemUptime
let startedAt = ISO8601DateFormatter().string(from: Date())
var rootBirths: [Int32: UInt64] = [:]

struct ProcessRow: Codable {
  let pid: Int32
  let ppid: UInt32
  let root: Int32
  let birthTicks: UInt64
  let exitTicks: UInt64
  let userTicks: UInt64
  let systemTicks: UInt64
  let childUserTicks: UInt64
  let childSystemTicks: UInt64
  let footprintBytes: UInt64
  let residentBytes: UInt64
  let interruptWakeups: UInt64
  let childInterruptWakeups: UInt64
  let packageIdleWakeups: UInt64
  let childPackageIdleWakeups: UInt64
  let diskReadBytes: UInt64
  let diskWriteBytes: UInt64
}
struct Sample: Codable {
  let elapsedSeconds: Double
  let processes: [ProcessRow]
  var cpuTicks: UInt64 { processes.reduce(0) { $0 + $1.userTicks + $1.systemTicks + $1.childUserTicks + $1.childSystemTicks } }
  var interrupts: UInt64 { processes.reduce(0) { $0 + $1.interruptWakeups + $1.childInterruptWakeups } }
  var packageIdle: UInt64 { processes.reduce(0) { $0 + $1.packageIdleWakeups + $1.childPackageIdleWakeups } }
  var footprint: UInt64 { processes.reduce(0) { $0 + $1.footprintBytes } }
}

struct ProcessIdentity {
  let ppid: Int32
  let startSeconds: Int
  let startMicros: Int32
}

func inventory() -> [Int32: ProcessIdentity] {
  // proc_listallpids omits zombies. Their final CPU still belongs to them
  // until the parent reaps them and the kernel rolls it into ri_child_*.
  // KERN_PROC_ALL includes that interval; omitting it makes totals regress.
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
  var bytes = 0
  guard sysctl(&mib, u_int(mib.count), nil, &bytes, nil, 0) == 0 else { fail("Could not size process inventory") }
  var capacity = max(512, bytes / MemoryLayout<kinfo_proc>.stride + 256)
  for _ in 0..<3 {
    var processes = [kinfo_proc](repeating: kinfo_proc(), count: capacity)
    bytes = capacity * MemoryLayout<kinfo_proc>.stride
    let status = processes.withUnsafeMutableBufferPointer {
      sysctl(&mib, u_int(mib.count), $0.baseAddress, &bytes, nil, 0)
    }
    if status != 0 && errno == ENOMEM { capacity *= 2; continue }
    guard status == 0, bytes % MemoryLayout<kinfo_proc>.stride == 0 else { fail("Could not enumerate processes") }
    var result: [Int32: ProcessIdentity] = [:]
    for info in processes.prefix(bytes / MemoryLayout<kinfo_proc>.stride) where info.kp_proc.p_pid > 1 {
      let start = info.kp_proc.p_un.__p_starttime
      result[info.kp_proc.p_pid] = ProcessIdentity(
        ppid: info.kp_eproc.e_ppid, startSeconds: start.tv_sec, startMicros: start.tv_usec)
    }
    return result
  }
  fail("Process inventory would be truncated")
}

func owned(_ all: [Int32: ProcessIdentity]) -> [Int32: Int32] {
  guard roots.allSatisfy({ all[$0] != nil }) else { fail("Owned root exited or is unreadable") }
  var owners = Dictionary(uniqueKeysWithValues: roots.map { ($0, $0) })
  var changed = true
  while changed {
    changed = false
    for (id, info) in all {
      if let parentRoot = owners[info.ppid] {
        if roots.contains(id) { fail("Root trees overlap; refusing to double-count") }
        if owners[id] == nil { owners[id] = parentRoot; changed = true }
      }
    }
  }
  return owners
}

func sample() -> Sample {
  // Reject a torn snapshot: a child can exit and transfer its counters to its
  // parent between reads. Stable membership/birth stamps bracket each read.
  for _ in 0..<10 {
    let before = inventory()
    let owners = owned(before)
    var rows: [ProcessRow] = []
    var missed = false
    for id in owners.keys.sorted() {
      var u = rusage_info_v4()
      let status = withUnsafeMutablePointer(to: &u) { pointer in
        pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
          proc_pid_rusage(id, RUSAGE_INFO_V4, $0)
        }
      }
      if status != 0 { missed = true; break }
      if roots.contains(id) {
        if u.ri_proc_exit_abstime != 0 { fail("Owned root exited") }
        if let birth = rootBirths[id], birth != u.ri_proc_start_abstime { fail("Owned root PID was reused") }
        rootBirths[id] = u.ri_proc_start_abstime
      }
      rows.append(ProcessRow(
        pid: id, ppid: UInt32(before[id]!.ppid), root: owners[id]!, birthTicks: u.ri_proc_start_abstime,
        exitTicks: u.ri_proc_exit_abstime,
        userTicks: u.ri_user_time, systemTicks: u.ri_system_time,
        childUserTicks: u.ri_child_user_time, childSystemTicks: u.ri_child_system_time,
        footprintBytes: u.ri_proc_exit_abstime == 0 ? u.ri_phys_footprint : 0,
        residentBytes: u.ri_proc_exit_abstime == 0 ? u.ri_resident_size : 0,
        interruptWakeups: u.ri_interrupt_wkups, childInterruptWakeups: u.ri_child_interrupt_wkups,
        packageIdleWakeups: u.ri_pkg_idle_wkups, childPackageIdleWakeups: u.ri_child_pkg_idle_wkups,
        diskReadBytes: u.ri_diskio_bytesread, diskWriteBytes: u.ri_diskio_byteswritten))
    }
    let after = inventory()
    let same = owners == owned(after) && owners.keys.allSatisfy {
      before[$0]?.startSeconds == after[$0]?.startSeconds
        && before[$0]?.startMicros == after[$0]?.startMicros
    }
    if !missed && same {
      return Sample(elapsedSeconds: ProcessInfo.processInfo.systemUptime - began, processes: rows)
    }
    Thread.sleep(forTimeInterval: 0.02)
  }
  fail("Could not capture stable process membership; preserve this failed run")
}

var samples = [sample()]
FileHandle.standardError.write(Data("Sampling owned forest \(roots) for \(duration) seconds\n".utf8))
for tick in 1...duration {
  let remaining = began + Double(tick) - ProcessInfo.processInfo.systemUptime
  if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
  let current = sample()
  let previous = samples.last!
  guard current.cpuTicks >= previous.cpuTicks,
        current.interrupts >= previous.interrupts,
        current.packageIdle >= previous.packageIdle else {
    let rejected: [String: Any] = [
      "schema": 1, "success": false, "roots": roots, "label": args[3], "startedAt": startedAt,
      "error": "Forest counters regressed",
      "cpuClock": ["timebaseNumer": timebase.numer, "timebaseDenom": timebase.denom],
      "samples": try JSONSerialization.jsonObject(with: JSONEncoder().encode(samples + [current])),
    ]
    let output = try JSONSerialization.data(withJSONObject: rejected, options: [.prettyPrinted, .sortedKeys])
    let descriptor = open(args[4], O_WRONLY | O_CREAT | O_EXCL, mode_t(0o600))
    if descriptor >= 0 {
      let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
      try handle.write(contentsOf: output)
      try handle.close()
    }
    fail("Forest counters regressed (process escape or accounting race); measurement rejected")
  }
  samples.append(current)
}
let first = samples.first!, last = samples.last!
let elapsed = last.elapsedSeconds - first.elapsedSeconds
let cpuSeconds = Double(last.cpuTicks - first.cpuTicks) * Double(timebase.numer) / Double(timebase.denom) / 1e9
let footprints = samples.map { Double($0.footprint) / 1_048_576 }.sorted()
let summary: [String: Any] = [
  "elapsedSeconds": elapsed, "cpuSeconds": cpuSeconds,
  "cpuPercentOneCore": cpuSeconds / elapsed * 100,
  "summedPhysicalFootprintMiBMedian": footprints[footprints.count / 2],
  "summedPhysicalFootprintMiBPeak": footprints.last!,
  "processCountMin": samples.map { $0.processes.count }.min()!,
  "processCountMax": samples.map { $0.processes.count }.max()!,
  "liveProcessCountMin": samples.map { $0.processes.filter { $0.exitTicks == 0 }.count }.min()!,
  "liveProcessCountMax": samples.map { $0.processes.filter { $0.exitTicks == 0 }.count }.max()!,
  "interruptWakeupsPerSecond": Double(last.interrupts - first.interrupts) / elapsed,
  "packageIdleWakeupsPerSecond": Double(last.packageIdle - first.packageIdle) / elapsed,
]
let output: [String: Any] = [
  "schema": 1, "success": true, "roots": roots, "label": args[3], "startedAt": startedAt,
  "boundary": "Owned live process trees plus kernel-accounted exited children. CPU 100% = one core. No GPU energy, battery discharge or escaped/reparented workers. Summed process footprints can include shared mappings.",
  "cpuClock": ["unit": "mach_absolute_time", "timebaseNumer": timebase.numer, "timebaseDenom": timebase.denom] as [String: Any],
  "summary": summary,
  "samples": try JSONSerialization.jsonObject(with: JSONEncoder().encode(samples)),
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
let fd = open(args[4], O_WRONLY | O_CREAT | O_EXCL, mode_t(0o600))
guard fd >= 0 else { fail("Could not create fresh output; previous evidence is preserved") }
let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
try handle.write(contentsOf: data)
try handle.close()
print(String(data: try JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]), encoding: .utf8)!)

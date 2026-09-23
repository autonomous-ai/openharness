// Standalone macOS process accounting. Does not launch, focus, or control apps.
// Build: xcrun swiftc process_usage.swift -o /private/tmp/harness-process-usage
// Run:   /private/tmp/harness-process-usage PID SECONDS LABEL OUTPUT.json
import Foundation
import Darwin

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

let args = CommandLine.arguments
guard args.count == 5, let target = Int32(args[1]), target > 1,
      let seconds = Int(args[2]), (5...1800).contains(seconds) else {
  fail("Usage: process_usage PID SECONDS(5–1800) LABEL OUTPUT.json")
}
guard !FileManager.default.fileExists(atPath: args[4]) else {
  fail("Output already exists; preserve previous observations")
}

struct Sample: Codable {
  let elapsedSeconds: Double
  let userNanoseconds: UInt64
  let systemNanoseconds: UInt64
  let physicalFootprintBytes: UInt64
  let residentBytes: UInt64
  let interruptWakeups: UInt64
  let packageIdleWakeups: UInt64
  let diskReadBytes: UInt64
  let diskWriteBytes: UInt64
}

let began = ProcessInfo.processInfo.systemUptime
let startedAt = ISO8601DateFormatter().string(from: Date())
func sample() -> Sample {
  var usage = rusage_info_v4()
  let status = withUnsafeMutablePointer(to: &usage) { pointer in
    pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
      proc_pid_rusage(target, RUSAGE_INFO_V4, $0)
    }
  }
  guard status == 0 else { fail("proc_pid_rusage failed (errno \(errno)); process may have exited") }
  return Sample(
    elapsedSeconds: ProcessInfo.processInfo.systemUptime - began,
    userNanoseconds: usage.ri_user_time,
    systemNanoseconds: usage.ri_system_time,
    physicalFootprintBytes: usage.ri_phys_footprint,
    residentBytes: usage.ri_resident_size,
    interruptWakeups: usage.ri_interrupt_wkups,
    packageIdleWakeups: usage.ri_pkg_idle_wkups,
    diskReadBytes: usage.ri_diskio_bytesread,
    diskWriteBytes: usage.ri_diskio_byteswritten)
}

var samples = [sample()]
for tick in 1...seconds {
  let remaining = began + Double(tick) - ProcessInfo.processInfo.systemUptime
  if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
  samples.append(sample())
}
let first = samples.first!
let last = samples.last!
let elapsed = last.elapsedSeconds - first.elapsedSeconds
let cpuSeconds = Double(last.userNanoseconds - first.userNanoseconds
  + last.systemNanoseconds - first.systemNanoseconds) / 1_000_000_000
let footprints = samples.map { Double($0.physicalFootprintBytes) / 1_048_576 }.sorted()
let summary: [String: Any] = [
  "elapsedSeconds": elapsed,
  "cpuPercentOneCore": cpuSeconds / elapsed * 100,
  "cpuSeconds": cpuSeconds,
  "physicalFootprintMiBMedian": footprints[footprints.count / 2],
  "physicalFootprintMiBPeak": footprints.last!,
  "physicalFootprintMiBStart": Double(first.physicalFootprintBytes) / 1_048_576,
  "physicalFootprintMiBEnd": Double(last.physicalFootprintBytes) / 1_048_576,
  "interruptWakeupsPerSecond": Double(last.interruptWakeups - first.interruptWakeups) / elapsed,
  "packageIdleWakeupsPerSecond": Double(last.packageIdleWakeups - first.packageIdleWakeups) / elapsed,
  "diskReadBytes": last.diskReadBytes - first.diskReadBytes,
  "diskWriteBytes": last.diskWriteBytes - first.diskWriteBytes,
]
let encodedSamples = try JSONEncoder().encode(samples)
let output: [String: Any] = [
  "schema": 1, "success": true, "label": args[3], "pid": target,
  "startedAt": startedAt, "os": ProcessInfo.processInfo.operatingSystemVersionString,
  "boundary": "proc_pid_rusage for this process only; CPU 100% = one core; excludes daemon, agents, and GPU energy",
  "sampleIntervalSeconds": 1, "summary": summary,
  "samples": try JSONSerialization.jsonObject(with: encodedSamples),
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
guard FileManager.default.createFile(atPath: args[4], contents: data,
                                    attributes: [.posixPermissions: 0o600]) else {
  fail("Could not write result")
}
let summaryData = try JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys])
print(String(data: summaryData, encoding: .utf8)!)

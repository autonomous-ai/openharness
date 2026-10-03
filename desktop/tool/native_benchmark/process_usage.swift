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
  let processStartMachTicks: UInt64
  let userMachTicks: UInt64
  let systemMachTicks: UInt64
  let physicalFootprintBytes: UInt64
  let residentBytes: UInt64
  let interruptWakeups: UInt64
  let packageIdleWakeups: UInt64
  let diskReadBytes: UInt64
  let diskWriteBytes: UInt64
}

// proc_pid_rusage exposes task CPU time in Mach absolute ticks. On this
// Apple Silicon host one tick is 125/3 ns; treating ticks as ns understated
// CPU by 41.67x. Retain both the raw counters and their clock conversion.
var timebase = mach_timebase_info_data_t()
guard mach_timebase_info(&timebase) == KERN_SUCCESS, timebase.denom > 0 else {
  fail("Could not read the Mach clock timebase")
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
    processStartMachTicks: usage.ri_proc_start_abstime,
    userMachTicks: usage.ri_user_time,
    systemMachTicks: usage.ri_system_time,
    physicalFootprintBytes: usage.ri_phys_footprint,
    residentBytes: usage.ri_resident_size,
    interruptWakeups: usage.ri_interrupt_wkups,
    packageIdleWakeups: usage.ri_pkg_idle_wkups,
    diskReadBytes: usage.ri_diskio_bytesread,
    diskWriteBytes: usage.ri_diskio_byteswritten)
}

var samples = [sample()]
FileHandle.standardError.write(Data("Sampling process \(target) for \(seconds) seconds\n".utf8))
for tick in 1...seconds {
  let remaining = began + Double(tick) - ProcessInfo.processInfo.systemUptime
  if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
  let current = sample()
  let previous = samples.last!
  guard current.processStartMachTicks == previous.processStartMachTicks,
        current.userMachTicks >= previous.userMachTicks,
        current.systemMachTicks >= previous.systemMachTicks else {
    fail("Process identity or CPU counters changed during sampling")
  }
  samples.append(current)
}
let first = samples.first!
let last = samples.last!
let elapsed = last.elapsedSeconds - first.elapsedSeconds
let cpuTicks = Double(last.userMachTicks - first.userMachTicks)
  + Double(last.systemMachTicks - first.systemMachTicks)
let cpuSeconds = cpuTicks * Double(timebase.numer) / Double(timebase.denom) / 1_000_000_000
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
  "schema": 2, "success": true, "label": args[3], "pid": target,
  "startedAt": startedAt, "os": ProcessInfo.processInfo.operatingSystemVersionString,
  "boundary": "proc_pid_rusage for this process only; CPU 100% = one core; excludes other processes and GPU energy",
  "cpuClock": ["unit": "mach_absolute_time", "timebaseNumer": timebase.numer, "timebaseDenom": timebase.denom] as [String: Any],
  "sampleIntervalSeconds": 1, "summary": summary,
  "samples": try JSONSerialization.jsonObject(with: encodedSamples),
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
// Another sample may have chosen this filename after our startup check.
// Reserve it exclusively, so completing later cannot overwrite its evidence.
let descriptor = open(args[4], O_WRONLY | O_CREAT | O_EXCL, mode_t(0o600))
guard descriptor >= 0 else {
  fail("Could not create fresh output (errno \(errno)); existing evidence is preserved")
}
let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
do {
  try handle.write(contentsOf: data)
  try handle.close()
} catch {
  fail("Could not write result: \(error)")
}
let summaryData = try JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys])
print(String(data: summaryData, encoding: .utf8)!)

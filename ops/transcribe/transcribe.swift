// Conduit's voice notes, read on this Mac. A tiny command-line helper over Apple's Speech framework.
//
//   transcribe status [--locale en-US]        what would happen, without asking for anything: permission, language support
//   transcribe authorize                      asks macOS for Speech Recognition permission (a system dialog: the owner clicks Allow)
//   transcribe run <audio file> [--locale en-US] [--wait SECONDS] [--max SECONDS]
//                                             reads the audio and prints the words
//   any of them: --out FILE also writes the answer to FILE
//
// One JSON object on stdout, always, and exit status 0 for ok and 1 for not ok:
//   { "ok": true,  "text": "...", "recogniser": "on-device", "locale": "en-US", "seconds": 2.1, "ms": 900 }
//   { "ok": false, "code": "...", "message": "a sentence a person can act on" }
// codes: permission_not_determined, permission_denied, permission_restricted, on_device_unsupported, recogniser_unavailable,
//        unreadable_audio, too_long, no_speech, failed, usage.
//
// Privacy: `requiresOnDeviceRecognition` is always true. A language the Mac cannot recognise on the device is an error, never a
// silent fall back to Apple's servers. The helper opens no network connection of its own and writes nothing: the audio is read from
// the path it is given and nowhere else.
//
// Built by the server (swiftc, once, into the data folder) with an embedded Info.plist; without one macOS refuses to show the
// permission dialog to a command-line tool. See ops/transcribe/README in docs/voice.md.

import AVFoundation
import Foundation
import Speech

func say(_ object: [String: Any], ok: Bool) -> Never {
  var data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{\"ok\":false,\"code\":\"failed\",\"message\":\"could not write the answer\"}".utf8)
  data.append(Data("\n".utf8))
  // `--out FILE`: the answer goes to a file as well (the app is started through LaunchServices, which has no stdout to give back).
  if let at = CommandLine.arguments.firstIndex(of: "--out"), at + 1 < CommandLine.arguments.count {
    try? data.write(to: URL(fileURLWithPath: CommandLine.arguments[at + 1]), options: .atomic)
  }
  FileHandle.standardOutput.write(data)
  exit(ok ? 0 : 1)
}

func fail(_ code: String, _ message: String) -> Never {
  say(["ok": false, "code": code, "message": message], ok: false)
}

let args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
  guard let at = args.firstIndex(of: name), at + 1 < args.count else { return nil }
  return args[at + 1]
}

guard let command = args.first else { fail("usage", "usage: transcribe status | authorize | run <audio file> [--locale en-US] [--wait SECONDS]") }
let localeId = option("--locale") ?? Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
let locale = Locale(identifier: localeId)

func permissionFailure(_ status: SFSpeechRecognizerAuthorizationStatus) -> Never? {
  switch status {
  case .authorized: return nil
  case .notDetermined: fail("permission_not_determined", "Speech Recognition has not been allowed yet. On this Mac run `pnpm voice-check` (or ops/transcribe/transcribe authorize) and click Allow in the dialog.")
  case .denied: fail("permission_denied", "Speech Recognition is turned off for Conduit's voice helper. Open System Settings > Privacy & Security > Speech Recognition and switch it on, or run `tccutil reset SpeechRecognition` and allow it again.")
  case .restricted: fail("permission_restricted", "Speech Recognition is restricted on this Mac (a profile or Screen Time rule), so voice notes cannot be read here. Type the message instead.")
  @unknown default: fail("failed", "Speech Recognition gave an answer this helper does not know.")
  }
}

/// Asks, and waits for the owner's click for at most `seconds`. A dialog nobody answers is reported, not waited on forever.
func authorize(waitingUpTo seconds: Double) -> SFSpeechRecognizerAuthorizationStatus {
  var answer: SFSpeechRecognizerAuthorizationStatus?
  SFSpeechRecognizer.requestAuthorization { status in answer = status }
  let until = Date().addingTimeInterval(seconds)
  while answer == nil && Date() < until { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1)) }
  return answer ?? SFSpeechRecognizer.authorizationStatus()
}

func recogniser() -> SFSpeechRecognizer {
  guard let made = SFSpeechRecognizer(locale: locale) else { fail("on_device_unsupported", "This Mac has no speech recogniser for \(localeId). Voice notes cannot be read here; type the message instead.") }
  guard made.isAvailable else { fail("recogniser_unavailable", "The speech recogniser for \(localeId) is not available right now. Try again in a moment, or type the message.") }
  guard made.supportsOnDeviceRecognition else {
    fail("on_device_unsupported", "\(localeId) cannot be recognised on this Mac without sending the audio to Apple, and Conduit never does that. Add the language under System Settings > Keyboard > Dictation, or type the message instead.")
  }
  return made
}

switch command {
case "status":
  let status = SFSpeechRecognizer.authorizationStatus()
  let made = SFSpeechRecognizer(locale: locale)
  let names: [SFSpeechRecognizerAuthorizationStatus: String] = [.authorized: "authorized", .denied: "denied", .restricted: "restricted", .notDetermined: "not_determined"]
  say([
    "ok": true,
    "permission": names[status] ?? "unknown",
    "locale": localeId,
    "recogniser": made == nil ? "none" : "present",
    "onDevice": made?.supportsOnDeviceRecognition ?? false,
    "available": made?.isAvailable ?? false,
  ], ok: true)

case "authorize":
  let status = authorize(waitingUpTo: Double(option("--wait") ?? "") ?? 120)
  if let _ = permissionFailure(status) {}
  _ = recogniser()
  say(["ok": true, "permission": "authorized", "locale": localeId, "onDevice": true], ok: true)

case "run":
  guard args.count >= 2 else { fail("usage", "usage: transcribe run <audio file>") }
  let path = args[1]
  let started = Date()
  var status = SFSpeechRecognizer.authorizationStatus()
  if status == .notDetermined { status = authorize(waitingUpTo: Double(option("--wait") ?? "") ?? 40) }
  if let _ = permissionFailure(status) {}
  let engine = recogniser()
  let url = URL(fileURLWithPath: path)
  var seconds = 0.0
  do {
    let file = try AVAudioFile(forReading: url)
    seconds = Double(file.length) / file.processingFormat.sampleRate
  } catch {
    fail("unreadable_audio", "That recording could not be opened as audio (\(error.localizedDescription)). Send a WAV, M4A, CAF or MP3 file.")
  }
  if seconds < 0.2 { fail("no_speech", "That recording is empty. Nothing was heard.") }
  if let most = Double(option("--max") ?? ""), seconds > most + 2 {
    fail("too_long", "That recording is \(Int(seconds)) seconds; voice notes may be at most \(Int(most)).")
  }

  let request = SFSpeechURLRecognitionRequest(url: url)
  request.requiresOnDeviceRecognition = true
  request.shouldReportPartialResults = false
  request.addsPunctuation = true
  var finished = false
  var best: String?
  var failure: Error?
  let task = engine.recognitionTask(with: request) { result, error in
    if let result = result, result.isFinal { best = result.bestTranscription.formattedString; finished = true }
    else if let error = error { failure = error; finished = true }
  }
  let limit = Date().addingTimeInterval(max(30, seconds * 3 + 20))
  while !finished && Date() < limit { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
  task.cancel()
  if !finished { fail("failed", "Reading the recording took too long and was stopped.") }
  if let text = best {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { fail("no_speech", "No speech was heard in that recording.") }
    say([
      "ok": true, "text": trimmed, "recogniser": "on-device", "locale": localeId,
      "seconds": (seconds * 10).rounded() / 10, "ms": Int(Date().timeIntervalSince(started) * 1000),
    ], ok: true)
  }
  let described = failure?.localizedDescription ?? "unknown"
  if described.lowercased().contains("no speech") { fail("no_speech", "No speech was heard in that recording.") }
  fail("failed", "The recogniser stopped: \(described)")

default:
  fail("usage", "usage: transcribe status | authorize | run <audio file> [--locale en-US] [--wait SECONDS]")
}

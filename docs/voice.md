# Voice notes

A voice note in any message, from a phone, an iPad or the desktop. It is recorded in the page, read **on the Mac that runs Conduit**, and the words come back into the message box to be checked before they are sent. The audio goes nowhere else: no browser speech service, no third party.

## How it works

1. The microphone button sits in the message box. Tap it to start, or hold it while you speak. There is no strip or box: the message box itself becomes the recorder, showing a live waveform and the time against the two-minute cap, with three controls: **Cancel** (x, throws it away; Escape does the same), **Stop** (a tick: the words go into the box to edit) and **Send** (an arrow: stops, reads and sends at once). Letting go of a hold is Stop, or Send when "Send voice notes when read" (in the [+] menu, remembered per device) is on. While it is read the box says "Reading…"; an error is one short line in the same place, which goes by itself or on a tap.
   - **A dead microphone is caught early.** If nothing at all is heard in the first three seconds, it stops and says: "The mic isn't hearing anything. Check it isn't in use by dictation or another app, then try again." Nothing is uploaded. A whole recording that was silent is not uploaded either.
   - **A note is sent once.** There is no "Try again" that resends the same recording (that is how one silent note went up three times); an answer such as "no speech was heard" is shown once and you record again.
   - **The microphone is asked for once.** The stream is kept after a note and let go about two minutes after the last one, or when the page is hidden, so the browser does not ask again for every note. If its track has ended or been muted (a call, dictation, Siri, the app in the background) it is dropped and asked for again; a dead track is never recorded from.
2. The page decodes what the browser recorded and sends a 16 kHz mono WAV (WebM, which Chrome records, is not something a Mac can read; Safari's M4A would pass as it is).
3. `POST /api/sessions/:id/voice` checks the bytes by content (WAV, M4A, CAF, MP3 or AIFF), keeps them in `DATA_DIR/voice/` with owner-only permissions only while they are read, runs the recogniser and deletes them. `VOICE_KEEP=on` keeps them instead.
4. The words land in the message box. Edit them, then Send. The turn carries the note's id (`TurnInput.voice`), and the brain is told it was spoken, read on a device (so a word can be misheard), and, if you corrected the words, what the recogniser first heard. The setting "Send voice notes when read" (in the [+] menu) sends at once instead.
5. The audit trail has two lines per note (`kind voice`): the upload (id, format, size, whether kept) and the reading (id, seconds, language, recogniser). Never the words, never the audio.

## The recogniser

`ops/transcribe/transcribe.swift` is a small Swift program over Apple's Speech framework with `requiresOnDeviceRecognition = true`. The server compiles it with `swiftc` the first time a note is read (about two seconds; again only if the source changes) into `DATA_DIR/cache/voice/<hash>/Conduit Voice.app`. Nothing is downloaded and no npm dependency is added; the Command Line Tools (`xcode-select --install`) supply `swiftc`.

It is built as a small app, not a bare executable, and started through `open`, for a reason: macOS asks for Speech Recognition on behalf of the *app that is responsible*, and a program started by a terminal or by `node` answers to that terminal or to `node`, which have no reason to give; the system then kills it. As its own app it has its own line in System Settings, "Conduit Voice".

**A language the Mac cannot recognise on the device is an error.** Apple's recogniser can fall back to its servers; this helper never lets it (`requiresOnDeviceRecognition` is always on, and `supportsOnDeviceRecognition` is checked first). The app says so plainly and offers typing. Add the language under System Settings > Keyboard > Dictation, or set `VOICE_LOCALE`.

## The one step the owner does: allow Speech Recognition

Once, on the Mac that runs Conduit, at its screen:

```
pnpm voice-check --authorize
```

A dialog appears: **"Conduit Voice" Would Like to Access Speech Recognition.** Click **Allow**. (The dialog's stock sentence says speech data "will be sent to Apple"; that is Apple's wording for the framework in general. The helper forces on-device recognition, and `pnpm voice-check <file>` prints which recogniser ran.)

Until then the microphone says, before it records anything: "Voice notes need Speech Recognition to be allowed once on the Mac running Conduit. Run `pnpm voice-check --authorize` there and click Allow in the dialog." If it was denied: System Settings > Privacy & Security > Speech Recognition > switch "Conduit Voice" on (or `tccutil reset SpeechRecognition com.conduit.voice`, then run the command again).

`pnpm voice-check` alone reports the state and asks for nothing. `pnpm voice-check some.m4a` reads a file and prints the words with `"recogniser":"on-device"`.

## Settings

| Variable | Default | |
|---|---|---|
| `VOICE` | `on` | `off` removes the route and the button |
| `VOICE_LOCALE` | the Mac's own | for example `en-US` |
| `VOICE_KEEP` | `off` | `on` keeps each recording in `DATA_DIR/voice/`, owner-only |
| `VOICE_COMMAND` | none | the owner's own recogniser in place of Apple's (below) |

## If Swift or Speech cannot be used: whisper.cpp

If `swiftc` is missing, the Mac is restricted, or the language is not available on the device, voice reports it and typing still works. The alternative is `whisper.cpp`, which the owner installs (a model file of 150 MB to 1.5 GB; Conduit does not download it). Wrap it in a script and name it in `VOICE_COMMAND`. The script is run as `script status` and `script run <audio file> [--locale L] [--max SECONDS]` and prints one JSON line:

```
status → {"ok":true,"permission":"authorized","locale":"en-US","onDevice":true,"available":true}
run    → {"ok":true,"text":"...","recogniser":"on-device","locale":"en-US","seconds":3.1}
       or {"ok":false,"code":"no_speech","message":"a sentence a person can act on"}
```

The script must run entirely on the machine; Conduit has no way to check that it does.

## Not done here

The helper is untested under the `launchd` service (`ops/install.sh`); the dialog needs the owner at the screen for the first note, and a note sent from a phone before then is told why it cannot be read.

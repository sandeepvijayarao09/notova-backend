# Notova Roadmap

Notova is an **app-only, on-device AI voice-notes** product: capture audio from any
source (phone mic, Bluetooth mic, other input devices, or an imported file),
transcribe and summarize it **fully on-device**, and export the result to the apps
you already use. A small backend handles only what must be server-side — accounts,
OAuth brokering, metadata sync, and billing. **AI never runs on the server.**

This roadmap is shared across the three repos: `notova-ios`, `notova-android`,
`notova-backend`.

---

## Phase 0 — Foundation ✅ (done)

- Three repos scaffolded to industry-standard structure, Apache-2.0 licensed.
- Shared **domain model** (`Recording` / `Transcript` / `Summary` / `IntegrationExport`)
  and an on-device **pipeline** seam: `AudioSource → Transcriber → Summarizer →
  IntegrationExporter`, all behind protocols/interfaces with working stubs.
- Backend `/v1` API: auth (JWT), OAuth broker (PKCE + AES-256-GCM token encryption),
  metadata sync, billing stub.
- Both mobile clients reconciled to the backend contract (identical mapping rules).
- ~648 tests across the three repos; CI on each.

The stubs are the seam: each real engine below is a **drop-in** replacement for a
`StubTranscriber` / `StubSummarizer`, wired through `AppContainer` (iOS) /
Hilt `PipelineModule` (Android). No feature code changes when an engine is swapped.

---

## Phase 1 — On-device transcription (Whisper)

Replace `StubTranscriber` with a real on-device ASR engine. Target output is the
shared `Transcript` (full text + timed segments + language).

| Platform | Primary option | Alternatives |
|----------|----------------|--------------|
| iOS | **WhisperKit** (CoreML Whisper) | Apple `SpeechTranscriber` (iOS 26 on-device); `whisper.cpp` |
| Android | **whisper.cpp via JNI** | LiteRT/TFLite Whisper; platform `SpeechRecognizer` |

- Ship a small model by default (`base`/`small`, ~150–500 MB) and let users opt into
  a larger/turbo model on capable devices.
- Run transcription off the main thread; show progress; persist partial results.
- Tradeoffs to track: model size vs accuracy vs latency vs battery; language coverage.

## Phase 2 — On-device summarization (Gemma 3n E4B)

Replace `StubSummarizer` with an on-device LLM. Target output is the shared `Summary`
(markdown + action items; mind map later).

| Platform | Runtime |
|----------|---------|
| Android | **MediaPipe LLM Inference / LiteRT-LM** (Google AI Edge), GPU/NPU accelerated |
| iOS | **MLX** (Apple) or MediaPipe LLM Inference iOS |

- **Gemma 3n E4B** is the current target (on-device, ~4B effective params, int4
  quantized). Gate by device capability (RAM/accelerator); fall back to E2B or a
  smaller model on constrained devices.
- Structured prompting → markdown summary + extracted action items (JSON-constrained
  output validated against the `Summary` schema).
- Gemma 3n's audio modality could later fold transcription + summarization into one
  pass — kept open by the swappable seam.
- Tradeoffs: first-token latency, memory headroom, thermals/battery, output quality.

## Phase 3 — Integrations (export targets)

OAuth via the backend broker (already built: PKCE, encrypted tokens, `notova://`
deep-link return). Each provider implements the `IntegrationExporter` seam.

- **Notes/docs:** Notion (export shape already scaffolded), Obsidian, Google Docs, Apple Notes (iOS share sheet).
- **Calendar/tasks:** turn action items into Google Calendar events, Todoist/Things/Reminders tasks.
- **Comms/CRM:** post to Slack, send email, log activities to Salesforce/HubSpot.

Build order is driven by demand — first concrete target TBD (Notion and Google
Calendar are the natural first two).

## Phase 4 — Product hardening

- Account + cross-device **metadata** sync (endpoints exist; wire the clients).
- **Billing** (free/Pro): Stripe / RevenueCat / App Store; backend stub exists.
- Mind-map visualization; speaker diarization; background processing
  (WorkManager / `BGProcessingTask`).

---

## Known follow-ups (carried from the build)

- Widen the `:core` `IntegrationExporter` interface to receive the full
  `Recording` + `Transcript` (not just `Summary`) so the richer `ContractMappers`
  path is used directly (Android note).
- Decide a default + opt-in policy for model downloads (size/network/storage UX).
- Add a CONTRIBUTING guide and issue templates per repo.

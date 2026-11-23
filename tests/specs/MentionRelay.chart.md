# Mention relay statechart

## Provider workflow

Muse can skip discovery when it already knows the project and session.
Include the full task in the session command.

```mermaid
flowchart LR
  project[Choose a project] --> session[Choose a session]
  session -->|Start fresh with /new| task[Run the task]
  session -->|Continue with /resume| task
```

## Request lifecycle

The generated chart follows one command in one chat and project with the
harness enabled. A project or session list ends that command. Muse sends
a separate command to start the task. The chart shows which model the
relay uses when a task starts and the reply for an unavailable model. It skips changes that leave the request phase
unchanged, such as saving a default model.

```mermaid
---
title: "blibs mention relay"
---
stateDiagram-v2
  s0: Awaiting command
  s1: Ignored
  s2: Introduction queued
  s3: Choose a project
  s4: Project creation failed
  s5: Selection rejected
  s6: Session command rejected
  s7: Session command with task queued
  s8: Choose a session from the project
  s9: Awaiting project choice
  s10: Project created
  s11: OpenCode is creating a session
  s12: Task dropped
  s13: Selection expired
  s14: Choose an available model
  s15: Harness running
  s16: Session selection rejected
  s17: Run failed
  s18: Run interrupted
  s19: Reply queued
  [*] --> s0
  s0 --> s1: Command is ineligible
  s0 --> s2: Ask about blibs
  s0 --> s3: Ask for projects
  s0 --> s4: Project cannot be created
  s0 --> s5: Submit an invalid selection
  s0 --> s6: Session command is invalid
  s0 --> s7: Choose project and start a new session or Choose project and resume by name
  s0 --> s8: List sessions for a project
  s0 --> s9: Project cannot be resolved
  s7 --> s11: Start OpenCode with a fresh session
  s7 --> s12: Dispatch fails or relay restarts
  s7 --> s14: Requested model is unavailable
  s7 --> s16: Session is unavailable
  s7 --> s15: Announce session and start with the harness default or Announce session and start with the requested model or Announce session and start with the saved model
  s9 --> s13: Clear the choice or restart
  s9 --> s8: Select a valid project
  s0 --> s10: Create a project
  s11 --> s15: Save the OpenCode session ID and announce the name
  s11 --> s17: Run or reply queuing fails
  s11 --> s18: Relay restarts
  s15 --> s17: Run or reply queuing fails
  s15 --> s18: Relay restarts
  s15 --> s19: Run succeeds and queues reply
```

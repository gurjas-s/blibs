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

The generated chart follows one command in one chat and project. A project
or session list ends that command. Muse sends a separate command to start
the task. The chart omits transitions that leave the request phase unchanged.

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
  s10: Harness running
  s11: Project created
  s12: Task dropped
  s13: Selection expired
  s14: Session selection rejected
  s15: Run failed
  s16: Run interrupted
  s17: Reply queued
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
  s7 --> s10: Announce session and start task
  s7 --> s12: Dispatch fails or relay restarts
  s7 --> s14: Session is unavailable
  s9 --> s13: Clear the choice or restart
  s9 --> s8: Select a valid project
  s0 --> s11: Create a project
  s10 --> s15: Run or reply queuing fails
  s10 --> s16: Relay restarts
  s10 --> s17: Run succeeds and queues reply
```

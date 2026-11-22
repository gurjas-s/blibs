# Mention relay statechart

The chart shows one request in one chat and project. It starts with either
an empty session list or two saved sessions. It omits steps that leave the
request phase unchanged, such as toggling the harness or changing the
project list while a task waits.

```mermaid
---
title: "blibs mention relay"
---
stateDiagram-v2
  s0: Awaiting command
  s1: Ignored
  s2: Introduction queued
  s3: Project list queued
  s4: Project creation failed
  s5: Selection rejected
  s6: Session command rejected
  s7: Task requested
  s8: Task queued
  s9: Session list queued
  s10: Awaiting project choice
  s11: Harness running
  s12: Project created
  s13: Task dropped
  s14: Selection expired
  s15: Awaiting session choice
  s16: Session ID rejected
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
  s0 --> s7: Name a project without a task
  s0 --> s8: Request a new session or Request a session by ID or Resolve a project
  s0 --> s9: Ask for sessions
  s0 --> s10: Project cannot be resolved
  s8 --> s11: Announce session and start the harness or Start the harness
  s8 --> s13: Dispatch fails or relay restarts
  s8 --> s16: Session ID is unavailable
  s8 --> s15: Several sessions match
  s10 --> s14: Clear the choice or restart
  s10 --> s8: Select a valid project
  s0 --> s12: Create a project
  s11 --> s17: Run or reply queuing fails
  s11 --> s18: Relay restarts
  s11 --> s19: Run succeeds and queues reply
```

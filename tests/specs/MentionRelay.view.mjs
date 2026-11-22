export const title = "blibs mention relay"
const labels = {
  unseen: "Awaiting command", intro: "Introduction queued", ignored: "Ignored",
  sessionList: "Session list queued", sessionChoice: "Awaiting session choice",
  unavailableSession: "Session selection rejected", invalidSessionCommand: "Session command rejected",
  list: "Project list queued", missingTask: "Task requested",
  invalidSelect: "Selection rejected", createError: "Project creation failed",
  created: "Project created", expired: "Selection expired", pending: "Awaiting project choice",
  queued: "Task queued", running: "Harness running", dropped: "Task dropped",
  interrupted: "Run interrupted", failed: "Run failed", replyQueued: "Reply queued"
}
export const state = v => labels[v.jobs.requestA.phase]
const steps = {
  intro: "Ask about blibs", ignored: "Command is ineligible",
  sessionList: "Ask for sessions", sessionChoice: "Several sessions match",
  unavailableSession: "Session is unavailable", invalidSessionCommand: "Session command is invalid",
  list: "Ask for projects", missingTask: "Name a project without a task",
  invalidSelect: "Submit an invalid selection", createError: "Project cannot be created",
  created: "Create a project", expired: "Clear the choice or restart",
  pending: "Project cannot be resolved", running: "Start the harness",
  dropped: "Dispatch fails or relay restarts", interrupted: "Relay restarts",
  failed: "Run or reply queuing fails", replyQueued: "Run succeeds and queues reply"
}
export const step = (_, from, to) => {
  const before = from.jobs.requestA.phase
  const after = to.jobs.requestA.phase
  if (before === after) return null
  if (after === "queued") {
    if (before === "pending") return "Select a valid project"
    if (to.jobs.requestA.command === "new") return "Request a new session"
    if (to.jobs.requestA.command === "resume") return "Request a session by name"
    return "Resolve a project"
  }
  if (after === "running" && to.jobs.requestA.notice !== "none") return "Announce session and start the harness"
  return steps[after]
}

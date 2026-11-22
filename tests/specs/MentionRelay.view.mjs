export const title = "blibs mention relay"
const labels = {
  unseen: "Awaiting command", intro: "Introduction queued", ignored: "Ignored",
  list: "Project list queued", missingTask: "Task requested",
  invalidSelect: "Selection rejected", createError: "Project creation failed",
  created: "Project created", expired: "Selection expired", pending: "Awaiting project choice",
  queued: "Task queued", running: "Harness running", dropped: "Task dropped",
  interrupted: "Run interrupted", failed: "Run failed", replyQueued: "Reply queued"
}
export const state = v => labels[v.jobs.requestA.phase]
const steps = {
  intro: "Ask about blibs", ignored: "Command is ineligible",
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
  if (after === "queued") return before === "pending" ? "Select a valid project" : "Resolve a project"
  return steps[after]
}

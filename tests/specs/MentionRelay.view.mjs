export const title = "blibs mention relay"
const labels = {
  unseen: "Awaiting command", intro: "Introduction queued", ignored: "Ignored",
  sessionList: "Choose a session from the project",
  unavailableSession: "Session selection rejected", invalidSessionCommand: "Session command rejected",
  list: "Choose a project", modelChoices: "Choose an available model",
  invalidSelect: "Selection rejected", createError: "Project creation failed",
  created: "Project created", expired: "Selection expired", pending: "Awaiting project choice",
  queued: "Session command with task queued", creating: "OpenCode is creating a session", running: "Harness running", dropped: "Task dropped",
  interrupted: "Run interrupted", failed: "Run failed", replyQueued: "Reply queued"
}
export const state = v => labels[v.jobs.requestA.phase]
const steps = {
  intro: "Ask about blibs", ignored: "Command is ineligible",
  sessionList: "List sessions for a project",
  unavailableSession: "Session is unavailable", invalidSessionCommand: "Session command is invalid",
  list: "Ask for projects", modelChoices: "Requested model is unavailable",
  invalidSelect: "Submit an invalid selection", createError: "Project cannot be created",
  created: "Create a project", expired: "Clear the choice or restart",
  pending: "Project cannot be resolved", creating: "Start OpenCode with a fresh session",
  dropped: "Dispatch fails or relay restarts", interrupted: "Relay restarts",
  failed: "Run or reply queuing fails", replyQueued: "Run succeeds and queues reply"
}
export const step = (_, from, to) => {
  const before = from.jobs.requestA.phase
  const after = to.jobs.requestA.phase
  if (before === after) return null
  if (after === "sessionList" && before === "pending") return "Select a valid project"
  if (after === "queued") {
    return to.jobs.requestA.command === "new" ? "Choose project and start a new session" : "Choose project and resume by name"
  }
  if (after === "running" && before === "creating") return "Save the OpenCode session ID and announce the name"
  if (after === "running") {
    const { model, requestedModel } = to.jobs.requestA
    if (requestedModel !== "none") return "Announce session and start with the requested model"
    if (model !== "none") return "Announce session and start with the saved model"
    return "Announce session and start with the harness default"
  }
  return steps[after]
}

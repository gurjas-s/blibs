// Chat text for a harness reply.
//
// A reply that a coding harness produces must say where it came from. The
// relay adds one header line before the reply, so the user can tell a harness
// message apart from a message that the assistant wrote itself.

/** Header that every forwarded harness reply starts with. */
export function harnessHeader(harnessName: string): string {
  return `Sent from user's harness (${harnessName}).`;
}

/** Add the harness header to one reply. An empty reply stays empty. */
export function harnessMessage(reply: string, harnessName: string): string {
  const body = reply.trim();
  if (!body) return '';
  return `${harnessHeader(harnessName)}\n\n${body}`;
}

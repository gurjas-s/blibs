---- MODULE MentionRelay ----
EXTENDS Naturals, FiniteSets

CONSTANTS Chats, Projects, Requests, FirstProject, SeedSessions
None == "none"

VARIABLES known, enabled, projects, jobs, pending, sessions
vars == <<known, enabled, projects, jobs, pending, sessions>>

\* Session IDs come from the request that creates them. Seed IDs model saved sessions.
SessionIds == Requests \cup SeedSessions
Idle == [phase |-> "unseen", chat |-> None, project |-> None, session |-> None,
         choices |-> {}, command |-> "task", target |-> None, notice |-> None]
Init ==
    /\ known = {}
    /\ enabled = TRUE
    /\ projects = {FirstProject}
    /\ jobs = [r \in Requests |-> Idle]
    /\ pending = [c \in Chats |-> None]
    /\ \E seedChat \in Chats, saved \in {{}, SeedSessions} :
         sessions = [c \in Chats |-> [p \in Projects |->
             IF c = seedChat /\ p = FirstProject THEN saved ELSE {}]]

Baseline(c) ==
    /\ c \notin known
    /\ known' = known \cup {c}
    /\ UNCHANGED <<enabled, projects, jobs, pending, sessions>>

Toggle ==
    /\ enabled' = ~enabled
    /\ UNCHANGED <<known, projects, jobs, pending, sessions>>

\* Collapse commands with no harness work to a terminal response or skip.
NoWork(r, c, outcome) ==
    /\ jobs[r] = Idle
    /\ outcome \in {"intro", "ignored"} \/ enabled
    /\ jobs' = [jobs EXCEPT ![r] = [Idle EXCEPT !.phase = outcome, !.chat = c]]
    /\ UNCHANGED <<known, enabled, projects, pending, sessions>>

Create(r, c, p) ==
    /\ c \in known /\ enabled /\ p \notin projects
    /\ jobs[r] = Idle
    /\ projects' = projects \cup {p}
    /\ jobs' = [q \in Requests |->
        IF q = r THEN [Idle EXCEPT !.phase = "created", !.chat = c]
        ELSE IF jobs[q].phase = "pending" THEN [jobs[q] EXCEPT !.choices = @ \cup {p}]
        ELSE jobs[q]]
    /\ UNCHANGED <<known, enabled, pending, sessions>>

Replace(r, c, phase, p, command, target) ==
    [q \in Requests |->
        IF q = r THEN [Idle EXCEPT !.phase = phase, !.chat = c, !.project = p,
                      !.choices = IF phase = "pending" THEN projects ELSE {},
                      !.command = command, !.target = target]
        ELSE IF q = pending[c] THEN [jobs[q] EXCEPT !.phase = "expired"]
        ELSE jobs[q]]

Request(r, c, p) ==
    /\ c \in known /\ enabled /\ jobs[r] = Idle
    /\ p \in projects \cup {None}
    /\ IF p = None
       THEN /\ jobs' = Replace(r, c, "pending", None, "task", None)
            /\ pending' = [pending EXCEPT ![c] = r]
       ELSE /\ jobs' = Replace(r, c, "sessionList", p, "task", None)
            /\ pending' = [pending EXCEPT ![c] = None]
    /\ UNCHANGED <<known, enabled, projects, sessions>>

\* A resume selector carries the symbolic identity of a name or an existing ID.
\* A selector for a name can resolve only in the sending chat and project.
SessionRequest(r, c, p, command, target) ==
    /\ c \in known /\ enabled /\ jobs[r] = Idle /\ p \in projects
    /\ jobs' = Replace(r, c, "queued", p, command, target)
    /\ pending' = [pending EXCEPT ![c] = None]
    /\ UNCHANGED <<known, enabled, projects, sessions>>

\* A valid /select consumes the project choice and lists sessions.
Select(c, r, p) ==
    /\ enabled /\ pending[c] = r /\ p \in (projects \cap jobs[r].choices)
    /\ jobs' = [jobs EXCEPT ![r].phase = "sessionList", ![r].project = p]
    /\ pending' = [pending EXCEPT ![c] = None]
    /\ UNCHANGED <<known, enabled, projects, sessions>>

Expire(chats) ==
    /\ \E c \in chats : pending[c] # None
    /\ jobs' = [r \in Requests |->
        IF \E c \in chats : pending[c] = r
        THEN [jobs[r] EXCEPT !.phase = "expired"]
        ELSE jobs[r]]
    /\ pending' = [c \in Chats |-> IF c \in chats THEN None ELSE pending[c]]
    /\ UNCHANGED <<known, enabled, projects, sessions>>

Restart ==
    /\ jobs' = [r \in Requests |->
        CASE jobs[r].phase = "pending" -> [jobs[r] EXCEPT !.phase = "expired"]
          [] jobs[r].phase = "queued" -> [jobs[r] EXCEPT !.phase = "dropped"]
          [] jobs[r].phase = "running" -> [jobs[r] EXCEPT !.phase = "interrupted"]
          [] OTHER -> jobs[r]]
    /\ pending' = [c \in Chats |-> None]
    /\ UNCHANGED <<known, enabled, projects, sessions>>

Start(r, saved, id) ==
    LET c == jobs[r].chat
        p == jobs[r].project
    IN /\ sessions' = [sessions EXCEPT ![c][p] = saved \cup {id}]
       /\ jobs' = [jobs EXCEPT ![r].phase = "running", ![r].session = id,
                              ![r].notice = id]

NoStart(r, outcome) ==
    /\ jobs' = [jobs EXCEPT ![r].phase = outcome]
    /\ UNCHANGED sessions

Dispatch(r) ==
    LET c == jobs[r].chat
        p == jobs[r].project
        saved == sessions[c][p]
        command == jobs[r].command
        target == jobs[r].target
    IN /\ jobs[r].phase = "queued"
       /\ \A q \in Requests : jobs[q].phase = "running" => jobs[q].project # p
       /\ CASE ~enabled \/ p \notin projects -> NoStart(r, "dropped")
             [] command = "new" -> Start(r, saved, r)
             [] command = "resume" /\ target \in saved -> Start(r, saved, target)
             [] OTHER -> NoStart(r, "unavailableSession")
       /\ UNCHANGED <<known, enabled, projects, pending>>

Finish(r, result) ==
    /\ jobs[r].phase = "running"
    /\ jobs' = [jobs EXCEPT ![r].phase = result]
    /\ UNCHANGED <<known, enabled, projects, pending, sessions>>

Next ==
    \/ Toggle
    \/ Expire(Chats)
    \/ Restart
    \/ \E c \in Chats :
        \/ Baseline(c)
        \/ Expire({c})
        \/ \E r \in Requests :
            \/ \E outcome \in {"intro", "ignored", "list", "invalidSelect", "createError", "sessionList", "invalidSessionCommand"} :
                /\ c \in known \/ outcome \in {"intro", "ignored", "list"}
                /\ NoWork(r, c, outcome)
            \/ \E p \in Projects :
                \/ Create(r, c, p)
                \/ Select(c, r, p)
                \/ SessionRequest(r, c, p, "new", None)
                \/ \E id \in SessionIds \cup {"unknown"} : SessionRequest(r, c, p, "resume", id)
            \/ \E p \in Projects \cup {None} : Request(r, c, p)
    \/ \E r \in Requests :
        \/ Dispatch(r)
        \/ \E result \in {"replyQueued", "failed"} : Finish(r, result)
    \/ \E p \in projects :
        /\ projects' = projects \ {p}
        /\ UNCHANGED <<known, enabled, jobs, pending, sessions>>

Spec == Init /\ [][Next]_vars

PendingOwnedByChat ==
    \A c \in Chats :
        pending[c] # None =>
            /\ jobs[pending[c]].chat = c
            /\ jobs[pending[c]].phase = "pending"

OneRunPerProject ==
    \A p \in Projects :
        Cardinality({r \in Requests : jobs[r].phase = "running" /\ jobs[r].project = p}) <= 1

SessionOwnedByScope ==
    \A r \in Requests :
        jobs[r].session # None => jobs[r].session \in sessions[jobs[r].chat][jobs[r].project]

SessionsIsolated ==
    \A c, d \in Chats, p, q \in Projects :
        sessions[c][p] \cap sessions[d][q] # {} => c = d /\ p = q

ExplicitSessionCommand ==
    \A r \in Requests :
        jobs[r].phase = "queued" \/ jobs[r].session # None =>
            jobs[r].command \in {"new", "resume"}

SessionResolution ==
    [] [\A r \in Requests :
        LET job == jobs[r]
            next == jobs'[r]
        IN job.phase = "queued" /\ next.phase \in {"running", "unavailableSession"} =>
           LET saved == sessions[job.chat][job.project]
           IN IF job.command = "new"
              THEN /\ next.phase = "running" /\ r \notin saved /\ next.session = r /\ next.notice = r
              ELSE IF job.target \in saved
                   THEN /\ next.phase = "running"
                        /\ next.session = job.target /\ next.notice = job.target
                   ELSE /\ next.phase = "unavailableSession" /\ next.session = None /\ next.notice = None]_vars

SessionMappingsFollowRuns ==
    [] [\A c \in Chats, p \in Projects :
        LET started == {r \in Requests :
            /\ jobs[r].phase = "queued" /\ jobs'[r].phase = "running"
            /\ jobs[r].chat = c /\ jobs[r].project = p}
        IN sessions'[c][p] = sessions[c][p] \cup {jobs'[r].session : r \in started}]_vars

StartedAtMostOnce ==
    [] [\A r \in Requests :
        jobs[r].session # None =>
            /\ jobs'[r].session = jobs[r].session
            /\ jobs[r].phase # "running" => jobs'[r].phase # "running"]_vars

ExpiredNeverStarts ==
    [] [\A r \in Requests : jobs[r].phase = "expired" => jobs'[r].phase = "expired"]_vars
====

---- MODULE MentionRelay ----
EXTENDS Naturals, FiniteSets

CONSTANTS Chats, Projects, Requests, FirstProject, SeedSessions, CheckModels
None == "none"
RequestedModels == IF CheckModels THEN {None, "requestedModel", "unavailableModel"} ELSE {None}
DefaultModels == IF CheckModels THEN {None, "savedModel"} ELSE {None}

VARIABLES known, enabled, projects, jobs, pending, sessions, defaultModel
vars == <<known, enabled, projects, jobs, pending, sessions, defaultModel>>

\* Session IDs come from the request that creates them. Seed IDs model saved sessions.
SessionIds == Requests \cup SeedSessions
ActivePhases == {"creating", "running"}
Idle == [phase |-> "unseen", chat |-> None, project |-> None, session |-> None,
         choices |-> {}, command |-> "task", target |-> None, notice |-> None, requestedModel |-> None, model |-> None]
Init ==
    /\ known = {}
    /\ enabled = TRUE
    /\ projects = {FirstProject}
    /\ defaultModel = None
    /\ jobs = [r \in Requests |-> Idle]
    /\ pending = [c \in Chats |-> None]
    /\ \E seedChat \in Chats, saved \in {{}, SeedSessions} :
         sessions = [c \in Chats |-> [p \in Projects |->
             IF c = seedChat /\ p = FirstProject THEN saved ELSE {}]]

Baseline(c) ==
    /\ c \notin known
    /\ known' = known \cup {c}
    /\ UNCHANGED <<enabled, projects, jobs, pending, sessions, defaultModel>>

SaveModel ==
    /\ defaultModel' \in DefaultModels \ {defaultModel}
    /\ UNCHANGED <<known, enabled, projects, jobs, pending, sessions>>

Toggle ==
    /\ enabled' = ~enabled
    /\ UNCHANGED <<known, projects, jobs, pending, sessions, defaultModel>>

\* Collapse commands with no harness work to a terminal response or skip.
NoWork(r, c, outcome) ==
    /\ jobs[r] = Idle
    /\ outcome \in {"intro", "ignored"} \/ enabled
    /\ jobs' = [jobs EXCEPT ![r] = [Idle EXCEPT !.phase = outcome, !.chat = c]]
    /\ UNCHANGED <<known, enabled, projects, pending, sessions, defaultModel>>

Create(r, c, p) ==
    /\ c \in known /\ enabled /\ p \notin projects
    /\ jobs[r] = Idle
    /\ projects' = projects \cup {p}
    /\ jobs' = [q \in Requests |->
        IF q = r THEN [Idle EXCEPT !.phase = "created", !.chat = c]
        ELSE IF jobs[q].phase = "pending" THEN [jobs[q] EXCEPT !.choices = @ \cup {p}]
        ELSE jobs[q]]
    /\ UNCHANGED <<known, enabled, pending, sessions, defaultModel>>

Replace(r, c, phase, p, command, target, model) ==
    [q \in Requests |->
        IF q = r THEN [Idle EXCEPT !.phase = phase, !.chat = c, !.project = p,
                      !.choices = IF phase = "pending" THEN projects ELSE {},
                      !.command = command, !.target = target, !.requestedModel = model]
        ELSE IF q = pending[c] THEN [jobs[q] EXCEPT !.phase = "expired"]
        ELSE jobs[q]]

Request(r, c, p) ==
    /\ c \in known /\ enabled /\ jobs[r] = Idle
    /\ p \in projects \cup {None}
    /\ IF p = None
       THEN /\ jobs' = Replace(r, c, "pending", None, "task", None, None)
            /\ pending' = [pending EXCEPT ![c] = r]
       ELSE /\ jobs' = Replace(r, c, "sessionList", p, "task", None, None)
            /\ pending' = [pending EXCEPT ![c] = None]
    /\ UNCHANGED <<known, enabled, projects, sessions, defaultModel>>

\* A resume selector carries the symbolic identity of a name or an existing ID.
\* A selector for a name can resolve only in the sending chat and project.
SessionRequest(r, c, p, command, target, model) ==
    /\ c \in known /\ enabled /\ jobs[r] = Idle /\ p \in projects
    /\ jobs' = Replace(r, c, "queued", p, command, target, model)
    /\ pending' = [pending EXCEPT ![c] = None]
    /\ UNCHANGED <<known, enabled, projects, sessions, defaultModel>>

\* A valid /select consumes the project choice and lists sessions.
Select(c, r, p) ==
    /\ enabled /\ pending[c] = r /\ p \in (projects \cap jobs[r].choices)
    /\ jobs' = [jobs EXCEPT ![r].phase = "sessionList", ![r].project = p]
    /\ pending' = [pending EXCEPT ![c] = None]
    /\ UNCHANGED <<known, enabled, projects, sessions, defaultModel>>

Expire(chats) ==
    /\ \E c \in chats : pending[c] # None
    /\ jobs' = [r \in Requests |->
        IF \E c \in chats : pending[c] = r
        THEN [jobs[r] EXCEPT !.phase = "expired"]
        ELSE jobs[r]]
    /\ pending' = [c \in Chats |-> IF c \in chats THEN None ELSE pending[c]]
    /\ UNCHANGED <<known, enabled, projects, sessions, defaultModel>>

Restart ==
    /\ jobs' = [r \in Requests |->
        CASE jobs[r].phase = "pending" -> [jobs[r] EXCEPT !.phase = "expired"]
          [] jobs[r].phase = "queued" -> [jobs[r] EXCEPT !.phase = "dropped"]
          [] jobs[r].phase \in ActivePhases -> [jobs[r] EXCEPT !.phase = "interrupted"]
          [] OTHER -> jobs[r]]
    /\ pending' = [c \in Chats |-> None]
    /\ UNCHANGED <<known, enabled, projects, sessions, defaultModel>>

PickModel(r) ==
    IF jobs[r].requestedModel = None THEN defaultModel ELSE jobs[r].requestedModel

AcceptSession(r, id) ==
    [jobs EXCEPT ![r].phase = "running", ![r].session = id, ![r].notice = id]

StartNew(r) ==
    /\ jobs' = [jobs EXCEPT ![r].phase = "creating", ![r].model = PickModel(r)]
    /\ UNCHANGED sessions

StartSaved(r, id) ==
    /\ jobs' = [AcceptSession(r, id) EXCEPT ![r].model = PickModel(r)]
    /\ UNCHANGED sessions

SessionCreated(r) ==
    LET c == jobs[r].chat
        p == jobs[r].project
    IN /\ jobs[r].phase = "creating"
       /\ jobs' = AcceptSession(r, r)
       /\ sessions' = [sessions EXCEPT ![c][p] = @ \cup {r}]
       /\ UNCHANGED <<known, enabled, projects, pending, defaultModel>>

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
       /\ \A q \in Requests : jobs[q].phase \in ActivePhases => jobs[q].project # p
       /\ CASE ~enabled \/ p \notin projects -> NoStart(r, "dropped")
             [] jobs[r].requestedModel = "unavailableModel" -> NoStart(r, "modelChoices")
             [] command = "new" -> StartNew(r)
             [] command = "resume" /\ target \in saved -> StartSaved(r, target)
             [] OTHER -> NoStart(r, "unavailableSession")
       /\ UNCHANGED <<known, enabled, projects, pending, defaultModel>>

Finish(r, result) ==
    /\ jobs[r].phase = "running" \/ (jobs[r].phase = "creating" /\ result = "failed")
    /\ jobs' = [jobs EXCEPT ![r].phase = result]
    /\ UNCHANGED <<known, enabled, projects, pending, sessions, defaultModel>>

Next ==
    \/ Toggle
    \/ SaveModel
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
                \/ \E model \in RequestedModels :
                    \/ SessionRequest(r, c, p, "new", None, model)
                    \/ \E id \in SessionIds \cup {"unknown"} : SessionRequest(r, c, p, "resume", id, model)
            \/ \E p \in Projects \cup {None} : Request(r, c, p)
    \/ \E r \in Requests :
        \/ Dispatch(r)
        \/ SessionCreated(r)
        \/ \E result \in {"replyQueued", "failed"} : Finish(r, result)
    \/ \E p \in projects :
        /\ projects' = projects \ {p}
        /\ UNCHANGED <<known, enabled, jobs, pending, sessions, defaultModel>>

Spec == Init /\ [][Next]_vars

ChartState ==
    /\ enabled
    /\ \A c \in Chats, p \in Projects : SeedSessions \subseteq sessions[c][p]

PendingOwnedByChat ==
    \A c \in Chats :
        pending[c] # None =>
            /\ jobs[pending[c]].chat = c
            /\ jobs[pending[c]].phase = "pending"

OneRunPerProject ==
    \A p \in Projects :
        Cardinality({r \in Requests : jobs[r].phase \in ActivePhases /\ jobs[r].project = p}) <= 1

SessionOwnedByScope ==
    \A r \in Requests :
        jobs[r].session # None => jobs[r].session \in sessions[jobs[r].chat][jobs[r].project]

SessionsIsolated ==
    \A c, d \in Chats, p, q \in Projects :
        sessions[c][p] \cap sessions[d][q] # {} => c = d /\ p = q

ExplicitSessionCommand ==
    \A r \in Requests :
        jobs[r].phase \in {"queued", "creating"} \/ jobs[r].session # None =>
            jobs[r].command \in {"new", "resume"}

SessionResolution ==
    [] [\A r \in Requests :
        LET job == jobs[r]
            next == jobs'[r]
        IN job.phase = "queued" /\ next.phase \in ActivePhases \cup {"unavailableSession"} =>
           LET saved == sessions[job.chat][job.project]
           IN IF job.command = "new"
              THEN /\ next.phase = "creating" /\ next.session = None /\ next.notice = None
              ELSE IF job.target \in saved
                   THEN /\ next.phase = "running"
                        /\ next.session = job.target /\ next.notice = job.target
                   ELSE /\ next.phase = "unavailableSession" /\ next.session = None /\ next.notice = None]_vars

NativeSessionAcknowledged ==
    [] [\A r \in Requests :
        jobs[r].phase = "creating" =>
            IF jobs'[r].phase = "running"
            THEN /\ jobs'[r].session = r /\ jobs'[r].notice = r
            ELSE /\ jobs'[r].session = None /\ jobs'[r].notice = None]_vars

SessionMappingsFollowRuns ==
    [] [\A c \in Chats, p \in Projects :
        LET started == {r \in Requests :
            /\ jobs[r].phase = "creating" /\ jobs'[r].phase = "running"
            /\ jobs[r].chat = c /\ jobs[r].project = p}
        IN sessions'[c][p] = sessions[c][p] \cup {jobs'[r].session : r \in started}]_vars

StartedAtMostOnce ==
    [] [\A r \in Requests :
        jobs[r].session # None =>
            /\ jobs'[r].session = jobs[r].session
            /\ jobs[r].phase # "running" => jobs'[r].phase # "running"]_vars

ExpiredNeverStarts ==
    [] [\A r \in Requests : jobs[r].phase = "expired" => jobs'[r].phase = "expired"]_vars

UnavailableModelReturnsChoices ==
    [] [\A r \in Requests :
        jobs[r].phase = "queued" /\ jobs[r].requestedModel = "unavailableModel"
            /\ jobs'[r].phase # "queued" /\ jobs'[r].phase # "dropped" =>
            /\ jobs'[r].phase = "modelChoices"
            /\ jobs'[r].session = None]_vars

ModelResolution ==
    [] [\A r \in Requests :
        LET job == jobs[r]
            next == jobs'[r]
        IN job.phase = "queued" /\ next.phase \in ActivePhases =>
           IF job.requestedModel = None
           THEN next.model = defaultModel
           ELSE next.model = job.requestedModel]_vars

RunKeepsModel ==
    [] [\A r \in Requests : (jobs[r].phase = "creating" \/ jobs[r].session # None) => jobs'[r].model = jobs[r].model]_vars

ModelDefaultChangesOnlyOnSave ==
    [] [defaultModel' # defaultModel => SaveModel]_vars
====

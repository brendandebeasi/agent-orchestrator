## ADDED Requirements

### Requirement: A launch selects a client profile

A client SHALL accept a profile name at launch, from its command line or from its
environment, with the command line taking precedence. The profile SHALL be resolved before
the client opens any window, since it determines where the client's own state lives. A
launch that names no profile SHALL behave exactly as a client behaved before profiles
existed, including which directories it reads and writes.

A profile name SHALL be validated rather than corrected. A name the client cannot accept
SHALL resolve to the default profile rather than preventing the client from starting, and
the resolved profile SHALL be visible to the operator so a rejected name is not mistaken
for an accepted one.

#### Scenario: No profile named

- **WHEN** a client is launched with no profile in its command line or environment
- **THEN** it uses the same state directories it used before profiles existed
- **AND** no existing recorded state is moved or rewritten

#### Scenario: Profile named on the command line

- **WHEN** a client is launched with a profile named on its command line
- **THEN** that profile's state directory is used for the whole session

#### Scenario: Command line overrides the environment

- **WHEN** a client is launched with one profile on its command line and a different one in
  its environment
- **THEN** the command line profile is used

#### Scenario: Unusable profile name

- **WHEN** a client is launched with a profile name it cannot accept
- **THEN** the client starts on the default profile
- **AND** does not create a directory derived from the rejected name

### Requirement: Profiles isolate concurrent clients

Clients launched under different profiles SHALL run concurrently, each with its own client
state, and SHALL NOT prevent one another from starting. Two launches naming the same
profile SHALL behave as two launches of a single-profile client did: the second SHALL not
run a second copy against the same state.

#### Scenario: Two profiles at once

- **WHEN** a client is running under one profile and another is launched under a different
  profile
- **THEN** both run
- **AND** neither reports that another instance is already running

#### Scenario: Same profile twice

- **WHEN** a client is running under a profile and another is launched under that same
  profile
- **THEN** the second launch does not start a second client against that profile's state

#### Scenario: Concurrent clients on different servers

- **WHEN** clients under different profiles are attached to different servers
- **THEN** each shows only the sessions, projects, and events of the server it is attached
  to

### Requirement: A profile remembers its server; the address book is shared

The server a client is attached to SHALL be recorded per profile, so that relaunching a
profile reconnects it to the server it was last attached to without the operator
re-entering the address. The list of known servers and their retained credentials SHALL be
shared across profiles, so that an address and password entered once are offered to every
profile.

A per-launch server override SHALL be accepted from the command line as well as from the
environment, and SHALL take precedence over the profile's recorded server for that launch
only.

#### Scenario: Profile reconnects to its own server

- **WHEN** a profile that was attached to a server is launched again
- **THEN** it reconnects to that server
- **AND** a different profile launched at the same time reconnects to its own

#### Scenario: Credential entered once

- **WHEN** the operator saves a server and its password under one profile
- **THEN** another profile connecting to that server is not prompted for the password again

#### Scenario: Server overridden for one launch

- **WHEN** a profile is launched with a server override on its command line
- **THEN** the client attaches to the overridden server
- **AND** the profile's recorded server is used again on the next launch without the
  override

### Requirement: Concurrent clients are distinguishable

When a client is running under a named profile, the profile SHALL be identified in the
client's window title and in any operating-system-level presence the client keeps, so that
an operator running several clients can tell them apart without interacting with each. A
client on the default profile SHALL present the text it presented before profiles existed.

#### Scenario: Named profile is labelled

- **WHEN** a client is running under a named profile
- **THEN** its window title identifies that profile

#### Scenario: Default profile is unchanged

- **WHEN** a client is running with no profile named
- **THEN** its window title and system-level presence read exactly as they did before
  profiles existed

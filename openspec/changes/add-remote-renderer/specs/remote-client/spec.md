## Purpose

Defines how a client targets a daemon that is not on the same machine: choosing a server
at runtime, holding credentials for it, reporting connection state, and withdrawing the
features that only make sense when the daemon shares the client's filesystem and desktop.

## ADDED Requirements

### Requirement: The server address is chosen at runtime

A client SHALL determine which daemon to talk to at runtime rather than at build time. The
chosen address SHALL apply to every subsequent request and stream the client opens,
including ones already described by generated API bindings. Changing the address SHALL
take effect without rebuilding or reinstalling the client.

#### Scenario: Default address

- **WHEN** a client starts with no server recorded and a daemon is available on this machine
- **THEN** it connects to the local daemon without prompting

#### Scenario: Operator supplies a remote address

- **WHEN** the operator enters a server address and connects
- **THEN** every API request and stream the client opens is directed at that address

#### Scenario: Switching servers

- **WHEN** the operator changes the server address on a connected client
- **THEN** open streams to the previous server are closed
- **AND** the client reloads its state from the new server

### Requirement: Credentials are supplied per server and reused

A client SHALL prompt for the server password when connecting to a server that requires
one, SHALL attach it to every request and stream it opens against that server, and SHALL
retain it for that server so the operator is not prompted on each launch. Retained
credentials SHALL be stored using the platform's protected storage where the client has
access to it, and SHALL be removable by the operator. A credential SHALL NOT be placed in
a request URL.

#### Scenario: First connection to a server

- **WHEN** the operator connects to a server that requires a password
- **THEN** the client prompts for the password before loading any data

#### Scenario: Subsequent launch

- **WHEN** the client is launched again and the recorded server is reachable
- **THEN** it reconnects using the retained credential without prompting

#### Scenario: Credential rejected

- **WHEN** the server rejects the retained credential
- **THEN** the client discards it, returns to the connection prompt, and reports that the password was not accepted

#### Scenario: Operator signs out of a server

- **WHEN** the operator removes a saved server
- **THEN** the stored credential for that server is deleted

### Requirement: Connection state is visible and recoverable

A client SHALL show whether it is connected to its server and, when connected, which
server. When a connection attempt fails, the client SHALL distinguish an unreachable
server from a rejected credential, and SHALL offer a way to correct the address or the
password without restarting. When an established connection drops, the client SHALL
attempt to reconnect and SHALL indicate that it is doing so rather than presenting stale
data as current.

#### Scenario: Unreachable server

- **WHEN** the operator enters an address that no daemon answers
- **THEN** the client reports that the server could not be reached
- **AND** leaves the entered address editable

#### Scenario: Connection lost mid-session

- **WHEN** an established connection to the server drops
- **THEN** the client indicates it is reconnecting
- **AND** does not present the last-known session output as live

#### Scenario: Connection restored

- **WHEN** the server becomes reachable again
- **THEN** the client reconnects and resumes streaming session output

### Requirement: Host-bound features are withdrawn when the daemon is remote

Features that act on the machine running the daemon, or that require the client's own
desktop integration, SHALL be gated on whether the client can actually perform them. When
the daemon is remote, the client SHALL NOT offer opening a file in a local editor,
revealing a path in a local file manager, choosing a project directory with a local
directory picker, or the browser-preview panel. Withdrawn features SHALL be absent or
plainly disabled with the reason given, and SHALL NOT fail silently or act on the wrong
machine.

#### Scenario: Editor handoff on a remote daemon

- **WHEN** the client is connected to a remote daemon and the operator looks for the open-in-editor action
- **THEN** the action is not offered
- **AND** no file is opened on either machine

#### Scenario: Adding a project on a remote daemon

- **WHEN** the operator adds a project while connected to a remote daemon
- **THEN** the client asks for a path on the daemon's machine rather than opening a local directory picker
- **AND** reports an error if that path does not exist on the daemon's machine

#### Scenario: Browser preview on a remote daemon

- **WHEN** the client is connected to a remote daemon
- **THEN** the browser-preview panel is not offered

#### Scenario: Same features on a local daemon

- **WHEN** the client is connected to a daemon on its own machine
- **THEN** editor handoff, reveal in file manager, the directory picker, and browser preview are all offered as before

### Requirement: A client running outside the desktop shell degrades predictably

A client that runs without the desktop shell's privileged bridge SHALL report which
host-integration features it can provide and SHALL withdraw the rest by the same rule as a
remote daemon. Absence of the bridge SHALL NOT produce unhandled errors, and SHALL NOT
cause the client to present placeholder or fixture data as if it came from the server.

#### Scenario: Web client feature set

- **WHEN** the client runs in a browser
- **THEN** it offers session, project, and terminal features
- **AND** withdraws the features that require desktop integration

#### Scenario: Web client data source

- **WHEN** the client runs in a browser and displays sessions, shells, workspace status, or version-control summaries
- **THEN** the data comes from the server it is connected to
- **AND** no fixture or placeholder data is shown

#### Scenario: Preview mode is explicit

- **WHEN** a build is intended to render fixture data without a server
- **THEN** that behavior is selected by an explicit preview setting
- **AND** is not implied by the absence of the desktop shell

### Requirement: The desktop shell can target a remote server

The desktop client SHALL support running against a server on another machine. In that
mode it SHALL NOT start a daemon on the client machine, SHALL NOT adopt or supervise a
local daemon process, SHALL NOT apply checks that verify a local daemon binary matches the
client build, and SHALL NOT stop the remote daemon when the client quits. When targeting a
server on its own machine, the desktop client's existing lifecycle behavior SHALL be
unchanged.

#### Scenario: Launching against a remote server

- **WHEN** the desktop client starts configured for a remote server
- **THEN** no daemon process is started on the client machine
- **AND** the client connects to the configured server

#### Scenario: Quitting while connected to a remote server

- **WHEN** the operator quits the desktop client connected to a remote server
- **THEN** the remote daemon keeps running
- **AND** agent sessions are unaffected

#### Scenario: Version mismatch with a remote server

- **WHEN** the desktop client connects to a server whose version it does not support
- **THEN** the client reports the mismatch and the versions involved
- **AND** does not attempt to replace or restart the remote daemon

#### Scenario: Local server unchanged

- **WHEN** the desktop client starts configured for a daemon on its own machine
- **THEN** it starts or adopts that daemon and stops it on quit exactly as before

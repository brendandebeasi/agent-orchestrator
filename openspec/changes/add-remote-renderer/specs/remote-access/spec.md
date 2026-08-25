## Purpose

Defines the daemon's authenticated network surface for full clients: which routes are
reachable from off-machine, how a client that cannot set request headers proves it is
authorized, and how the web client is delivered. The loopback surface is unchanged; this
capability governs only the opt-in network listener.

## ADDED Requirements

### Requirement: Network access is opt-in and separately addressed

The daemon SHALL NOT accept connections from other machines unless network access has
been explicitly enabled by the operator. When enabled, the daemon SHALL listen on a
second address distinct from the loopback address, and SHALL continue to serve the
loopback address with its existing behavior unchanged. Disabling network access SHALL
stop the network listener without interrupting sessions or connections on loopback.

#### Scenario: Network access disabled by default

- **WHEN** the daemon starts with no network-access setting recorded
- **THEN** it accepts connections only on the loopback address
- **AND** a connection attempt from another machine is refused at the transport layer

#### Scenario: Operator enables network access

- **WHEN** the operator enables network access and supplies a password
- **THEN** the daemon begins accepting connections on the network address
- **AND** reports the address a client should use

#### Scenario: Operator disables network access while a remote client is connected

- **WHEN** the operator disables network access
- **THEN** the network listener stops accepting new connections
- **AND** agent sessions continue running
- **AND** a client on the loopback address is unaffected

### Requirement: Every network request is authenticated

The daemon SHALL require proof of the operator's password on every request received on
the network address, including WebSocket upgrades and static asset requests. A request
without valid credentials SHALL be rejected with an unauthenticated status and SHALL NOT
disclose whether a resource exists. Repeated failures from one source SHALL be locked out
for a cooldown period. The comparison of the supplied credential SHALL NOT leak timing
information about the expected value.

#### Scenario: Request without credentials

- **WHEN** a client requests any network-address route with no credential
- **THEN** the daemon responds with an unauthenticated status
- **AND** the response body contains no session, project, or filesystem data

#### Scenario: Request with an incorrect credential

- **WHEN** a client requests a network-address route with a wrong password
- **THEN** the daemon responds with an unauthenticated status
- **AND** the response is indistinguishable from the response for a route that does not exist

#### Scenario: Repeated failures from one source

- **WHEN** a single source submits more than the permitted number of consecutive incorrect credentials
- **THEN** further requests from that source are refused for a cooldown period even if the credential is subsequently correct

#### Scenario: Request with the correct credential

- **WHEN** a client requests a permitted route with the correct password
- **THEN** the daemon serves the route with the same response it would return on loopback

### Requirement: Full-client routes are reachable over the network

The daemon SHALL serve, on the network address, every route a full client needs to list
projects and sessions, read and write session state, stream agent output, and read the
workspace summary for a session. Routes reachable on loopback that a remote client
genuinely needs SHALL NOT be withheld solely because the request arrived over the
network.

#### Scenario: Remote client loads the session list

- **WHEN** an authenticated remote client requests the project and session listings
- **THEN** the daemon returns the same data it returns to a loopback client

#### Scenario: Remote client reads a session workspace summary

- **WHEN** an authenticated remote client requests the workspace summary for a session
- **THEN** the daemon returns the summary rather than a not-found status

#### Scenario: Remote client drives an agent session

- **WHEN** an authenticated remote client sends input to a running agent session and subscribes to its output
- **THEN** the input reaches the agent and the output stream is delivered to that client

### Requirement: Host-control routes are refused over the network

The daemon SHALL refuse, at the network address, every route that controls the host
machine rather than the workspace: process shutdown, internal maintenance endpoints,
development-only endpoints, software installation, the paired-device enrollment surface,
and the local browser-automation surface. Refusal SHALL report the route as not found
rather than as forbidden, and SHALL apply even when the request carries valid
credentials. These routes SHALL remain available on the loopback address.

#### Scenario: Authenticated shutdown attempt over the network

- **WHEN** an authenticated remote client requests the daemon shutdown route
- **THEN** the daemon responds with a not-found status
- **AND** the daemon keeps running

#### Scenario: Authenticated install attempt over the network

- **WHEN** an authenticated remote client requests the software-installation route
- **THEN** the daemon responds with a not-found status
- **AND** no installation is performed

#### Scenario: Same route on loopback

- **WHEN** a loopback client requests a route that is refused on the network address
- **THEN** the daemon serves it normally

### Requirement: Header-less clients can authenticate the terminal stream

Because a browser cannot attach request headers to a WebSocket handshake, the daemon
SHALL accept the connection credential offered as a negotiated WebSocket subprotocol on
the terminal stream, in addition to the existing request-header form. When a credential
is offered as a subprotocol, the daemon SHALL echo the negotiated subprotocol back to the
client on a successful upgrade. A handshake carrying neither a valid header credential nor
a valid subprotocol credential SHALL be refused before the connection is upgraded.

#### Scenario: Browser client authenticates by subprotocol

- **WHEN** a client opens the terminal stream offering a valid credential as a subprotocol
- **THEN** the handshake succeeds
- **AND** the response names the negotiated subprotocol
- **AND** the stream carries the same data a header-authenticated client receives

#### Scenario: Native client authenticates by header

- **WHEN** a client opens the terminal stream with a valid credential in a request header
- **THEN** the handshake succeeds without any subprotocol negotiation

#### Scenario: Invalid subprotocol credential

- **WHEN** a client opens the terminal stream offering an incorrect credential as a subprotocol
- **THEN** the handshake is refused with an unauthenticated status
- **AND** the connection is never upgraded

#### Scenario: Credential is not accepted in the request URL

- **WHEN** a client opens the terminal stream with a credential in the query string and no other credential
- **THEN** the handshake is refused

### Requirement: The web client is served same-origin

When network access is enabled and a built web client is present, the daemon SHALL serve
that client from the network address so that its API and stream requests share the
daemon's origin. Client asset requests SHALL be subject to the same authentication as
every other network request, except for the minimal entry point needed to prompt for
credentials. A request for an unknown client path SHALL return the client entry point so
that client-side routing works on reload. When no built web client is present, the daemon
SHALL continue to serve the API without error.

#### Scenario: Loading the web client

- **WHEN** an operator opens the daemon's network address in a browser and supplies the password
- **THEN** the web client loads and reaches the API without any cross-origin permission being configured

#### Scenario: Deep link reload

- **WHEN** a browser requests a client route that is not a file on disk
- **THEN** the daemon returns the client entry point rather than a not-found status

#### Scenario: No web client bundled

- **WHEN** network access is enabled on a daemon built without the web client
- **THEN** API routes are served normally
- **AND** a request for the client entry point returns a not-found status

### Requirement: Cross-origin access stays restricted

The daemon SHALL NOT widen its cross-origin policy to admit arbitrary origins in order to
support remote clients. An origin that is not explicitly permitted SHALL be refused, and
a wildcard or null origin SHALL never be accepted.

#### Scenario: Request from an unlisted origin

- **WHEN** a page on an origin that is not permitted issues a cross-origin request to the daemon
- **THEN** the daemon refuses the request

#### Scenario: Same-origin web client

- **WHEN** the web client served by the daemon calls the API
- **THEN** the request is same-origin and no cross-origin permission is required

### Requirement: Transport confidentiality is the operator's responsibility and is stated

The daemon SHALL NOT present the network address as safe for the public internet. Where
the network address is served without transport encryption, the daemon SHALL make that
plain to the operator at the point of enabling it, and SHALL document the supported way
to obtain an encrypted address for use beyond a trusted local network.

#### Scenario: Enabling network access

- **WHEN** the operator enables network access
- **THEN** the daemon reports whether the address is encrypted
- **AND** states that the address must not be exposed to the public internet

#### Scenario: Encrypted address available

- **WHEN** the operator has configured the supported encrypted proxy
- **THEN** the daemon reports the encrypted address as the one to give to clients

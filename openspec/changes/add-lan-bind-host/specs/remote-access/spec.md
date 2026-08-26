## ADDED Requirements

### Requirement: The network listener's interface is configurable

The daemon SHALL allow an operator to specify which network interface the
opt-in network listener binds. The setting SHALL default to every interface, so
that a daemon whose operator has not specified one behaves as it did before the
setting existed.

The setting SHALL only be able to narrow which addresses the listener answers
on. It SHALL NOT affect whether the listener requires a connection password,
the per-source lockout, or which routes the listener refuses to serve.

A value that is not a valid address SHALL prevent the daemon from starting,
rather than falling back to the default, since a setting whose purpose is to
restrict reachability must not silently widen it.

#### Scenario: Unconfigured daemon

- **WHEN** no interface is specified and the network listener is enabled
- **THEN** it answers on every interface of the machine

#### Scenario: Listener narrowed to loopback

- **WHEN** the interface is set to the machine's loopback address and the
  network listener is enabled
- **THEN** the listener answers on loopback
- **AND** does not answer on any other address the machine holds

#### Scenario: Authentication is unaffected

- **WHEN** the listener is narrowed to a single interface
- **THEN** a request on that interface without a valid connection password is
  still refused
- **AND** the routes the listener never serves are still refused

#### Scenario: Unusable interface value

- **WHEN** the interface is set to something that is not an address
- **THEN** the daemon refuses to start and reports the value it rejected

#### Scenario: Configured port already in use

- **WHEN** the listener falls back to an operating-system-assigned port
- **THEN** it binds that port on the configured interface, not on every
  interface

## 1. Configuration

- [x] 1.1 Added `RemoteAccessConfig.ListenHost` and `DefaultLANHost = "0.0.0.0"` in `backend/internal/config/config.go`, defaulted in the `Load` literal so an unset environment produces the previous bind exactly. The doc comment records why this listener may have a settable host while the primary one may not: this one is authenticated, and the setting can only narrow it.
- [x] 1.2 Read `AO_LAN_HOST`, validated with `net.ParseIP` and rejected otherwise, failing `Load` rather than falling back (design D2). Verified by `TestLANHostDefaultsToEveryInterface`, `TestLANHostNarrowsTheListener`, and `TestLANHostRejectsAnythingThatIsNotAnAddress`, which covers `localhost`, a domain, free text, and a host:port pair.

## 2. Listener

- [x] 2.1 Added `NewLANManagerOn(listenHost, ...)` and reduced `NewLANManager` to a delegation with the default, so every existing call site and test keeps its meaning (design D3). `NewMobileLAN` passes `cfg.RemoteAccess.ListenHost`.
- [x] 2.2 Replaced the hardcoded `0.0.0.0` bind with `net.JoinHostPort(host, port)`, including the ephemeral-port fallback, which now follows the configured interface rather than widening to every one (design D4). The `//nolint:gosec` comments were rewritten to say that binding every interface is the deliberate default rather than the only behaviour.
- [x] 2.3 Verified by `TestLANListenerBindsOnlyTheConfiguredInterface`, which starts a listener on `127.0.0.1`, confirms loopback accepts a connection, and confirms a dial to this machine's first non-loopback IPv4 does not. `TestLANListenerDefaultsToEveryInterface` asserts the unconfigured manager still answers on that same address, so the two cases fail in opposite directions if the bind ever stops following the setting. Both skip on a machine with no non-loopback IPv4 rather than passing vacuously.

## 3. Verification

- [x] 3.1 `go build ./...` and `go build -tags webui ./...` clean. `go test ./...` shows one failure, `TestCrushLocalAuthStatusDoesNotUseProviderCatalog`, which reads this machine's real crush credentials and fails identically on a clean checkout. `golangci-lint` reports 0 issues.
- [x] 3.2 Live pass on five client VMs. A `-tags webui` daemon was deployed to each with `AO_LAN_HOST=127.0.0.1` and `AO_REMOTE_SERVE_WEB=on`. On every box `ss -ltn` shows both `127.0.0.1:3001` and `127.0.0.1:3011` and nothing on the LAN address, and `curl` to `<lan-ip>:3011` is refused while `127.0.0.1:3011` returns the login page. Before this change the same enable would have bound `0.0.0.0:3011` on all five.
- [x] 3.3 Drove all five dashboards through SSH tunnels in a real browser: login page, password exchange, redirect to `/app/`, the project list rendered, "daemon ready", and zero page or console errors on each. This also confirms the Host header survives the tunnel, so the listener's origin check sees the same origin the browser sent.
- [x] 3.4 `openspec validate --changes` passes.

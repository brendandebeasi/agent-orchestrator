//go:build !webui

package httpd

import "testing"

// The default build is the one almost everyone runs, and the reason the bundle
// is behind a tag at all: embedding it costs roughly six megabytes of binary
// that a loopback desktop client never reads. A change that made the embed
// unconditional would still pass every other test in this package, since they
// all supply their own asset filesystem.
func TestDefaultBuildCarriesNoWebClient(t *testing.T) {
	assets, ok := webClientFS()

	if ok || assets != nil {
		t.Fatalf("default build reports a web client: ok=%v assets=%v", ok, assets)
	}
}

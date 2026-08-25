//go:build webui

package httpd

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A tagged build with a bundle beside it serves that bundle, and the bundle it
// serves is the one on disk rather than a placeholder.
//
// Every other test in this package hands the handler a synthetic filesystem,
// which is the right way to test the serving rules but leaves the embed
// directive itself uncovered: a wrong path in the //go:embed line, or a build
// script writing somewhere else, would break the feature without failing a
// single test. This is the case that reads what the build actually produced.
//
// It skips when the directory holds no entry point, which is the clean-checkout
// state — the frontend's `npm run build:web` has not run, so there is nothing to
// assert about. That makes this a test that gets stronger in a pipeline that
// builds the client and stays quiet in one that does not.
func TestEmbeddedWebClientIsServed(t *testing.T) {
	assets, ok := webClientFS()
	if !ok {
		t.Skip("no bundle embedded; run `npm run build:web` in frontend/ before building with -tags webui")
	}

	h, reached := remoteWebStack(t, remoteWebOptions{ServeWebClient: true, Assets: assets})
	r := remoteWebRequest(http.MethodGet, remoteWebAssetPrefix+webClientEntry)
	r.Header.Set("Authorization", "Bearer "+remoteWebPassword)
	w := httptest.NewRecorder()

	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("entry point status = %d, want 200", w.Code)
	}
	if reached() {
		t.Fatal("the request fell through to the API router instead of being answered by the embedded bundle")
	}
	body := w.Body.String()
	if !strings.Contains(body, "<div id=\"root\"></div>") {
		t.Fatalf("entry point does not look like the renderer's index.html: %q", truncate(body))
	}
	// The entry point names hashed asset filenames, so the assets it names have
	// to be embedded too. A build that emitted the HTML and dropped the assets
	// would serve a page that loads nothing.
	if _, err := fs.Stat(assets, "assets"); err != nil {
		t.Fatalf("bundle has no assets directory: %v", err)
	}
}

func truncate(s string) string {
	if len(s) <= 200 {
		return s
	}
	return s[:200] + "…"
}

package httpd

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// The login page and the client it loads agree on two sessionStorage keys, and
// they are written in different languages in different trees. Nothing at either
// compiler's disposal connects them: rename one and the page still serves, the
// client still builds, and the only symptom is a browser that logs in and then
// bounces straight back to the password prompt forever.
//
// So the agreement is asserted here, against the real text of both files rather
// than against a copy either could drift from.

var (
	goKeyPattern = regexp.MustCompile(`(?m)^\s*var (TOKEN_KEY|VERSION_KEY) = "([^"]+)";`)
	tsKeyPattern = regexp.MustCompile(`(?m)^export const REMOTE_SESSION_(TOKEN|VERSION)_KEY = "([^"]+)";`)
)

func TestRemoteWebSessionKeysMatchTheClient(t *testing.T) {
	pageKeys := map[string]string{}
	for _, match := range goKeyPattern.FindAllStringSubmatch(remoteWebLoginPage, -1) {
		pageKeys[match[1]] = match[2]
	}
	if len(pageKeys) != 2 {
		t.Fatalf("expected 2 key declarations in the login page, found %d: %v", len(pageKeys), pageKeys)
	}

	source := readSharedRemoteSession(t)
	clientKeys := map[string]string{}
	for _, match := range tsKeyPattern.FindAllStringSubmatch(source, -1) {
		clientKeys[match[1]+"_KEY"] = match[2]
	}
	if len(clientKeys) != 2 {
		t.Fatalf("expected 2 key exports in remote-session.ts, found %d: %v", len(clientKeys), clientKeys)
	}

	for name, pageValue := range pageKeys {
		if clientValue := clientKeys[name]; clientValue != pageValue {
			t.Errorf("%s: login page writes %q, client reads %q", name, pageValue, clientValue)
		}
	}
}

// TestRemoteWebLoginPathMatchesTheClient guards the other half of the handoff:
// the client sends an operator back here when it finds no session, and the page
// only exists at the path the router serves it from.
func TestRemoteWebLoginPathMatchesTheClient(t *testing.T) {
	pattern := regexp.MustCompile(`(?m)^export const REMOTE_LOGIN_PATH = "([^"]+)";`)
	match := pattern.FindStringSubmatch(readSharedRemoteSession(t))
	if match == nil {
		t.Fatal("no REMOTE_LOGIN_PATH export found in remote-session.ts")
	}
	if match[1] != remoteWebLoginPath {
		t.Errorf("client returns to %q, daemon serves the login page at %q", match[1], remoteWebLoginPath)
	}
}

func readSharedRemoteSession(t *testing.T) string {
	t.Helper()
	path := filepath.Join("..", "..", "..", "frontend", "src", "shared", "remote-session.ts")
	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(source)
}

//go:build webui

package httpd

import (
	"embed"
	"io/fs"
)

// webClientAssets holds the browser build of the renderer, written into
// webclient/ by the frontend build before the daemon is compiled with
// -tags webui. The directory is committed with only a .gitkeep so this file
// compiles in a clean checkout; a build with no bundle simply serves nothing.
//
// all: is required because the bundle's entry point sits alongside dotfiles the
// default embed pattern would skip.
//
//go:embed all:webclient
var webClientAssets embed.FS

// webClientFS returns the embedded bundle rooted at its own directory, and
// false when the directory holds no entry point — the clean-checkout case,
// where the daemon was built with the tag but the frontend build never ran.
func webClientFS() (fs.FS, bool) {
	sub, err := fs.Sub(webClientAssets, "webclient")
	if err != nil {
		return nil, false
	}
	if _, err := fs.Stat(sub, webClientEntry); err != nil {
		return nil, false
	}
	return sub, true
}

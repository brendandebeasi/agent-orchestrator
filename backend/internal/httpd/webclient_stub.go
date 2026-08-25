//go:build !webui

package httpd

import "io/fs"

// webClientFS reports that this build carries no web client. The browser build
// of the renderer is a multi-megabyte bundle produced by the frontend toolchain,
// so embedding it is opt-in at build time (-tags webui) rather than a cost every
// `ao` binary pays. See webclient_webui.go for the embedded variant.
func webClientFS() (fs.FS, bool) { return nil, false }

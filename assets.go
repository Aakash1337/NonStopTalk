package nonstoptalk

import (
	"embed"
	"io/fs"
)

// embeddedAssets contains everything the web and desktop binaries need at
// runtime, so they do not depend on the repository's working directory.
//
//go:embed internal/web/templates/*.html web/static
var embeddedAssets embed.FS

// EmbeddedAssets returns the templates and browser assets compiled into the
// application binaries.
func EmbeddedAssets() fs.FS {
	return embeddedAssets
}

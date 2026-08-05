package main

import (
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	nonstoptalk "github.com/Aakash1337/NonStopTalk"
	"github.com/Aakash1337/NonStopTalk/internal/web/handlers"
)

func main() {
	server, err := handlers.NewServerFromFS(nonstoptalk.EmbeddedAssets())
	if err != nil {
		log.Fatal(err)
	}

	// Rooms survive restarts via periodic JSON snapshots. Set
	// NONSTOPTALK_DATA_FILE to change the location, or to "off" to keep
	// everything in memory. DST_DATA_FILE remains a deprecated fallback.
	dataFile, primaryDataFileSet := os.LookupEnv("NONSTOPTALK_DATA_FILE")
	if !primaryDataFileSet {
		dataFile = os.Getenv("DST_DATA_FILE")
		if dataFile != "" {
			log.Printf("DST_DATA_FILE is deprecated; use NONSTOPTALK_DATA_FILE instead")
		}
	}
	if dataFile == "" {
		dataFile = "data/rooms.json"
	}
	if dataFile != "off" {
		server.EnablePersistence(dataFile)
		log.Printf("room persistence enabled at %s", dataFile)
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	addr := port
	if !strings.HasPrefix(addr, ":") {
		addr = ":" + addr
	}
	log.Printf("NonStopTalk web app listening on http://localhost%s", addr)
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           server.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

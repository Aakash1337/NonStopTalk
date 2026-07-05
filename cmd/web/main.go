package main

import (
	"log"
	"net/http"
	"os"
	"strings"

	"dontstoptalking/internal/web/handlers"
)

func main() {
	server, err := handlers.NewServer("internal/web/templates/*.html")
	if err != nil {
		log.Fatal(err)
	}

	// Rooms survive restarts via periodic JSON snapshots. Set DST_DATA_FILE
	// to change the location, or to "off" to keep everything in memory.
	dataFile := os.Getenv("DST_DATA_FILE")
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
	log.Printf("Don't Stop Talking web app listening on http://localhost%s", addr)
	if err := http.ListenAndServe(addr, server.Routes()); err != nil {
		log.Fatal(err)
	}
}

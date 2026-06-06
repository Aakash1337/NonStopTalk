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

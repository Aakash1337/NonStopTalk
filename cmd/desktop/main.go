package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"time"

	"dontstoptalking/internal/web/handlers"
)

func main() {
	server, err := handlers.NewServer("internal/web/templates/*.html")
	if err != nil {
		log.Fatal(err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	url := fmt.Sprintf("http://%s", listener.Addr().String())

	go func() {
		if err := http.Serve(listener, server.Routes()); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	time.Sleep(150 * time.Millisecond)
	if err := openBrowser(url); err != nil {
		log.Printf("Open %s in your browser. Launcher could not open it automatically: %v", url, err)
	} else {
		log.Printf("Don't Stop Talking desktop session running at %s", url)
	}

	select {}
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

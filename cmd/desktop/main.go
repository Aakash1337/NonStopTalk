package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"time"

	nonstoptalk "github.com/Aakash1337/NonStopTalk"
	"github.com/Aakash1337/NonStopTalk/internal/web/handlers"
)

func main() {
	server, err := handlers.NewServerFromFS(nonstoptalk.EmbeddedAssets())
	if err != nil {
		log.Fatal(err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	url := fmt.Sprintf("http://%s", listener.Addr().String())
	httpServer := &http.Server{
		Handler:           server.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	go func() {
		if err := httpServer.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	time.Sleep(150 * time.Millisecond)
	if err := openBrowser(url); err != nil {
		log.Printf("Open %s in your browser. Launcher could not open it automatically: %v", url, err)
	} else {
		log.Printf("NonStopTalk desktop session running at %s", url)
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

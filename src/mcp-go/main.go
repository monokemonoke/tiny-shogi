package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	mcpserver "github.com/mark3labs/mcp-go/server"
)

func main() {
	dbPath := os.Getenv("LOOKUP_DB_PATH")
	if dbPath == "" {
		dbPath = GetDefaultLookupDBPath()
	}

	server, closeFn := CreateTinyShogiMcpServer(dbPath)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		closeFn()
		cancel()
		os.Exit(0)
	}()

	stdioServer := mcpserver.NewStdioServer(server)
	if err := stdioServer.Listen(ctx, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "サーバーエラー: %v\n", err)
		os.Exit(1)
	}
}
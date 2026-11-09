package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/markhuangai/AaA-muse-ai/internal/app"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

var revision = "development"
var dirty = "true"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(app.Run(ctx, os.Args[1:], service.Build{Revision: revision, Dirty: dirty != "false"}, app.Production(os.Stdout, os.Stderr)))
}

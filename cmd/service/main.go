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
var version = service.DevelopmentVersion
var workerSHA256 = ""
var workerUpdateFrom = ""

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(app.Run(ctx, os.Args[1:], service.Build{Version: version, Revision: revision, Dirty: dirty != "false", WorkerPackage: service.PairedWorker(version, workerSHA256), WorkerUpdateFrom: workerUpdateFrom}, app.Production(os.Stdout, os.Stderr)))
}

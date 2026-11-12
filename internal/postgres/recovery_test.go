package postgres

import (
	"context"
	"strings"
	"testing"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func TestRecoveryRepositorySelectionAndAtomicPersistence(t *testing.T) {
	ctx := context.Background()
	repo, tx, ref := routingRepository(t, "")
	ref.WorkerID, ref.SubmissionID, ref.Recovery = "", "", true
	apply := func(s *inference.State) error {
		if s.Recovery.Receipts != 7 || s.Recovery.Conversations != 4 || len(s.Experiments["request"].Messages) != 1 {
			t.Fatal("recovery omitted durable receipt counts or canonical context")
		}
		return applyRouting(s)
	}
	if err := repo.WithinInference(ctx, ref, apply); err != nil || !tx.committed {
		t.Fatal("recovery transaction failed", err)
	}
	queries := strings.Join(tx.queriesSeen, "\n")
	if !strings.Contains(queries, "output_completed_at") || !strings.Contains(queries, "pending_call_id") || !strings.Contains(queries, "context_delivery_written_at") {
		t.Fatal("recovery omitted unresolved completed requests")
	}
	for step := 1; step <= tx.step; step++ {
		repo, failing, _ := routingRepository(t, "")
		failing.failStep = step
		if err := repo.WithinInference(ctx, ref, apply); err == nil || !failing.rolledBack {
			t.Fatal("recovery storage fault did not roll back", step)
		}
	}
	repo, _, _ = routingRepository(t, "recovery-summary-error")
	if err := repo.WithinInference(ctx, ref, apply); err == nil {
		t.Fatal("missing recovery summary ignored")
	}
}

package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func nativeWorkPrincipal(workerID string) string { return "native-work:" + workerID }

func recordNativeGrant(ctx context.Context, tx *sql.Tx, workerID, claimID string, pull inference.Pull) error {
	receipt := inference.NativeWorkReceipt{Checker: pull.Checker, Occurrence: pull.Occurrence}
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO aaa_inference_receipts(principal,submission_id,data) VALUES(?1,?2,?3)",
		nativeWorkPrincipal(workerID), claimID, data)
	return err
}

func readNativeWork(ctx context.Context, tx *sql.Tx, job *inference.Job) (*inference.NativeWorkReceipt, error) {
	if job == nil || !inference.VerifiedClaim(job.LeaseID) {
		return nil, nil
	}
	var data []byte
	err := tx.QueryRowContext(ctx, "SELECT data FROM aaa_inference_receipts WHERE principal=?1 AND submission_id=?2",
		nativeWorkPrincipal(job.WorkerID), job.LeaseID).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var receipt inference.NativeWorkReceipt
	if err = decodeInference(data, &receipt); err != nil {
		return nil, err
	}
	return &receipt, nil
}

func recordNativeStart(ctx context.Context, tx *sql.Tx, job *inference.Job, receipt *inference.NativeWorkReceipt) error {
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE aaa_inference_receipts SET data=?3 WHERE principal=?1 AND submission_id=?2",
		nativeWorkPrincipal(job.WorkerID), job.LeaseID, data)
	return err
}

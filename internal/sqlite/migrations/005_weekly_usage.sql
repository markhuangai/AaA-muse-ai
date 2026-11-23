CREATE TABLE aaa_worker_weekly_usage (
    worker_id TEXT PRIMARY KEY REFERENCES aaa_workers(id),
    used_percent REAL NOT NULL CHECK(used_percent BETWEEN 0 AND 100),
    observed_at INTEGER NOT NULL,
    scheduled_at INTEGER NOT NULL,
    reset_label TEXT NOT NULL CHECK(length(reset_label)<=48)
) STRICT;
CREATE INDEX aaa_weekly_usage_rank ON aaa_worker_weekly_usage(used_percent,observed_at,worker_id);

ALTER TABLE aaa_worker_polls ADD COLUMN available_capability INTEGER CHECK(available_capability BETWEEN 0 AND 2);
ALTER TABLE aaa_worker_polls ADD COLUMN available_major TEXT NOT NULL DEFAULT '';
ALTER TABLE aaa_worker_polls ADD COLUMN previous_pin_reason TEXT NOT NULL DEFAULT 'offline_before_claim_and_context';

ALTER TABLE aaa_pull_queue ADD COLUMN model_request INTEGER NOT NULL DEFAULT 0 CHECK(model_request IN (0,1));
CREATE INDEX aaa_pull_queue_model_head ON aaa_pull_queue(target,capability,shift,bucket,created_at,job_id) WHERE model_request=1;
UPDATE aaa_pull_queue SET model_request=1 WHERE target<>'' AND job_id IN (
    SELECT job.id FROM aaa_inference_jobs AS job JOIN aaa_model_requests AS req ON req.id=job.experiment_id
    WHERE job.state='queued' AND job.worker_id IS NOT NULL
);

-- The model request can be inserted after its first queued job in the same transaction.
CREATE TRIGGER aaa_model_pull_queue_insert AFTER INSERT ON aaa_model_requests BEGIN
    UPDATE aaa_pull_queue SET model_request=1 WHERE target<>'' AND job_id IN (
        SELECT id FROM aaa_inference_jobs WHERE experiment_id=NEW.id AND state='queued'
    );
END;

DROP TRIGGER aaa_pull_queue_insert;
DROP TRIGGER aaa_pull_queue_update;
CREATE TRIGGER aaa_pull_queue_insert AFTER INSERT ON aaa_inference_jobs WHEN NEW.state='queued' BEGIN
    INSERT INTO aaa_pull_queue(job_id,shift,target,capability,bucket,created_at,model_request)
        SELECT NEW.id,shift,coalesce(NEW.worker_id,''),NEW.capability,NEW.deadline_at >> shift,NEW.created_at,
            NEW.worker_id IS NOT NULL AND EXISTS(SELECT 1 FROM aaa_model_requests WHERE id=NEW.experiment_id)
        FROM aaa_pull_levels;
END;
CREATE TRIGGER aaa_pull_queue_update AFTER UPDATE OF state,worker_id,capability,deadline_at,created_at ON aaa_inference_jobs
    WHEN (OLD.state='queued' OR NEW.state='queued') AND (OLD.state IS NOT NEW.state OR OLD.worker_id IS NOT NEW.worker_id
        OR OLD.capability IS NOT NEW.capability OR OLD.deadline_at IS NOT NEW.deadline_at OR OLD.created_at IS NOT NEW.created_at) BEGIN
    DELETE FROM aaa_pull_queue WHERE job_id=OLD.id;
    INSERT INTO aaa_pull_queue(job_id,shift,target,capability,bucket,created_at,model_request)
        SELECT NEW.id,shift,coalesce(NEW.worker_id,''),NEW.capability,NEW.deadline_at >> shift,NEW.created_at,
            NEW.worker_id IS NOT NULL AND EXISTS(SELECT 1 FROM aaa_model_requests WHERE id=NEW.experiment_id)
        FROM aaa_pull_levels WHERE NEW.state='queued';
END;

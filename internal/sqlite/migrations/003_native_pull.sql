CREATE TABLE aaa_worker_polls (
    worker_id TEXT PRIMARY KEY REFERENCES aaa_workers(id),
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    scheduled_at INTEGER NOT NULL,
    last_poll_at INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    result BLOB NOT NULL,
    previous_pin TEXT NOT NULL
) STRICT;
CREATE VIEW aaa_pull_levels AS
    WITH RECURSIVE levels(shift) AS (VALUES(0) UNION ALL SELECT shift+1 FROM levels WHERE shift<63)
    SELECT shift FROM levels;
CREATE TABLE aaa_pull_queue (
    job_id TEXT NOT NULL REFERENCES aaa_inference_jobs(id) ON DELETE CASCADE,
    shift INTEGER NOT NULL,
    target TEXT NOT NULL,
    capability INTEGER NOT NULL,
    bucket INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, shift)
) STRICT, WITHOUT ROWID;
CREATE INDEX aaa_pull_queue_head ON aaa_pull_queue(target, capability, shift, bucket, created_at, job_id);

INSERT INTO aaa_pull_queue(job_id, shift, target, capability, bucket, created_at)
    SELECT job.id, shift, coalesce(job.worker_id,''), job.capability, job.deadline_at >> shift, job.created_at
    FROM aaa_inference_jobs AS job CROSS JOIN aaa_pull_levels WHERE job.state='queued';
CREATE TRIGGER aaa_pull_queue_insert AFTER INSERT ON aaa_inference_jobs WHEN NEW.state='queued' BEGIN
    INSERT INTO aaa_pull_queue(job_id, shift, target, capability, bucket, created_at)
        SELECT NEW.id, shift, coalesce(NEW.worker_id,''), NEW.capability, NEW.deadline_at >> shift, NEW.created_at FROM aaa_pull_levels;
END;
CREATE TRIGGER aaa_pull_queue_update AFTER UPDATE OF state,worker_id,capability,deadline_at,created_at ON aaa_inference_jobs
    WHEN (OLD.state='queued' OR NEW.state='queued') AND (OLD.state IS NOT NEW.state OR OLD.worker_id IS NOT NEW.worker_id
        OR OLD.capability IS NOT NEW.capability OR OLD.deadline_at IS NOT NEW.deadline_at OR OLD.created_at IS NOT NEW.created_at) BEGIN
    DELETE FROM aaa_pull_queue WHERE job_id=OLD.id;
    INSERT INTO aaa_pull_queue(job_id, shift, target, capability, bucket, created_at)
        SELECT NEW.id, shift, coalesce(NEW.worker_id,''), NEW.capability, NEW.deadline_at >> shift, NEW.created_at
        FROM aaa_pull_levels WHERE NEW.state='queued';
END;
CREATE INDEX aaa_experiments_due ON aaa_experiments(deadline_at, id)
    WHERE state NOT IN ('completed', 'cancelled', 'interrupted');
CREATE INDEX aaa_queued_pins_due ON aaa_inference_jobs(pin_check_at, id)
    WHERE state = 'queued' AND pin_check_at IS NOT NULL;

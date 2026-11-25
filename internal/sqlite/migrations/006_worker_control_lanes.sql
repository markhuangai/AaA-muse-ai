CREATE TABLE aaa_worker_slots (
    worker_id TEXT PRIMARY KEY REFERENCES aaa_workers(id),
    lane TEXT NOT NULL CHECK (lane IN ('inference', 'worker_op', 'agent_task')),
    item_id TEXT NOT NULL,
    acquired_at INTEGER NOT NULL
) STRICT;

INSERT INTO aaa_worker_slots(worker_id, lane, item_id, acquired_at)
    SELECT worker_id, 'inference', id,
        COALESCE(CAST(unixepoch(json_extract(CAST(data AS TEXT), '$.claimed_at'), 'subsec') * 1000000 AS INTEGER), created_at)
    FROM aaa_inference_jobs WHERE held = 1;

CREATE TABLE aaa_worker_capabilities (
    worker_id TEXT PRIMARY KEY REFERENCES aaa_workers(id),
    agent_tasks INTEGER NOT NULL CHECK (agent_tasks IN (0, 1)),
    prompt_contract TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    scheduled_at INTEGER NOT NULL
) STRICT;

CREATE TABLE aaa_worker_ops (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES aaa_workers(id),
    kind TEXT NOT NULL CHECK (kind IN ('diagnostics_export', 'doctor', 'retry_update')),
    state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
    held INTEGER NOT NULL CHECK (held IN (0, 1)),
    claim_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    update_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL,
    claimed_at INTEGER,
    finished_at INTEGER,
    reason TEXT NOT NULL,
    remote_outcome TEXT NOT NULL,
    result_bytes INTEGER NOT NULL CHECK (result_bytes >= 0),
    result_sha256 TEXT NOT NULL,
    data BLOB NOT NULL,
    result BLOB,
    CHECK (NOT held OR state IN ('claimed', 'running', 'cancelled', 'interrupted')),
    CHECK (NOT held OR claim_id <> ''),
    CHECK (kind <> 'retry_update' OR held = 0)
) STRICT;
CREATE UNIQUE INDEX aaa_worker_op_held ON aaa_worker_ops(worker_id) WHERE held = 1;
CREATE UNIQUE INDEX aaa_worker_op_retry ON aaa_worker_ops(worker_id)
    WHERE kind = 'retry_update' AND state IN ('queued', 'running');
CREATE INDEX aaa_worker_op_queue ON aaa_worker_ops(worker_id, created_at, id) WHERE state = 'queued';
CREATE INDEX aaa_worker_op_due ON aaa_worker_ops(deadline_at, id) WHERE state IN ('queued', 'claimed', 'running');
CREATE INDEX aaa_worker_op_history ON aaa_worker_ops(worker_id, created_at DESC, id DESC);
CREATE INDEX aaa_worker_op_update ON aaa_worker_ops(worker_id, update_id) WHERE update_id <> '';

CREATE TABLE aaa_agent_tasks (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES aaa_workers(id),
    state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'running', 'completed', 'failed', 'refused', 'cancelled', 'interrupted')),
    held INTEGER NOT NULL CHECK (held IN (0, 1)),
    claim_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL,
    claimed_at INTEGER,
    started_at INTEGER,
    finished_at INTEGER,
    reason TEXT NOT NULL,
    remote_outcome TEXT NOT NULL,
    result_bytes INTEGER NOT NULL CHECK (result_bytes >= 0),
    result_sha256 TEXT NOT NULL,
    data BLOB NOT NULL,
    prompt BLOB NOT NULL,
    result BLOB,
    CHECK (NOT held OR claim_id <> ''),
    CHECK (started_at IS NULL OR claimed_at IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX aaa_agent_task_held ON aaa_agent_tasks(worker_id) WHERE held = 1;
CREATE INDEX aaa_agent_task_queue ON aaa_agent_tasks(worker_id, created_at, id) WHERE state = 'queued';
CREATE INDEX aaa_agent_task_due ON aaa_agent_tasks(deadline_at, id) WHERE state IN ('queued', 'claimed', 'running');
CREATE INDEX aaa_agent_task_history ON aaa_agent_tasks(worker_id, created_at DESC, id DESC);
CREATE INDEX aaa_agent_task_created ON aaa_agent_tasks(created_at, id);

CREATE TRIGGER aaa_slot_inference_insert AFTER INSERT ON aaa_inference_jobs WHEN NEW.held = 1 BEGIN
    INSERT INTO aaa_worker_slots(worker_id, lane, item_id, acquired_at)
        VALUES(NEW.worker_id, 'inference', NEW.id, COALESCE(CAST(unixepoch(json_extract(CAST(NEW.data AS TEXT), '$.claimed_at'), 'subsec') * 1000000 AS INTEGER), NEW.created_at));
END;

CREATE TRIGGER aaa_slot_inference_update AFTER UPDATE OF worker_id, held, id ON aaa_inference_jobs
    WHEN OLD.held <> NEW.held OR OLD.worker_id IS NOT NEW.worker_id OR OLD.id <> NEW.id BEGIN
    DELETE FROM aaa_worker_slots WHERE worker_id = OLD.worker_id AND lane = 'inference' AND item_id = OLD.id AND OLD.held = 1;
    INSERT INTO aaa_worker_slots(worker_id, lane, item_id, acquired_at)
        SELECT NEW.worker_id, 'inference', NEW.id, COALESCE(CAST(unixepoch(json_extract(CAST(NEW.data AS TEXT), '$.claimed_at'), 'subsec') * 1000000 AS INTEGER), NEW.created_at) WHERE NEW.held = 1;
END;

CREATE TRIGGER aaa_slot_inference_delete AFTER DELETE ON aaa_inference_jobs WHEN OLD.held = 1 BEGIN
    DELETE FROM aaa_worker_slots WHERE worker_id = OLD.worker_id AND lane = 'inference' AND item_id = OLD.id;
END;

CREATE TRIGGER aaa_slot_worker_op_insert AFTER INSERT ON aaa_worker_ops WHEN NEW.held = 1 BEGIN
    INSERT INTO aaa_worker_slots(worker_id, lane, item_id, acquired_at)
        VALUES(NEW.worker_id, 'worker_op', NEW.id, COALESCE(NEW.claimed_at, NEW.created_at));
END;

CREATE TRIGGER aaa_slot_worker_op_update AFTER UPDATE OF worker_id, held, id ON aaa_worker_ops
    WHEN OLD.held <> NEW.held OR OLD.worker_id IS NOT NEW.worker_id OR OLD.id <> NEW.id BEGIN
    DELETE FROM aaa_worker_slots WHERE worker_id = OLD.worker_id AND lane = 'worker_op' AND item_id = OLD.id AND OLD.held = 1;
    INSERT INTO aaa_worker_slots(worker_id, lane, item_id, acquired_at)
        SELECT NEW.worker_id, 'worker_op', NEW.id, COALESCE(NEW.claimed_at, NEW.created_at) WHERE NEW.held = 1;
END;

CREATE TRIGGER aaa_slot_worker_op_delete AFTER DELETE ON aaa_worker_ops WHEN OLD.held = 1 BEGIN
    DELETE FROM aaa_worker_slots WHERE worker_id = OLD.worker_id AND lane = 'worker_op' AND item_id = OLD.id;
END;

CREATE TRIGGER aaa_slot_agent_task_insert AFTER INSERT ON aaa_agent_tasks WHEN NEW.held = 1 BEGIN
    INSERT INTO aaa_worker_slots(worker_id, lane, item_id, acquired_at)
        VALUES(NEW.worker_id, 'agent_task', NEW.id, COALESCE(NEW.claimed_at, NEW.created_at));
END;

CREATE TRIGGER aaa_slot_agent_task_update AFTER UPDATE OF worker_id, held, id ON aaa_agent_tasks
    WHEN OLD.held <> NEW.held OR OLD.worker_id IS NOT NEW.worker_id OR OLD.id <> NEW.id BEGIN
    DELETE FROM aaa_worker_slots WHERE worker_id = OLD.worker_id AND lane = 'agent_task' AND item_id = OLD.id AND OLD.held = 1;
    INSERT INTO aaa_worker_slots(worker_id, lane, item_id, acquired_at)
        SELECT NEW.worker_id, 'agent_task', NEW.id, COALESCE(NEW.claimed_at, NEW.created_at) WHERE NEW.held = 1;
END;

CREATE TRIGGER aaa_slot_agent_task_delete AFTER DELETE ON aaa_agent_tasks WHEN OLD.held = 1 BEGIN
    DELETE FROM aaa_worker_slots WHERE worker_id = OLD.worker_id AND lane = 'agent_task' AND item_id = OLD.id;
END;

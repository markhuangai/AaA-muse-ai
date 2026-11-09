package worker

import "time"

type Record struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	RegisteredAt  time.Time  `json:"registered_at"`
	RevokedAt     *time.Time `json:"revoked_at"`
	LastContactAt *time.Time `json:"last_contact_at"`
}

type Enrollment struct {
	ID         string     `json:"enrollment_id"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  time.Time  `json:"expires_at"`
	ConsumedAt *time.Time `json:"consumed_at,omitempty"`
	WorkerID   string     `json:"worker_id,omitempty"`
}

type Rejection struct {
	Reason     string
	Enrollment Enrollment
	WorkerID   string
	Outcome    string
}

func (r *Rejection) Error() string { return r.Reason }

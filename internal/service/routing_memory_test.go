package service

import (
	"bytes"
	"encoding/json"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func (m *inferenceMemory) withinRouting(ref inference.Ref, apply func(*inference.State) error) error {
	data, err := json.Marshal(m.states)
	if err != nil {
		return err
	}
	states := map[string]*inference.State{}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	if err = d.Decode(&states); err != nil {
		return err
	}
	if err = memoryHistoryScope(states, &ref); err != nil {
		return err
	}

	s := &inference.State{Now: m.now, WorkerID: ref.WorkerID, HistoryConversationID: ref.ConversationID, Experiments: map[string]*inference.Experiment{}, Jobs: map[string]*inference.Job{}, Conversations: map[string]*inference.Conversation{}, Requests: map[string]*inference.Request{}, Pool: map[string]*inference.State{}, Receipt: m.receipts[ref.Principal+":"+ref.SubmissionID]}
	for id, w := range states {
		w.Now = s.Now
		if id != "" {
			s.Pool[id] = w
		}
		for k, v := range w.Experiments {
			s.Experiments[k] = v
		}
		for k, v := range w.Jobs {
			s.Jobs[k] = v
		}
		for k, v := range w.Conversations {
			v.Events = nil
			s.Conversations[k] = v
		}
		for k, v := range w.Requests {
			s.Requests[k] = v
		}
	}
	for _, w := range s.Pool {
		w.Requests = s.Requests
		w.Conversations = s.Conversations
	}
	if ref.Recovery {
		s.Recovery = inference.RecoverySummary{Receipts: len(m.receipts), Conversations: len(s.Conversations)}
	}
	for id, r := range s.Requests {
		if e := s.Experiments[id]; e != nil {
			e.Messages = inference.RequestMessages(s.Conversations[r.ConversationID], r)
		}
	}
	if err = apply(s); err != nil {
		return err
	}
	if m.persistFail != nil {
		return m.persistFail
	}
	if m.timeline == nil {
		m.timeline = map[string][]inference.TimelineEvent{}
	}
	for _, c := range s.Conversations {
		m.timeline[c.ID] = append(m.timeline[c.ID], c.Events...)
		c.Events = nil
	}
	if s.Receipt != nil {
		m.receipts[ref.Principal+":"+ref.SubmissionID] = s.Receipt
	}
	states[""] = &inference.State{Now: s.Now}
	for _, w := range states {
		w.Pool = nil
		w.Requests = map[string]*inference.Request{}
		w.Conversations = map[string]*inference.Conversation{}
		w.Experiments = map[string]*inference.Experiment{}
		w.Jobs = map[string]*inference.Job{}
	}
	for id, e := range s.Experiments {
		states[e.WorkerID].Experiments[id] = e
	}
	for id, j := range s.Jobs {
		states[j.WorkerID].Jobs[id] = j
	}
	for id, c := range s.Conversations {
		states[c.WorkerID].Conversations[id] = c
	}
	for id, r := range s.Requests {
		states[r.WorkerID].Requests[id] = r
	}
	m.states = states
	return nil
}

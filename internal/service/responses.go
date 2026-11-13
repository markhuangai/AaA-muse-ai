package service

import (
	"context"
	"log/slog"
	"reflect"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func (b *Broker) SubmitResponse(ctx context.Context, logger *slog.Logger, client, session string, value inference.ResponseInput) (inference.RequestView, error) {
	if len(value.ItemIDs) != len(value.Input.Messages) {
		return inference.RequestView{}, inference.Reject("invalid_response_item_ids", 400)
	}
	metadata := &inference.ResponseMetadata{Instructions: value.Instructions, PreviousResponseID: value.Input.PreviousResponseID, Input: value.Input.Messages, ItemIDs: value.ItemIDs, Tools: value.Input.Tools}
	return b.submitRequest(ctx, logger, client, session, value.Input, metadata)
}

func responseHistory(c *inference.Conversation, requests map[string]*inference.Request, supplied []inference.Item, metadata *inference.ResponseMetadata) ([]inference.Item, error) {
	known := map[string]inference.HistoryItem{}
	if c != nil {
		for _, item := range c.Items {
			if item.Source == "server_observed" {
				known[inference.OutputItemID(item.RequestID, item.Item.Type)] = item
			}
		}
	}
	seen := map[string]bool{}
	for i, id := range metadata.ItemIDs {
		if id == "" {
			continue
		}
		expected, ok := known[id]
		if !ok {
			return nil, inference.Reject("response_item_not_owned", 404, "position", i, "requested_item_id", id)
		}
		if seen[id] || !reflect.DeepEqual(expected.Item, supplied[i]) {
			return nil, inference.Reject("response_item_conflict", 409, "position", i, "expected_item", expected.Item, "observed_item", supplied[i], "item_id", id)
		}
		seen[id] = true
	}
	if metadata.PreviousResponseID == "" {
		return supplied, nil
	}
	var previous *inference.Request
	for _, request := range requests {
		if request.ResponseID == metadata.PreviousResponseID {
			previous = request
			break
		}
	}
	if previous == nil || c == nil {
		return nil, inference.Reject("history_owner_denied", 404)
	}
	if previous.ID != c.CurrentRequestID {
		return nil, inference.Reject("stale_response_reference", 409, "conversation_id", c.ID, "current_request_id", c.CurrentRequestID, "observed_response_id", metadata.PreviousResponseID)
	}
	base := inference.Messages(c, previous.CanonicalEnd)
	if len(supplied) >= len(base) && reflect.DeepEqual(supplied[:len(base)], base) {
		return supplied, nil
	}
	if len(seen) > 0 && metadata.ItemIDs[0] == "" {
		return supplied, nil
	}
	delta := make([]inference.Item, 0, len(supplied))
	for i, item := range supplied {
		if metadata.ItemIDs[i] == "" {
			delta = append(delta, item)
		}
	}
	return append(base, delta...), nil
}

package inference

type ResponseInput struct {
	Input        RequestInput `json:"request"`
	Instructions *string      `json:"instructions"`
	ItemIDs      []string     `json:"item_ids"`
}

type ResponseMetadata struct {
	Instructions       *string  `json:"instructions"`
	PreviousResponseID string   `json:"previous_response_id"`
	Input              []Item   `json:"input"`
	ItemIDs            []string `json:"item_ids"`
	Tools              []Tool   `json:"tools"`
}

func OutputItemID(requestID, kind string) string {
	if kind == "tool_call" {
		return "fc_" + requestID
	}
	return "msg_" + requestID
}

func RequestMessages(c *Conversation, r *Request) []Item {
	messages := Messages(c, r.CanonicalEnd)
	if r.Response != nil && r.Response.Instructions != nil {
		messages = append([]Item{{Type: "message", Role: "system", Text: *r.Response.Instructions}}, messages...)
	}
	return messages
}

package openwa

import (
	"context"
	"testing"
)

// net/http sends a request that carries Idempotency-Key again after a dropped connection, so the
// key from the context reaches only the routes where the gateway deduplicates.
func TestIdempotencyKeyReachesOnlyRoutesThatHonorIt(t *testing.T) {
	rt := &recordTransport{status: 200, body: `{}`}
	c := newTestClient(t, rt)
	ctx := WithIdempotencyKey(context.Background(), "order-1")
	for _, tc := range []struct {
		name string
		do   func() error
		want string
	}{
		{"send-text", func() error { _, err := c.Messages.SendText(ctx, "s", SendTextRequest{}); return err }, "order-1"},
		{"reply", func() error { _, err := c.Messages.Reply(ctx, "s", ReplyMessageRequest{}); return err }, "order-1"},
		{"forward", func() error { _, err := c.Messages.Forward(ctx, "s", ForwardMessageRequest{}); return err }, "order-1"},
		{"send-bulk", func() error { _, err := c.Messages.SendBulk(ctx, "s", SendBulkRequest{}); return err }, ""},
		{"click-button", func() error { _, err := c.Messages.ClickButton(ctx, "s", ClickButtonRequest{}); return err }, ""},
		{"status", func() error { _, err := c.Status.SendText(ctx, "s", SendTextStatusRequest{}); return err }, ""},
		{"do on a keyed route", func() error {
			return c.Do(ctx, "POST", "/api/sessions/s/messages/send-text", nil, map[string]string{}, nil)
		}, "order-1"},
		{"do on another route", func() error { return c.Do(ctx, "POST", "/api/sessions/s/groups", nil, map[string]string{}, nil) }, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rt.lastReq = nil
			if err := tc.do(); err != nil {
				t.Fatal(err)
			}
			if got := rt.lastReq.Header.Get("Idempotency-Key"); got != tc.want {
				t.Fatalf("Idempotency-Key = %q, want %q", got, tc.want)
			}
		})
	}
}

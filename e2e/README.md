# End-to-end smoke test

Drives the whole product in a real browser: operator signs in, opens an event,
attendee opens the share link, takes a selfie through the camera, and gets
results back.

```bash
./scripts/dev-all.sh            # postgres, enrollment service, worker, web app
./scripts/seed-demo.sh          # an operator, an event, and an indexed album
DEMO_SLUG=<slug> node e2e/smoke.mjs
```

Screenshots land in `/tmp/shots`.

## The camera

Chromium is given a synthetic camera:

```
--use-fake-device-for-media-stream
--use-file-for-fake-video-capture=<file.y4m>
```

`scripts/make-fake-camera.py` writes that Y4M from the demo selfie frames — a
text header followed by raw planar YUV420, no encoder involved. The frames cycle
so consecutive captures genuinely differ, which is what the replay check in
`SelfieCapture` looks for; a still image would be rejected, correctly.

This is the only way to exercise the capture path as written. The flow is
camera-only by design — there is no file-upload fallback to test through,
because that fallback is exactly the impersonation hole the design closes.

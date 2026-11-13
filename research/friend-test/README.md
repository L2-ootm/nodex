# steer prototype

Read `STEER.md` first. Nothing here touches production code. Run everything from the repository root
(Node 20+; `@playwright/test` 1.60.0 is already a devDependency and is the only non-builtin import).

```
node research/friend-test/compress-audit.mjs                  # byte audit, synthetic payloads
node research/friend-test/compress-audit.mjs --file real.json # byte audit, one real snapshot
node research/friend-test/selftest.mjs                        # analyzer fixtures, under 1 s
node research/friend-test/selftest.mjs --e2e                  # full harness against the mock, about 45 s
```

Look at the page by hand against the mock (three terminals):

```
node research/friend-test/mock-server.mjs --port 4990
$env:NODEX_ADMIN_TOKEN="mock"; node research/friend-test/writer.mjs --api http://127.0.0.1:4990 --key friend-demo --period 4000 --bytes 4000 --seconds 120
start "http://127.0.0.1:4990/friend.html?room=demo&role=A&secs=60&sw=skip"
```

`sw=skip` exists only for the mock, which has no Service Worker. The real run is in STEER.md section 7.
`out/` holds generated selftest results and screenshots and can be deleted.

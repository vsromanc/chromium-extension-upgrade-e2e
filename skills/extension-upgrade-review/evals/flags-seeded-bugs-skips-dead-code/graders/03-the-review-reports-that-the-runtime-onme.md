---
type: llm
focus: trace
weight: 1
---

The review reports that the runtime.onMessage listener in src/background.js is registered inside the async init() after an await, so messages that wake the worker can be missed, rated High.

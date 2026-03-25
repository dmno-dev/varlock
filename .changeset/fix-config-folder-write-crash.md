---
"varlock": patch
---

Fix process crash when config folder is not writable (e.g., in Kubernetes containers). The anonymous ID write failure now logs at debug level and continues gracefully instead of calling `gracefulExit(1)`.

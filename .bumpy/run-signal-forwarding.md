---
varlock: patch
---

varlock run now forwards termination signals (SIGTERM/SIGINT/SIGHUP/SIGQUIT) to the child process and propagates its exit status faithfully (128+N on signal death), making it safe to use as a container ENTRYPOINT / PID 1

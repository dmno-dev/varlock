---
"varlock": patch
---

Fix Docker image failing to run due to missing `libstdc++` and `libgcc_s` shared libraries on Alpine Linux. The bun-compiled binary dynamically links against these C++ runtime libraries, which are now installed in the Docker image via `apk add libstdc++`.

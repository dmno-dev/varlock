---
varlock: patch
---

Skip keys whose names clash with members of the generated C# class (for example LOAD or GET_TYPE). Previously the generated module failed to compile; now those keys are left out and listed in the file header.

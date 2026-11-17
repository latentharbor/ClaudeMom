# DSH Projects worktree helper

Derived from `createThreadWorktree` and `gitOk` in `bundle/lib/project-tools.js`.
Source: https://github.com/ChengliangCao/dsh-projects
Commit: db930cbe1a53c9bd117c0507a3736ca83dea9dce
License: Apache-2.0; see LICENSE and NOTICE.

Changes: caller-owned destination, disabled Git hooks, explicit base commit, idempotent reopening, errors instead of fallback to a shared checkout. Work is retained until explicitly removed; this module never merges or deletes branches.

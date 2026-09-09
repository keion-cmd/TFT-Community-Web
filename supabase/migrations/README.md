# Migrations — BLOCKED

`0001_init.sql` and `0002_group_overview.sql` were not authored in this pass.

T-CODE-01 specified their content should come from `TFT-Phase3-Database.md`
(section B: schema, RPCs, RLS policies) and `TFT-Revision-UnifiedApp.md`
(section D: schema delta). Neither file exists in this repository or in any
parent folder searched during setup.

To unblock: add those two documents to the repo (or paste their relevant
sections), then author:

- `0001_init.sql` — roles, profiles, positions, user_positions,
  position_history, groups, group_members, messages, message_attachments,
  message_reactions, message_reads, schedules, schedule_settings,
  broadcasts, broadcast_targets, audit_logs, approvals, notifications;
  the `claim_schedule` RPC; the `current_role_rank` / `is_admin` helper
  functions; and the RLS policies from section D.
- `0002_group_overview.sql` — `groups.location`, `groups.pinned_message_id`,
  the `group_members` coordinator role, `schedules.group_id`, and the
  `group_resources` table.

No migration in this directory has been applied to any Supabase project.

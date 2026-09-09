# TFT Community Platform — Schema Fix: Exclusivity Trigger Gap (found in T-CODE-06)

## Problem
`user_positions` has a full `unique(user_id, position_id)` constraint, so
re-assigning a previously-revoked holder happens via `UPDATE` (reactivating
the existing row), not `INSERT`. The exclusivity trigger only fired on
`INSERT`, so that `UPDATE` path had **no database-layer enforcement** —
only the app-layer check added in T-CODE-06. This reintroduces a
single-layer-of-trust gap Phase 6 explicitly warned against.

## Fix
Fire the trigger on `INSERT` and on the specific `UPDATE` that reactivates
a row, and only run the exclusivity check when the row is *becoming active*
(not when it's being revoked).

```sql
drop trigger if exists trg_position_exclusivity on user_positions;

create or replace function enforce_position_exclusivity() returns trigger as $$
begin
  -- Only check when this row is becoming active (revoked_at is null on the
  -- new row). A revoke (revoked_at going from null -> set) never conflicts
  -- with anything and must be allowed through unchecked.
  if new.revoked_at is null then
    if (select is_exclusive from positions where id = new.position_id) then
      if exists (
        select 1 from user_positions
        where position_id = new.position_id
          and revoked_at is null
          and id is distinct from new.id   -- exclude self, so reactivating
                                            -- the same row isn't a false
                                            -- conflict with itself
      ) then
        raise exception 'This position is exclusive and already has an active holder';
      end if;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_position_exclusivity
  before insert or update of revoked_at on user_positions
  for each row execute function enforce_position_exclusivity();
```

## Net effect
- `assignPosition`'s app-layer `EXCLUSIVE_POSITION_TAKEN` check stays as-is
  — it's still the right thing to have for a clean error message before
  hitting the DB. It just stops being the *only* thing preventing the
  actual conflict.
- No change needed to `assignPosition`'s logic — the trigger backstop
  catches the same case the app already checks; nothing to remove, nothing
  to re-plumb.

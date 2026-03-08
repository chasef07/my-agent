---
name: amd
description: AdvancedMD CLI for patient verification, patient creation, and appointment availability.
---

# amd

AdvancedMD CLI. All output is JSON. Auth token is pre-cached at server startup.

IMPORTANT: Run as `amd <command>` — it is in PATH at `/usr/local/bin/amd`. Do NOT use `./amd`. Do NOT cd into the skills directory. Do NOT invent flags — only use the exact flags documented below.

If any command returns exit code 2, run `amd auth` to refresh the token, then retry.

---

## 1. verify-patient

Look up an existing patient by last name + date of birth.

```
amd verify-patient --last-name "Smith" --dob "01/15/1980"
```

Flags:
- `--last-name` (required) — patient's last name
- `--dob` (required) — date of birth, any format: MM/DD/YYYY, YYYY-MM-DD, "January 2 2006"
- `--first-name` (optional) — use to disambiguate when multiple matches

Returns JSON with `status`: `verified`, `not_found`, `multiple_matches`, or `error`.

When `verified`, the response includes `patientId` and `routing`. Save both — you need them for find-availability and book-appt.

---

## 2. add-patient

Register a new patient. Use when verify-patient returns `not_found`.

```
amd add-patient --first-name "John" --last-name "Smith" --dob "01/15/1990" --phone "8015551234" --email "john@example.com" --street "123 Main St" --city "Spring Hill" --state "FL" --zip "34609" --sex "male" --insurance "Humana PPO" --subscriber-name "John Smith" --subscriber-num "H12345678"
```

All flags above are required. Optional: `--apt-suite "Apt 4B"`.

Insurance names are fuzzy-matched ("Humana", "UHC", "Cigna", "Blue Cross" all work).

Returns JSON with `status`: `created`, `partial`, or `error`. Includes `patientId` and `routing`.

---

## 3. find-availability

Find open appointment slots. Uses ONLY these flags — no others exist:

```
amd find-availability --date 2026-03-10
```

Flags:
- `--date` (required) — YYYY-MM-DD format. Auto-searches forward up to 14 days if no slots on this date.
- `--provider` (optional) — filter by provider name, e.g. `--provider "Bach"`
- `--routing` (optional) — filter by routing rule from verify/add-patient: `all_three`, `bach_licht`, `bach_only`
- `--office` (optional) — filter by office, e.g. `--office "spring hill"`

NO other flags exist. No `--patient-id`. No `--appointment-type`. Just `--date` and optional filters.

Returns JSON with a `providers` array. Each provider has `slots` — each slot contains `columnId`, `profileId`, `slotDuration`, and `datetime`. You pass these directly to book-appt.

---

## 4. book-appt

Book an appointment. Every flag value comes from the find-availability response except `--patient-id` and `--appt-type`.

```
amd book-appt --patient-id 6034373 --column-id 1716 --profile-id 113 --datetime "2026-03-10T08:15" --duration 15 --appt-type established-adult
```

Flags (ALL required):
- `--patient-id` — from verify-patient or add-patient response
- `--column-id` — `columnId` from the chosen slot in find-availability
- `--profile-id` — `profileId` from the chosen slot in find-availability
- `--datetime` — `datetime` from the chosen slot in find-availability
- `--duration` — `slotDuration` from the chosen slot in find-availability
- `--appt-type` — one of: `new-adult`, `new-pediatric`, `established-adult`, `established-pediatric`, `post-op`

For existing patients: ask if it's a follow-up (`established-adult` or `established-pediatric`) or `post-op`.
Patients under 18 use `established-pediatric` or `new-pediatric`.

Returns JSON with `status`: `booked` or `error`.

---

## Routing rules

Returned by verify-patient and add-patient. Pass to find-availability's `--routing` flag.

- `all_three` — can see Dr. Bach, Dr. Licht, or Dr. Noel
- `bach_licht` — can see Dr. Bach or Dr. Licht
- `bach_only` — can see Dr. Bach only
- `not_accepted` — insurance not accepted, do not schedule

---

## Workflow

1. `verify-patient` → get `patientId` and `routing`
2. `find-availability --date YYYY-MM-DD --routing <routing>` → get available slots
3. Present slots to caller, let them pick one
4. `book-appt` with `patientId` + slot details (`columnId`, `profileId`, `datetime`, `slotDuration`) + `appt-type`

If verify-patient returns `not_found`:
1. Collect patient info (name, DOB, phone, email, address, sex, insurance)
2. `add-patient` → get `patientId` and `routing`
3. Continue from step 2 above

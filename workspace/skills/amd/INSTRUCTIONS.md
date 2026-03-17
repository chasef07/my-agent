---
name: amd
description: |
  Interact with AdvancedMD practice management APIs via CLI. Use when the user wants to
  look up patients, check availability, create patients, view or cancel appointments,
  or inspect AMD auth tokens.
---

# AdvancedMD CLI

Installed at `/usr/local/bin/amd`. All output is JSON to stdout; logs to stderr. Use the bash tool to run commands.

## Commands

**Token** — get current AMD auth token + API URLs:
- `amd token`

**Verify patient** — lookup by name + DOB, returns ID, insurance, routing:
- `amd verify --last Smith --dob 1985-06-15`
- `amd verify --last Smith --first John --dob 06/15/1985`

**Add patient** — create patient + attach insurance:
- `amd add-patient --first Jane --last Doe --dob 2000-03-01 --phone 555-123-4567 --email jane@example.com --street "123 Main St" --city Miami --state FL --zip 33101 --sex F --insurance "Florida Blue" --subscriber-name "Jane Doe" --subscriber-num ABC123`
- Optional: `--apt` for apartment/suite

**Availability** — open appointment slots (auto-searches forward 14 days):
- `amd availability --date 2026-03-20`
- `amd availability --date 2026-03-20 --provider Bach --routing bach_only`
- Optional: `--office`, `--preauth` (14-day lead time)
- Same-day searches rejected. Max 5 slots per provider returned.

**Appointments** — upcoming appointments for a patient:
- `amd appointments --patient-id 12345`

**Cancel** — cancel by appointment ID:
- `amd cancel --appointment-id 98765`

## Typical flow

1. `verify` → get `patientId` + `routing`
2. `availability --routing <routing>` → see open slots
3. `appointments --patient-id <id>` → see what's booked

## Routing rules

Insurance determines providers: `all_three` (Bach/Licht/Noel), `bach_licht`, `bach_only`, `not_accepted`. Patients under 18 auto-route to `bach_only`. Ambiguous carriers (`routingAmbiguous: true`) need a clarifying question.

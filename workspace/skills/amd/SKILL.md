---
name: amd
description: AdvancedMD CLI for patient verification, patient creation, and appointment availability.
---

# amd

Use `amd` for AdvancedMD patient and scheduling operations. All output is JSON to stdout.

IMPORTANT: `amd` is installed at `/usr/local/bin/amd`. Run commands as `amd <command>` (NOT `./amd`). Do NOT cd into the skills directory. Auth token is pre-cached at server startup.

Setup
- Env vars are pre-configured: `ADVANCEDMD_USERNAME`, `ADVANCEDMD_PASSWORD`, `ADVANCEDMD_OFFICE_KEY`, `ADVANCEDMD_APP_NAME`
- Auth token is pre-cached. If any command returns exit code 2 (token expired), run `amd auth` to refresh.

Commands

- Auth: `amd auth`
- Verify patient: `amd verify-patient --last-name "Smith" --dob "01/15/1980"`
- Verify with disambiguation: `amd verify-patient --last-name "Smith" --dob "01/15/1980" --first-name "John"`
- Add patient: `amd add-patient --first-name "John" --last-name "Smith" --dob "01/15/1990" --phone "8015551234" --email "john@example.com" --street "123 Main St" --city "Spring Hill" --state "FL" --zip "34609" --sex "male" --insurance "Humana PPO" --subscriber-name "John Smith" --subscriber-num "H12345678"`
- Add patient with apt: append `--apt-suite "Apt 4B"`
- Find availability: `amd find-availability --date 2026-03-10`
- Filter by provider: `amd find-availability --date 2026-03-10 --provider "Bach"`
- Filter by routing: `amd find-availability --date 2026-03-10 --routing bach_only`
- Filter by office: `amd find-availability --date 2026-03-10 --office "spring hill"`
- Combined filters: `amd find-availability --date 2026-03-10 --provider "Bach" --routing bach_only --office "spring hill"`
- Book appointment: `amd book-appt --patient-id 6034373 --column-id 1716 --profile-id 113 --datetime "2026-03-10T08:15" --duration 15 --appt-type established-adult`
- Appt types: `new-adult`, `new-pediatric`, `established-adult`, `established-pediatric`, `post-op`

Response statuses
- verify-patient returns: `verified`, `not_found`, `multiple_matches`, or `error`
- add-patient returns: `created`, `partial` (patient created but insurance failed), or `error`
- find-availability returns providers array with available slots, or empty array with message if none found within 14 days
- book-appt returns: `booked` or `error`

Routing rules (returned by verify/add-patient, pass to find-availability)
- `all_three`: Patient can see Dr. Bach, Dr. Licht, or Dr. Noel
- `bach_licht`: Patient can see Dr. Bach or Dr. Licht
- `bach_only`: Patient can see Dr. Bach only
- `not_accepted`: Insurance not accepted

Notes
- DOB accepts flexible formats: MM/DD/YYYY, YYYY-MM-DD, January 2 2006, etc.
- Phone should be 10 digits (formatting is automatic).
- Insurance names are fuzzy-matched. Common aliases work: "Humana", "UHC", "Cigna", "Blue Cross", etc.
- Patients under 18 are automatically routed to Dr. Bach only (pediatric override).
- find-availability auto-searches forward up to 14 days if the requested date has no slots.
- Date format for find-availability must be YYYY-MM-DD.
- Exit code 0 = success, 1 = error, 2 = token expired (run `amd auth`).
- book-appt uses `columnId`, `profileId`, `slotDuration`, and `datetime` directly from the find-availability response.
- For existing patients, determine appt-type by asking: follow-up or post-op?

Workflow
1. Verify patient → get routing and patientId
2. Use routing in find-availability to show only allowed providers
3. If patient not found → add-patient → get routing → find-availability
4. Patient confirms a slot → book-appt with patientId + slot details from find-availability

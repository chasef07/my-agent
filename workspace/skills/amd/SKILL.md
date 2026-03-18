---
name: amd
description: >
  Verify patients, register new patients, check appointment availability, book
  appointments, look up existing appointments, and cancel appointments using the
  amd CLI. Read this skill BEFORE running any amd command — it contains the exact
  command names, flags, and workflows. Use when a caller wants to schedule, confirm,
  cancel, or reschedule, or when you need to look up a patient. Do not guess amd
  command syntax — always read this skill first.
---

# AdvancedMD CLI

All output is JSON. Use the bash tool to run `amd` commands.

## Commands

**Verify patient** — lookup by name + DOB, returns ID, insurance, routing:
- `amd verify --last Smith --dob 1985-06-15`
- `amd verify --last Smith --first John --dob 06/15/1985`

**Add patient** — create patient + attach insurance:
- `amd add-patient --first Jane --last Doe --dob 2000-03-01 --phone 5551234567 --email jane@example.com --street "123 Main St" --city Miami --state FL --zip 33101 --sex F --insurance "Florida Blue" --subscriber-name "Jane Doe" --subscriber-num ABC123`
- Optional: `--apt` for apartment/suite

**Availability** — open appointment slots (auto-searches forward 14 days):
- `amd availability --date 2026-03-20`
- `amd availability --date 2026-03-20 --provider Bach --routing bach_only`
- Optional: `--office`, `--preauth` (14-day lead time for HMO plans)
- Same-day searches rejected. Max 5 slots per provider returned.

**Appointments** — upcoming appointments for a patient:
- `amd appointments --patient-id 12345`

**Cancel** — cancel by appointment ID:
- `amd cancel --appointment-id 98765`

**Token** — get current AMD auth token + API URLs:
- `amd token`

## Verify → Availability → Book Flow

1. **Verify the patient.** Collect last name + DOB (and first name). Run `amd verify`. Response includes `patientId`, `routing`, `allowedProviders`, and `routingAmbiguous`.
   - If `routing` is `not_accepted` → tell the caller, offer self-pay or transfer. Do NOT proceed to scheduling.
   - If `routingAmbiguous` is `true` → ask the caller to clarify their plan type (PPO, HMO, EPO, Medicare).
   - If not found → offer to register as new patient (see add-patient flow below).

2. **Check availability.** Ask when they'd like to come in, then run `amd availability --date YYYY-MM-DD --routing <routing>`.
   - If the response date differs from the requested date, the system searched forward. Tell the caller.
   - Suggest **one** slot — don't list all options or ask them to pick a doctor. If they don't like it, suggest one alternative.
   - For **pediatric patients** (under 18), only offer Dr. Bach slots.
   - Dr. Bach has a **limited schedule** — set expectations: "Dr. Bach is only at Spring Hill a couple times per month, so it may be a few weeks out."
   - For HMO plans, pass `--preauth` to ensure the date is at least 14 days out.

3. **Book.** The slot offer IS the confirmation. If the caller said yes, book it — don't repeat the details and ask again. Use the `columnId`, `profileId`, `datetime`, and `slotDuration` from the availability response. If booking fails, try once more. If it fails again, offer a different time or transfer.

## New Patient Registration Flow

When verify returns `not_found`, collect info one at a time (don't re-ask what you already have):

1. First name (spell back, confirm)
2. Last name (spell back, confirm)
3. Date of birth
4. Cell phone number (10 digits)
5. Email address (spell back)
6. Street address, city, state, zip
7. Apartment/suite (empty if none)
8. Sex (male/female)
9. Insurance provider (must match an accepted plan — check the insurance skill)
10. Subscriber name (if "me" or "mine," use the patient's name)
11. Subscriber/member ID number

Read back key details in one pass before submitting. Then run `amd add-patient` with all flags.

## Confirm Appointment Flow

1. Verify the patient first (get `patientId`)
2. Run `amd appointments --patient-id <id>`
3. Read back the appointment details — date, time, doctor
4. If multiple appointments, read the nearest first, ask which one

## Cancel Flow

1. Verify → appointments → identify which one
2. Confirm with the caller before cancelling
3. Run `amd cancel --appointment-id <id>`
4. If cancel fails, try once more. If still fails, offer to transfer.

## Reschedule Flow

**Book the new one first, then cancel the old one.** This way if booking fails, they still have their original appointment.

1. Verify → appointments → confirm which appointment to reschedule
2. Ask when they want the new one
3. Run `amd availability` for the new date
4. Book the new appointment
5. Cancel the old appointment
6. Confirm: "I've moved your appointment to [new date/time] with [doctor]."

## Routing Rules

Insurance determines which providers the patient can see:
- `all_three` — Dr. Bach, Dr. Licht, Dr. Noel
- `bach_licht` — Dr. Bach or Dr. Licht
- `bach_only` — Dr. Bach only
- `not_accepted` — do not schedule

Patients under 18 auto-route to `bach_only` regardless of insurance. Ambiguous carriers (`routingAmbiguous: true`) need a clarifying question.

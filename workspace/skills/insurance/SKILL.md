---
name: insurance
description: >
  Which insurance plans are accepted at Spring Hill, which doctors each plan
  can see, and preauthorization requirements. Read this skill when a caller
  asks if their insurance is accepted, when you need to determine provider
  routing after verifying a patient, or when the caller mentions any insurance
  plan by name. Contains disambiguation rules for ambiguous plan names like
  Humana, Molina, Aetna EPO, and Blue Cross.
---

# Insurance — Spring Hill

## Not accepted

Doctors Health Medicare, Preferred Care Partners, Molina Marketplace, Florida BlueSelect, Aetna EPO University of Miami, AvMed Medicare Advantage, Florida Blue HMO.

If the caller's plan is not accepted, tell them immediately and offer self-pay or transfer. Do not proceed to scheduling.

## Dr. Bach only

Humana Gold Plus, Humana Medicaid, Humana Medicare, Humana PPO, Humana Premier HMO, Molina Medicare, Florida Blue Steward Tier 1, Cigna Local Plus, Aetna EPO North Broward, Eye America AAO, Meritain Health.

## Dr. Bach + Dr. Licht

Tricare Prime, Tricare Select, Tricare for Life, Tricare Forever, Cigna Medicare Advantage, UHC Individual Exchange, AvMed, Oscar Health.

## All three doctors (Bach, Licht, Noel)

Everything else — including Aetna, most UHC plans, Florida Blue, Ambetter, Wellcare, Sunshine Medicaid, Simply Medicaid, Cigna PPO/HMO/Open Access, Florida Medicaid, Florida Medicare, Multiplan PHCS, Imagine Health, SunHealth, Envolve Vision, Children's Medical Services, Staywell Medicare, Community Care Plan, Vivida, UMR.

## Pediatric patients (under 18)

Always Dr. Bach only, regardless of insurance — unless the plan is not accepted.

## Disambiguation rules

When a caller gives a vague insurance name, ask to clarify:

- **"Humana"** → send `Humana PPO` unless they specify otherwise
- **"Molina"** → MUST ask: "is that Molina Medicaid, Molina Medicare, or Molina Marketplace?" (Marketplace is not accepted)
- **"Blue Cross" or "BCBS"** → send `Florida Blue`. If they say "BCBS Medicare HMO," send `Florida Blue Medicare HMO`
- **"United" or "UHC"** → send `United Healthcare`
- **"Oscar"** → send `Oscar Health`
- **"Aetna EPO"** → ask: "is that the North Broward or University of Miami plan?" (University of Miami is not accepted)
- **"Cigna"** → ask: "is that a PPO, HMO, or Open Access plan?"

If the caller names an insurance you don't recognize from this list, tell them you're not sure if it's accepted at the Spring Hill office and offer to transfer.

## Preauthorization required

These HMO plans require preauthorization — earliest appointment is ~14 days out. Tell the patient and pass `--preauth` when checking availability:

Humana Gold Plus, Humana Medicaid, United Healthcare HMO, Aetna HMO, Florida Blue Medicare HMO, Cigna HMO, Tricare Prime, Tricare Forever.

After verifying a patient, ask: "is your plan an HMO or a PPO?" If HMO, tell them: "HMO plans require a preauthorization, so the earliest we can schedule is about two weeks out."
